import { createFileRoute } from "@tanstack/react-router";
import { logEvent, fail } from "@/lib/api-response";
import { applyShipmentStatus } from "@/lib/shipment.server";
import { getServerEnv } from "@/lib/env.server";
import { shipmentEventKey } from "@/lib/shipment-state";

/**
 * Shiprocket status callback. Shiprocket authenticates with a shared token sent
 * in `x-api-key`, configured as SHIPROCKET_WEBHOOK_TOKEN. Requests without a
 * matching token are rejected before any database write.
 */
export const Route = createFileRoute("/api/public/webhooks/shiprocket")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const expected = getServerEnv().shiprocketWebhookToken;
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
        const { data: shipment, error: shipmentError } = await supabaseAdmin
          .from("shipments")
          .select("*")
          .eq("awb_code", awb)
          .maybeSingle();
        if (shipmentError)
          return fail("WEBHOOK_UNAVAILABLE", "Webhook processing will be retried.", 503);
        if (!shipment) {
          logEvent("info", "shiprocket_webhook_unknown_awb", {});
          return new Response(JSON.stringify({ success: true, data: { ignored: true } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }

        const rawOccurredAt =
          typeof body["current_timestamp"] === "string" ? body["current_timestamp"] : null;
        const occurredAt =
          rawOccurredAt && !Number.isNaN(new Date(rawOccurredAt).getTime())
            ? new Date(rawOccurredAt).toISOString()
            : undefined;
        const providerEventId = String(body["event_id"] ?? body["id"] ?? "") || null;
        const eventKey = shipmentEventKey({ providerEventId, awb, status, occurredAt });
        const result = await applyShipmentStatus(
          supabaseAdmin,
          shipment,
          status,
          body,
          occurredAt,
          eventKey,
          providerEventId,
        );
        if (result && !result.ok)
          return fail("WEBHOOK_UNAVAILABLE", "Webhook processing will be retried.", 503);

        logEvent("info", "shiprocket_webhook_processed", { shipment_id: shipment.id });
        return new Response(JSON.stringify({ success: true, data: { received: true } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
  },
});
