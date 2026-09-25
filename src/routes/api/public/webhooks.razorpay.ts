import { createFileRoute } from "@tanstack/react-router";
import { fail, logEvent } from "@/lib/api-response";
import { verifyWebhookSignature } from "@/lib/razorpay.server";
import {
  markOrderPaid,
  markOrderPaymentFailed,
  releaseOrderInventory,
} from "@/lib/order-fulfilment.server";
import {
  isCapturedPaymentStatus,
  paymentMatchesOrder,
  shouldReleaseFailedPayment,
} from "@/lib/payment-state";

type RazorpayEntity = {
  id?: string;
  order_id?: string;
  amount?: number;
  method?: string;
  status?: string;
  currency?: string;
  captured?: boolean;
  payment_id?: string;
};

type RazorpayWebhook = {
  event: string;
  payload?: {
    payment?: { entity?: RazorpayEntity };
    order?: { entity?: RazorpayEntity };
    refund?: { entity?: RazorpayEntity };
  };
};

export const Route = createFileRoute("/api/public/webhooks/razorpay")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const raw = await request.text();
        const signature = request.headers.get("x-razorpay-signature");

        if (!(await verifyWebhookSignature(raw, signature))) {
          logEvent("error", "webhook_signature_invalid", { provider: "razorpay" });
          return fail("SIGNATURE_INVALID", "Invalid signature.", 401);
        }

        let body: RazorpayWebhook;
        try {
          body = JSON.parse(raw) as RazorpayWebhook;
        } catch {
          return fail("INVALID_PAYLOAD", "Invalid payload.", 400);
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        // Idempotency: Razorpay's delivery id, else a deterministic key.
        const deliveryId =
          request.headers.get("x-razorpay-event-id") ??
          `${body.event}:${body.payload?.payment?.entity?.id ?? body.payload?.order?.entity?.id ?? raw.length}`;

        const { error: insertError } = await supabaseAdmin.from("payment_events").insert({
          event_id: deliveryId,
          provider: "razorpay",
          event_type: body.event,
          payment_id: body.payload?.payment?.entity?.id ?? null,
          signature_verified: true,
          processed: false,
          payload: JSON.parse(raw),
        });

        if (insertError?.code === "23505") {
          const { data: existing, error: existingError } = await supabaseAdmin
            .from("payment_events")
            .select("processed")
            .eq("event_id", deliveryId)
            .maybeSingle();
          if (existingError)
            return fail("WEBHOOK_UNAVAILABLE", "Webhook processing will be retried.", 503);
          if (existing?.processed) {
            logEvent("info", "webhook_duplicate_ignored", { event: body.event });
            return new Response(JSON.stringify({ success: true, data: { duplicate: true } }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          logEvent("info", "webhook_retry_resumed", { event: body.event, event_id: deliveryId });
        }
        if (insertError) {
          logEvent("error", "webhook_persistence_failed", { event: body.event });
          return fail("WEBHOOK_UNAVAILABLE", "Webhook processing is temporarily unavailable.", 503);
        }

        const paymentEntity = body.payload?.payment?.entity;
        const orderEntity = body.payload?.order?.entity;
        const razorpayOrderId = paymentEntity?.order_id ?? orderEntity?.id ?? null;

        let order = null;
        if (razorpayOrderId) {
          const { data, error } = await supabaseAdmin
            .from("orders")
            .select(
              "id, grand_total, currency, email, payment_status, inventory_finalized, razorpay_order_id",
            )
            .eq("razorpay_order_id", razorpayOrderId)
            .maybeSingle();
          if (error)
            return fail(
              "WEBHOOK_UNAVAILABLE",
              "Webhook processing is temporarily unavailable.",
              503,
            );
          order = data;
        }

        const paymentEvent = ["payment.captured", "order.paid", "payment.failed"].includes(
          body.event,
        );
        if (!order && paymentEvent) {
          return fail(
            "WEBHOOK_UNAVAILABLE",
            "The local order is not available yet; webhook processing will be retried.",
            503,
          );
        }

        if (order) {
          switch (body.event) {
            case "payment.captured":
            case "order.paid": {
              if (
                !paymentEntity?.id ||
                paymentEntity.order_id !== razorpayOrderId ||
                (orderEntity?.id && orderEntity.id !== razorpayOrderId)
              ) {
                return fail("WEBHOOK_INVALID", "Captured payment identity is incomplete.", 422);
              }
              if (
                !isCapturedPaymentStatus(paymentEntity.status) ||
                paymentEntity.captured !== true
              ) {
                return fail("WEBHOOK_PAYMENT_NOT_CAPTURED", "Payment is not captured.", 409);
              }
              if (
                !paymentMatchesOrder({
                  providerOrderId: paymentEntity.order_id,
                  providerPaymentId: paymentEntity.id,
                  amount: paymentEntity.amount ?? 0,
                  currency: paymentEntity.currency ?? "",
                  expectedOrderId: order.razorpay_order_id ?? razorpayOrderId ?? "",
                  expectedAmount: Math.round(Number(order.grand_total) * 100),
                  expectedCurrency: order.currency,
                })
              ) {
                logEvent("error", "webhook_payment_identity_mismatch", {
                  order_id: order.id,
                  expected_amount: Math.round(Number(order.grand_total) * 100),
                  received_amount: paymentEntity.amount ?? null,
                });
                return fail(
                  "WEBHOOK_AMOUNT_MISMATCH",
                  "Webhook payment amount or currency does not match the order.",
                  400,
                );
              }
              const paid = await markOrderPaid(supabaseAdmin, {
                orderId: order.id,
                razorpayPaymentId: paymentEntity.id,
                razorpayOrderId: paymentEntity.order_id,
                providerAmountPaise: paymentEntity.amount!,
                currency: paymentEntity.currency!,
                method: paymentEntity.method ?? null,
                signatureVerified: true,
              });
              if (!paid.ok) {
                logEvent("error", "payment_fulfilment_failed", {
                  order_id: order.id,
                  reason: paid.reason,
                });
                return paid.reason === "PAYMENT_ID_MISMATCH"
                  ? fail("PAYMENT_ID_MISMATCH", "Payment identity did not match the order.", 409)
                  : fail("PAYMENT_PROCESSING_FAILED", "Payment processing will be retried.", 503);
              }
              // Fulfilment is best-effort: a courier outage must not fail the webhook.
              try {
                const { createShipmentForOrder } = await import("@/lib/shipment.server");
                await createShipmentForOrder(supabaseAdmin, order.id);
              } catch {
                logEvent("error", "shipment_autocreate_failed", { order_id: order.id });
              }
              break;
            }
            case "payment.failed": {
              // A delayed failure event must not undo a successful capture or
              // release a cart claimed by a later checkout attempt.
              if (!shouldReleaseFailedPayment(order)) break;
              const released = await releaseOrderInventory(supabaseAdmin, order.id, "FAILED");
              if (!released.ok)
                return fail("WEBHOOK_UNAVAILABLE", "Webhook processing will be retried.", 503);
              const failed = await markOrderPaymentFailed(
                supabaseAdmin,
                order.id,
                "Razorpay payment failed",
              );
              if (!failed.ok)
                return fail("WEBHOOK_UNAVAILABLE", "Webhook processing will be retried.", 503);
              if (failed.duplicate) break;
              const { error: notificationError } = await supabaseAdmin.from("notifications").upsert(
                {
                  type: "payment_failed",
                  recipient: order.email,
                  order_id: order.id,
                  subject: "Payment failed",
                  status: "QUEUED",
                  dedupe_key: `payment-failed:${order.id}`,
                },
                { onConflict: "dedupe_key" },
              );
              if (notificationError && notificationError.code !== "23505")
                return fail("WEBHOOK_UNAVAILABLE", "Webhook processing will be retried.", 503);
              break;
            }
            case "refund.created":
            case "refund.processed": {
              const refundId = body.payload?.refund?.entity?.id;
              const paymentId = body.payload?.refund?.entity?.payment_id;
              if (!refundId || !paymentId)
                return fail("WEBHOOK_INVALID", "Refund event is incomplete.", 422);
              const { data: payment, error: paymentError } = await supabaseAdmin
                .from("payments")
                .select("id, order_id, status, refunded_amount, captured_amount")
                .eq("razorpay_payment_id", paymentId)
                .maybeSingle();
              if (paymentError || !payment)
                return fail("WEBHOOK_UNAVAILABLE", "Webhook processing will be retried.", 503);
              const { data: localRefund, error: localRefundLookupError } = await supabaseAdmin
                .from("refunds")
                .select("id")
                .eq("razorpay_refund_id", refundId)
                .maybeSingle();
              if (localRefundLookupError || !localRefund)
                return fail("WEBHOOK_UNAVAILABLE", "Webhook processing will be retried.", 503);
              const { error: refundError } = await supabaseAdmin
                .from("refunds")
                .update({
                  razorpay_refund_id: refundId,
                  provider_status: body.payload?.refund?.entity?.status ?? body.event,
                  status: body.event === "refund.processed" ? "PROCESSED" : "CREATED",
                  processed_at: body.event === "refund.processed" ? new Date().toISOString() : null,
                })
                .eq("id", localRefund.id);
              const nextPaymentStatus =
                Number(payment.refunded_amount) >= Number(payment.captured_amount)
                  ? "REFUNDED"
                  : "PARTIALLY_REFUNDED";
              const { error: refundOrderError } = await supabaseAdmin
                .from("orders")
                .update({
                  payment_status: nextPaymentStatus,
                  ...(nextPaymentStatus === "REFUNDED" ? { status: "REFUNDED" } : {}),
                })
                .eq("id", payment.order_id);
              if (refundError || refundOrderError)
                return fail("WEBHOOK_UNAVAILABLE", "Refund processing will be retried.", 503);
              break;
            }
            default:
              break;
          }
        }

        const { error: eventUpdateError } = await supabaseAdmin
          .from("payment_events")
          .update({ processed: true, order_id: order?.id ?? null })
          .eq("event_id", deliveryId);

        if (eventUpdateError)
          return fail("WEBHOOK_UNAVAILABLE", "Webhook processing will be retried.", 503);
        logEvent("info", "webhook_processed", { event: body.event, order_id: order?.id });
        return new Response(JSON.stringify({ success: true, data: { received: true } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
  },
});
