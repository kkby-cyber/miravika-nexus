import { describe, expect, it } from "vitest";
import { codCheckoutDecision, isCodEnabled, storeCodAvailable } from "../src/lib/cod";
import { checkoutBodySchema } from "../src/lib/checkout-request";

describe("cash on delivery gate", () => {
  it("is off unless COD_ENABLED is exactly true", () => {
    expect(isCodEnabled({})).toBe(false);
    expect(isCodEnabled({ COD_ENABLED: "1" })).toBe(false);
    expect(isCodEnabled({ COD_ENABLED: "TRUE" })).toBe(true);
  });

  it("always allows prepaid checkout", () => {
    expect(codCheckoutDecision("razorpay", false)).toEqual({ allowed: true });
  });

  it("refuses COD while the store has it disabled", () => {
    expect(codCheckoutDecision("cod", false)).toMatchObject({
      allowed: false,
      code: "COD_UNAVAILABLE",
      status: 409,
    });
  });

  it("still refuses COD when the flag is on but the COD order path is not built", () => {
    expect(codCheckoutDecision("cod", true)).toMatchObject({
      allowed: false,
      code: "COD_NOT_SUPPORTED",
    });
  });

  it("only advertises COD when the store and a courier both support it", () => {
    expect(storeCodAvailable(false, true)).toBe(false);
    expect(storeCodAvailable(true, false)).toBe(false);
    expect(storeCodAvailable(true, true)).toBe(true);
  });

  it("defaults checkout to prepaid and rejects unknown payment methods", () => {
    const base = {
      email: "a@b.co",
      phone: "9876543210",
      full_name: "Test Buyer",
      shipping_address: {
        full_name: "Test Buyer",
        phone: "9876543210",
        line1: "12 Marine Drive",
        city: "Mumbai",
        state: "Maharashtra",
        postal_code: "400001",
      },
    };
    expect(checkoutBodySchema.parse(base).payment_method).toBe("razorpay");
    expect(() =>
      checkoutBodySchema.parse({ ...base, payment_method: "upi_on_delivery" }),
    ).toThrow();
  });
});
