import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { ok, fail, preflight } from "@/lib/api-response";
import { enforceRateLimit } from "@/lib/rate-limit.server";

const schema = z.object({
  order_number: z.string().min(4).max(40),
  email: z.string().email(),
});

/**
 * Customer order tracking. Requires the order number AND the email on the order,
 * so no order data can be enumerated from the order number alone.
 */
export const Route = createFileRoute("/api/public/orders/track")({
  server: {
    handlers: {
      OPTIONS: async () => preflight(),
      POST: async ({ request }) => {
        const rateLimit = await enforceRateLimit(request, "order-tracking", 20);
        if (rateLimit.error)
          return fail("RATE_LIMIT_UNAVAILABLE", "Order tracking is temporarily unavailable.", 503);
        if (!rateLimit.allowed) return fail("RATE_LIMITED", "Too many tracking requests.", 429);
        let body;
        try {
          body = schema.parse(await request.json());
        } catch {
          return fail("INVALID_REQUEST", "Order number and email are required.", 422);
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data: order, error: orderError } = await supabaseAdmin
          .from("orders")
          .select(
            "id, order_number, status, payment_status, grand_total, currency, tracking_number, tracking_url, created_at, paid_at",
          )
          .eq("order_number", body.order_number.toUpperCase())
          .ilike("email", body.email)
          .maybeSingle();

        if (orderError)
          return fail("ORDER_UNAVAILABLE", "Order tracking is temporarily unavailable.", 503);
        if (!order) return fail("NOT_FOUND", "We could not find that order.", 404);

        const [{ data: items, error: itemsError }, { data: shipment, error: shipmentError }] =
          await Promise.all([
            supabaseAdmin
              .from("order_items")
              .select("title, sku, quantity, line_total")
              .eq("order_id", order.id),
            supabaseAdmin
              .from("shipments")
              .select(
                "status, courier_name, awb_code, tracking_url, estimated_delivery_date, shipped_at, delivered_at",
              )
              .eq("order_id", order.id)
              .maybeSingle(),
          ]);

        const { data: events, error: eventsError } = await supabaseAdmin
          .from("shipment_events")
          .select("status, location, occurred_at")
          .eq("order_id", order.id)
          .order("occurred_at", { ascending: false })
          .limit(20);

        if (itemsError || shipmentError || eventsError)
          return fail("TRACKING_UNAVAILABLE", "Order tracking is temporarily unavailable.", 503);
        return ok({
          order_number: order.order_number,
          status: order.status,
          payment_status: order.payment_status,
          total: Number(order.grand_total),
          currency: order.currency,
          placed_at: order.created_at,
          paid_at: order.paid_at,
          items: items ?? [],
          shipment: shipment ?? null,
          tracking: {
            awb: shipment?.awb_code ?? order.tracking_number ?? null,
            url: shipment?.tracking_url ?? order.tracking_url ?? null,
            courier: shipment?.courier_name ?? null,
          },
          timeline: events ?? [],
        });
      },
    },
  },
});
