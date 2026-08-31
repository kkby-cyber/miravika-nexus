import { createFileRoute } from "@tanstack/react-router";
import { logEvent, fail } from "@/lib/api-response";
import { applyShipmentStatus } from "@/lib/shipment.server";

/**
 * Shiprocket status callback. Shiprocket authenticates with a shared token sent
 * in `x-api-key`, configured as SHIPROCKET_WEBHOOK_TOKEN. Requests without a
 * matching token are rejected before any database write.
 */
export const Route = createFileRoute("/api/public/webhooks/shiprocket")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const expected = process.env["SHIPROCKET_WEBHOOK_TOKEN"];
        const provided = request.headers.get("x-api-key");
        if (!expected || provided !== expected) {
          logEvent("error", "shiprocket_webhook_unauthorized", {});
          return fail("UNAUTHORIZED", "Invalid token.", 401);
        }

        let body: Record<string, unknown>;
        try {
          body = (await request.json()) as Record<string, unknown>;
        } catch {
          return fail("INVALID_PAYLOAD", "Invalid payload.", 400);
        }

        const awb = String(body["awb"] ?? body["awb_code"] ?? "");
        const status = String(body["current_status"] ?? body["shipment_status"] ?? "");
        if (!awb || !status) return fail("INVALID_PAYLOAD", "Missing awb or status.", 422);

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data: shipment } = await supabaseAdmin
          .from("shipments")
          .select("*")
          .eq("awb_code", awb)
          .maybeSingle();
        if (!shipment) {
          logEvent("info", "shiprocket_webhook_unknown_awb", {});
          return new Response(JSON.stringify({ success: true, data: { ignored: true } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }

        const occurredAt =
          typeof body["current_timestamp"] === "string"
            ? new Date(body["current_timestamp"] as string).toISOString()
            : undefined;
        await applyShipmentStatus(supabaseAdmin, shipment, status, body, occurredAt);

        logEvent("info", "shiprocket_webhook_processed", { shipment_id: shipment.id });
        return new Response(JSON.stringify({ success: true, data: { received: true } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
  },
});
