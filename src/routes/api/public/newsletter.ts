import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { fail, ok, preflight } from "@/lib/api-response";
import { newsletter } from "@/lib/customer-commerce.server";
import { enforceRateLimit } from "@/lib/rate-limit.server";

const schema = z.object({ email: z.string().email().max(254) });

export const Route = createFileRoute("/api/public/newsletter")({
  server: {
    handlers: {
      OPTIONS: async () => preflight(),
      GET: async ({ request }) => {
        const email = new URL(request.url).searchParams.get("email");
        if (!email) return fail("INVALID_EMAIL", "A valid email is required.", 422);
        try {
          return ok(
            await newsletter(
              (await import("@/integrations/supabase/client.server")).supabaseAdmin,
              "status",
              email,
            ),
          );
        } catch {
          return fail(
            "NEWSLETTER_UNAVAILABLE",
            "Newsletter status is temporarily unavailable.",
            503,
          );
        }
      },
      POST: async ({ request }) => {
        const limit = await enforceRateLimit(request, "newsletter-mutation", 10);
        if (limit.error)
          return fail(
            "RATE_LIMIT_UNAVAILABLE",
            "Newsletter service is temporarily unavailable.",
            503,
          );
        if (!limit.allowed) return fail("RATE_LIMITED", "Too many newsletter requests.", 429);
        let input: z.infer<typeof schema>;
        try {
          input = schema.parse(await request.json());
        } catch {
          return fail("INVALID_EMAIL", "A valid email is required.", 422);
        }
        try {
          return ok(
            await newsletter(
              (await import("@/integrations/supabase/client.server")).supabaseAdmin,
              "subscribe",
              input.email,
            ),
            201,
          );
        } catch {
          return fail("NEWSLETTER_WRITE_FAILED", "Subscription could not be saved.", 503);
        }
      },
      DELETE: async ({ request }) => {
        const limit = await enforceRateLimit(request, "newsletter-mutation", 10);
        if (limit.error)
          return fail(
            "RATE_LIMIT_UNAVAILABLE",
            "Newsletter service is temporarily unavailable.",
            503,
          );
        if (!limit.allowed) return fail("RATE_LIMITED", "Too many newsletter requests.", 429);
        let input: z.infer<typeof schema>;
        try {
          input = schema.parse(await request.json());
        } catch {
          return fail("INVALID_EMAIL", "A valid email is required.", 422);
        }
        try {
          return ok(
            await newsletter(
              (await import("@/integrations/supabase/client.server")).supabaseAdmin,
              "unsubscribe",
              input.email,
            ),
          );
        } catch {
          return fail("NEWSLETTER_WRITE_FAILED", "Subscription could not be updated.", 503);
        }
      },
    },
  },
});
