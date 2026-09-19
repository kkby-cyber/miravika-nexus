import { auditCommerceMutation } from "@/lib/commerce-audit.server";
import { releaseOrderInventory } from "@/lib/order-fulfilment.server";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = any;

export async function cancelOrder(admin: Admin, orderId: string, reason?: string | null) {
  const { data: order, error } = await admin
    .from("orders")
    .select("id, status, payment_status, inventory_finalized, razorpay_payment_id")
    .eq("id", orderId)
    .maybeSingle();
  if (error) return { ok: false as const, error: "ORDER_LOOKUP_FAILED" };
  if (!order) return { ok: false as const, error: "ORDER_NOT_FOUND" };
  if (["CANCELLED", "REFUNDED", "RETURNED"].includes(order.status)) {
    return { ok: true as const, duplicate: true as const };
  }
  if (["SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED", "RTO_INITIATED"].includes(order.status)) {
    return { ok: false as const, error: "ORDER_ALREADY_FULFILLED" };
  }
  if (order.payment_status === "PAID") {
    const { error: updateError } = await admin
      .from("orders")
      .update({ status: "REFUND_REQUESTED", notes: reason?.slice(0, 500) ?? null })
      .eq("id", orderId)
      .in("status", ["PAID", "PROCESSING", "PACKED", "CONFIRMED"]);
    if (updateError) return { ok: false as const, error: "ORDER_UPDATE_FAILED" };
    await auditCommerceMutation(admin, {
      action: "ORDER_CANCELLATION_REFUND_REQUESTED",
      entityType: "order",
      entityId: orderId,
      metadata: { reason: reason?.slice(0, 200) ?? null },
    });
    return { ok: true as const, refundRequired: true as const };
  }

  const released = await releaseOrderInventory(admin, orderId, "CANCELLED");
  if (released && !released.ok) return { ok: false as const, error: released.error };
  const { error: updateError } = await admin
    .from("orders")
    .update({
      status: "CANCELLED",
      payment_status: "CANCELLED",
      cancelled_at: new Date().toISOString(),
      notes: reason?.slice(0, 500) ?? null,
    })
    .eq("id", orderId);
  if (updateError) return { ok: false as const, error: "ORDER_UPDATE_FAILED" };
  const { error: paymentError } = await admin
    .from("payments")
    .update({ status: "CANCELLED" })
    .eq("order_id", orderId)
    .in("status", ["PENDING", "AUTHORIZED"]);
  if (paymentError) return { ok: false as const, error: "PAYMENT_UPDATE_FAILED" };
  await auditCommerceMutation(admin, {
    action: "ORDER_CANCELLED",
    entityType: "order",
    entityId: orderId,
    metadata: { reason: reason?.slice(0, 200) ?? null },
  });
  return { ok: true as const, refundRequired: false as const };
}
