import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { ok, fail, preflight } from "@/lib/api-response";

export const Route = createFileRoute("/api/public/products/$slug")({
  server: {
    handlers: {
      OPTIONS: async () => preflight(),
      GET: async ({ params }) => {
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
          .from("products")
          .select(
            "id, sku, title, slug, description, short_description, brand, product_type, material, size, color, mrp, price, compare_at_price, tax_rate, hsn_code, weight_grams, seo_title, seo_description, seo_keywords, product_images(url, alt_text, position, is_main), product_variants(id, sku, title, price, mrp, attributes, barcode), inventory(sku, available_quantity)",
          )
          .eq("slug", params.slug)
          .eq("status", "ACTIVE")
          .is("deleted_at", null)
          .maybeSingle();

        if (error) return fail("PRODUCT_UNAVAILABLE", "Could not load this product.", 500);
        if (!data) return fail("NOT_FOUND", "This product does not exist.", 404);
        return ok({ product: data });
      },
    },
  },
});
