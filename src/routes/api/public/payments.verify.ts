import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { ok, fail, preflight, logEvent } from "@/lib/api-response";
import { verifyPaymentSignature, fetchRazorpayPayment } from "@/lib/razorpay.server";
import { markOrderPaid } from "@/lib/order-fulfilment.server";

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
        const payment = await fetchRazorpayPayment(body.razorpay_payment_id);
        if (!payment || payment.order_id !== body.razorpay_order_id) {
          return fail("PAYMENT_UNVERIFIED", "We could not verify this payment.", 400);
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data: order } = await supabaseAdmin
          .from("orders")
          .select("id, order_number, grand_total, payment_status")
          .eq("razorpay_order_id", body.razorpay_order_id)
          .maybeSingle();
        if (!order) return fail("NOT_FOUND", "Order not found.", 404);

        if (Math.round(Number(order.grand_total) * 100) !== payment.amount) {
          logEvent("error", "payment_amount_mismatch", { order_id: order.id });
          return fail("AMOUNT_MISMATCH", "Payment amount did not match the order.", 409);
        }

        if (!["captured", "authorized"].includes(payment.status)) {
          return fail("PAYMENT_NOT_CAPTURED", "This payment has not completed.", 409);
        }

        const result = await markOrderPaid(supabaseAdmin, {
          orderId: order.id,
          razorpayPaymentId: payment.id,
          razorpayOrderId: payment.order_id,
          method: payment.method ?? null,
          signatureVerified: true,
        });

        if (!result.ok) return fail("ORDER_FAILED", "Order could not be confirmed.", 500);
        return ok({ order_number: order.order_number, status: "PAID", duplicate: result.duplicate });
      },
    },
  },
});
