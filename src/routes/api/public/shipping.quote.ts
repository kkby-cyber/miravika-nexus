import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { ok, fail, preflight } from "@/lib/api-response";
import { checkServiceability, getShiprocketConfig } from "@/lib/shiprocket.server";

const schema = z.object({
  pincode: z.string().regex(/^\d{6}$/),
  items: z
    .array(z.object({ sku: z.string().min(1).max(64), quantity: z.number().int().min(1).max(20) }))
    .min(1)
    .max(50),
  cod: z.boolean().default(false),
});

export const Route = createFileRoute("/api/public/shipping/quote")({
  server: {
    handlers: {
      OPTIONS: async () => preflight(),
      POST: async ({ request }) => {
        let body;
        try {
          body = schema.parse(await request.json());
        } catch {
          return fail("INVALID_REQUEST", "Please provide a valid 6-digit pincode and items.", 422);
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        // Authoritative weight + value from the catalogue, never from the client.
        const skus = body.items.map((i) => i.sku);
        const { data: variants } = await supabaseAdmin
          .from("product_variants")
          .select("sku, product_id, price")
          .in("sku", skus);
        const { data: products } = await supabaseAdmin
          .from("products")
          .select("id, sku, price, weight_grams")
          .in("sku", skus);

        const productById = new Map((products ?? []).map((p) => [p.id, p]));
        const productBySku = new Map((products ?? []).map((p) => [p.sku, p]));
        const variantBySku = new Map((variants ?? []).map((v) => [v.sku, v]));

        let grams = 0;
        let declaredValue = 0;
        for (const item of body.items) {
          const variant = variantBySku.get(item.sku);
          const product = variant ? productById.get(variant.product_id) : productBySku.get(item.sku);
          if (!product) return fail("PRODUCT_UNAVAILABLE", `${item.sku} is not available.`, 409);
          grams += Number(product.weight_grams ?? 300) * item.quantity;
          declaredValue += Number(variant?.price ?? product.price) * item.quantity;
        }
        const weightKg = Math.max(0.1, Math.round((grams / 1000) * 100) / 100);

        // Configured flat-rate fallback keeps checkout working without couriers.
        const { data: methods } = await supabaseAdmin
          .from("shipping_methods")
          .select("id, name, flat_rate, free_shipping_threshold, min_days, max_days")
          .eq("is_active", true)
          .order("position")
          .limit(1);
        const method = methods?.[0] ?? null;
        const threshold = method?.free_shipping_threshold;
        const flatRate =
          method == null
            ? 0
            : threshold != null && declaredValue >= Number(threshold)
              ? 0
              : Number(method.flat_rate);

        if (!getShiprocketConfig()) {
          return ok({
            serviceable: true,
            shipping_charge: flatRate,
            currency: "INR",
            estimated_days: method ? { min: method.min_days, max: method.max_days } : null,
            couriers: [],
            source: "flat_rate",
          });
        }

        const result = await checkServiceability(supabaseAdmin, {
          deliveryPincode: body.pincode,
          weightKg,
          cod: body.cod,
          declaredValue,
        });

        if (!result.ok || result.couriers.length === 0) {
          return ok({
            serviceable: result.ok ? false : true,
            shipping_charge: flatRate,
            currency: "INR",
            estimated_days: method ? { min: method.min_days, max: method.max_days } : null,
            couriers: [],
            source: "flat_rate",
          });
        }

        const cheapest = [...result.couriers].sort((a, b) => a.rate - b.rate)[0]!;
        return ok({
          serviceable: true,
          // Customers pay the configured rate; courier cost stays internal.
          shipping_charge: flatRate,
          courier_rate: cheapest.rate,
          currency: "INR",
          estimated_days: cheapest.estimated_delivery_days ?? null,
          etd: cheapest.etd ?? null,
          cod_available: result.couriers.some((c) => c.cod_available),
          couriers: result.couriers.slice(0, 5).map((c) => ({
            name: c.courier_name,
            estimated_delivery_days: c.estimated_delivery_days,
            etd: c.etd,
          })),
          source: "shiprocket",
        });
      },
    },
  },
});
