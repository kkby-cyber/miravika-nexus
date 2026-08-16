import { logEvent } from "@/lib/api-response";

type Admin = Awaited<
  ReturnType<typeof import("@/integrations/supabase/client.server").then>
> extends never
  ? never
  : // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any;

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
  const { data: order } = await supabaseAdmin
    .from("orders")
    .select("*")
    .eq("id", input.orderId)
    .maybeSingle();
  if (!order) return { ok: false, reason: "ORDER_NOT_FOUND" as const };

  if (order.payment_status === "PAID" && order.inventory_finalized) {
    return { ok: true, duplicate: true as const };
  }

  const { data: items } = await supabaseAdmin
    .from("order_items")
    .select("sku, quantity, title, unit_price, product_id")
    .eq("order_id", order.id);

  if (!order.inventory_finalized) {
    for (const item of items ?? []) {
      await supabaseAdmin.rpc("finalize_inventory", {
        _sku: item.sku,
        _qty: item.quantity,
        _reference_id: order.id,
      });
    }
  }

  await supabaseAdmin
    .from("orders")
    .update({
      status: order.status === "PENDING_PAYMENT" ? "PAID" : order.status,
      payment_status: "PAID",
      razorpay_payment_id: input.razorpayPaymentId,
      inventory_finalized: true,
      paid_at: order.paid_at ?? new Date().toISOString(),
    })
    .eq("id", order.id);

  const { data: existingPayment } = await supabaseAdmin
    .from("payments")
    .select("id")
    .eq("razorpay_payment_id", input.razorpayPaymentId)
    .maybeSingle();

  if (existingPayment) {
    await supabaseAdmin
      .from("payments")
      .update({
        status: "PAID",
        method: input.method ?? null,
        razorpay_signature_verified: input.signatureVerified,
      })
      .eq("id", existingPayment.id);
  } else {
    await supabaseAdmin
      .from("payments")
      .update({
        status: "PAID",
        razorpay_payment_id: input.razorpayPaymentId,
        method: input.method ?? null,
        razorpay_signature_verified: input.signatureVerified,
      })
      .eq("order_id", order.id)
      .eq("status", "PENDING");
  }

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
        items: (items ?? []).map((i: { sku: string; title: string; quantity: number; unit_price: number }) => ({
          item_id: i.sku,
          item_name: i.title,
          quantity: i.quantity,
          price: Number(i.unit_price),
        })),
      },
    });
    if (!analyticsError) {
      await supabaseAdmin.from("orders").update({ purchase_event_sent: true }).eq("id", order.id);
    }
  }

  // Queue transactional emails (delivery handled by the configured provider).
  await supabaseAdmin.from("notifications").insert([
    {
      type: "order_confirmation",
      recipient: order.email,
      order_id: order.id,
      subject: `MIRAVIKA order ${order.order_number} confirmed`,
      status: "QUEUED",
      payload: { order_number: order.order_number, total: order.grand_total },
    },
  ]);

  if (order.coupon_code) {
    const { data: coupon } = await supabaseAdmin
      .from("coupons")
      .select("id, used_count")
      .eq("code", order.coupon_code)
      .maybeSingle();
    if (coupon) {
      await supabaseAdmin
        .from("coupon_redemptions")
        .insert({
          coupon_id: coupon.id,
          user_id: order.user_id,
          order_id: order.id,
          amount: order.discount_total,
        });
      await supabaseAdmin
        .from("coupons")
        .update({ used_count: coupon.used_count + 1 })
        .eq("id", coupon.id);
    }
  }

  logEvent("info", "order_paid", { order_id: order.id });
  return { ok: true, duplicate: false as const };
}

/** Releases reservations for an order that will never be paid. */
export async function releaseOrderInventory(
  supabaseAdmin: Admin,
  orderId: string,
  nextPaymentStatus: "FAILED" | "CANCELLED",
) {
  const { data: order } = await supabaseAdmin
    .from("orders")
    .select("id, status, payment_status, inventory_finalized")
    .eq("id", orderId)
    .maybeSingle();
  if (!order || order.inventory_finalized || order.payment_status === "PAID") return;

  const { data: items } = await supabaseAdmin
    .from("order_items")
    .select("sku, quantity")
    .eq("order_id", orderId);

  for (const item of items ?? []) {
    await supabaseAdmin.rpc("release_inventory", {
      _sku: item.sku,
      _qty: item.quantity,
      _reference_id: orderId,
    });
  }

  await supabaseAdmin
    .from("orders")
    .update({
      payment_status: nextPaymentStatus,
      status: nextPaymentStatus === "CANCELLED" ? "CANCELLED" : order.status,
      cancelled_at: nextPaymentStatus === "CANCELLED" ? new Date().toISOString() : null,
    })
    .eq("id", orderId);

  logEvent("info", "order_inventory_released", { order_id: orderId, reason: nextPaymentStatus });
}
