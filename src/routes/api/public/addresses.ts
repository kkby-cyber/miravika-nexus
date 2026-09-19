import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { fail, ok, preflight } from "@/lib/api-response";
import {
  authenticatedCustomer,
  createAddress,
  listAddresses,
} from "@/lib/customer-commerce.server";
import { enforceRateLimit } from "@/lib/rate-limit.server";

const schema = z.object({
  address_type: z.enum(["shipping", "billing"]).default("shipping"),
  label: z.string().max(40).optional().nullable(),
  full_name: z.string().min(2).max(120),
  phone: z.string().min(6).max(30),
  line1: z.string().min(3).max(200),
  line2: z.string().max(200).optional().nullable(),
  landmark: z.string().max(160).optional().nullable(),
  city: z.string().min(2).max(80),
  state: z.string().min(2).max(80),
  postal_code: z.string().regex(/^[A-Za-z0-9 -]{4,12}$/),
  country: z.string().length(2).default("IN"),
  is_default: z.boolean().default(false),
});

export const Route = createFileRoute("/api/public/addresses")({
  server: {
    handlers: {
      OPTIONS: async () => preflight(),
      GET: async ({ request }) => {
        const customer = await authenticatedCustomer(request);
        if (!customer) return fail("UNAUTHORIZED", "Authentication is required.", 401);
        try {
          return ok({
            addresses: await listAddresses(
              (await import("@/integrations/supabase/client.server")).supabaseAdmin,
              customer.id,
            ),
          });
        } catch {
          return fail("ADDRESS_UNAVAILABLE", "Addresses are temporarily unavailable.", 503);
        }
      },
      POST: async ({ request }) => {
        const limit = await enforceRateLimit(request, "address-mutation", 20);
        if (limit.error)
          return fail("RATE_LIMIT_UNAVAILABLE", "Address service is temporarily unavailable.", 503);
        if (!limit.allowed) return fail("RATE_LIMITED", "Too many address requests.", 429);
        const customer = await authenticatedCustomer(request);
        if (!customer) return fail("UNAUTHORIZED", "Authentication is required.", 401);
        let input: z.infer<typeof schema>;
        try {
          input = schema.parse(await request.json());
        } catch {
          return fail("INVALID_ADDRESS", "Address fields are invalid.", 422);
        }
        try {
          return ok(
            {
              address: await createAddress(
                (await import("@/integrations/supabase/client.server")).supabaseAdmin,
                customer.id,
                input,
              ),
            },
            201,
          );
        } catch {
          return fail("ADDRESS_CREATE_FAILED", "Address could not be created.", 503);
        }
      },
    },
  },
});
