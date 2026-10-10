import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

// Readiness differs from /api/health: it proves the database is reachable and that the
// server secrets needed for commerce are configured. It reports only booleans — never
// secret values, connection strings or provider error messages.
function configured(name: string) {
  return Boolean(process.env[name]?.trim());
}

async function databaseReachable(): Promise<boolean> {
  const url = process.env["SUPABASE_URL"];
  const key = process.env["SUPABASE_PUBLISHABLE_KEY"];
  if (!url || !key) return false;
  try {
    const supabase = createClient<Database>(url, key, {
      auth: { persistSession: false },
      global: {
        fetch: (input, init) => {
          const h = new Headers(init?.headers);
          if (key.startsWith("sb_") && h.get("Authorization") === `Bearer ${key}`)
            h.delete("Authorization");
          h.set("apikey", key);
          return fetch(input, { ...init, headers: h, signal: AbortSignal.timeout(4000) });
        },
      },
    });
    const { error } = await supabase.from("collections").select("id", { head: true }).limit(1);
    return !error;
  } catch {
    return false;
  }
}

export const Route = createFileRoute("/api/ready")({
  server: {
    handlers: {
      GET: async () => {
        const database = await databaseReachable();
        const checks = {
          database,
          supabase_service_role: configured("SUPABASE_SERVICE_ROLE_KEY"),
          razorpay: configured("RAZORPAY_KEY_ID") && configured("RAZORPAY_KEY_SECRET"),
          razorpay_webhook: configured("RAZORPAY_WEBHOOK_SECRET"),
          shiprocket: configured("SHIPROCKET_EMAIL") && configured("SHIPROCKET_PASSWORD"),
        };
        const ready = database && checks.supabase_service_role;
        return Response.json(
          {
            status: ready ? "ready" : "not_ready",
            service: "miravika-nexus",
            checks,
            timestamp: new Date().toISOString(),
          },
          { status: ready ? 200 : 503, headers: { "cache-control": "no-store" } },
        );
      },
    },
  },
});
