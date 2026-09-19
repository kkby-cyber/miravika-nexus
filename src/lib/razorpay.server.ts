/**
 * Razorpay access. Server-only: the key secret is read from process.env inside
 * functions and never returned to a client, logged, or embedded in a response.
 */

export type RazorpayConfig = { keyId: string; keySecret: string };

export function getRazorpayConfig(): RazorpayConfig | null {
  const keyId = process.env["RAZORPAY_KEY_ID"];
  const keySecret = process.env["RAZORPAY_KEY_SECRET"];
  if (!keyId || !keySecret) return null;
  return { keyId, keySecret };
}

export async function createRazorpayOrder(input: {
  amountPaise: number;
  currency: string;
  receipt: string;
  notes?: Record<string, string>;
}): Promise<{ id: string; amount: number; currency: string } | { error: string }> {
  const config = getRazorpayConfig();
  if (!config) return { error: "RAZORPAY_NOT_CONFIGURED" };

  const auth = btoa(`${config.keyId}:${config.keySecret}`);
  const res = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: {
      authorization: `Basic ${auth}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      amount: input.amountPaise,
      currency: input.currency,
      receipt: input.receipt,
      notes: input.notes ?? {},
      payment_capture: 1,
    }),
  });

  if (!res.ok) {
    // Provider errors are logged as a category only, never with credentials.
    console.error("razorpay_order_create_failed", { status: res.status });
    return { error: "RAZORPAY_ORDER_FAILED" };
  }
  return (await res.json()) as { id: string; amount: number; currency: string };
}

async function hmacSha256Hex(secret: string, payload: string) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Verifies the checkout handshake signature (order_id|payment_id). */
export async function verifyPaymentSignature(input: {
  razorpayOrderId: string;
  razorpayPaymentId: string;
  signature: string;
}) {
  const secret = process.env["RAZORPAY_KEY_SECRET"];
  if (!secret) return false;
  const expected = await hmacSha256Hex(
    secret,
    `${input.razorpayOrderId}|${input.razorpayPaymentId}`,
  );
  return timingSafeEqual(expected, input.signature);
}

/** Verifies a webhook body against X-Razorpay-Signature. */
export async function verifyWebhookSignature(rawBody: string, signature: string | null) {
  const secret = process.env["RAZORPAY_WEBHOOK_SECRET"];
  if (!secret || !signature) return false;
  const expected = await hmacSha256Hex(secret, rawBody);
  return timingSafeEqual(expected, signature);
}

export async function fetchRazorpayPayment(paymentId: string) {
  const config = getRazorpayConfig();
  if (!config) return null;
  const auth = btoa(`${config.keyId}:${config.keySecret}`);
  const res = await fetch(`https://api.razorpay.com/v1/payments/${paymentId}`, {
    headers: { authorization: `Basic ${auth}` },
  });
  if (!res.ok) return null;
  return (await res.json()) as {
    id: string;
    order_id: string;
    status: string;
    amount: number;
    currency: string;
    method?: string;
  };
}

export async function createRazorpayRefund(input: {
  paymentId: string;
  amountPaise: number;
  notes?: Record<string, string>;
}): Promise<{ id: string; amount: number; status?: string } | { error: string }> {
  const config = getRazorpayConfig();
  if (!config) return { error: "RAZORPAY_NOT_CONFIGURED" };
  if (!Number.isInteger(input.amountPaise) || input.amountPaise <= 0) {
    return { error: "INVALID_REFUND_AMOUNT" };
  }
  const auth = btoa(`${config.keyId}:${config.keySecret}`);
  const res = await fetch(`https://api.razorpay.com/v1/payments/${input.paymentId}/refund`, {
    method: "POST",
    headers: {
      authorization: `Basic ${auth}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ amount: input.amountPaise, notes: input.notes ?? {} }),
  });
  if (!res.ok) {
    console.error("razorpay_refund_create_failed", { status: res.status });
    return { error: "RAZORPAY_REFUND_FAILED" };
  }
  const body = (await res.json()) as { id?: string; amount?: number; status?: string };
  if (!body.id || body.amount !== input.amountPaise)
    return { error: "RAZORPAY_REFUND_INVALID_RESPONSE" };
  return {
    id: body.id,
    amount: body.amount,
    ...(body.status ? { status: body.status } : {}),
  };
}
