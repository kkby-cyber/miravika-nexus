import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { fail, ok, preflight } from "@/lib/api-response";
import { authenticatedCustomer, wishlist } from "@/lib/customer-commerce.server";
import { enforceRateLimit } from "@/lib/rate-limit.server";

const schema = z.object({
  action: z.enum(["add", "remove"]),
  product_id: z.string().uuid(),
  variant_id: z.string().uuid().nullable().optional(),
});

export const Route = createFileRoute("/api/public/wishlist")({
  server: {
    handlers: {
      OPTIONS: async () => preflight(),
      GET: async ({ request }) => {
        const customer = await authenticatedCustomer(request);
        if (!customer) return fail("UNAUTHORIZED", "Authentication is required.", 401);
        try {
          return ok(
            await wishlist(
              (await import("@/integrations/supabase/client.server")).supabaseAdmin,
              customer.id,
              "get",
            ),
          );
        } catch {
          return fail("WISHLIST_UNAVAILABLE", "Wishlist is temporarily unavailable.", 503);
        }
      },
      POST: async ({ request }) => {
        const limit = await enforceRateLimit(request, "wishlist-mutation", 30);
        if (limit.error)
          return fail("RATE_LIMIT_UNAVAILABLE", "Wishlist is temporarily unavailable.", 503);
        if (!limit.allowed) return fail("RATE_LIMITED", "Too many wishlist requests.", 429);
        const customer = await authenticatedCustomer(request);
        if (!customer) return fail("UNAUTHORIZED", "Authentication is required.", 401);
        let input: z.infer<typeof schema>;
        try {
          input = schema.parse(await request.json());
        } catch {
          return fail("INVALID_REQUEST", "Wishlist request is invalid.", 422);
        }
        try {
          return ok(
            await wishlist(
              (await import("@/integrations/supabase/client.server")).supabaseAdmin,
              customer.id,
              input.action,
              input.product_id,
              input.variant_id ?? null,
            ),
          );
        } catch {
          return fail("WISHLIST_WRITE_FAILED", "Wishlist could not be updated.", 503);
        }
      },
    },
  },
});
