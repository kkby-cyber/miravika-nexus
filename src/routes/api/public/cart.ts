import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { fail, ok, preflight } from "@/lib/api-response";
import { enforceRateLimit } from "@/lib/rate-limit.server";
import {
  addCartItem,
  authenticatedCustomer,
  clearCart,
  getCart,
  mergeGuestCart,
  newGuestToken,
  removeCartItem,
  updateCartItem,
} from "@/lib/customer-commerce.server";

const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("add"),
    sku: z.string().min(1).max(64),
    quantity: z.number().int().positive().max(50),
  }),
  z.object({
    action: z.literal("update"),
    cart_item_id: z.string().uuid(),
    quantity: z.number().int().positive().max(50),
  }),
  z.object({ action: z.literal("remove"), cart_item_id: z.string().uuid() }),
  z.object({ action: z.literal("clear") }),
  z.object({ action: z.literal("merge"), guest_token: z.string().min(32).max(128) }),
]);

async function db() {
  return (await import("@/integrations/supabase/client.server")).supabaseAdmin;
}

function guestToken(request: Request) {
  const value = request.headers.get("x-cart-token");
  return value && /^[a-zA-Z0-9_-]{32,128}$/.test(value) ? value : null;
}

export const Route = createFileRoute("/api/public/cart")({
  server: {
    handlers: {
      OPTIONS: async () => preflight(),
      GET: async ({ request }) => {
        const customer = await authenticatedCustomer(request);
        if (request.headers.get("authorization") && !customer)
          return fail("UNAUTHORIZED", "The supplied session is invalid.", 401);
        const token = customer ? null : (guestToken(request) ?? newGuestToken());
        try {
          const result = await getCart(await db(), customer?.id ?? null, token);
          return ok({ ...result, cart_token: customer ? null : token });
        } catch (error) {
          return fail(
            String(error).includes("TOKEN") ? "GUEST_CART_TOKEN_REQUIRED" : "CART_UNAVAILABLE",
            "Cart is temporarily unavailable.",
            400,
          );
        }
      },
      POST: async ({ request }) => {
        const limit = await enforceRateLimit(request, "cart-mutation", 60);
        if (limit.error)
          return fail("RATE_LIMIT_UNAVAILABLE", "Cart is temporarily unavailable.", 503);
        if (!limit.allowed) return fail("RATE_LIMITED", "Too many cart requests.", 429);
        let body: z.infer<typeof schema>;
        try {
          body = schema.parse(await request.json());
        } catch {
          return fail("INVALID_REQUEST", "Cart request is invalid.", 422);
        }
        const customer = await authenticatedCustomer(request);
        if (request.headers.get("authorization") && !customer)
          return fail("UNAUTHORIZED", "The supplied session is invalid.", 401);
        if (body.action === "merge" && !customer)
          return fail("UNAUTHORIZED", "Authentication is required to merge a guest cart.", 401);
        const token = customer
          ? null
          : (guestToken(request) ?? (body.action === "merge" ? body.guest_token : newGuestToken()));
        try {
          const admin = await db();
          const owner = { customerId: customer?.id ?? null, guestToken: token };
          const result =
            body.action === "add"
              ? await addCartItem(admin, owner.customerId, owner.guestToken, body)
              : body.action === "update"
                ? await updateCartItem(admin, body.cart_item_id, body.quantity, owner)
                : body.action === "remove"
                  ? await removeCartItem(admin, body.cart_item_id, owner)
                  : body.action === "clear"
                    ? await clearCart(admin, owner)
                    : await mergeGuestCart(admin, customer!.id, body.guest_token);
          return ok({ ...result, cart_token: customer ? null : token });
        } catch (error) {
          const code = String(error).replace("Error: ", "");
          const known = [
            "PRODUCT_UNAVAILABLE",
            "OUT_OF_STOCK",
            "INVALID_QUANTITY",
            "CART_NOT_ACTIVE",
            "CART_ITEM_NOT_FOUND",
            "GUEST_CART_TOKEN_REQUIRED",
          ];
          return fail(
            known.includes(code) ? code : "CART_UNAVAILABLE",
            known.includes(code)
              ? "Cart request cannot be completed."
              : "Cart is temporarily unavailable.",
            known.includes(code) ? 409 : 503,
          );
        }
      },
    },
  },
});
