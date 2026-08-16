import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { ok, fail, preflight, logEvent, requestId } from "@/lib/api-response";
import { computeTotals, toPaise, type PriceLine } from "@/lib/pricing";
import { createRazorpayOrder } from "@/lib/razorpay.server";

const addressSchema = z.object({
  full_name: z.string().min(2).max(120),
  phone: z.string().min(6).max(20),
  line1: z.string().min(3).max(200),
  line2: z.string().max(200).optional().nullable(),
  city: z.string().min(2).max(80),
  state: z.string().min(2).max(80),
  postal_code: z.string().min(4).max(12),
  country: z.string().min(2).max(2).default("IN"),
});

const bodySchema = z.object({
  email: z.string().email(),
  phone: z.string().min(6).max(20),
  full_name: z.string().min(2).max(120),
  items: z
    .array(z.object({ sku: z.string().min(1).max(64), quantity: z.number().int().min(1).max(20) }))
    .min(1)
    .max(50),
  shipping_address: addressSchema,
  billing_address: addressSchema.optional().nullable(),
  billing_same_as_shipping: z.boolean().default(true),
  shipping_method_id: z.string().uuid().optional().nullable(),
  coupon_code: z.string().max(40).optional().nullable(),
  user_id: z.string().uuid().optional().nullable(),
});

export const Route = createFileRoute("/api/public/checkout")({
  server: {
    handlers: {
      OPTIONS: async () => preflight(),
      POST: async ({ request }) => {
        const rid = requestId();
        let parsed;
        try {
          parsed = bodySchema.parse(await request.json());
        } catch {
          return fail("INVALID_REQUEST", "Some checkout details are missing or invalid.", 422);
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        // 1. Re-fetch authoritative prices + stock from the database.
        const skus = parsed.items.map((i) => i.sku);
        const { data: variants } = await supabaseAdmin
          .from("product_variants")
          .select("id, product_id, sku, title, price, status")
          .in("sku", skus);
        const { data: products } = await supabaseAdmin
          .from("products")
          .select("id, sku, title, price, tax_rate, tax_inclusive, status, deleted_at")
          .in("sku", skus);
        const { data: inventory } = await supabaseAdmin
          .from("inventory")
          .select("sku, available_quantity")
          .in("sku", skus);

        const productBySku = new Map((products ?? []).map((p) => [p.sku, p]));
        const variantBySku = new Map((variants ?? []).map((v) => [v.sku, v]));
        const productById = new Map((products ?? []).map((p) => [p.id, p]));
        const stockBySku = new Map((inventory ?? []).map((i) => [i.sku, i.available_quantity]));

        const lines: PriceLine[] = [];
        for (const item of parsed.items) {
          const variant = variantBySku.get(item.sku);
          const product = variant
            ? productById.get(variant.product_id)
            : productBySku.get(item.sku);
          if (!product || product.status !== "ACTIVE" || product.deleted_at) {
            return fail("PRODUCT_UNAVAILABLE", `${item.sku} is not available for purchase.`, 409);
          }
          const available = stockBySku.get(item.sku) ?? 0;
          if (available < item.quantity) {
            return fail("OUT_OF_STOCK", "This product is no longer available in that quantity.", 409);
          }
          lines.push({
            sku: item.sku,
            title: variant ? `${product.title} — ${variant.title}` : product.title,
            productId: product.id,
            variantId: variant?.id ?? null,
            quantity: item.quantity,
            unitPrice: Number(variant?.price ?? product.price),
            taxRate: Number(product.tax_rate ?? 0),
            taxInclusive: product.tax_inclusive ?? true,
          });
        }

        // 2. Coupon (server-side validation only).
        let coupon = null;
        if (parsed.coupon_code) {
          const { data: c } = await supabaseAdmin
            .from("coupons")
            .select("*")
            .eq("code", parsed.coupon_code.toUpperCase())
            .eq("is_active", true)
            .maybeSingle();
          const now = new Date();
          const valid =
            c &&
            (!c.starts_at || new Date(c.starts_at) <= now) &&
            (!c.ends_at || new Date(c.ends_at) >= now) &&
            (c.usage_limit == null || c.used_count < c.usage_limit);
          if (!valid) return fail("INVALID_COUPON", "This coupon code cannot be used.", 422);
          coupon = {
            id: c!.id,
            code: c!.code,
            discount_type: c!.discount_type as "PERCENTAGE" | "FIXED",
            discount_value: Number(c!.discount_value),
            min_order_value: Number(c!.min_order_value),
            max_discount: c!.max_discount == null ? null : Number(c!.max_discount),
          };
        }

        // 3. Shipping method from configuration, never from the browser.
        let shippingQuery = supabaseAdmin
          .from("shipping_methods")
          .select("id, flat_rate, free_shipping_threshold")
          .eq("is_active", true);
        if (parsed.shipping_method_id) shippingQuery = shippingQuery.eq("id", parsed.shipping_method_id);
        const { data: methods } = await shippingQuery.order("position").limit(1);
        const shipping = methods?.[0]
          ? {
              id: methods[0].id,
              flat_rate: Number(methods[0].flat_rate),
              free_shipping_threshold:
                methods[0].free_shipping_threshold == null
                  ? null
                  : Number(methods[0].free_shipping_threshold),
            }
          : null;

        const totals = computeTotals(lines, coupon, shipping);

        // 4. Create the internal order first.
        const { data: numberRow } = await supabaseAdmin.rpc("next_order_number");
        const orderNumber = (numberRow as unknown as string) ?? `MIR-${Date.now()}`;

        const { data: order, error: orderError } = await supabaseAdmin
          .from("orders")
          .insert({
            order_number: orderNumber,
            user_id: parsed.user_id ?? null,
            email: parsed.email,
            phone: parsed.phone,
            full_name: parsed.full_name,
            status: "PENDING_PAYMENT",
            payment_status: "PENDING",
            subtotal: totals.subtotal,
            discount_total: totals.discountTotal,
            tax_total: totals.taxTotal,
            shipping_total: totals.shippingTotal,
            grand_total: totals.grandTotal,
            coupon_code: coupon?.code ?? null,
            shipping_address: parsed.shipping_address,
            billing_address: parsed.billing_same_as_shipping
              ? parsed.shipping_address
              : (parsed.billing_address ?? parsed.shipping_address),
            shipping_method_id: shipping?.id ?? null,
          })
          .select("id, order_number")
          .single();

        if (orderError || !order) {
          logEvent("error", "order_create_failed", { rid });
          return fail("ORDER_FAILED", "We could not start your order. Please try again.", 500);
        }

        await supabaseAdmin.from("order_items").insert(
          totals.items.map((i) => ({
            order_id: order.id,
            product_id: i.productId,
            variant_id: i.variantId,
            sku: i.sku,
            title: i.title,
            quantity: i.quantity,
            unit_price: i.unitPrice,
            discount_amount: i.discountAmount,
            tax_rate: i.taxRate,
            tax_amount: i.taxAmount,
            line_total: i.lineTotal,
          })),
        );

        // 5. Reserve inventory atomically; roll back on any shortfall.
        const reserved: Array<{ sku: string; quantity: number }> = [];
        for (const line of totals.items) {
          const { data: okReserve } = await supabaseAdmin.rpc("reserve_inventory", {
            _sku: line.sku,
            _qty: line.quantity,
            _reference_id: order.id,
          });
          if (!okReserve) {
            for (const r of reserved) {
              await supabaseAdmin.rpc("release_inventory", {
                _sku: r.sku,
                _qty: r.quantity,
                _reference_id: order.id,
              });
            }
            await supabaseAdmin
              .from("orders")
              .update({ status: "CANCELLED", cancelled_at: new Date().toISOString() })
              .eq("id", order.id);
            return fail("OUT_OF_STOCK", "This product is no longer available.", 409);
          }
          reserved.push({ sku: line.sku, quantity: line.quantity });
        }

        // 6. Create the Razorpay order server-side.
        const rzp = await createRazorpayOrder({
          amountPaise: toPaise(totals.grandTotal),
          currency: "INR",
          receipt: order.order_number,
          notes: { order_id: order.id },
        });

        if ("error" in rzp) {
          for (const r of reserved) {
            await supabaseAdmin.rpc("release_inventory", {
              _sku: r.sku,
              _qty: r.quantity,
              _reference_id: order.id,
            });
          }
          await supabaseAdmin
            .from("orders")
            .update({ status: "CANCELLED", payment_status: "FAILED" })
            .eq("id", order.id);
          logEvent("error", "razorpay_unavailable", { rid, order_id: order.id, code: rzp.error });
          return fail(
            rzp.error,
            rzp.error === "RAZORPAY_NOT_CONFIGURED"
              ? "Payments are not configured yet."
              : "Payment could not be started. Please try again.",
            503,
          );
        }

        await supabaseAdmin
          .from("orders")
          .update({ razorpay_order_id: rzp.id })
          .eq("id", order.id);
        await supabaseAdmin.from("payments").insert({
          order_id: order.id,
          provider: "razorpay",
          razorpay_order_id: rzp.id,
          status: "PENDING",
          amount: totals.grandTotal,
          currency: "INR",
        });

        logEvent("info", "checkout_created", { rid, order_id: order.id });

        // Only the public key id ever reaches the browser.
        return ok({
          order_id: order.id,
          order_number: order.order_number,
          totals: {
            subtotal: totals.subtotal,
            discount: totals.discountTotal,
            tax: totals.taxTotal,
            shipping: totals.shippingTotal,
            total: totals.grandTotal,
            currency: "INR",
          },
          razorpay: {
            key_id: process.env["RAZORPAY_KEY_ID"],
            order_id: rzp.id,
            amount: rzp.amount,
            currency: rzp.currency,
          },
        });
      },
    },
  },
});
