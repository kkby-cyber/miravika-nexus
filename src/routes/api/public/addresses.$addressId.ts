import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { fail, ok, preflight } from "@/lib/api-response";
import {
  authenticatedCustomer,
  deleteAddress,
  updateAddress,
} from "@/lib/customer-commerce.server";
import { enforceRateLimit } from "@/lib/rate-limit.server";

const schema = z.object({
  address_type: z.enum(["shipping", "billing"]).optional(),
  label: z.string().max(40).optional().nullable(),
  full_name: z.string().min(2).max(120).optional(),
  phone: z.string().min(6).max(30).optional(),
  line1: z.string().min(3).max(200).optional(),
  line2: z.string().max(200).optional().nullable(),
  landmark: z.string().max(160).optional().nullable(),
  city: z.string().min(2).max(80).optional(),
  state: z.string().min(2).max(80).optional(),
  postal_code: z
    .string()
    .regex(/^[A-Za-z0-9 -]{4,12}$/)
    .optional(),
  country: z.string().length(2).optional(),
  is_default: z.boolean().optional(),
});

export const Route = createFileRoute("/api/public/addresses/$addressId")({
  server: {
    handlers: {
      OPTIONS: async () => preflight(),
      PATCH: async ({ request, params }) => {
        const limit = await enforceRateLimit(request, "address-mutation", 20);
        if (limit.error)
          return fail("RATE_LIMIT_UNAVAILABLE", "Address service is temporarily unavailable.", 503);
        if (!limit.allowed) return fail("RATE_LIMITED", "Too many address requests.", 429);
        const customer = await authenticatedCustomer(request);
        if (!customer) return fail("UNAUTHORIZED", "Authentication is required.", 401);
        let input: Record<string, unknown>;
        try {
          input = schema.parse(await request.json());
        } catch {
          return fail("INVALID_ADDRESS", "Address fields are invalid.", 422);
        }
        try {
          return ok({
            address: await updateAddress(
              (await import("@/integrations/supabase/client.server")).supabaseAdmin,
              customer.id,
              params.addressId,
              input,
            ),
          });
        } catch {
          return fail("ADDRESS_UPDATE_FAILED", "Address could not be updated.", 503);
        }
      },
      DELETE: async ({ request, params }) => {
        const limit = await enforceRateLimit(request, "address-mutation", 20);
        if (limit.error)
          return fail("RATE_LIMIT_UNAVAILABLE", "Address service is temporarily unavailable.", 503);
        if (!limit.allowed) return fail("RATE_LIMITED", "Too many address requests.", 429);
        const customer = await authenticatedCustomer(request);
        if (!customer) return fail("UNAUTHORIZED", "Authentication is required.", 401);
        try {
          return ok(
            await deleteAddress(
              (await import("@/integrations/supabase/client.server")).supabaseAdmin,
              customer.id,
              params.addressId,
            ),
          );
        } catch {
          return fail("ADDRESS_DELETE_FAILED", "Address could not be deleted.", 503);
        }
      },
    },
  },
});
