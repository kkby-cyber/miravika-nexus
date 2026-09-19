export type ShipmentState =
  | "CREATED"
  | "READY_FOR_SHIPMENT"
  | "AWB_ASSIGNED"
  | "PICKUP_SCHEDULED"
  | "PICKED_UP"
  | "IN_TRANSIT"
  | "OUT_FOR_DELIVERY"
  | "DELIVERED"
  | "NDR"
  | "RTO_INITIATED"
  | "RTO_IN_TRANSIT"
  | "RTO_DELIVERED"
  | "CANCELLED"
  | "LOST"
  | "DAMAGED"
  | "FAILED";

const progression: Record<ShipmentState, number> = {
  CREATED: 10,
  READY_FOR_SHIPMENT: 20,
  AWB_ASSIGNED: 30,
  PICKUP_SCHEDULED: 40,
  PICKED_UP: 50,
  IN_TRANSIT: 60,
  OUT_FOR_DELIVERY: 70,
  DELIVERED: 80,
  NDR: 65,
  RTO_INITIATED: 90,
  RTO_IN_TRANSIT: 95,
  RTO_DELIVERED: 100,
  CANCELLED: 110,
  LOST: 110,
  DAMAGED: 110,
  FAILED: 0,
};

function normalized(value: string) {
  return value
    .toUpperCase()
    .trim()
    .replace(/[\s-]+/g, "_");
}

export function mapShiprocketStatus(status: string): ShipmentState | null {
  const value = normalized(status);
  if (value.includes("RTO") && value.includes("DELIVER")) return "RTO_DELIVERED";
  if (value.includes("RTO") && (value.includes("TRANSIT") || value.includes("PICK"))) {
    return "RTO_IN_TRANSIT";
  }
  if (value.includes("RTO")) return "RTO_INITIATED";
  if (
    value.includes("NDR") ||
    value.includes("NON_DELIVERY") ||
    value.includes("DELIVERY_EXCEPTION")
  )
    return "NDR";
  if (value.includes("CANCEL")) return "CANCELLED";
  if (value.includes("LOST")) return "LOST";
  if (value.includes("DAMAGED")) return "DAMAGED";
  if (value.includes("DELIVERED")) return "DELIVERED";
  if (value.includes("OUT_FOR_DELIVERY")) return "OUT_FOR_DELIVERY";
  if (value.includes("IN_TRANSIT") || value.includes("SHIPPED")) return "IN_TRANSIT";
  if (value.includes("PICKED") || value === "PICKUP_COMPLETE") return "PICKED_UP";
  if (value.includes("PICKUP")) return "PICKUP_SCHEDULED";
  if (value.includes("AWB")) return "AWB_ASSIGNED";
  if (value.includes("READY") || value.includes("ORDER_CREATED")) return "READY_FOR_SHIPMENT";
  if (value === "CREATED") return "CREATED";
  return null;
}

export function acceptsShipmentTransition(
  current: ShipmentState | string | null | undefined,
  next: ShipmentState,
  eventAt?: string | null,
  lastEventAt?: string | null,
) {
  if (!current) return true;
  const currentState = mapShiprocketStatus(current) ?? (current as ShipmentState);
  if (currentState === next) return true;
  if (eventAt && lastEventAt && new Date(eventAt).getTime() < new Date(lastEventAt).getTime())
    return false;
  if (["DELIVERED", "RTO_DELIVERED", "CANCELLED", "LOST", "DAMAGED"].includes(currentState))
    return false;
  return progression[next] >= progression[currentState];
}

export function shipmentEventKey(input: {
  providerEventId?: string | null | undefined;
  awb: string;
  status: string;
  occurredAt?: string | null | undefined;
}) {
  if (input.providerEventId) return `provider:${input.providerEventId}`;
  return `status:${input.awb}:${normalized(input.status)}:${input.occurredAt ?? "unknown"}`;
}
