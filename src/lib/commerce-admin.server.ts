/**
 * Server-only admin operations for payments, shipping and commerce metrics.
 * Imported exclusively by commerce-admin.functions.ts. Secrets are only ever
 * read here and never returned to a client — only booleans and safe metadata.
 */
import { getRazorpayConfig } from "@/lib/razorpay.server";
import { getShiprocketConfig, getToken, checkServiceability } from "@/lib/shiprocket.server";
import {
  createShipmentForOrder,
  syncShipmentTracking,
  cancelOrderShipment,
} from "@/lib/shipment.server";
import { requireStaff, requirePermission, recordActivity } from "@/lib/staff.server";
import { createRefund } from "@/lib/refund.server";
import {
  getPaymentReconciliationReport,
  reconcilePayment,
} from "@/lib/payment-reconciliation.server";
import { cancelOrder } from "@/lib/order-cancellation.server";
import { reconcileShipment } from "@/lib/shipment-reconciliation.server";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = { supabase: any; userId: string };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

async function admin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

/** Live, credential-free health report for both providers. */
export async function getIntegrationStatus(ctx: Ctx) {
  await requireStaff(ctx);

  const rzpConfig = getRazorpayConfig();
  let razorpay: { configured: boolean; reachable: boolean; detail: string } = {
    configured: Boolean(rzpConfig),
    reachable: false,
    detail: rzpConfig ? "" : "Missing RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET",
  };
  if (rzpConfig) {
    try {
      const auth = btoa(`${rzpConfig.keyId}:${rzpConfig.keySecret}`);
      const res = await fetch("https://api.razorpay.com/v1/payments?count=1", {
        headers: { authorization: `Basic ${auth}` },
      });
      razorpay = {
        configured: true,
        reachable: res.ok,
        detail: res.ok ? "Authenticated with Razorpay API" : `Razorpay responded ${res.status}`,
      };
    } catch {
      razorpay = { configured: true, reachable: false, detail: "Razorpay API unreachable" };
    }
  }

  const srConfig = getShiprocketConfig();
  let shiprocket: {
    configured: boolean;
    reachable: boolean;
    detail: string;
    pickup_location: string | null;
    pickup_pincode: string | null;
    webhook_secret_set?: boolean;
  } = {
    configured: Boolean(srConfig),
    reachable: false,
    detail: srConfig ? "" : "Missing SHIPROCKET_EMAIL / SHIPROCKET_PASSWORD",
    pickup_location: srConfig?.pickupLocation ?? null,
    pickup_pincode: srConfig?.pickupPincode ?? null,
  };
  if (srConfig) {
    const token = await getToken(await admin());
    shiprocket = {
      ...shiprocket,
      reachable: !("error" in token),
      detail: "error" in token ? token.error : "Authenticated with Shiprocket API",
    };
  }

  return {
    razorpay: {
      ...razorpay,
      webhook_secret_set: Boolean(process.env["RAZORPAY_WEBHOOK_SECRET"]),
    },
    shiprocket,
  };
}

/** Serviceability + live courier rates for a pincode (admin view). */
export async function adminServiceability(
  ctx: Ctx,
  input: { pincode: string; weightKg?: number; declaredValue?: number },
) {
  await requireStaff(ctx);
  return checkServiceability(await admin(), {
    deliveryPincode: input.pincode,
    weightKg: input.weightKg ?? 0.5,
    cod: false,
    declaredValue: input.declaredValue ?? 1000,
  });
}

export async function adminCreateShipment(ctx: Ctx, orderId: string, courierId?: string | null) {
  await requirePermission(ctx, "orders.fulfill");
  const res = await createShipmentForOrder(await admin(), orderId, courierId ?? null);
  await recordActivity(ctx, {
    action: res.ok ? "SHIPMENT_CREATED" : "SHIPMENT_CREATE_FAILED",
    entityType: "order",
    entityId: orderId,
    metadata: res.ok ? {} : { error: (res as Json).error },
  });
  return res;
}

export async function adminSyncTracking(ctx: Ctx, orderId: string) {
  await requireStaff(ctx);
  return syncShipmentTracking(await admin(), orderId);
}

export async function adminCancelShipment(ctx: Ctx, orderId: string) {
  await requirePermission(ctx, "orders.fulfill");
  const res = await cancelOrderShipment(await admin(), orderId);
  await recordActivity(ctx, {
    action: res.ok ? "SHIPMENT_CANCELLED" : "SHIPMENT_CANCEL_FAILED",
    entityType: "order",
    entityId: orderId,
  });
  return res;
}

export async function adminReconcileShipment(ctx: Ctx, shipmentId: string, apply = false) {
  await requirePermission(ctx, apply ? "shipping.edit" : "shipping.view");
  const result = await reconcileShipment(await admin(), shipmentId, apply);
  await recordActivity(ctx, {
    action: result.ok ? "SHIPMENT_RECONCILED" : "SHIPMENT_RECONCILIATION_FAILED",
    entityType: "shipment",
    entityId: shipmentId,
    metadata: { applied: apply, error: result.ok ? undefined : result.error },
  });
  return result;
}

export async function adminModerateReview(
  ctx: Ctx,
  reviewId: string,
  status: "PENDING" | "APPROVED" | "REJECTED",
) {
  await requireStaff(ctx);
  const db = await admin();
  const { data, error } = await db
    .from("reviews")
    .update({ status })
    .eq("id", reviewId)
    .select("id, product_id, user_id, status")
    .single();
  if (error || !data) return { ok: false as const, error: "REVIEW_MODERATION_FAILED" };
  await recordActivity(ctx, {
    action: "REVIEW_MODERATED",
    entityType: "review",
    entityId: reviewId,
    metadata: { status },
  });
  return { ok: true as const, review: data };
}

export async function adminCreateRefund(
  ctx: Ctx,
  input: { orderId: string; amount: number; reason?: string | null; idempotencyKey: string },
) {
  await requirePermission(ctx, "orders.refund");
  const result = await createRefund(await admin(), input);
  await recordActivity(ctx, {
    action: result.ok ? "REFUND_CREATED" : "REFUND_CREATE_FAILED",
    entityType: "order",
    entityId: input.orderId,
    metadata: { error: result.ok ? undefined : result.error },
  });
  return result;
}

export async function adminCancelOrder(ctx: Ctx, orderId: string, reason?: string | null) {
  await requirePermission(ctx, "orders.cancel");
  const result = await cancelOrder(await admin(), orderId, reason);
  await recordActivity(ctx, {
    action: result.ok ? "ORDER_CANCELLED" : "ORDER_CANCEL_FAILED",
    entityType: "order",
    entityId: orderId,
    metadata: { error: result.ok ? undefined : result.error },
  });
  return result;
}

export async function getReconciliationReport(ctx: Ctx) {
  await requirePermission(ctx, "orders.view");
  return getPaymentReconciliationReport(await admin());
}

export async function reconcilePaymentById(ctx: Ctx, paymentId: string) {
  await requirePermission(ctx, "orders.edit");
  const result = await reconcilePayment(await admin(), paymentId);
  await recordActivity(ctx, {
    action: result.ok ? "PAYMENT_RECONCILED" : "PAYMENT_RECONCILIATION_FAILED",
    entityType: "payment",
    entityId: paymentId,
    metadata: { error: result.ok ? undefined : result.error },
  });
  return result;
}

/** Full order detail: items, payments, shipment and event trail. */
export async function getOrderDetail(ctx: Ctx, orderId: string) {
  await requireStaff(ctx);
  const db = await admin();
  const { data: order } = await db.from("orders").select("*").eq("id", orderId).maybeSingle();
  if (!order) return null;
  const [items, payments, shipment, history, events] = await Promise.all([
    db.from("order_items").select("*").eq("order_id", orderId),
    db
      .from("payments")
      .select(
        "id, provider, razorpay_order_id, razorpay_payment_id, status, amount, method, error_description, created_at",
      )
      .eq("order_id", orderId),
    db.from("shipments").select("*").eq("order_id", orderId).maybeSingle(),
    db.from("order_status_history").select("*").eq("order_id", orderId).order("created_at"),
    db
      .from("shipment_events")
      .select("*")
      .eq("order_id", orderId)
      .order("occurred_at", { ascending: false }),
  ]);
  return {
    order,
    items: items.data ?? [],
    payments: payments.data ?? [],
    shipment: shipment.data ?? null,
    history: history.data ?? [],
    events: events.data ?? [],
  };
}

/** Commerce KPIs for the dashboard (today + lifecycle counts). */
export async function getCommerceMetrics(ctx: Ctx) {
  await requireStaff(ctx);
  const db = await admin();
  const start = new Date();
  start.setHours(0, 0, 0, 0);

  const [todayRows, allRows, lowStock] = await Promise.all([
    db.from("orders").select("grand_total, payment_status").gte("created_at", start.toISOString()),
    db.from("orders").select("status, payment_status, grand_total"),
    db.from("inventory").select("sku, available_quantity, low_stock_threshold"),
  ]);

  const today = (todayRows.data ?? []) as Json[];
  const all = (allRows.data ?? []) as Json[];
  const count = (s: string) => all.filter((o) => o.status === s).length;

  return {
    today_orders: today.length,
    today_revenue: today
      .filter((o) => o.payment_status === "PAID")
      .reduce((s, o) => s + Number(o.grand_total ?? 0), 0),
    pending_payments: all.filter((o) => o.payment_status === "PENDING").length,
    paid: all.filter((o) => o.payment_status === "PAID").length,
    processing: count("PROCESSING") + count("CONFIRMED") + count("PACKED"),
    shipped:
      count("SHIPPED") +
      count("SHIPMENT_CREATED") +
      count("AWB_ASSIGNED") +
      count("PICKUP_SCHEDULED") +
      count("OUT_FOR_DELIVERY"),
    delivered: count("DELIVERED"),
    cancelled: count("CANCELLED"),
    returns_rto:
      count("RTO_INITIATED") +
      count("RTO_DELIVERED") +
      count("RETURNED") +
      count("RETURN_REQUESTED"),
    low_stock: ((lowStock.data ?? []) as Json[]).filter(
      (i) => Number(i.available_quantity) <= Number(i.low_stock_threshold ?? 0),
    ).length,
  };
}
