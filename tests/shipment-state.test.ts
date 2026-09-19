import { describe, expect, it } from "vitest";
import {
  acceptsShipmentTransition,
  mapShiprocketStatus,
  shipmentEventKey,
} from "../src/lib/shipment-state";

describe("Shiprocket shipment state", () => {
  it("maps provider statuses to canonical states", () => {
    expect(mapShiprocketStatus("Out For Delivery")).toBe("OUT_FOR_DELIVERY");
    expect(mapShiprocketStatus("RTO Delivered")).toBe("RTO_DELIVERED");
    expect(mapShiprocketStatus("Delivery Exception")).toBe("NDR");
  });

  it("maps provider order creation to ready for shipment", () => {
    expect(mapShiprocketStatus("ORDER_CREATED")).toBe("READY_FOR_SHIPMENT");
  });

  it("maps AWB assignment to the canonical AWB state", () => {
    expect(mapShiprocketStatus("AWB Assigned")).toBe("AWB_ASSIGNED");
  });

  it("keeps provider order event keys idempotent", () => {
    const first = shipmentEventKey({ providerEventId: "order-1", awb: "awb", status: "Created" });
    const second = shipmentEventKey({ providerEventId: "order-1", awb: "awb", status: "Created" });
    expect(first).toBe(second);
  });

  it("keeps repeated AWB event keys idempotent", () => {
    expect(shipmentEventKey({ providerEventId: "awb-1", awb: "awb", status: "AWB Assigned" })).toBe(
      shipmentEventKey({ providerEventId: "awb-1", awb: "awb", status: "AWB Assigned" }),
    );
  });

  it("does not map unknown provider webhooks", () => {
    expect(mapShiprocketStatus("provider-specific-unknown-status")).toBeNull();
  });

  it("rejects a delivered to in-transit regression", () => {
    expect(acceptsShipmentTransition("DELIVERED", "IN_TRANSIT")).toBe(false);
  });

  it("rejects stale provider events", () => {
    expect(
      acceptsShipmentTransition("IN_TRANSIT", "OUT_FOR_DELIVERY", "2026-01-01", "2026-01-02"),
    ).toBe(false);
  });

  it("accepts forward shipment progression", () => {
    expect(acceptsShipmentTransition("AWB_ASSIGNED", "PICKUP_SCHEDULED")).toBe(true);
  });

  it("accepts pickup and in-transit progression", () => {
    expect(acceptsShipmentTransition("PICKUP_SCHEDULED", "PICKED_UP")).toBe(true);
    expect(acceptsShipmentTransition("PICKED_UP", "IN_TRANSIT")).toBe(true);
  });

  it("rejects an out-of-order delivered event after RTO delivery", () => {
    expect(acceptsShipmentTransition("RTO_DELIVERED", "DELIVERED")).toBe(false);
  });

  it("maps NDR events without inventing customer actions", () => {
    expect(mapShiprocketStatus("NDR")).toBe("NDR");
  });

  it("maps RTO initiation and transit", () => {
    expect(mapShiprocketStatus("RTO Initiated")).toBe("RTO_INITIATED");
    expect(mapShiprocketStatus("RTO In Transit")).toBe("RTO_IN_TRANSIT");
  });

  it("maps cancellation to a terminal state", () => {
    expect(mapShiprocketStatus("Cancelled")).toBe("CANCELLED");
    expect(acceptsShipmentTransition("CANCELLED", "IN_TRANSIT")).toBe(false);
  });

  it("rejects provider corrections with an older timestamp", () => {
    expect(
      acceptsShipmentTransition("OUT_FOR_DELIVERY", "DELIVERED", "2026-02-01", "2026-02-02"),
    ).toBe(false);
  });

  it("creates deterministic fallback keys when provider IDs are absent", () => {
    expect(
      shipmentEventKey({ awb: "awb-2", status: "In Transit", occurredAt: "2026-01-01T00:00:00Z" }),
    ).toBe("status:awb-2:IN_TRANSIT:2026-01-01T00:00:00Z");
  });

  it("creates stable provider and fallback event keys", () => {
    expect(shipmentEventKey({ providerEventId: "evt-1", awb: "awb", status: "Delivered" })).toBe(
      "provider:evt-1",
    );
    expect(shipmentEventKey({ awb: "awb", status: "Delivered", occurredAt: "2026-01-01" })).toBe(
      "status:awb:DELIVERED:2026-01-01",
    );
  });
});
