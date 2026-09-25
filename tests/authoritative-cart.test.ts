/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { checkoutBodySchema } from "../src/lib/checkout-request";
import { claimCartForCheckout, releaseCartClaim } from "../src/lib/customer-commerce.server";
import { markOrderPaid, releaseOrderInventory } from "../src/lib/order-fulfilment.server";

type Result = { data: unknown; error: { message: string; code?: string } | null };

function makeFulfillmentAdmin(options: {
  order: Record<string, unknown>;
  items?: Record<string, unknown>[];
  responses?: Record<string, Record<string, unknown>>;
}) {
  const calls: Array<{ kind: string; table?: string; name?: string; args?: unknown }> = [];
  const responses = options.responses ?? {};
  const selectData: Record<string, unknown> = {
    orders: options.order,
    order_items: options.items ?? [],
  };
  const from = (table: string) => {
    const query: any = {
      select: () => query,
      update: (value: unknown) => {
        calls.push({ kind: "update", table, args: value });
        return query;
      },
      insert: (value: unknown) => {
        calls.push({ kind: "insert", table, args: value });
        return query;
      },
      upsert: (value: unknown) => {
        calls.push({ kind: "upsert", table, args: value });
        return query;
      },
      eq: () => query,
      in: () => query,
      order: () => query,
      limit: () => query,
      maybeSingle: async (): Promise<Result> => ({ data: selectData[table] ?? null, error: null }),
      single: async (): Promise<Result> => ({ data: selectData[table] ?? null, error: null }),
      then: (resolve: (result: Result) => unknown) =>
        Promise.resolve({ data: selectData[table] ?? null, error: null }).then(resolve),
    };
    return query;
  };
  const rpc = vi.fn(async (name: string, args: unknown) => {
    calls.push({ kind: "rpc", name, args });
    return { data: responses[name] ?? { ok: true }, error: null };
  });
  return { admin: { from, rpc }, calls, rpc };
}

const order = {
  id: "order-1",
  order_number: "MIR-1",
  user_id: "customer-1",
  email: "buyer@example.com",
  currency: "INR",
  grand_total: 100,
  tax_total: 0,
  shipping_total: 0,
  discount_total: 0,
  coupon_code: "SAVE10",
  payment_status: "PENDING",
  inventory_finalized: false,
  razorpay_order_id: "rz_order_1",
  razorpay_payment_id: null,
  purchase_event_sent: false,
};

const items = [{ sku: "SKU-1", quantity: 1, title: "Product", unit_price: 100, product_id: "p1" }];

function validCheckoutBody() {
  return {
    email: "buyer@example.com",
    phone: "9999999999",
    full_name: "Test Buyer",
    shipping_address: {
      full_name: "Test Buyer",
      phone: "9999999999",
      line1: "1 Test Street",
      city: "Mumbai",
      state: "Maharashtra",
      postal_code: "400001",
    },
  };
}

describe("authoritative checkout contract", () => {
  it("strips browser line items and totals from checkout input", () => {
    const parsed = checkoutBodySchema.parse({
      ...validCheckoutBody(),
      items: [{ sku: "CLIENT-SKU", quantity: 99 }],
      grand_total: 1,
      totals: { total: 1 },
    });
    expect(parsed).not.toHaveProperty("items");
    expect(parsed).not.toHaveProperty("grand_total");
    expect(parsed).not.toHaveProperty("totals");
  });

  it("passes ownership and the generated claim through the cart claim RPC", async () => {
    const cart = { id: "cart-1", user_id: "customer-1", status: "ACTIVE" };
    const query: any = {
      select: () => query,
      eq: () => query,
      order: () => query,
      limit: () => query,
      maybeSingle: async () => ({ data: cart, error: null }),
    };
    const rpc = vi.fn(async () => ({
      data: { ok: true, cart_id: "cart-1", checkout_claim_id: "claim-1" },
      error: null,
    }));
    const result = await claimCartForCheckout({ from: () => query, rpc }, "customer-1", null);
    expect(result).toEqual({ cartId: "cart-1", checkoutClaimId: "claim-1" });
    expect(rpc).toHaveBeenCalledWith("claim_checkout_cart", {
      _cart_id: "cart-1",
      _user_id: "customer-1",
      _session_token: null,
    });
  });

  it("rejects a claim response when the database does not confirm ownership", async () => {
    const cart = { id: "cart-1", user_id: "customer-1", status: "ACTIVE" };
    const query: any = {
      select: () => query,
      eq: () => query,
      order: () => query,
      limit: () => query,
      maybeSingle: async () => ({ data: cart, error: null }),
    };
    const rpc = vi.fn(async () => ({
      data: { ok: false, error: "CART_NOT_AVAILABLE" },
      error: null,
    }));
    await expect(
      claimCartForCheckout({ from: () => query, rpc }, "customer-1", null),
    ).rejects.toThrow("CART_NOT_AVAILABLE");
  });

  it("requires the exact claim for a checkout release", async () => {
    const rpc = vi.fn(async () => ({ data: true, error: null }));
    await releaseCartClaim({ rpc } as any, "customer-1", null, "cart-1", "claim-1");
    expect(rpc).toHaveBeenCalledWith("release_checkout_cart", {
      _cart_id: "cart-1",
      _checkout_claim_id: "claim-1",
      _user_id: "customer-1",
      _session_token: null,
    });
  });
});

describe("payment finalization and cleanup", () => {
  it("keeps payment successful while exposing cleanup as pending", async () => {
    const { admin, calls } = makeFulfillmentAdmin({
      order,
      items,
      responses: {
        confirm_order_paid: { ok: true, duplicate: false },
        clear_order_cart: { ok: false, error: "DATABASE_BUSY" },
        redeem_order_coupon: { ok: true, duplicate: false },
      },
    });
    const result = await markOrderPaid(admin, {
      orderId: "order-1",
      razorpayOrderId: "rz_order_1",
      razorpayPaymentId: "pay_1",
      providerAmountPaise: 10000,
      currency: "INR",
      signatureVerified: true,
    });
    expect(result).toEqual({ ok: true, duplicate: false, cartCleanupPending: true });
    expect(calls.some((call) => call.name === "confirm_order_paid")).toBe(true);
    expect(calls.some((call) => call.name === "clear_order_cart")).toBe(true);
    expect(calls.some((call) => call.name === "redeem_order_coupon")).toBe(true);
  });

  it("rejects a different payment ID before invoking finalization", async () => {
    const paidOrder = {
      ...order,
      payment_status: "PAID",
      inventory_finalized: true,
      razorpay_payment_id: "pay_original",
    };
    const { admin, rpc } = makeFulfillmentAdmin({ order: paidOrder, items });
    const result = await markOrderPaid(admin, {
      orderId: "order-1",
      razorpayOrderId: "rz_order_1",
      razorpayPaymentId: "pay_different",
      providerAmountPaise: 10000,
      currency: "INR",
      signatureVerified: true,
    });
    expect(result).toEqual({ ok: false, reason: "PAYMENT_ID_MISMATCH" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("retries post-payment side effects for a duplicate capture", async () => {
    const paidOrder = {
      ...order,
      payment_status: "PAID",
      inventory_finalized: true,
      razorpay_payment_id: "pay_original",
    };
    const { admin, calls } = makeFulfillmentAdmin({
      order: paidOrder,
      items,
      responses: {
        confirm_order_paid: { ok: true, duplicate: true },
        clear_order_cart: { ok: true, duplicate: true },
        redeem_order_coupon: { ok: true, duplicate: true },
      },
    });
    const result = await markOrderPaid(admin, {
      orderId: "order-1",
      razorpayOrderId: "rz_order_1",
      razorpayPaymentId: "pay_original",
      providerAmountPaise: 10000,
      currency: "INR",
      signatureVerified: true,
    });
    expect(result).toEqual({ ok: true, duplicate: true, cartCleanupPending: false });
    expect(calls.filter((call) => call.kind === "upsert").length).toBeGreaterThanOrEqual(2);
  });

  it("uses the transaction-safe inventory release RPC with the requested status", async () => {
    const { admin, rpc } = makeFulfillmentAdmin({
      order,
      items,
      responses: { release_order_inventory: { ok: true, duplicate: false } },
    });
    const result = await releaseOrderInventory(admin, "order-1", "FAILED");
    expect(result.ok).toBe(true);
    expect(rpc).toHaveBeenCalledWith("release_order_inventory", {
      _order_id: "order-1",
      _next_payment_status: "FAILED",
    });
  });
});

describe("claim-bound migration safeguards", () => {
  const migration = readFileSync(
    new URL(
      "../supabase/migrations/20260925120000_phase6_authoritative_cart_checkout.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const webhook = readFileSync(
    new URL("../src/routes/api/public/webhooks.razorpay.ts", import.meta.url),
    "utf8",
  );

  it("requires the exact order-linked cart and claim for cleanup", () => {
    expect(migration).toContain(
      "DELETE FROM public.cart_items WHERE cart_id = target_order.cart_id",
    );
    expect(migration).toContain("checkout_claim_id IS DISTINCT FROM target_order.cart_claim_id");
    expect(migration).toContain("checkout_claim_id = target_order.cart_claim_id");
  });

  it("protects webhook retries and delayed failure handling", () => {
    expect(webhook).toContain('insertError?.code === "23505"');
    expect(webhook).toContain("if (existing?.processed)");
    expect(webhook).toContain("paymentEntity.captured !== true");
    expect(webhook).toContain("if (!shouldReleaseFailedPayment(order)) break;");
    expect(webhook).toContain("if (failed.duplicate) break;");
  });

  it("keeps one open order per cart and removes direct client cart writes", () => {
    expect(migration).toContain("orders_one_open_cart_idx");
    expect(migration).toContain(
      "REVOKE INSERT, UPDATE, DELETE ON public.carts FROM anon, authenticated",
    );
    expect(migration).toContain(
      "REVOKE INSERT, UPDATE, DELETE ON public.cart_items FROM anon, authenticated",
    );
  });
});
