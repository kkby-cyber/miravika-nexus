export type PaymentStatus =
  "PENDING" | "AUTHORIZED" | "PAID" | "FAILED" | "REFUNDED" | "PARTIALLY_REFUNDED" | "CANCELLED";

const transitions: Record<PaymentStatus, readonly PaymentStatus[]> = {
  PENDING: ["AUTHORIZED", "PAID", "FAILED", "CANCELLED"],
  AUTHORIZED: ["PAID", "FAILED", "CANCELLED"],
  PAID: ["PARTIALLY_REFUNDED", "REFUNDED"],
  FAILED: [],
  REFUNDED: [],
  PARTIALLY_REFUNDED: ["REFUNDED"],
  CANCELLED: [],
};

export function canTransitionPaymentStatus(from: PaymentStatus, to: PaymentStatus) {
  return from === to || transitions[from].includes(to);
}

export function refundableAmount(capturedAmount: number, refundedAmount: number) {
  return Math.max(0, Math.round((capturedAmount - refundedAmount) * 100) / 100);
}

export function validateRefundAmount(
  capturedAmount: number,
  refundedAmount: number,
  requestedAmount: number,
) {
  const remaining = refundableAmount(capturedAmount, refundedAmount);
  return {
    valid: Number.isFinite(requestedAmount) && requestedAmount > 0 && requestedAmount <= remaining,
    remaining,
  };
}

export function isCapturedPaymentStatus(status: string | null | undefined) {
  return status === "captured";
}

export function paymentMatchesOrder(input: {
  providerOrderId: string;
  providerPaymentId: string;
  amount: number;
  currency: string;
  expectedOrderId: string;
  expectedPaymentId?: string;
  expectedAmount: number;
  expectedCurrency: string;
}) {
  return (
    input.providerOrderId === input.expectedOrderId &&
    input.providerPaymentId.length > 0 &&
    (!input.expectedPaymentId || input.providerPaymentId === input.expectedPaymentId) &&
    Number.isInteger(input.amount) &&
    input.amount > 0 &&
    input.amount === input.expectedAmount &&
    input.currency === input.expectedCurrency
  );
}

export function shouldReleaseFailedPayment(order: {
  payment_status: string;
  inventory_finalized: boolean;
}) {
  return (
    !order.inventory_finalized &&
    !["PAID", "PARTIALLY_REFUNDED", "REFUNDED"].includes(order.payment_status)
  );
}

export function paymentStatusAfterRefund(
  capturedAmount: number,
  refundedAmount: number,
): PaymentStatus {
  return refundedAmount >= capturedAmount ? "REFUNDED" : "PARTIALLY_REFUNDED";
}
