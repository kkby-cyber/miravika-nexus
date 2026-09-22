import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { ok, fail, preflight } from "@/lib/api-response";

export const Route = createFileRoute("/api/public/collections")({
  server: {
    handlers: {
      OPTIONS: async () => preflight(),
      GET: async ({ request }) => {
        const key = process.env["SUPABASE_PUBLISHABLE_KEY"]!;
        const supabase = createClient<Database>(process.env["SUPABASE_URL"]!, key, {
          auth: { persistSession: false },
          global: {
            fetch: (input, init) => {
              const h = new Headers(init?.headers);
              if (key.startsWith("sb_") && h.get("Authorization") === `Bearer ${key}`)
                h.delete("Authorization");
              h.set("apikey", key);
              return fetch(input, { ...init, headers: h });
            },
          },
        });

        const { data, error } = await supabase
          .from("collections")
          .select("id, title, slug, description, image_url, position, seo_title, seo_description")
          .eq("status", "ACTIVE")
          .is("deleted_at", null)
          .order("position");

if (error) {
  console.error("[PUBLIC_COLLECTIONS_QUERY_ERROR]", {
    requestId: request.headers.get("x-request-id"),
    code: error.code,
    message: error.message,
    details: error.details,
    hint: error.hint,
  });

  return fail("COLLECTIONS_UNAVAILABLE", "Could not load collections.", 500);
}        return ok({ collections: data ?? [] });
      },
    },
  },
});
