import { logEvent } from "@/lib/api-response";
import { fetchRazorpayPayment } from "@/lib/razorpay.server";
import { markOrderPaid } from "@/lib/order-fulfilment.server";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = any;

export async function getPaymentReconciliationReport(admin: Admin) {
  const [pending, incomplete, events, payments, processedEvents] = await Promise.all([
    admin
      .from("payments")
      .select("id, order_id, razorpay_payment_id, amount, status, created_at")
      .in("status", ["PENDING", "AUTHORIZED"]),
    admin
      .from("orders")
      .select(
        "id, order_number, razorpay_order_id, payment_status, inventory_finalized, grand_total",
      )
      .eq("payment_status", "PAID")
      .eq("inventory_finalized", false),
    admin
      .from("payment_events")
      .select("id, event_id, event_type, order_id, processed, created_at")
      .eq("processed", false),
    admin
      .from("payments")
      .select("id, order_id, razorpay_payment_id, status, amount, refunded_amount"),
    admin
      .from("payment_events")
      .select("order_id, event_type")
      .eq("processed", true)
      .in("event_type", ["payment.captured", "order.paid"]),
  ]);
  const errors = [
    pending.error,
    incomplete.error,
    events.error,
    payments.error,
    processedEvents.error,
  ].filter(Boolean);
  if (errors.length) return { ok: false as const, error: "RECONCILIATION_LOOKUP_FAILED" };

  const paymentIds = new Map<string, number>();
  for (const payment of payments.data ?? []) {
    if (!payment.razorpay_payment_id) continue;
    paymentIds.set(
      payment.razorpay_payment_id,
      (paymentIds.get(payment.razorpay_payment_id) ?? 0) + 1,
    );
  }
  return {
    ok: true as const,
    pending_payments: pending.data ?? [],
    paid_inventory_incomplete: incomplete.data ?? [],
    unprocessed_events: events.data ?? [],
    paid_without_processed_event: (payments.data ?? []).filter(
      (payment: { status: string; order_id: string }) =>
        payment.status === "PAID" &&
        !(processedEvents.data ?? []).some(
          (event: { order_id: string | null }) => event.order_id === payment.order_id,
        ),
    ),
    duplicate_provider_payment_ids: [...paymentIds.entries()]
      .filter(([, count]) => count > 1)
      .map(([razorpay_payment_id, count]) => ({ razorpay_payment_id, count })),
  };
}

export async function reconcilePayment(admin: Admin, paymentId: string) {
  const { data: payment, error } = await admin
    .from("payments")
    .select("id, order_id, razorpay_payment_id, amount")
    .eq("id", paymentId)
    .maybeSingle();
  if (error) return { ok: false as const, error: "PAYMENT_LOOKUP_FAILED" };
  if (!payment?.razorpay_payment_id)
    return { ok: false as const, error: "PAYMENT_PROVIDER_ID_MISSING" };

  let provider: Awaited<ReturnType<typeof fetchRazorpayPayment>>;
  try {
    provider = await fetchRazorpayPayment(payment.razorpay_payment_id);
  } catch {
    logEvent("error", "reconciliation_provider_unavailable", { payment_id: payment.id });
    return { ok: false as const, error: "RAZORPAY_LOOKUP_FAILED" };
  }
  if (!provider) return { ok: false as const, error: "RAZORPAY_LOOKUP_FAILED" };
  if (provider.amount !== Math.round(Number(payment.amount) * 100)) {
    logEvent("error", "reconciliation_amount_mismatch", { payment_id: payment.id });
    return { ok: false as const, error: "PAYMENT_AMOUNT_MISMATCH" };
  }
  if (!["captured", "authorized"].includes(provider.status)) {
    return { ok: true as const, changed: false as const, provider_status: provider.status };
  }
  const result = await markOrderPaid(admin, {
    orderId: payment.order_id,
    razorpayPaymentId: provider.id,
    razorpayOrderId: provider.order_id,
    method: provider.method ?? null,
    signatureVerified: true,
  });
  return result.ok
    ? { ok: true as const, changed: !result.duplicate, provider_status: provider.status }
    : { ok: false as const, error: result.reason };
}
