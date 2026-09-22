import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { ok, fail, preflight } from "@/lib/api-response";

function publicClient() {
  const key = process.env["SUPABASE_PUBLISHABLE_KEY"]!;
  return createClient<Database>(process.env["SUPABASE_URL"]!, key, {
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
}

export const Route = createFileRoute("/api/public/products")({
  server: {
    handlers: {
      OPTIONS: async () => preflight(),
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const limit = Math.min(Number(url.searchParams.get("limit") ?? 24) || 24, 100);
        const offset = Math.max(Number(url.searchParams.get("offset") ?? 0) || 0, 0);
        const search = url.searchParams.get("q");
        const collection = url.searchParams.get("collection");

        const supabase = publicClient();
        let query = supabase
          .from("products")
          .select(
            "id, sku, title, slug, short_description, brand, product_type, material, size, color, mrp, price, compare_at_price, seo_title, seo_description, product_images(url, alt_text, position, is_main), product_variants(id, sku, title, price, mrp, attributes), inventory(available_quantity)",
          )
          .eq("status", "ACTIVE")
          .is("deleted_at", null)
          .order("created_at", { ascending: false })
          .range(offset, offset + limit - 1);

        if (search) query = query.ilike("title", `%${search}%`);

        if (collection) {
          const { data: col } = await supabase
            .from("collections")
            .select("id")
            .eq("slug", collection)
            .maybeSingle();
          if (!col) return ok({ products: [], total: 0 });
          const { data: links } = await supabase
            .from("product_collections")
            .select("product_id")
            .eq("collection_id", col.id);
          const ids = (links ?? []).map((l) => l.product_id);
          if (ids.length === 0) return ok({ products: [], total: 0 });
          query = query.in("id", ids);
        }

        const { data, error } = await query;
        if (error) {
  console.error("[PUBLIC_PRODUCTS_QUERY_ERROR]", {
    requestId: request.headers.get("x-request-id"),
    code: error.code,
    message: error.message,
    details: error.details,
    hint: error.hint,
  });

  return fail("PRODUCTS_UNAVAILABLE", "Could not load products.", 500);
}
        return ok({ products: data ?? [], limit, offset });
      },
    },
  },
});
