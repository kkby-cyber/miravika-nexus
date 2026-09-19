import { logEvent } from "@/lib/api-response";
import { auditCommerceMutation } from "@/lib/commerce-audit.server";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = any;

/**
 * Idempotently marks an order PAID: finalises reserved inventory, records the
 * payment, queues notifications and creates exactly one purchase analytics
 * event. Safe to call again for a duplicate webhook.
 */
export async function markOrderPaid(
  supabaseAdmin: Admin,
  input: {
    orderId: string;
    razorpayPaymentId: string;
    razorpayOrderId: string;
    method?: string | null;
    signatureVerified: boolean;
  },
) {
  if (!input.signatureVerified) return { ok: false, reason: "SIGNATURE_NOT_VERIFIED" as const };

  const { data: order, error: orderError } = await supabaseAdmin
    .from("orders")
    .select("*")
    .eq("id", input.orderId)
    .maybeSingle();
  if (orderError) return { ok: false, reason: "ORDER_LOOKUP_FAILED" as const };
  if (!order) return { ok: false, reason: "ORDER_NOT_FOUND" as const };

  if (order.payment_status === "PAID" && order.inventory_finalized) {
    return { ok: true, duplicate: true as const };
  }

  const { data: items, error: itemsError } = await supabaseAdmin
    .from("order_items")
    .select("sku, quantity, title, unit_price, product_id")
    .eq("order_id", order.id);

  if (itemsError) return { ok: false, reason: "ORDER_ITEMS_LOOKUP_FAILED" as const };

  const { data: confirmation, error: confirmationError } = await supabaseAdmin.rpc(
    "confirm_order_paid",
    {
      _order_id: order.id,
      _razorpay_payment_id: input.razorpayPaymentId,
      _method: input.method ?? null,
    },
  );
  if (confirmationError || !confirmation?.ok) {
    logEvent("error", "payment_confirmation_failed", { order_id: order.id });
    return {
      ok: false,
      reason: confirmationError?.message ?? "PAYMENT_CONFIRMATION_FAILED",
    };
  }

  await auditCommerceMutation(supabaseAdmin, {
    action: "PAYMENT_CAPTURED",
    entityType: "order",
    entityId: order.id,
    metadata: { razorpay_payment_id: input.razorpayPaymentId, amount: order.grand_total },
  });

  // Purchase analytics event, deduplicated by order id.
  if (!order.purchase_event_sent) {
    const { error: analyticsError } = await supabaseAdmin.from("analytics_events").insert({
      event_name: "purchase",
      dedupe_key: `purchase:${order.id}`,
      order_id: order.id,
      user_id: order.user_id,
      value: order.grand_total,
      currency: order.currency,
      payload: {
        transaction_id: order.order_number,
        value: Number(order.grand_total),
        currency: order.currency,
        tax: Number(order.tax_total),
        shipping: Number(order.shipping_total),
        coupon: order.coupon_code,
        items: (items ?? []).map(
          (i: { sku: string; title: string; quantity: number; unit_price: number }) => ({
            item_id: i.sku,
            item_name: i.title,
            quantity: i.quantity,
            price: Number(i.unit_price),
          }),
        ),
      },
    });
    if (analyticsError) {
      logEvent("error", "purchase_analytics_failed", { order_id: order.id });
    } else {
      const { error } = await supabaseAdmin
        .from("orders")
        .update({ purchase_event_sent: true })
        .eq("id", order.id);
      if (error) logEvent("error", "purchase_analytics_marker_failed", { order_id: order.id });
    }
  }

  // Queue transactional emails (delivery handled by the configured provider).
  const { error: notificationError } = await supabaseAdmin.from("notifications").insert([
    {
      type: "order_confirmation",
      recipient: order.email,
      order_id: order.id,
      subject: `MIRAVIKA order ${order.order_number} confirmed`,
      status: "QUEUED",
      payload: { order_number: order.order_number, total: order.grand_total },
    },
  ]);
  if (notificationError)
    logEvent("error", "order_notification_queue_failed", { order_id: order.id });

  if (order.coupon_code) {
    const { data: coupon, error: couponLookupError } = await supabaseAdmin
      .from("coupons")
      .select("id, used_count")
      .eq("code", order.coupon_code)
      .maybeSingle();
    if (couponLookupError) logEvent("error", "coupon_lookup_failed", { order_id: order.id });
    if (coupon) {
      const { error: redemptionError } = await supabaseAdmin.from("coupon_redemptions").insert({
        coupon_id: coupon.id,
        user_id: order.user_id,
        order_id: order.id,
        amount: order.discount_total,
      });
      const { error: couponUpdateError } = await supabaseAdmin
        .from("coupons")
        .update({ used_count: coupon.used_count + 1 })
        .eq("id", coupon.id);
      if (redemptionError || couponUpdateError) {
        logEvent("error", "coupon_redemption_failed", { order_id: order.id, coupon_id: coupon.id });
      }
    }
  }

  logEvent("info", "order_paid", { order_id: order.id });
  return { ok: true, duplicate: Boolean(confirmation.duplicate) };
}

/** Releases reservations for an order that will never be paid. */
export async function releaseOrderInventory(
  supabaseAdmin: Admin,
  orderId: string,
  nextPaymentStatus: "FAILED" | "CANCELLED",
) {
  const { data: order, error: orderError } = await supabaseAdmin
    .from("orders")
    .select("id, status, payment_status, inventory_finalized")
    .eq("id", orderId)
    .maybeSingle();
  if (orderError) {
    logEvent("error", "order_inventory_release_lookup_failed", { order_id: orderId });
    return { ok: false as const, error: "ORDER_LOOKUP_FAILED" };
  }
  if (!order || order.inventory_finalized || order.payment_status === "PAID")
    return { ok: true as const, duplicate: true as const };

  const { data: items, error: itemsError } = await supabaseAdmin
    .from("order_items")
    .select("sku, quantity")
    .eq("order_id", orderId);

  if (itemsError) {
    logEvent("error", "order_inventory_release_items_failed", { order_id: orderId });
    return { ok: false as const, error: "ORDER_ITEMS_LOOKUP_FAILED" };
  }
  for (const item of items ?? []) {
    const { data: released, error } = await supabaseAdmin.rpc("release_inventory", {
      _sku: item.sku,
      _qty: item.quantity,
      _reference_id: orderId,
    });
    if (error || !released) {
      logEvent("error", "inventory_release_failed", { order_id: orderId, sku: item.sku });
      return { ok: false as const, error: "INVENTORY_RELEASE_FAILED" };
    }
  }

  const { error: updateError } = await supabaseAdmin
    .from("orders")
    .update({
      payment_status: nextPaymentStatus,
      status: nextPaymentStatus === "CANCELLED" ? "CANCELLED" : order.status,
      cancelled_at: nextPaymentStatus === "CANCELLED" ? new Date().toISOString() : null,
    })
    .eq("id", orderId);
  if (updateError) {
    logEvent("error", "order_inventory_release_update_failed", { order_id: orderId });
    return { ok: false as const, error: "ORDER_UPDATE_FAILED" };
  }

  await auditCommerceMutation(supabaseAdmin, {
    action: "INVENTORY_RELEASED",
    entityType: "order",
    entityId: orderId,
    metadata: { reason: nextPaymentStatus },
  });

  logEvent("info", "order_inventory_released", { order_id: orderId, reason: nextPaymentStatus });
  return { ok: true as const, duplicate: false as const };
}

export async function markOrderPaymentFailed(
  supabaseAdmin: Admin,
  orderId: string,
  reason?: string | null,
) {
  const { error } = await supabaseAdmin
    .from("payments")
    .update({
      status: "FAILED",
      failed_at: new Date().toISOString(),
      last_error: reason?.slice(0, 500) ?? null,
    })
    .eq("order_id", orderId)
    .in("status", ["PENDING", "AUTHORIZED"]);
  if (error) return { ok: false as const, error: "PAYMENT_UPDATE_FAILED" };
  const audit = await auditCommerceMutation(supabaseAdmin, {
    action: "PAYMENT_FAILED",
    entityType: "order",
    entityId: orderId,
    metadata: { reason: reason?.slice(0, 200) ?? null },
  });
  return { ok: audit, error: audit ? undefined : "AUDIT_WRITE_FAILED" };
}
