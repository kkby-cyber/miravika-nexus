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
  checkServiceability,
} from "@/lib/shiprocket.server";
import { auditCommerceMutation } from "@/lib/commerce-audit.server";
import {
  acceptsShipmentTransition,
  mapShiprocketStatus,
  shipmentEventKey,
  type ShipmentState,
} from "@/lib/shipment-state";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/** Maps a Shiprocket status string onto the MIRAVIKA order lifecycle. */
export function mapShipmentStatusToOrder(status: string): string | null {
  const state = mapShiprocketStatus(status);
  if (state === "RTO_DELIVERED") return "RTO_DELIVERED";
  if (state === "RTO_INITIATED" || state === "RTO_IN_TRANSIT") return "RTO_INITIATED";
  if (state === "CANCELLED") return "CANCELLED";
  if (state === "OUT_FOR_DELIVERY") return "OUT_FOR_DELIVERY";
  if (state === "DELIVERED") return "DELIVERED";
  if (["IN_TRANSIT", "PICKED_UP"].includes(state ?? "")) return "SHIPPED";
  if (state === "PICKUP_SCHEDULED") return "PICKUP_SCHEDULED";
  if (state === "AWB_ASSIGNED") return "AWB_ASSIGNED";
  return null;
}

async function recordEvent(
  admin: Admin,
  input: {
    shipmentId: string;
    orderId: string;
    status: string;
    eventKey?: string;
    providerEventId?: string | null | undefined;
    providerStatus?: string | null;
    providerOccurredAt?: string | null | undefined;
    note?: string | null;
    raw?: Json;
  },
) {
  const { error } = await admin.from("shipment_events").insert({
    shipment_id: input.shipmentId,
    order_id: input.orderId,
    status: input.status,
    event_key: input.eventKey ?? `local:${input.shipmentId}:${input.status}:${Date.now()}`,
    provider_event_id: input.providerEventId ?? null,
    provider_status: input.providerStatus ?? null,
    provider_occurred_at: input.providerOccurredAt ?? null,
    note: input.note ?? null,
    occurred_at: new Date().toISOString(),
    raw: input.raw ?? {},
  });
  return error;
}

/**
 * Creates (or resumes) the shipment for a paid order: Shiprocket order → AWB →
 * pickup → label. Returns the current shipment row.
 */
export async function createShipmentForOrder(
  admin: Admin,
  orderId: string,
  courierId?: string | null,
) {
  if (!getShiprocketConfig()) {
    await admin
      .from("orders")
      .update({ shipping_status: "UNCONFIGURED", shipping_last_error: SHIPROCKET_NOT_CONFIGURED })
      .eq("id", orderId);
    return { ok: false as const, error: SHIPROCKET_NOT_CONFIGURED };
  }

  const { data: order, error: orderError } = await admin
    .from("orders")
    .select("*")
    .eq("id", orderId)
    .maybeSingle();
  if (orderError) return { ok: false as const, error: "ORDER_LOOKUP_FAILED" };
  if (!order) return { ok: false as const, error: "ORDER_NOT_FOUND" };
  if (order.payment_status !== "PAID") return { ok: false as const, error: "ORDER_NOT_PAID" };

  const addr = (order.shipping_address ?? {}) as Json;
  const requiredAddress = ["line1", "city", "state", "postal_code", "country"].every(
    (field) => String(addr[field] ?? "").trim().length > 0,
  );
  if (!requiredAddress || !/^\d{6}$/.test(String(addr.postal_code))) {
    await admin
      .from("orders")
      .update({ shipping_status: "FAILED", shipping_last_error: "INVALID_SHIPPING_ADDRESS" })
      .eq("id", orderId);
    return { ok: false as const, error: "INVALID_SHIPPING_ADDRESS" };
  }

  const { data: items, error: itemsError } = await admin
    .from("order_items")
    .select("sku, title, quantity, unit_price, product_id")
    .eq("order_id", orderId);
  if (itemsError) return { ok: false as const, error: "ORDER_ITEMS_LOOKUP_FAILED" };
  if (!items?.length) return { ok: false as const, error: "ORDER_HAS_NO_ITEMS" };

  const productIds = [...new Set(items.map((i: Json) => i.product_id).filter(Boolean))];
  let products: Json[] = [];
  if (productIds.length) {
    const { data, error } = await admin
      .from("products")
      .select("id, weight_grams, length_cm, width_cm, height_cm, hsn_code")
      .in("id", productIds);
    if (error) return { ok: false as const, error: "PRODUCT_LOOKUP_FAILED" };
    products = data ?? [];
  }
  const productById = new Map(products.map((p) => [p.id, p]));

  const grams = items.reduce((sum: number, i: Json) => {
    const p = productById.get(i.product_id);
    return sum + Number(p?.weight_grams ?? 300) * i.quantity;
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

  const serviceability = await checkServiceability(admin, {
    deliveryPincode: String(addr.postal_code),
    weightKg,
    cod: false,
    declaredValue: Number(order.grand_total),
  });
  if (!serviceability.ok)
    return { ok: false as const, error: "SHIPROCKET_SERVICEABILITY_UNAVAILABLE" };
  if (serviceability.couriers.length === 0)
    return { ok: false as const, error: "SHIPMENT_NOT_SERVICEABLE" };

  // Idempotency: reuse an existing shipment row for this order.
  let { data: shipment } = await admin
    .from("shipments")
    .select("*")
    .eq("order_id", orderId)
    .maybeSingle();

  if (!shipment) {
    const { data: created, error: createError } = await admin
      .from("shipments")
      .insert({ order_id: orderId, provider: "shiprocket", status: "CREATED", raw: {} })
      .select("*")
      .single();
    if (createError?.code === "23505") {
      const existing = await admin
        .from("shipments")
        .select("*")
        .eq("order_id", orderId)
        .maybeSingle();
      shipment = existing.data;
    } else if (createError) {
      return { ok: false as const, error: "SHIPMENT_CREATE_FAILED" };
    } else {
      shipment = created;
    }
  }
  if (!shipment) return { ok: false as const, error: "SHIPMENT_CREATE_FAILED" };

  if (!shipment.provider_shipment_id) {
    const res = await createShiprocketOrder(admin, {
      orderNumber: order.order_number,
      orderDate: new Date(order.paid_at ?? order.created_at)
        .toISOString()
        .slice(0, 16)
        .replace("T", " "),
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
    if (!payload.order_id || !payload.shipment_id) {
      await admin
        .from("shipments")
        .update({ status: "FAILED", last_error: "SHIPROCKET_ORDER_RESPONSE_INCOMPLETE" })
        .eq("id", shipment.id);
      return { ok: false as const, error: "SHIPROCKET_ORDER_RESPONSE_INCOMPLETE" };
    }
    const { data: updated } = await admin
      .from("shipments")
      .update({
        provider_order_id: payload.order_id ? String(payload.order_id) : null,
        provider_shipment_id: payload.shipment_id ? String(payload.shipment_id) : null,
        status: "READY_FOR_SHIPMENT",
        raw: payload,
        last_error: null,
      })
      .eq("id", shipment.id)
      .select("*")
      .single();
    if (!updated) return { ok: false as const, error: "SHIPMENT_UPDATE_FAILED" };
    shipment = updated;
    const eventError = await recordEvent(admin, {
      shipmentId: shipment.id,
      orderId,
      status: "READY_FOR_SHIPMENT",
      eventKey: `provider-order:${payload.order_id}`,
      raw: payload,
    });
    if (eventError) return { ok: false as const, error: "SHIPMENT_EVENT_PERSISTENCE_FAILED" };
    const { error: orderUpdateError } = await admin
      .from("orders")
      .update({
        status: "SHIPMENT_CREATED",
        shipping_status: "READY_FOR_SHIPMENT",
        shipping_last_error: null,
      })
      .eq("id", orderId);
    if (orderUpdateError) return { ok: false as const, error: "ORDER_SHIPPING_UPDATE_FAILED" };
    await auditCommerceMutation(admin, {
      action: "SHIPROCKET_ORDER_CREATED",
      entityType: "shipment",
      entityId: shipment.id,
      metadata: { provider_order_id: payload.order_id, provider_shipment_id: payload.shipment_id },
    });
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
        if (!updated) return { ok: false as const, error: "SHIPMENT_AWB_UPDATE_FAILED" };
        shipment = updated;
        const eventError = await recordEvent(admin, {
          shipmentId: shipment.id,
          orderId,
          status: "AWB_ASSIGNED",
          eventKey: `awb:${d.awb_code}`,
          raw: d,
        });
        if (eventError) return { ok: false as const, error: "SHIPMENT_EVENT_PERSISTENCE_FAILED" };
        const { error: orderUpdateError } = await admin
          .from("orders")
          .update({
            status: "AWB_ASSIGNED",
            tracking_number: String(d.awb_code),
            tracking_url: `https://shiprocket.co/tracking/${d.awb_code}`,
            shipping_status: "AWB_ASSIGNED",
          })
          .eq("id", orderId);
        if (orderUpdateError) return { ok: false as const, error: "ORDER_SHIPPING_UPDATE_FAILED" };
        await auditCommerceMutation(admin, {
          action: "SHIPMENT_AWB_ASSIGNED",
          entityType: "shipment",
          entityId: shipment.id,
          metadata: { awb: d.awb_code, courier: d.courier_name ?? null },
        });
      } else {
        await admin
          .from("shipments")
          .update({ status: "READY_FOR_SHIPMENT", last_error: "SHIPROCKET_AWB_MISSING" })
          .eq("id", shipment.id);
        return { ok: false as const, error: "SHIPROCKET_AWB_MISSING" };
      }
    } else {
      await admin
        .from("shipments")
        .update({ status: "READY_FOR_SHIPMENT", last_error: awbRes.detail ?? awbRes.error })
        .eq("id", shipment.id);
      return { ok: false as const, error: awbRes.error, detail: awbRes.detail };
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
      if (!updated) return { ok: false as const, error: "SHIPMENT_PICKUP_UPDATE_FAILED" };
      shipment = updated;
      const eventError = await recordEvent(admin, {
        shipmentId: shipment.id,
        orderId,
        status: "PICKUP_SCHEDULED",
        eventKey: `pickup:${shipment.id}:${shipment.pickup_scheduled_date}`,
        raw: pickup.data as Json,
      });
      if (eventError) return { ok: false as const, error: "SHIPMENT_EVENT_PERSISTENCE_FAILED" };
      const { error: orderUpdateError } = await admin
        .from("orders")
        .update({ status: "PICKUP_SCHEDULED", shipping_status: "PICKUP_SCHEDULED" })
        .eq("id", orderId);
      if (orderUpdateError) return { ok: false as const, error: "ORDER_SHIPPING_UPDATE_FAILED" };
    } else {
      await admin
        .from("shipments")
        .update({ last_error: pickup.detail ?? pickup.error })
        .eq("id", shipment.id);
      return { ok: false as const, error: pickup.error, detail: pickup.detail };
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

  await admin.from("notifications").upsert(
    {
      type: "shipment_created",
      channel: "email",
      recipient: order.email,
      order_id: orderId,
      subject: `Your MIRAVIKA order ${order.order_number} is on its way`,
      status: "QUEUED",
      dedupe_key: `shipment-created:${orderId}`,
      payload: { awb: shipment.awb_code, courier: shipment.courier_name },
    },
    { onConflict: "dedupe_key" },
  );

  logEvent("info", "shipment_ready", { order_id: orderId, shipment_id: shipment.id });
  const { data: finalRow } = await admin
    .from("shipments")
    .select("*")
    .eq("id", shipment.id)
    .single();
  return { ok: true as const, shipment: finalRow ?? shipment };
}

/** Pulls the latest courier scan for an order and syncs local status. */
export async function syncShipmentTracking(admin: Admin, orderId: string) {
  const { data: shipment, error: shipmentError } = await admin
    .from("shipments")
    .select("*")
    .eq("order_id", orderId)
    .maybeSingle();
  if (shipmentError) return { ok: false as const, error: "SHIPMENT_LOOKUP_FAILED" };
  if (!shipment?.awb_code) return { ok: false as const, error: "NO_AWB" };

  const res = await trackByAwb(admin, shipment.awb_code);
  if (!res.ok) return res;

  const data = res.data as Json;
  const track = data?.tracking_data ?? {};
  const status = String(track?.shipment_track?.[0]?.current_status ?? "");
  if (status) {
    const occurredAt = track?.shipment_track?.[0]?.scans?.[0]?.date ?? null;
    const result = await applyShipmentStatus(admin, shipment, status, track, occurredAt);
    if (!result.ok) return result;
  }
  await admin
    .from("shipments")
    .update({ provider_last_synced_at: new Date().toISOString() })
    .eq("id", shipment.id);
  return { ok: true as const, status, tracking: track };
}

/** Applies an external status update to the shipment + order (idempotent). */
export async function applyShipmentStatus(
  admin: Admin,
  shipment: Json,
  status: string,
  raw: Json,
  occurredAt?: string,
  eventKey?: string,
  providerEventId?: string | null,
) {
  const normalized = status.toUpperCase().replace(/\s+/g, "_");
  const canonical = mapShiprocketStatus(status);
  if (!canonical) {
    logEvent("info", "shiprocket_status_ignored", { status: normalized, shipment_id: shipment.id });
    return { ok: true as const, ignored: true as const };
  }
  const duplicateKey =
    eventKey ??
    shipmentEventKey({
      providerEventId,
      awb: String(shipment.awb_code ?? ""),
      status,
      occurredAt,
    });
  const { data: existingEvent, error: existingEventError } = await admin
    .from("shipment_events")
    .select("id")
    .eq("shipment_id", shipment.id)
    .eq("event_key", duplicateKey)
    .maybeSingle();
  if (existingEventError) return { ok: false as const, error: "SHIPMENT_EVENT_LOOKUP_FAILED" };
  if (existingEvent) return { ok: true as const, duplicate: true as const };
  if (
    !acceptsShipmentTransition(
      shipment.status,
      canonical,
      occurredAt,
      shipment.provider_status_at ?? null,
    )
  ) {
    const staleEventError = await recordEvent(admin, {
      shipmentId: shipment.id,
      orderId: shipment.order_id,
      status: canonical,
      eventKey: duplicateKey,
      providerEventId,
      providerStatus: status,
      providerOccurredAt: occurredAt,
      raw,
    });
    if (staleEventError?.code === "23505") return { ok: true as const, duplicate: true as const };
    if (staleEventError) return { ok: false as const, error: "SHIPMENT_EVENT_PERSISTENCE_FAILED" };
    logEvent("info", "shiprocket_status_regression_ignored", {
      shipment_id: shipment.id,
      current_status: shipment.status,
      incoming_status: canonical,
    });
    return { ok: true as const, regression: true as const };
  }

  const patch: Json = {
    status: canonical,
    provider_status: status,
    provider_event_id: providerEventId ?? null,
    provider_status_at: occurredAt ?? new Date().toISOString(),
    provider_last_synced_at: new Date().toISOString(),
    raw,
  };
  if (canonical === "PICKED_UP" || canonical === "IN_TRANSIT")
    patch.shipped_at = shipment.shipped_at ?? new Date().toISOString();
  if (canonical === "DELIVERED" && !shipment.delivered_at)
    patch.delivered_at = new Date().toISOString();
  if (canonical === "CANCELLED" && !shipment.cancelled_at)
    patch.cancelled_at = new Date().toISOString();
  if (canonical === "RTO_INITIATED" && !shipment.rto_initiated_at)
    patch.rto_initiated_at = new Date().toISOString();
  if (canonical === "RTO_DELIVERED" && !shipment.rto_delivered_at)
    patch.rto_delivered_at = new Date().toISOString();
  if (canonical === "NDR") {
    patch.ndr_attempt_count = Number(raw?.attempt_count ?? shipment.ndr_attempt_count ?? 0) + 1;
    patch.ndr_reason = String(raw?.ndr_reason ?? raw?.reason ?? "Unknown NDR reason").slice(0, 500);
    patch.ndr_last_at = occurredAt ?? new Date().toISOString();
  }
  if (
    canonical === "RTO_INITIATED" ||
    canonical === "RTO_IN_TRANSIT" ||
    canonical === "RTO_DELIVERED"
  )
    patch.rto_reason = String(raw?.rto_reason ?? raw?.reason ?? "").slice(0, 500) || null;

  const { error: shipmentError } = await admin
    .from("shipments")
    .update(patch)
    .eq("id", shipment.id);
  if (shipmentError) return { ok: false as const, error: "SHIPMENT_UPDATE_FAILED" };
  const eventError = await recordEvent(admin, {
    shipmentId: shipment.id,
    orderId: shipment.order_id,
    status: canonical,
    eventKey: duplicateKey,
    providerEventId,
    providerStatus: status,
    providerOccurredAt: occurredAt,
    raw,
  });
  if (eventError?.code === "23505") return { ok: true as const, duplicate: true as const };
  if (eventError) return { ok: false as const, error: "SHIPMENT_EVENT_PERSISTENCE_FAILED" };

  const orderStatus = mapShipmentStatusToOrder(canonical);
  if (orderStatus && canonical !== "RTO_DELIVERED")
    if (orderStatus === "DELIVERED" && canonical !== "DELIVERED") return { ok: true as const };
  if (orderStatus) {
    const { error: orderError } = await admin
      .from("orders")
      .update({ status: orderStatus, shipping_status: canonical })
      .eq("id", shipment.order_id);
    if (orderError) return { ok: false as const, error: "ORDER_SHIPPING_UPDATE_FAILED" };
  }

  if (canonical === "NDR") {
    const { error: ndrError } = await admin.from("shipment_ndr_events").upsert(
      {
        shipment_id: shipment.id,
        order_id: shipment.order_id,
        event_key: duplicateKey,
        provider_event_id: providerEventId ?? null,
        reason: patch.ndr_reason,
        attempt_number: patch.ndr_attempt_count,
        occurred_at: occurredAt ?? new Date().toISOString(),
        raw,
      },
      { onConflict: "shipment_id,event_key" },
    );
    if (ndrError) return { ok: false as const, error: "NDR_PERSISTENCE_FAILED" };
  }

  await auditCommerceMutation(admin, {
    action:
      canonical === "NDR"
        ? "SHIPMENT_NDR_CREATED"
        : canonical.startsWith("RTO")
          ? "SHIPMENT_RTO_STATUS_CHANGED"
          : "SHIPMENT_STATUS_CHANGED",
    entityType: "shipment",
    entityId: shipment.id,
    metadata: { provider_status: status, canonical_status: canonical, event_key: duplicateKey },
  });
  return { ok: true as const, status: canonical };
}

/** Cancels the courier shipment for an order. */
export async function cancelOrderShipment(admin: Admin, orderId: string) {
  const { data: shipment, error: shipmentError } = await admin
    .from("shipments")
    .select("*")
    .eq("order_id", orderId)
    .maybeSingle();
  if (shipmentError) return { ok: false as const, error: "SHIPMENT_LOOKUP_FAILED" };
  if (!shipment) return { ok: false as const, error: "SHIPMENT_NOT_FOUND" };
  if (["DELIVERED", "RTO_DELIVERED"].includes(shipment.status))
    return { ok: false as const, error: "SHIPMENT_ALREADY_TERMINAL" };
  if (!shipment.awb_code) {
    const { error } = await admin
      .from("shipments")
      .update({ status: "CANCELLED", cancelled_at: new Date().toISOString() })
      .eq("id", shipment.id);
    if (error) return { ok: false as const, error: "SHIPMENT_UPDATE_FAILED" };
    return { ok: true as const, providerConfirmed: false as const };
  }
  const res = await cancelShipment(admin, shipment.awb_code);
  if (!res.ok) return res;
  const applied = await applyShipmentStatus(admin, shipment, "CANCELLED", res.data as Json);
  if (!applied.ok) return applied;
  await auditCommerceMutation(admin, {
    action: "SHIPMENT_CANCELLED",
    entityType: "shipment",
    entityId: shipment.id,
    metadata: { provider_confirmed: true, awb: shipment.awb_code },
  });
  return { ok: true as const, providerConfirmed: true as const };
}
