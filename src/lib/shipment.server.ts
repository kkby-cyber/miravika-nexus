/**
 * Order → shipment orchestration. Idempotent: a second call for the same order
 * reuses the existing shipment row and never creates a duplicate Shiprocket
 * order. All statuses come from Shiprocket responses — never invented locally.
 */
import { logEvent } from "@/lib/api-response";
import {
  assignAwb,
  cancelShipment,
  createShiprocketOrder,
  generateLabel,
  requestPickup,
  trackByAwb,
  getShiprocketConfig,
  SHIPROCKET_NOT_CONFIGURED,
} from "@/lib/shiprocket.server";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/** Maps a Shiprocket status string onto the MIRAVIKA order lifecycle. */
export function mapShipmentStatusToOrder(status: string): string | null {
  const s = status.toUpperCase().replace(/\s+/g, "_");
  if (s.includes("DELIVERED") && s.startsWith("RTO")) return "RTO_DELIVERED";
  if (s.startsWith("RTO")) return "RTO_INITIATED";
  if (s.includes("CANCEL")) return "CANCELLED";
  if (s.includes("OUT_FOR_DELIVERY")) return "OUT_FOR_DELIVERY";
  if (s.includes("DELIVERED")) return "DELIVERED";
  if (s.includes("IN_TRANSIT") || s.includes("SHIPPED") || s.includes("PICKED")) return "SHIPPED";
  if (s.includes("PICKUP")) return "PICKUP_SCHEDULED";
  if (s.includes("AWB")) return "AWB_ASSIGNED";
  return null;
}

async function recordEvent(
  admin: Admin,
  input: { shipmentId: string; orderId: string; status: string; note?: string | null; raw?: Json },
) {
  await admin.from("shipment_events").insert({
    shipment_id: input.shipmentId,
    order_id: input.orderId,
    status: input.status,
    note: input.note ?? null,
    occurred_at: new Date().toISOString(),
    raw: input.raw ?? {},
  });
}

/**
 * Creates (or resumes) the shipment for a paid order: Shiprocket order → AWB →
 * pickup → label. Returns the current shipment row.
 */
export async function createShipmentForOrder(admin: Admin, orderId: string, courierId?: string | null) {
  if (!getShiprocketConfig()) {
    await admin
      .from("orders")
      .update({ shipping_status: "UNCONFIGURED", shipping_last_error: SHIPROCKET_NOT_CONFIGURED })
      .eq("id", orderId);
    return { ok: false as const, error: SHIPROCKET_NOT_CONFIGURED };
  }

  const { data: order } = await admin.from("orders").select("*").eq("id", orderId).maybeSingle();
  if (!order) return { ok: false as const, error: "ORDER_NOT_FOUND" };
  if (order.payment_status !== "PAID") return { ok: false as const, error: "ORDER_NOT_PAID" };

  const { data: items } = await admin
    .from("order_items")
    .select("sku, title, quantity, unit_price, product_id")
    .eq("order_id", orderId);
  if (!items?.length) return { ok: false as const, error: "ORDER_HAS_NO_ITEMS" };

  const productIds = [...new Set(items.map((i: Json) => i.product_id).filter(Boolean))];
  let products: Json[] = [];
  if (productIds.length) {
    const { data } = await admin
      .from("products")
      .select("id, weight_grams, length_cm, width_cm, height_cm, hsn_code")
      .in("id", productIds);
    products = data ?? [];
  }
  const productById = new Map(products.map((p) => [p.id, p]));

  const grams = items.reduce((sum: number, i: Json) => {
    const p = productById.get(i.product_id);
    return sum + (Number(p?.weight_grams ?? 300) * i.quantity);
  }, 0);
  const weightKg = Math.max(0.1, Math.round((grams / 1000) * 100) / 100);
  const dims = items
    .map((i: Json) => productById.get(i.product_id))
    .filter(Boolean)
    .reduce(
      (acc: { length: number; breadth: number; height: number }, p: Json) => ({
        length: Math.max(acc.length, Number(p.length_cm ?? 10)),
        breadth: Math.max(acc.breadth, Number(p.width_cm ?? 10)),
        height: Math.max(acc.height, Number(p.height_cm ?? 10)),
      }),
      { length: 10, breadth: 10, height: 10 },
    );

  // Idempotency: reuse an existing shipment row for this order.
  let { data: shipment } = await admin
    .from("shipments")
    .select("*")
    .eq("order_id", orderId)
    .maybeSingle();

  if (!shipment) {
    const { data: created } = await admin
      .from("shipments")
      .insert({ order_id: orderId, provider: "shiprocket", status: "CREATING", raw: {} })
      .select("*")
      .single();
    shipment = created;
  }
  if (!shipment) return { ok: false as const, error: "SHIPMENT_CREATE_FAILED" };

  const addr = (order.shipping_address ?? {}) as Json;

  if (!shipment.provider_shipment_id) {
    const res = await createShiprocketOrder(admin, {
      orderNumber: order.order_number,
      orderDate: new Date(order.paid_at ?? order.created_at).toISOString().slice(0, 16).replace("T", " "),
      billing: {
        name: order.full_name,
        address: String(addr.line1 ?? ""),
        address2: addr.line2 ?? "",
        city: String(addr.city ?? ""),
        state: String(addr.state ?? ""),
        pincode: String(addr.postal_code ?? ""),
        country: String(addr.country ?? "IN"),
        email: order.email,
        phone: order.phone,
      },
      items: items.map((i: Json) => ({
        name: i.title,
        sku: i.sku,
        units: i.quantity,
        sellingPrice: Number(i.unit_price),
        hsn: productById.get(i.product_id)?.hsn_code ?? "",
      })),
      subTotal: Number(order.grand_total),
      weightKg,
      dimensionsCm: dims,
      paymentMethod: "Prepaid",
    });

    if (!("ok" in res) || !res.ok) {
      const detail = "detail" in res ? (res.detail ?? null) : null;
      const error = "error" in res ? res.error : "SHIPROCKET_REQUEST_FAILED";
      await admin
        .from("shipments")
        .update({ status: "FAILED", last_error: detail ?? error })
        .eq("id", shipment.id);
      await admin
        .from("orders")
        .update({
          shipping_status: "FAILED",
          shipping_last_error: detail ?? error,
          shipping_attempts: (order.shipping_attempts ?? 0) + 1,
        })
        .eq("id", orderId);
      return { ok: false as const, error, detail };
    }

    const payload = res.data as Json;
    const { data: updated } = await admin
      .from("shipments")
      .update({
        provider_order_id: payload.order_id ? String(payload.order_id) : null,
        provider_shipment_id: payload.shipment_id ? String(payload.shipment_id) : null,
        status: "ORDER_CREATED",
        raw: payload,
        last_error: null,
      })
      .eq("id", shipment.id)
      .select("*")
      .single();
    shipment = updated ?? shipment;
    await recordEvent(admin, {
      shipmentId: shipment.id,
      orderId,
      status: "ORDER_CREATED",
      raw: payload,
    });
    await admin
      .from("orders")
      .update({ status: "SHIPMENT_CREATED", shipping_status: "CREATED", shipping_last_error: null })
      .eq("id", orderId);
  }

  // AWB assignment.
  if (shipment.provider_shipment_id && !shipment.awb_code) {
    const awbRes = await assignAwb(admin, shipment.provider_shipment_id, courierId ?? null);
    if (awbRes.ok) {
      const d = (awbRes.data as Json)?.response?.data ?? {};
      if (d.awb_code) {
        const { data: updated } = await admin
          .from("shipments")
          .update({
            awb_code: String(d.awb_code),
            courier_name: d.courier_name ?? null,
            courier_company_id: d.courier_company_id ? String(d.courier_company_id) : null,
            freight_charge: d.freight_charges ?? null,
            applied_weight: d.applied_weight ?? null,
            status: "AWB_ASSIGNED",
            tracking_url: `https://shiprocket.co/tracking/${d.awb_code}`,
          })
          .eq("id", shipment.id)
          .select("*")
          .single();
        shipment = updated ?? shipment;
        await recordEvent(admin, {
          shipmentId: shipment.id,
          orderId,
          status: "AWB_ASSIGNED",
          raw: d,
        });
        await admin
          .from("orders")
          .update({
            status: "AWB_ASSIGNED",
            tracking_number: String(d.awb_code),
            tracking_url: `https://shiprocket.co/tracking/${d.awb_code}`,
            shipping_status: "AWB_ASSIGNED",
          })
          .eq("id", orderId);
      }
    } else {
      await admin
        .from("shipments")
        .update({ last_error: awbRes.detail ?? awbRes.error })
        .eq("id", shipment.id);
    }
  }

  // Pickup + label (best effort; failures are recorded, not fatal).
  if (shipment.awb_code && !shipment.pickup_scheduled_date) {
    const pickup = await requestPickup(admin, shipment.provider_shipment_id!);
    if (pickup.ok) {
      const { data: updated } = await admin
        .from("shipments")
        .update({ pickup_scheduled_date: new Date().toISOString(), status: "PICKUP_SCHEDULED" })
        .eq("id", shipment.id)
        .select("*")
        .single();
      shipment = updated ?? shipment;
      await recordEvent(admin, {
        shipmentId: shipment.id,
        orderId,
        status: "PICKUP_SCHEDULED",
        raw: pickup.data as Json,
      });
      await admin
        .from("orders")
        .update({ status: "PICKUP_SCHEDULED", shipping_status: "PICKUP_SCHEDULED" })
        .eq("id", orderId);
    }
  }

  if (shipment.awb_code && !shipment.label_url) {
    const label = await generateLabel(admin, shipment.provider_shipment_id!);
    if (label.ok && (label.data as Json)?.label_url) {
      await admin
        .from("shipments")
        .update({ label_url: String((label.data as Json).label_url) })
        .eq("id", shipment.id);
    }
  }

  await admin.from("notifications").insert({
    type: "shipment_created",
    channel: "email",
    recipient: order.email,
    order_id: orderId,
    subject: `Your MIRAVIKA order ${order.order_number} is on its way`,
    status: "QUEUED",
    payload: { awb: shipment.awb_code, courier: shipment.courier_name },
  });

  logEvent("info", "shipment_ready", { order_id: orderId, shipment_id: shipment.id });
  const { data: finalRow } = await admin.from("shipments").select("*").eq("id", shipment.id).single();
  return { ok: true as const, shipment: finalRow ?? shipment };
}

/** Pulls the latest courier scan for an order and syncs local status. */
export async function syncShipmentTracking(admin: Admin, orderId: string) {
  const { data: shipment } = await admin
    .from("shipments")
    .select("*")
    .eq("order_id", orderId)
    .maybeSingle();
  if (!shipment?.awb_code) return { ok: false as const, error: "NO_AWB" };

  const res = await trackByAwb(admin, shipment.awb_code);
  if (!res.ok) return res;

  const data = res.data as Json;
  const track = data?.tracking_data ?? {};
  const status = String(track?.shipment_track?.[0]?.current_status ?? "");
  if (status) await applyShipmentStatus(admin, shipment, status, track);
  return { ok: true as const, status, tracking: track };
}

/** Applies an external status update to the shipment + order (idempotent). */
export async function applyShipmentStatus(
  admin: Admin,
  shipment: Json,
  status: string,
  raw: Json,
  occurredAt?: string,
) {
  const normalized = status.toUpperCase().replace(/\s+/g, "_");
  if (shipment.status === normalized) return;

  const patch: Json = { status: normalized, raw };
  const orderStatus = mapShipmentStatusToOrder(status);
  if (orderStatus === "SHIPPED" && !shipment.shipped_at) patch.shipped_at = new Date().toISOString();
  if (orderStatus === "DELIVERED" && !shipment.delivered_at)
    patch.delivered_at = new Date().toISOString();
  if (orderStatus === "CANCELLED" && !shipment.cancelled_at)
    patch.cancelled_at = new Date().toISOString();

  await admin.from("shipments").update(patch).eq("id", shipment.id);
  await recordEvent(admin, {
    shipmentId: shipment.id,
    orderId: shipment.order_id,
    status: normalized,
    raw,
  });
  if (occurredAt) {
    await admin
      .from("shipment_events")
      .update({ occurred_at: occurredAt })
      .eq("shipment_id", shipment.id)
      .eq("status", normalized);
  }

  if (orderStatus) {
    await admin
      .from("orders")
      .update({ status: orderStatus, shipping_status: normalized })
      .eq("id", shipment.order_id);

    const notifyFor: Record<string, string> = {
      SHIPPED: "order_shipped",
      OUT_FOR_DELIVERY: "out_for_delivery",
      DELIVERED: "order_delivered",
      RTO_INITIATED: "order_rto",
    };
    const type = notifyFor[orderStatus];
    if (type) {
      const { data: order } = await admin
        .from("orders")
        .select("email, order_number")
        .eq("id", shipment.order_id)
        .maybeSingle();
      if (order) {
        await admin.from("notifications").insert({
          type,
          channel: "email",
          recipient: order.email,
          order_id: shipment.order_id,
          subject: `MIRAVIKA order ${order.order_number} update`,
          status: "QUEUED",
          payload: { status: normalized, awb: shipment.awb_code },
        });
      }
    }
  }
}

/** Cancels the courier shipment for an order. */
export async function cancelOrderShipment(admin: Admin, orderId: string) {
  const { data: shipment } = await admin
    .from("shipments")
    .select("*")
    .eq("order_id", orderId)
    .maybeSingle();
  if (!shipment?.awb_code) return { ok: false as const, error: "NO_AWB" };
  const res = await cancelShipment(admin, shipment.awb_code);
  if (!res.ok) return res;
  await applyShipmentStatus(admin, shipment, "CANCELLED", res.data as Json);
  return { ok: true as const };
}
