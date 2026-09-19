import { createFileRoute } from "@tanstack/react-router";
import { fail, ok, preflight } from "@/lib/api-response";
import { authenticatedCustomer } from "@/lib/customer-commerce.server";

export const Route = createFileRoute("/api/public/customer-orders")({
  server: {
    handlers: {
      OPTIONS: async () => preflight(),
      GET: async ({ request }) => {
        const customer = await authenticatedCustomer(request);
        if (!customer) return fail("UNAUTHORIZED", "Authentication is required.", 401);
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data, error } = await supabaseAdmin
          .from("orders")
          .select(
            "id, order_number, status, payment_status, grand_total, currency, created_at, paid_at, tracking_number, tracking_url, order_items(title, sku, quantity, line_total)",
          )
          .eq("user_id", customer.id)
          .order("created_at", { ascending: false });
        if (error) return fail("ORDERS_UNAVAILABLE", "Orders are temporarily unavailable.", 503);
        return ok({ orders: data ?? [] });
      },
    },
  },
});
