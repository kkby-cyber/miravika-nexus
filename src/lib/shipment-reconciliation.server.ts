import { logEvent } from "@/lib/api-response";
import { auditCommerceMutation } from "@/lib/commerce-audit.server";
import { trackByAwb } from "@/lib/shiprocket.server";
import { applyShipmentStatus } from "@/lib/shipment.server";
import { mapShiprocketStatus } from "@/lib/shipment-state";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = any;

export async function reconcileShipment(admin: Admin, shipmentId: string, apply = false) {
  const { data: shipment, error } = await admin
    .from("shipments")
    .select("*")
    .eq("id", shipmentId)
    .maybeSingle();
  if (error) return { ok: false as const, error: "SHIPMENT_LOOKUP_FAILED" };
  if (!shipment) return { ok: false as const, error: "SHIPMENT_NOT_FOUND" };

  const findings: string[] = [];
  if (!shipment.provider_order_id) findings.push("PROVIDER_ORDER_ID_MISSING");
  if (!shipment.provider_shipment_id) findings.push("PROVIDER_SHIPMENT_ID_MISSING");
  if (!shipment.awb_code) findings.push("AWB_MISSING");
  if (!shipment.awb_code) return { ok: true as const, applied: false as const, findings };

  const provider = await trackByAwb(admin, shipment.awb_code);
  if (!provider.ok) {
    logEvent("error", "shipment_reconciliation_provider_failed", { shipment_id: shipmentId });
    return { ok: false as const, error: provider.error, findings };
  }
  const tracking = provider.data as {
    tracking_data?: {
      shipment_track?: Array<{ current_status?: string; date?: string }>;
    };
  };
  const providerTrack = tracking?.tracking_data?.shipment_track?.[0] ?? {};
  const providerStatus = String(providerTrack.current_status ?? "");
  const canonical = mapShiprocketStatus(providerStatus);
  if (!canonical) findings.push("PROVIDER_STATUS_UNKNOWN");
  if (canonical && canonical !== shipment.status) findings.push("STATUS_MISMATCH");
  if (
    !shipment.provider_last_synced_at ||
    Date.now() - new Date(shipment.provider_last_synced_at).getTime() > 24 * 60 * 60 * 1000
  ) {
    findings.push("STALE_LOCAL_SYNC");
  }
  const { data: event } = await admin
    .from("shipment_events")
    .select("id")
    .eq("shipment_id", shipment.id)
    .eq("status", canonical ?? providerStatus)
    .limit(1)
    .maybeSingle();
  if (canonical && !event) findings.push("MISSING_LOCAL_EVENT");

  let mutationApplied = false;
  if (apply && canonical) {
    const applied = await applyShipmentStatus(
      admin,
      shipment,
      providerStatus,
      tracking,
      providerTrack.date ?? undefined,
    );
    if (!applied.ok) return { ok: false as const, error: applied.error, findings };
    mutationApplied = true;
    await auditCommerceMutation(admin, {
      action: "SHIPMENT_RECONCILED",
      entityType: "shipment",
      entityId: shipment.id,
      metadata: { provider_status: providerStatus, canonical_status: canonical, findings },
    });
  }
  return {
    ok: true as const,
    applied: mutationApplied,
    findings,
    local_status: shipment.status,
    provider_status: providerStatus,
    canonical_status: canonical,
    mutation: mutationApplied ? { ok: true } : null,
  };
}
