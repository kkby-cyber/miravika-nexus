import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { ok, fail, preflight, logEvent } from "@/lib/api-response";
import { verifyPaymentSignature, fetchRazorpayPayment } from "@/lib/razorpay.server";
import { markOrderPaid } from "@/lib/order-fulfilment.server";
import { enforceRateLimit } from "@/lib/rate-limit.server";
import { isCapturedPaymentStatus, paymentMatchesOrder } from "@/lib/payment-state";

const schema = z.object({
  razorpay_order_id: z.string().min(4).max(80),
  razorpay_payment_id: z.string().min(4).max(80),
  razorpay_signature: z.string().min(8).max(200),
});

export const Route = createFileRoute("/api/public/payments/verify")({
  server: {
    handlers: {
      OPTIONS: async () => preflight(),
      POST: async ({ request }) => {
        const rateLimit = await enforceRateLimit(request, "payment-verification", 20);
        if (rateLimit.error)
          return fail(
            "RATE_LIMIT_UNAVAILABLE",
            "Payment verification is temporarily unavailable.",
            503,
          );
        if (!rateLimit.allowed)
          return fail("RATE_LIMITED", "Too many payment verification attempts.", 429);
        let body;
        try {
          body = schema.parse(await request.json());
        } catch {
          return fail("INVALID_REQUEST", "Payment details are invalid.", 422);
        }

        const valid = await verifyPaymentSignature({
          razorpayOrderId: body.razorpay_order_id,
          razorpayPaymentId: body.razorpay_payment_id,
          signature: body.razorpay_signature,
        });
        if (!valid) {
          logEvent("error", "payment_signature_invalid", {});
          return fail("SIGNATURE_INVALID", "We could not verify this payment.", 400);
        }

        // Never trust the callback alone: confirm with Razorpay directly.
        let payment;
        try {
          payment = await fetchRazorpayPayment(body.razorpay_payment_id);
        } catch {
          return fail(
            "PAYMENT_PROVIDER_UNAVAILABLE",
            "Payment verification is temporarily unavailable.",
            503,
          );
        }
        if (!payment || payment.order_id !== body.razorpay_order_id) {
          return fail("PAYMENT_UNVERIFIED", "We could not verify this payment.", 400);
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data: order, error: orderError } = await supabaseAdmin
          .from("orders")
          .select("id, order_number, grand_total, currency, payment_status, razorpay_order_id")
          .eq("razorpay_order_id", body.razorpay_order_id)
          .maybeSingle();
        if (orderError) return fail("ORDER_UNAVAILABLE", "The order could not be verified.", 503);
        if (!order) return fail("NOT_FOUND", "Order not found.", 404);

        if (
          !paymentMatchesOrder({
            providerOrderId: payment.order_id,
            providerPaymentId: payment.id,
            amount: payment.amount,
            currency: payment.currency,
            expectedOrderId: order.razorpay_order_id ?? "",
            expectedPaymentId: body.razorpay_payment_id,
            expectedAmount: Math.round(Number(order.grand_total) * 100),
            expectedCurrency: order.currency,
          })
        ) {
          logEvent("error", "payment_identity_or_amount_mismatch", { order_id: order.id });
          return fail("AMOUNT_MISMATCH", "Payment amount did not match the order.", 409);
        }

        if (!isCapturedPaymentStatus(payment.status)) {
          return fail("PAYMENT_NOT_CAPTURED", "This payment has not completed.", 409);
        }

        const result = await markOrderPaid(supabaseAdmin, {
          orderId: order.id,
          razorpayPaymentId: payment.id,
          razorpayOrderId: payment.order_id,
          providerAmountPaise: payment.amount,
          currency: payment.currency,
          method: payment.method ?? null,
          signatureVerified: true,
        });

        if (!result.ok) return fail("ORDER_FAILED", "Order could not be confirmed.", 500);

        // Kick off fulfilment; failures are recorded on the order, not surfaced.
        try {
          const { createShipmentForOrder } = await import("@/lib/shipment.server");
          await createShipmentForOrder(supabaseAdmin, order.id);
        } catch {
          logEvent("error", "shipment_autocreate_failed", { order_id: order.id });
        }
        return ok({
          order_number: order.order_number,
          status: "PAID",
          duplicate: result.duplicate,
          cart_cleanup_pending: result.cartCleanupPending,
        });
      },
    },
  },
});
