import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { fail, ok, preflight } from "@/lib/api-response";
import { authenticatedCustomer, reviews } from "@/lib/customer-commerce.server";
import { enforceRateLimit } from "@/lib/rate-limit.server";

const schema = z.object({
  product_id: z.string().uuid(),
  rating: z.number().int().min(1).max(5),
  title: z.string().max(200).optional(),
  body: z.string().min(10).max(5000),
});

export const Route = createFileRoute("/api/public/reviews")({
  server: {
    handlers: {
      OPTIONS: async () => preflight(),
      GET: async ({ request }) => {
        const productId = new URL(request.url).searchParams.get("product_id");
        if (!productId || !z.string().uuid().safeParse(productId).success)
          return fail("INVALID_REQUEST", "A valid product_id is required.", 422);
        const summary = new URL(request.url).searchParams.get("summary") === "true";
        try {
          return ok(
            summary
              ? await reviews(
                  (await import("@/integrations/supabase/client.server")).supabaseAdmin,
                  "summary",
                  { productId },
                )
              : await reviews(
                  (await import("@/integrations/supabase/client.server")).supabaseAdmin,
                  "list",
                  { productId },
                ),
          );
        } catch {
          return fail("REVIEWS_UNAVAILABLE", "Reviews are temporarily unavailable.", 503);
        }
      },
      POST: async ({ request }) => {
        const limit = await enforceRateLimit(request, "review-mutation", 10);
        if (limit.error)
          return fail("RATE_LIMIT_UNAVAILABLE", "Reviews are temporarily unavailable.", 503);
        if (!limit.allowed) return fail("RATE_LIMITED", "Too many review requests.", 429);
        const customer = await authenticatedCustomer(request);
        if (!customer) return fail("UNAUTHORIZED", "Authentication is required.", 401);
        let input: z.infer<typeof schema>;
        try {
          input = schema.parse(await request.json());
        } catch {
          return fail("INVALID_REVIEW", "Review fields are invalid.", 422);
        }
        try {
          return ok(
            {
              review: await reviews(
                (await import("@/integrations/supabase/client.server")).supabaseAdmin,
                "create",
                {
                  productId: input.product_id,
                  customerId: customer.id,
                  rating: input.rating,
                  ...(input.title !== undefined ? { title: input.title } : {}),
                  body: input.body,
                },
              ),
            },
            201,
          );
        } catch {
          return fail("REVIEW_CREATE_FAILED", "Review could not be created.", 409);
        }
      },
    },
  },
});
