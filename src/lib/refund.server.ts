import { logEvent } from "@/lib/api-response";
import { createRazorpayRefund } from "@/lib/razorpay.server";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = any;

type RefundInput = {
  orderId: string;
  amount: number;
  reason?: string | null;
  idempotencyKey: string;
};

export async function createRefund(admin: Admin, input: RefundInput) {
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    return { ok: false as const, error: "INVALID_REFUND_AMOUNT" };
  }
  if (!/^[a-zA-Z0-9._:-]{8,120}$/.test(input.idempotencyKey)) {
    return { ok: false as const, error: "INVALID_IDEMPOTENCY_KEY" };
  }

  const { data: payment, error: paymentError } = await admin
    .from("payments")
    .select("id, order_id, razorpay_payment_id, amount, refunded_amount, status")
    .eq("order_id", input.orderId)
    .in("status", ["PAID", "PARTIALLY_REFUNDED"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (paymentError) return { ok: false as const, error: "PAYMENT_LOOKUP_FAILED" };
  if (!payment?.razorpay_payment_id) return { ok: false as const, error: "PAYMENT_NOT_REFUNDABLE" };

  const { data: prepared, error: prepareError } = await admin.rpc("prepare_refund", {
    _payment_id: payment.id,
    _amount: input.amount,
    _idempotency_key: input.idempotencyKey,
    _reason: input.reason?.slice(0, 500) ?? null,
  });
  if (prepareError || !prepared) {
    logEvent("error", "refund_prepare_failed", { order_id: input.orderId });
    return { ok: false as const, error: prepareError?.message ?? "REFUND_PREPARE_FAILED" };
  }
  if (prepared.duplicate) return { ok: true as const, duplicate: true as const, refund: prepared };

  let provider: Awaited<ReturnType<typeof createRazorpayRefund>>;
  try {
    provider = await createRazorpayRefund({
      paymentId: payment.razorpay_payment_id,
      amountPaise: Math.round(Number(prepared.amount) * 100),
      notes: { order_id: input.orderId, refund_id: prepared.refund_id },
    });
  } catch {
    logEvent("error", "razorpay_refund_unavailable", { order_id: input.orderId });
    return { ok: false as const, error: "RAZORPAY_REFUND_UNAVAILABLE" };
  }
  if ("error" in provider) {
    await admin.rpc("fail_refund", {
      _refund_id: prepared.refund_id,
      _reason: provider.error,
    });
    logEvent("error", "razorpay_refund_failed", { order_id: input.orderId });
    return { ok: false as const, error: provider.error };
  }

  const { data: completed, error: completeError } = await admin.rpc("complete_refund", {
    _refund_id: prepared.refund_id,
    _provider_refund_id: provider.id,
    _provider_status: provider.status ?? "created",
  });
  if (completeError || !completed) {
    logEvent("error", "refund_completion_failed", { order_id: input.orderId });
    return { ok: false as const, error: "REFUND_COMPLETION_FAILED" };
  }
  logEvent("info", "refund_created", { order_id: input.orderId, refund_id: prepared.refund_id });
  return { ok: true as const, duplicate: false as const, refund: completed };
}
