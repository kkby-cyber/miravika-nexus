import { createFileRoute } from "@tanstack/react-router";
import { fail, logEvent } from "@/lib/api-response";
import { verifyWebhookSignature } from "@/lib/razorpay.server";
import { markOrderPaid, releaseOrderInventory } from "@/lib/order-fulfilment.server";

type RazorpayEntity = {
  id?: string;
  order_id?: string;
  amount?: number;
  method?: string;
  status?: string;
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
          signature_verified: true,
          processed: false,
          payload: body as unknown as Record<string, unknown>,
        });

        if (insertError) {
          // Unique violation => already received; acknowledge without reprocessing.
          logEvent("info", "webhook_duplicate_ignored", { event: body.event });
          return new Response(JSON.stringify({ success: true, data: { duplicate: true } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }

        const paymentEntity = body.payload?.payment?.entity;
        const orderEntity = body.payload?.order?.entity;
        const razorpayOrderId = paymentEntity?.order_id ?? orderEntity?.id ?? null;

        let order = null;
        if (razorpayOrderId) {
          const { data } = await supabaseAdmin
            .from("orders")
            .select("id, grand_total")
            .eq("razorpay_order_id", razorpayOrderId)
            .maybeSingle();
          order = data;
        }

        if (order) {
          switch (body.event) {
            case "payment.captured":
            case "order.paid": {
              if (paymentEntity?.amount != null) {
                const expected = Math.round(Number(order.grand_total) * 100);
                if (expected !== paymentEntity.amount) {
                  logEvent("error", "webhook_amount_mismatch", { order_id: order.id });
                  break;
                }
              }
              await markOrderPaid(supabaseAdmin, {
                orderId: order.id,
                razorpayPaymentId: paymentEntity?.id ?? "",
                razorpayOrderId: razorpayOrderId!,
                method: paymentEntity?.method ?? null,
                signatureVerified: true,
              });
              break;
            }
            case "payment.failed": {
              await releaseOrderInventory(supabaseAdmin, order.id, "FAILED");
              await supabaseAdmin.from("notifications").insert({
                type: "payment_failed",
                recipient: "",
                order_id: order.id,
                subject: "Payment failed",
                status: "QUEUED",
              });
              break;
            }
            case "refund.created":
            case "refund.processed": {
              await supabaseAdmin
                .from("orders")
                .update({ payment_status: "REFUNDED", status: "REFUNDED" })
                .eq("id", order.id);
              await supabaseAdmin
                .from("payments")
                .update({ status: "REFUNDED" })
                .eq("order_id", order.id);
              break;
            }
            default:
              break;
          }
        }

        await supabaseAdmin
          .from("payment_events")
          .update({ processed: true, order_id: order?.id ?? null })
          .eq("event_id", deliveryId);

        logEvent("info", "webhook_processed", { event: body.event, order_id: order?.id });
        return new Response(JSON.stringify({ success: true, data: { received: true } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
  },
});
