import { logEvent } from "@/lib/api-response";
import { auditCommerceMutation } from "@/lib/commerce-audit.server";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = any;

export async function clearLinkedOrderCart(admin: Admin, orderId: string) {
  try {
    const { data, error } = await admin.rpc("clear_order_cart", { _order_id: orderId });
    if (error || !data?.ok) {
      const reason = error?.message ?? data?.error ?? "CART_CLEAR_FAILED";
      logEvent("error", "post_payment_cart_cleanup_failed", { order_id: orderId, reason });
      const { error: markerError } = await admin
        .from("orders")
        .update({ cart_cleanup_status: "FAILED", cart_cleanup_last_error: reason.slice(0, 500) })
        .eq("id", orderId);
      if (markerError)
        logEvent("error", "post_payment_cart_cleanup_marker_failed", { order_id: orderId });
      return { ok: false as const, error: reason };
    }
    return { ok: true as const, duplicate: Boolean(data.duplicate) };
  } catch (error) {
    const reason = String(error).slice(0, 500);
    logEvent("error", "post_payment_cart_cleanup_failed", { order_id: orderId, reason });
    return { ok: false as const, error: reason };
  }
}

/**
 * Idempotently marks an order PAID. The database RPC owns payment/inventory
 * identity; this function retries every post-payment side effect on duplicates.
 */
export async function markOrderPaid(
  supabaseAdmin: Admin,
  input: {
    orderId: string;
    razorpayPaymentId: string;
    razorpayOrderId: string;
    providerAmountPaise: number;
    currency: string;
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

  if (!input.razorpayPaymentId || !input.razorpayOrderId)
    return { ok: false, reason: "PAYMENT_REFERENCE_REQUIRED" as const };
  if (!order.razorpay_order_id || order.razorpay_order_id !== input.razorpayOrderId)
    return { ok: false, reason: "PROVIDER_ORDER_MISMATCH" as const };
  if (order.razorpay_payment_id && order.razorpay_payment_id !== input.razorpayPaymentId)
    return { ok: false, reason: "PAYMENT_ID_MISMATCH" as const };
  if (
    !Number.isInteger(input.providerAmountPaise) ||
    input.providerAmountPaise !== Math.round(Number(order.grand_total) * 100)
  )
    return { ok: false, reason: "PAYMENT_AMOUNT_MISMATCH" as const };
  if (input.currency !== order.currency)
    return { ok: false, reason: "PAYMENT_CURRENCY_MISMATCH" as const };

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
    const providerError = confirmationError?.message ?? "";
    logEvent("error", "payment_confirmation_failed", {
      order_id: order.id,
      reason: providerError.includes("PAYMENT_ID_MISMATCH")
        ? "PAYMENT_ID_MISMATCH"
        : "PAYMENT_CONFIRMATION_FAILED",
    });
    return {
      ok: false,
      reason: providerError.includes("PAYMENT_ID_MISMATCH")
        ? ("PAYMENT_ID_MISMATCH" as const)
        : ("PAYMENT_CONFIRMATION_FAILED" as const),
    };
  }

  const duplicate = Boolean(confirmation.duplicate);
  if (!duplicate) {
    await auditCommerceMutation(supabaseAdmin, {
      action: "PAYMENT_CAPTURED",
      entityType: "order",
      entityId: order.id,
      metadata: { razorpay_payment_id: input.razorpayPaymentId, amount: order.grand_total },
    });
  }

  // This is deliberately attempted even when the payment was already recorded.
  // A previous invocation may have committed payment but failed before a side
  // effect, and the order row is the durable retry record.
  const cartCleanup = await clearLinkedOrderCart(supabaseAdmin, order.id);

  const { error: analyticsError } = await supabaseAdmin.from("analytics_events").upsert(
    {
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
    },
    { onConflict: "dedupe_key" },
  );
  if (analyticsError && analyticsError.code !== "23505") {
    logEvent("error", "purchase_analytics_failed", { order_id: order.id });
  } else {
    const { error } = await supabaseAdmin
      .from("orders")
      .update({ purchase_event_sent: true })
      .eq("id", order.id);
    if (error) logEvent("error", "purchase_analytics_marker_failed", { order_id: order.id });
  }

  const { error: notificationError } = await supabaseAdmin.from("notifications").upsert(
    {
      type: "order_confirmation",
      recipient: order.email,
      order_id: order.id,
      subject: `MIRAVIKA order ${order.order_number} confirmed`,
      status: "QUEUED",
      dedupe_key: `order-confirmation:${order.id}`,
      payload: { order_number: order.order_number, total: order.grand_total },
    },
    { onConflict: "dedupe_key" },
  );
  if (notificationError && notificationError.code !== "23505")
    logEvent("error", "order_notification_queue_failed", { order_id: order.id });

  if (order.coupon_code) {
    const { error: couponError } = await supabaseAdmin.rpc("redeem_order_coupon", {
      _order_id: order.id,
    });
    if (couponError) logEvent("error", "coupon_redemption_failed", { order_id: order.id });
  }

  logEvent("info", "order_paid", { order_id: order.id, duplicate });
  return { ok: true, duplicate, cartCleanupPending: !cartCleanup.ok };
}

/** Explicit staff retry path for a paid order whose exact cart cleanup failed. */
export async function retryOrderCartCleanup(admin: Admin, orderId: string) {
  return clearLinkedOrderCart(admin, orderId);
}

/** Releases reservations for an order that will never be paid. */
export async function releaseOrderInventory(
  supabaseAdmin: Admin,
  orderId: string,
  nextPaymentStatus: "FAILED" | "CANCELLED",
) {
  const { data, error } = await supabaseAdmin.rpc("release_order_inventory", {
    _order_id: orderId,
    _next_payment_status: nextPaymentStatus,
  });
  if (error || !data?.ok) {
    logEvent("error", "order_inventory_release_failed", {
      order_id: orderId,
      reason: error?.message ?? data?.error ?? "INVENTORY_RELEASE_FAILED",
    });
    return {
      ok: false as const,
      error: data?.error ?? error?.message ?? "INVENTORY_RELEASE_FAILED",
    };
  }
  if (data.duplicate) return { ok: true as const, duplicate: true as const };

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
  const { data: order, error: orderError } = await supabaseAdmin
    .from("orders")
    .select("id, payment_status, inventory_finalized")
    .eq("id", orderId)
    .maybeSingle();
  if (orderError) return { ok: false as const, error: "ORDER_LOOKUP_FAILED" };
  if (!order) return { ok: false as const, error: "ORDER_NOT_FOUND" };
  if (order.inventory_finalized || order.payment_status === "PAID")
    return { ok: true as const, duplicate: true as const };

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
  if (!audit) return { ok: false as const, error: "AUDIT_WRITE_FAILED" };
  return { ok: true as const, duplicate: false as const };
}
