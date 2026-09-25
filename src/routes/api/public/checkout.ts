import { createFileRoute } from "@tanstack/react-router";
import { ok, fail, preflight, logEvent, requestId } from "@/lib/api-response";
import { toPaise } from "@/lib/pricing";
import { createRazorpayOrder } from "@/lib/razorpay.server";
import { enforceRateLimit } from "@/lib/rate-limit.server";
import { quote, userFromRequest } from "@/lib/store.server";
import {
  claimCartForCheckout,
  loadAuthoritativeCartLines,
  releaseCartClaim,
} from "@/lib/customer-commerce.server";
import { auditCommerceMutation } from "@/lib/commerce-audit.server";
import { checkoutBodySchema } from "@/lib/checkout-request";

export const Route = createFileRoute("/api/public/checkout")({
  server: {
    handlers: {
      OPTIONS: async () => preflight(),
      POST: async ({ request }) => {
        const rid = requestId(request);
        const rateLimit = await enforceRateLimit(request, "checkout", 10);
        if (rateLimit.error)
          return fail("RATE_LIMIT_UNAVAILABLE", "Checkout is temporarily unavailable.", 503);
        if (!rateLimit.allowed)
          return fail("RATE_LIMITED", "Too many checkout attempts. Please try again later.", 429);
        let parsed;
        try {
          parsed = checkoutBodySchema.parse(await request.json());
        } catch {
          return fail("INVALID_REQUEST", "Some checkout details are missing or invalid.", 422);
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const authorization = request.headers.get("authorization");
        const customer = await userFromRequest(request);
        if (authorization && !customer)
          return fail("UNAUTHORIZED", "The supplied session is invalid.", 401);

        const guestToken = (() => {
          const value = request.headers.get("x-cart-token");
          return value && /^[a-zA-Z0-9_-]{32,128}$/.test(value) ? value : null;
        })();
        if (!customer && !guestToken)
          return fail("GUEST_CART_TOKEN_REQUIRED", "A valid guest cart token is required.", 400);

        let claimedCartId: string | undefined;
        let claimedCheckoutClaimId: string | undefined;
        let claimedOrderId: string | undefined;
        let authoritativeItems: Array<{ sku: string; quantity: number }>;
        try {
          const claimed = await claimCartForCheckout(
            supabaseAdmin,
            customer?.id ?? null,
            guestToken,
          );
          claimedCartId = claimed.cartId;
          claimedCheckoutClaimId = claimed.checkoutClaimId;
          authoritativeItems = await loadAuthoritativeCartLines(
            supabaseAdmin,
            claimed.cartId,
            claimed.checkoutClaimId,
          );
        } catch (error) {
          const code = String(error).replace("Error: ", "");
          if (claimedCartId && claimedCheckoutClaimId) {
            await releaseCartClaim(
              supabaseAdmin,
              customer?.id ?? null,
              guestToken,
              claimedCartId,
              claimedCheckoutClaimId,
            ).catch((releaseError) =>
              logEvent("error", "checkout_cart_release_failed", {
                rid,
                cart_id: claimedCartId,
                reason: String(releaseError).slice(0, 120),
              }),
            );
          }
          const known = [
            "GUEST_CART_TOKEN_REQUIRED",
            "CART_EMPTY",
            "CART_CHECKOUT_IN_PROGRESS",
            "CART_NOT_AVAILABLE",
            "PRODUCT_UNAVAILABLE",
            "INVALID_CART_ITEM",
          ];
          return fail(
            known.includes(code) ? code : "CHECKOUT_UNAVAILABLE",
            known.includes(code)
              ? "Your cart cannot be checked out right now."
              : "Checkout is temporarily unavailable.",
            known.includes(code) ? 409 : 503,
          );
        }

        const releaseClaim = async () => {
          if (!claimedCartId || !claimedCheckoutClaimId) return;
          const cartId = claimedCartId;
          const checkoutClaimId = claimedCheckoutClaimId;
          claimedCartId = undefined;
          claimedCheckoutClaimId = undefined;

          // Once an order exists, its claim-bound release RPC also records that
          // no post-payment cleanup is required for the cancelled attempt.
          if (claimedOrderId) {
            const { error } = await supabaseAdmin.rpc("release_order_cart_checkout", {
              _order_id: claimedOrderId,
            });
            if (!error) {
              claimedOrderId = undefined;
              return;
            }
            logEvent("error", "checkout_order_cart_release_failed", {
              rid,
              order_id: claimedOrderId,
              cart_id: cartId,
              reason: String(error).slice(0, 120),
            });
            // The order-bound RPC is the only safe release path once an order
            // exists. Keep the claim on uncertainty rather than risk releasing
            // a newer checkout attempt.
            return;
          }

          await releaseCartClaim(
            supabaseAdmin,
            customer?.id ?? null,
            guestToken,
            cartId,
            checkoutClaimId,
          ).catch((error) =>
            logEvent("error", "checkout_cart_release_failed", {
              rid,
              cart_id: cartId,
              reason: String(error).slice(0, 120),
            }),
          );
        };

        let keepCartClaimed = false;
        try {
          let calculated;
          try {
            calculated = await quote(supabaseAdmin, {
              items: authoritativeItems,
              userId: customer?.id ?? null,
              postalCode: parsed.shipping_address.postal_code,
              ...(parsed.coupon_code !== undefined ? { couponCode: parsed.coupon_code } : {}),
              ...(parsed.shipping_method_id !== undefined
                ? { shippingMethodId: parsed.shipping_method_id }
                : {}),
            });
          } catch {
            logEvent("error", "checkout_quote_failed", { rid });
            return fail("CHECKOUT_UNAVAILABLE", "Checkout is temporarily unavailable.", 503);
          }
          if (!calculated.ok) {
            return fail(
              calculated.code,
              calculated.message,
              calculated.code === "STORE_UNAVAILABLE" ? 503 : 409,
            );
          }
          const { totals, coupon, shipping } = calculated;

          // 4. Create the internal order first.
          const { data: numberRow, error: numberError } =
            await supabaseAdmin.rpc("next_order_number");
          if (numberError) {
            logEvent("error", "order_number_generation_failed", { rid });
            return fail("ORDER_FAILED", "We could not start your order. Please try again.", 500);
          }
          const orderNumber = (numberRow as unknown as string) ?? `MIR-${Date.now()}`;

          const { data: order, error: orderError } = await supabaseAdmin
            .from("orders")
            .insert({
              order_number: orderNumber,
              cart_id: claimedCartId!,
              cart_claim_id: claimedCheckoutClaimId!,
              cart_cleanup_status: "PENDING",
              user_id: customer?.id ?? null,
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
            await releaseClaim();
            return fail("ORDER_FAILED", "We could not start your order. Please try again.", 500);
          }
          claimedOrderId = order.id;
          await auditCommerceMutation(supabaseAdmin, {
            action: "ORDER_CREATED",
            entityType: "order",
            entityId: order.id,
            metadata: { order_number: order.order_number, guest: !customer },
          });

          const { error: itemsError } = await supabaseAdmin.from("order_items").insert(
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
          if (itemsError) {
            logEvent("error", "order_items_create_failed", { rid, order_id: order.id });
            const { error: cleanupError } = await supabaseAdmin
              .from("orders")
              .update({
                status: "CANCELLED",
                payment_status: "CANCELLED",
                cancelled_at: new Date().toISOString(),
              })
              .eq("id", order.id);
            if (cleanupError)
              logEvent("error", "order_cleanup_failed", { rid, order_id: order.id });
            await releaseClaim();
            return fail("ORDER_FAILED", "We could not start your order. Please try again.", 500);
          }

          // 5. Reserve inventory atomically; roll back on any shortfall.
          const reserved: Array<{ sku: string; quantity: number }> = [];
          for (const line of totals.items) {
            const { data: okReserve, error: reserveError } = await supabaseAdmin.rpc(
              "reserve_inventory",
              {
                _sku: line.sku,
                _qty: line.quantity,
                _reference_id: order.id,
              },
            );
            if (reserveError || !okReserve) {
              for (const r of reserved) {
                const { data: released, error: releaseError } = await supabaseAdmin.rpc(
                  "release_inventory",
                  {
                    _sku: r.sku,
                    _qty: r.quantity,
                    _reference_id: order.id,
                  },
                );
                if (releaseError || !released)
                  logEvent("error", "checkout_reservation_rollback_failed", {
                    rid,
                    order_id: order.id,
                    sku: r.sku,
                  });
              }
              const { error: cancelError } = await supabaseAdmin
                .from("orders")
                .update({ status: "CANCELLED", cancelled_at: new Date().toISOString() })
                .eq("id", order.id);
              if (cancelError)
                logEvent("error", "checkout_cancel_failed", { rid, order_id: order.id });
              await releaseClaim();
              return fail(
                reserveError ? "INVENTORY_UNAVAILABLE" : "OUT_OF_STOCK",
                reserveError
                  ? "Inventory is temporarily unavailable."
                  : "This product is no longer available.",
                reserveError ? 503 : 409,
              );
            }
            reserved.push({ sku: line.sku, quantity: line.quantity });
          }

          // 6. Create the Razorpay order server-side.
          let rzp;
          try {
            rzp = await createRazorpayOrder({
              amountPaise: toPaise(totals.grandTotal),
              currency: "INR",
              receipt: order.order_number,
              notes: { order_id: order.id },
            });
          } catch {
            logEvent("error", "razorpay_order_unavailable", { rid, order_id: order.id });
            rzp = { error: "RAZORPAY_ORDER_UNAVAILABLE" };
          }

          if ("error" in rzp) {
            for (const r of reserved) {
              const { data: released, error: releaseError } = await supabaseAdmin.rpc(
                "release_inventory",
                {
                  _sku: r.sku,
                  _qty: r.quantity,
                  _reference_id: order.id,
                },
              );
              if (releaseError || !released)
                logEvent("error", "payment_reservation_rollback_failed", {
                  rid,
                  order_id: order.id,
                  sku: r.sku,
                });
            }
            await supabaseAdmin
              .from("orders")
              .update({ status: "CANCELLED", payment_status: "FAILED" })
              .eq("id", order.id);
            await releaseClaim();
            logEvent("error", "razorpay_unavailable", { rid, order_id: order.id, code: rzp.error });
            return fail(
              rzp.error,
              rzp.error === "RAZORPAY_NOT_CONFIGURED"
                ? "Payments are not configured yet."
                : "Payment could not be started. Please try again.",
              503,
            );
          }

          const { error: orderUpdateError } = await supabaseAdmin
            .from("orders")
            .update({ razorpay_order_id: rzp.id })
            .eq("id", order.id);
          const { error: paymentError } = await supabaseAdmin.from("payments").insert({
            order_id: order.id,
            provider: "razorpay",
            razorpay_order_id: rzp.id,
            status: "PENDING",
            amount: totals.grandTotal,
            currency: "INR",
          });

          if (orderUpdateError || paymentError) {
            logEvent("error", "checkout_payment_record_failed", { rid, order_id: order.id });
            for (const r of reserved) {
              const { data: released, error: releaseError } = await supabaseAdmin.rpc(
                "release_inventory",
                { _sku: r.sku, _qty: r.quantity, _reference_id: order.id },
              );
              if (releaseError || !released)
                logEvent("error", "payment_record_rollback_failed", {
                  rid,
                  order_id: order.id,
                  sku: r.sku,
                });
            }
            const { error: cancelError } = await supabaseAdmin
              .from("orders")
              .update({ status: "CANCELLED", payment_status: "FAILED" })
              .eq("id", order.id);
            if (cancelError)
              logEvent("error", "payment_record_order_cancel_failed", { rid, order_id: order.id });
            await releaseClaim();
            return fail("ORDER_FAILED", "We could not start your payment. Please try again.", 500);
          }
          keepCartClaimed = true;
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
        } finally {
          if (!keepCartClaimed) await releaseClaim();
        }
      },
    },
  },
});
