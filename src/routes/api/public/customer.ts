import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { fail, ok, preflight } from "@/lib/api-response";
import { authenticatedCustomer, getProfile, updateProfile } from "@/lib/customer-commerce.server";
import { enforceRateLimit } from "@/lib/rate-limit.server";

const schema = z.object({
  full_name: z.string().min(2).max(120).optional(),
  phone: z.string().min(6).max(30).optional(),
  marketing_opt_in: z.boolean().optional(),
});

export const Route = createFileRoute("/api/public/customer")({
  server: {
    handlers: {
      OPTIONS: async () => preflight(),
      GET: async ({ request }) => {
        const customer = await authenticatedCustomer(request);
        if (!customer) return fail("UNAUTHORIZED", "Authentication is required.", 401);
        try {
          return ok({
            profile: await getProfile(
              (await import("@/integrations/supabase/client.server")).supabaseAdmin,
              customer.id,
            ),
          });
        } catch {
          return fail("PROFILE_UNAVAILABLE", "Profile is temporarily unavailable.", 503);
        }
      },
      PATCH: async ({ request }) => {
        const limit = await enforceRateLimit(request, "customer-profile-mutation", 20);
        if (limit.error)
          return fail("RATE_LIMIT_UNAVAILABLE", "Profile service is temporarily unavailable.", 503);
        if (!limit.allowed) return fail("RATE_LIMITED", "Too many profile requests.", 429);
        const customer = await authenticatedCustomer(request);
        if (!customer) return fail("UNAUTHORIZED", "Authentication is required.", 401);
        let input: z.infer<typeof schema>;
        try {
          input = schema.parse(await request.json());
        } catch {
          return fail("INVALID_REQUEST", "Profile fields are invalid.", 422);
        }
        try {
          return ok({
            profile: await updateProfile(
              (await import("@/integrations/supabase/client.server")).supabaseAdmin,
              customer.id,
              {
                ...(input.full_name !== undefined ? { full_name: input.full_name } : {}),
                ...(input.phone !== undefined ? { phone: input.phone } : {}),
                ...(input.marketing_opt_in !== undefined
                  ? { marketing_opt_in: input.marketing_opt_in }
                  : {}),
              },
            ),
          });
        } catch {
          return fail("PROFILE_UPDATE_FAILED", "Profile could not be updated.", 503);
        }
      },
    },
  },
});
