// Thin createServerFn wrappers. All logic lives in commerce-admin.server.ts.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import * as srv from "./commerce-admin.server";

export const getIntegrationStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => srv.getIntegrationStatus(context));

export const getCommerceMetrics = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => srv.getCommerceMetrics(context));

export const getOrderDetail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { orderId: string }) => data)
  .handler(async ({ data, context }) => srv.getOrderDetail(context, data.orderId));

export const adminServiceability = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { pincode: string; weightKg?: number; declaredValue?: number }) => data)
  .handler(async ({ data, context }) => srv.adminServiceability(context, data));

export const adminCreateShipment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { orderId: string; courierId?: string | null }) => data)
  .handler(async ({ data, context }) =>
    srv.adminCreateShipment(context, data.orderId, data.courierId ?? null),
  );

export const adminSyncTracking = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { orderId: string }) => data)
  .handler(async ({ data, context }) => srv.adminSyncTracking(context, data.orderId));

export const adminCancelShipment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { orderId: string }) => data)
  .handler(async ({ data, context }) => srv.adminCancelShipment(context, data.orderId));
