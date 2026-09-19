import {
  canAccessCustomerResource,
  guestTokenIsValid,
  oneDefaultAddress,
} from "../src/lib/customer-commerce-rules";
import { describe, expect, it } from "vitest";
import {
  isApprovedReviewVisible,
  mergeCartQuantities,
  normalizeEmail,
  verifiedPurchaseStatus,
} from "../src/lib/customer-commerce-rules";

describe("customer commerce rules", () => {
  it("normalizes newsletter emails", () =>
    expect(normalizeEmail("  User@Example.COM ")).toBe("user@example.com"));
  it("merges duplicate cart lines", () => expect(mergeCartQuantities(2, 3, 5)).toBe(5));
  it("rejects cart merges above inventory", () => expect(mergeCartQuantities(2, 4, 5)).toBeNull());
  it("rejects non-positive cart additions", () => expect(mergeCartQuantities(1, 0, 5)).toBeNull());
  it("requires integer cart quantities", () => expect(mergeCartQuantities(1, 1.5, 5)).toBeNull());
  it("only exposes approved reviews", () => {
    expect(isApprovedReviewVisible("APPROVED")).toBe(true);
    expect(isApprovedReviewVisible("PENDING")).toBe(false);
    expect(isApprovedReviewVisible("REJECTED")).toBe(false);
  });
  it("derives verified purchase server-side", () => {
    expect(verifiedPurchaseStatus(true)).toBe(true);
    expect(verifiedPurchaseStatus(false)).toBe(false);
  });
  it("does not accept a client verified flag through the rule", () => {
    expect(verifiedPurchaseStatus(false)).not.toBe(true);
  });
  it("enforces customer ownership", () => {
    expect(canAccessCustomerResource("customer-a", "customer-a")).toBe(true);
    expect(canAccessCustomerResource("customer-a", "customer-b")).toBe(false);
  });
  it("enforces one default address", () => {
    expect(oneDefaultAddress(0)).toBe(true);
    expect(oneDefaultAddress(1)).toBe(true);
    expect(oneDefaultAddress(2)).toBe(false);
  });
  it("validates guest cart tokens", () => {
    expect(guestTokenIsValid("a".repeat(32))).toBe(true);
    expect(guestTokenIsValid("short")).toBe(false);
    expect(guestTokenIsValid(" ".repeat(32))).toBe(false);
  });
  it("keeps cart quantities positive and bounded", () => {
    expect(mergeCartQuantities(0, 1, 1)).toBe(1);
    expect(mergeCartQuantities(1, -1, 5)).toBeNull();
    expect(mergeCartQuantities(1, 1, 1)).toBeNull();
  });
});
