export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export function mergeCartQuantities(existing: number, incoming: number, available: number) {
  if (!Number.isInteger(existing) || !Number.isInteger(incoming) || incoming <= 0) return null;
  const merged = existing + incoming;
  return merged <= available ? merged : null;
}

export function isApprovedReviewVisible(status: string) {
  return status === "APPROVED";
}

export function verifiedPurchaseStatus(hasPaidMatchingOrder: boolean) {
  return hasPaidMatchingOrder;
}

export function canAccessCustomerResource(resourceOwnerId: string, customerId: string) {
  return resourceOwnerId === customerId;
}

export function oneDefaultAddress(existingDefaultCount: number) {
  return existingDefaultCount <= 1;
}

export function guestTokenIsValid(token: string) {
  return /^[a-zA-Z0-9_-]{32,128}$/.test(token);
}
