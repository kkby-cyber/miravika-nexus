/**
 * Cash on Delivery gate.
 *
 * COD stays OFF until the business rules are approved and the COD order path exists
 * (see docs/cod-readiness.md). The flag only lets the storefront *advertise* COD; checkout
 * still refuses COD requests explicitly, so a COD order can never be routed into the prepaid
 * Razorpay flow by accident.
 */
export type PaymentMethod = "razorpay" | "cod";

export function isCodEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env["COD_ENABLED"]?.trim().toLowerCase() === "true";
}

export type CodDecision =
  | { allowed: true }
  | {
      allowed: false;
      code: "COD_UNAVAILABLE" | "COD_NOT_SUPPORTED";
      status: number;
      message: string;
    };

export function codCheckoutDecision(method: PaymentMethod, codEnabled: boolean): CodDecision {
  if (method !== "cod") return { allowed: true };
  if (!codEnabled) {
    return {
      allowed: false,
      code: "COD_UNAVAILABLE",
      status: 409,
      message: "Cash on Delivery is not available. Please pay securely online.",
    };
  }
  // The flag is on but the COD order path (unpaid order, COD shipment, collection
  // confirmation) has not been built yet; refuse rather than mis-handle the order.
  return {
    allowed: false,
    code: "COD_NOT_SUPPORTED",
    status: 501,
    message: "Cash on Delivery is not available yet. Please pay securely online.",
  };
}

/** Store-level COD availability: only when the store accepts COD *and* a courier supports it. */
export function storeCodAvailable(codEnabled: boolean, courierSupportsCod: boolean): boolean {
  return codEnabled && courierSupportsCod;
}
