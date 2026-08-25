// Thin createServerFn wrappers for the staff CRM. All logic lives in staff.server.ts.
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import * as srv from "./staff.server";

export const startStaffSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => srv.startSession(context));

export const staffHeartbeat = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { sessionId: string }) => data)
  .handler(async ({ data, context }) => srv.heartbeat(context, data.sessionId));

export const endStaffSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { sessionId: string; reason?: string }) => data)
  .handler(async ({ data, context }) => srv.endSession(context, data.sessionId, data.reason ?? "logout"));

export const revokeStaffSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { sessionId: string }) => data)
  .handler(async ({ data, context }) => srv.revokeSession(context, data.sessionId));

export const recordStaffActivity = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (data: {
      action: string;
      entityType?: string;
      entityId?: string;
      entityName?: string;
      metadata?: Record<string, unknown>;
    }) => data,
  )
  .handler(async ({ data, context }) => srv.recordActivity(context, data));

export const getStaffOverview = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => srv.getStaffOverview(context));

export const getStaffDashboardActivity = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => srv.getStaffDashboardActivity(context));

export const getStaffDetail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { staffId: string; fromIso?: string; toIso?: string }) => data)
  .handler(async ({ data, context }) =>
    srv.getStaffDetail(context, data.staffId, data.fromIso ?? null, data.toIso ?? null),
  );

export const getStaffLeaderboard = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { metric: string; days: number }) => data)
  .handler(async ({ data, context }) => srv.getLeaderboard(context, data.metric, data.days));

export const getPermissionMatrix = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => srv.getPermissionMatrix(context));

export const setRolePermission = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { role: string; permission: string; allowed: boolean }) => data)
  .handler(async ({ data, context }) => srv.setRolePermission(context, data));

export const searchAuditLog = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (data: { action?: string; actorId?: string; search?: string; fromIso?: string; toIso?: string }) => data,
  )
  .handler(async ({ data, context }) => srv.searchAuditLog(context, data));
