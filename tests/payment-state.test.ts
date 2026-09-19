import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import {
  canTransitionPaymentStatus,
  paymentStatusAfterRefund,
  refundableAmount,
  validateRefundAmount,
} from "../src/lib/payment-state";
import { verifyPaymentSignature } from "../src/lib/razorpay.server";

describe("payment state machine", () => {
  it("allows a successful pending payment to become paid", () => {
    expect(canTransitionPaymentStatus("PENDING", "PAID")).toBe(true);
  });

  it("allows an authorized payment to become paid", () => {
    expect(canTransitionPaymentStatus("AUTHORIZED", "PAID")).toBe(true);
  });

  it("makes captured delivery idempotent", () => {
    expect(canTransitionPaymentStatus("PAID", "PAID")).toBe(true);
  });

  it("rejects failed to captured transitions", () => {
    expect(canTransitionPaymentStatus("FAILED", "PAID")).toBe(false);
  });

  it("rejects refunded to captured transitions", () => {
    expect(canTransitionPaymentStatus("REFUNDED", "PAID")).toBe(false);
  });

  it("rejects cancelled to captured transitions", () => {
    expect(canTransitionPaymentStatus("CANCELLED", "PAID")).toBe(false);
  });

  it("calculates the remaining refundable amount", () => {
    expect(refundableAmount(1000, 250)).toBe(750);
  });

  it("accepts a valid full refund", () => {
    expect(validateRefundAmount(1000, 0, 1000)).toEqual({ valid: true, remaining: 1000 });
  });

  it("accepts a valid partial refund", () => {
    expect(validateRefundAmount(1000, 250, 300)).toEqual({ valid: true, remaining: 750 });
  });

  it("rejects refunds above the captured amount", () => {
    expect(validateRefundAmount(1000, 0, 1000.01).valid).toBe(false);
  });

  it("rejects a second refund above the remaining balance", () => {
    expect(validateRefundAmount(1000, 750, 300).valid).toBe(false);
  });

  it("rejects zero and negative refunds", () => {
    expect(validateRefundAmount(1000, 0, 0).valid).toBe(false);
    expect(validateRefundAmount(1000, 0, -1).valid).toBe(false);
  });

  it("marks a partial refund without exhausting the capture", () => {
    expect(paymentStatusAfterRefund(1000, 250)).toBe("PARTIALLY_REFUNDED");
  });

  it("marks a full refund when the captured amount is exhausted", () => {
    expect(paymentStatusAfterRefund(1000, 1000)).toBe("REFUNDED");
  });
});

describe("Razorpay signature verification", () => {
  it("accepts a valid server-side payment signature", async () => {
    process.env["RAZORPAY_KEY_SECRET"] = "test-secret";
    const payload = "order_test|pay_test";
    const signature = createHmac("sha256", "test-secret").update(payload).digest("hex");
    await expect(
      verifyPaymentSignature({
        razorpayOrderId: "order_test",
        razorpayPaymentId: "pay_test",
        signature,
      }),
    ).resolves.toBe(true);
  });

  it("rejects an invalid payment signature", async () => {
    process.env["RAZORPAY_KEY_SECRET"] = "test-secret";
    await expect(
      verifyPaymentSignature({
        razorpayOrderId: "order_test",
        razorpayPaymentId: "pay_test",
        signature: "invalid-signature",
      }),
    ).resolves.toBe(false);
  });
});
