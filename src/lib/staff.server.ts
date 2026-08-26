// Server-only staff CRM logic. Imported by staff.functions.ts only.
import { getRequest } from "@tanstack/react-start/server";
import {
  ALL_PERMISSIONS,
  DEFAULT_INACTIVITY_MINUTES,
  ONLINE_WINDOW_MINUTES,
  type Presence,
  type StaffRole,
} from "./staff-constants";

type StaffCtx = { supabase: any; userId: string };

export function requestMeta() {
  const req = getRequest();
  const headers = req?.headers;
  const forwarded = headers?.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = forwarded || headers?.get("cf-connecting-ip") || null;
  const ua = headers?.get("user-agent") || null;
  return { ip, ua };
}

export async function requireStaff(ctx: StaffCtx) {
  const { data, error } = await ctx.supabase.rpc("is_staff", { _user_id: ctx.userId });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Forbidden: staff access required");
}

export async function requirePermission(ctx: StaffCtx, permission: string) {
  const { data, error } = await ctx.supabase.rpc("has_permission", {
    _user_id: ctx.userId,
    _permission: permission,
  });
  if (error) throw new Error(error.message);
  if (!data) throw new Error(`Forbidden: missing permission ${permission}`);
}

async function getInactivityThreshold(db: any): Promise<number> {
  const { data } = await db
    .from("site_settings")
    .select("value")
    .eq("key", "staff_inactivity_minutes")
    .maybeSingle();
  const v = Number(data?.value);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_INACTIVITY_MINUTES;
}

function sessionSeconds(
  s: { started_at: string; ended_at: string | null; revoked_at: string | null; last_activity_at: string },
  nowMs: number,
  thresholdMin: number,
): number {
  const start = new Date(s.started_at).getTime();
  let endMs: number;
  if (s.ended_at) endMs = new Date(s.ended_at).getTime();
  else if (s.revoked_at) endMs = new Date(s.revoked_at).getTime();
  else endMs = Math.min(new Date(s.last_activity_at).getTime() + thresholdMin * 60000, nowMs);
  return Math.max(0, Math.round((endMs - start) / 1000));
}

function presenceOf(
  active: { last_activity_at: string } | undefined,
  nowMs: number,
  thresholdMin: number,
): Presence {
  if (!active) return "OFFLINE";
  const idleMs = nowMs - new Date(active.last_activity_at).getTime();
  return idleMs <= thresholdMin * 60000 ? "ONLINE" : "IDLE";
}

// ---------- Sessions ----------

export async function startSession(ctx: StaffCtx) {
  await requireStaff(ctx);
  const db = ctx.supabase;
  const meta = requestMeta();
  const { data, error } = await db
    .from("staff_sessions")
    .insert({ user_id: ctx.userId, ip_address: meta.ip, user_agent: meta.ua })
    .select("id, started_at")
    .single();
  if (error) throw new Error(error.message);
  await db.rpc("log_staff_activity", {
    _action: "LOGIN",
    _entity_type: "session",
    _entity_id: data.id,
    _entity_name: "Staff login",
    _ip: meta.ip,
    _user_agent: meta.ua,
  });
  return { sessionId: data.id as string, startedAt: data.started_at as string };
}

export async function heartbeat(ctx: StaffCtx, sessionId: string) {
  const db = ctx.supabase;
  const { data, error } = await db
    .from("staff_sessions")
    .update({ last_activity_at: new Date().toISOString() })
    .eq("id", sessionId)
    .eq("user_id", ctx.userId)
    .is("ended_at", null)
    .is("revoked_at", null)
    .select("id")
    .maybeSingle();
  if (error) throw new Error(error.message);
  return { status: data ? "ACTIVE" : "ENDED" };
}

export async function endSession(ctx: StaffCtx, sessionId: string, reason: string) {
  const db = ctx.supabase;
  const meta = requestMeta();
  const { data } = await db
    .from("staff_sessions")
    .update({ ended_at: new Date().toISOString(), end_reason: reason.slice(0, 40) })
    .eq("id", sessionId)
    .eq("user_id", ctx.userId)
    .is("ended_at", null)
    .select("id")
    .maybeSingle();
  if (data) {
    await db.rpc("log_staff_activity", {
      _action: "LOGOUT",
      _entity_type: "session",
      _entity_id: sessionId,
      _entity_name: "Staff logout",
      _ip: meta.ip,
      _user_agent: meta.ua,
    });
  }
  return { ok: true };
}

export async function revokeSession(ctx: StaffCtx, sessionId: string) {
  await requirePermission(ctx, "staff.manage");
  const db = ctx.supabase;
  const meta = requestMeta();
  const { data: target, error } = await db
    .from("staff_sessions")
    .update({
      revoked_at: new Date().toISOString(),
      revoked_by: ctx.userId,
      end_reason: "revoked",
    })
    .eq("id", sessionId)
    .is("ended_at", null)
    .is("revoked_at", null)
    .select("id, user_id")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!target) throw new Error("Session not found or already ended");
  await db.rpc("log_staff_activity", {
    _action: "SESSION_REVOKED",
    _entity_type: "session",
    _entity_id: sessionId,
    _entity_name: "Session revoked",
    _metadata: { target_user_id: target.user_id },
    _ip: meta.ip,
    _user_agent: meta.ua,
  });
  return { ok: true };
}

export async function recordActivity(
  ctx: StaffCtx,
  input: { action: string; entityType?: string; entityId?: string; entityName?: string; metadata?: Record<string, unknown> },
) {
  await requireStaff(ctx);
  const action = String(input.action || "").slice(0, 80);
  if (!/^[A-Z0-9_ ]{2,80}$/.test(action)) throw new Error("Invalid action");
  const meta = requestMeta();
  const { error } = await ctx.supabase.rpc("log_staff_activity", {
    _action: action,
    _entity_type: input.entityType?.slice(0, 60) ?? null,
    _entity_id: input.entityId?.slice(0, 120) ?? null,
    _entity_name: input.entityName?.slice(0, 200) ?? null,
    _metadata: input.metadata ?? {},
    _ip: meta.ip,
    _user_agent: meta.ua,
  });
  if (error) throw new Error(error.message);
  return { ok: true };
}

// ---------- Staff overview / dashboard ----------

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

export async function getStaffOverview(ctx: StaffCtx) {
  await requirePermission(ctx, "staff.view");
  const db = ctx.supabase;
  const thresholdMin = await getInactivityThreshold(db);
  const nowMs = Date.now();
  const today = startOfToday();
  const weekAgo = new Date(nowMs - 7 * 86400000);

  const [{ data: roleRows }, { data: profiles }, { data: sessions }, { data: weekLogs }] =
    await Promise.all([
      db.from("user_roles").select("user_id, role"),
      db.from("profiles").select("id, email, full_name, created_at"),
      db
        .from("staff_sessions")
        .select("id, user_id, started_at, ended_at, revoked_at, last_activity_at, user_agent, ip_address")
        .gte("started_at", weekAgo.toISOString())
        .order("started_at", { ascending: false }),
      db
        .from("audit_logs")
        .select("actor_id, action, entity_type, created_at")
        .gte("created_at", weekAgo.toISOString())
        .limit(10000),
    ]);
  const todayLogs = (weekLogs ?? []).filter((l: any) => new Date(l.created_at) >= today);

  const staffIds = new Set((roleRows ?? []).map((r: any) => r.user_id));
  const staffProfiles = (profiles ?? []).filter((p: any) => staffIds.has(p.id));
  const logs = todayLogs ?? [];

  const staff = staffProfiles.map((p: any) => {
    const userSessions = (sessions ?? []).filter((s: any) => s.user_id === p.id);
    const active = userSessions.find((s: any) => !s.ended_at && !s.revoked_at);
    const todaySessions = userSessions.filter((s: any) => new Date(s.started_at) >= today);
    const todaySec = todaySessions.reduce(
      (sum: number, s: any) => sum + sessionSeconds(s, nowMs, thresholdMin),
      0,
    );
    const weekSec = userSessions.reduce(
      (sum: number, s: any) => sum + sessionSeconds(s, nowMs, thresholdMin),
      0,
    );
    const userLogs = logs.filter((l: any) => l.actor_id === p.id);
    return {
      id: p.id,
      name: p.full_name || p.email || "Staff member",
      email: p.email,
      roles: (roleRows ?? []).filter((r: any) => r.user_id === p.id).map((r: any) => r.role as StaffRole),
      createdAt: p.created_at,
      presence: presenceOf(active, nowMs, thresholdMin),
      currentSessionId: active?.id ?? null,
      sessionStartedAt: active?.started_at ?? null,
      lastActivityAt: active?.last_activity_at ?? userSessions[0]?.last_activity_at ?? null,
      totalSessions: userSessions.length,
      todayActiveSec: todaySec,
      weekActiveSec: weekSec,
      todayActions: userLogs.length,
      weekActions: 0,
    };
  });

  const counts: Record<Presence, number> = { ONLINE: 0, IDLE: 0, OFFLINE: 0 };
  staff.forEach((s: { presence: Presence }) => {
    counts[s.presence] += 1;
  });

  return {
    thresholdMinutes: thresholdMin,
    totals: {
      staff: staff.length,
      online: counts.ONLINE,
      idle: counts.IDLE,
      offline: counts.OFFLINE,
      todayActions: logs.length,
      todayActiveSec: staff.reduce(
        (sum: number, s: { todayActiveSec: number }) => sum + s.todayActiveSec,
        0,
      ),
    },
    staff,
  };
}

export async function getStaffDashboardActivity(ctx: StaffCtx) {
  await requireStaff(ctx);
  const db = ctx.supabase;
  const { data: logs } = await db
    .from("audit_logs")
    .select("id, actor_id, action, entity_type, entity_id, entity_name, created_at")
    .order("created_at", { ascending: false })
    .limit(12);
  const actorIds = [...new Set((logs ?? []).map((l: any) => l.actor_id).filter(Boolean))];
  const { data: actors } = actorIds.length
    ? await db.from("profiles").select("id, full_name, email").in("id", actorIds)
    : { data: [] };
  const nameOf = (id: string | null) => {
    const a = (actors ?? []).find((p: any) => p.id === id);
    return a ? a.full_name || a.email : "System";
  };
  return (logs ?? []).map((l: any) => ({ ...l, actor_name: nameOf(l.actor_id) }));
}

// ---------- Staff detail ----------

export async function getStaffDetail(
  ctx: StaffCtx,
  staffId: string,
  fromIso: string | null,
  toIso: string | null,
) {
  if (ctx.userId !== staffId) await requirePermission(ctx, "staff.view");
  else await requireStaff(ctx);
  const db = ctx.supabase;
  const thresholdMin = await getInactivityThreshold(db);
  const nowMs = Date.now();
  const from = fromIso ? new Date(fromIso) : startOfToday();
  const to = toIso ? new Date(toIso) : new Date(nowMs + 60000);

  const [
    { data: profile },
    { data: roles },
    { data: sessions },
    { data: logs },
    { data: permRows },
  ] = await Promise.all([
    db.from("profiles").select("id, email, full_name, created_at").eq("id", staffId).maybeSingle(),
    db.from("user_roles").select("role, created_at").eq("user_id", staffId),
    db
      .from("staff_sessions")
      .select("id, started_at, ended_at, revoked_at, end_reason, last_activity_at, ip_address, user_agent")
      .eq("user_id", staffId)
      .order("started_at", { ascending: false })
      .limit(50),
    db
      .from("audit_logs")
      .select("id, action, entity_type, entity_id, entity_name, metadata, ip_address, user_agent, created_at")
      .eq("actor_id", staffId)
      .gte("created_at", from.toISOString())
      .lte("created_at", to.toISOString())
      .order("created_at", { ascending: false })
      .limit(300),
    db.from("role_permissions").select("role, permission"),
  ]);

  if (!profile) throw new Error("Staff member not found");

  const roleList: StaffRole[] = (roles ?? []).map((r: any) => r.role as StaffRole);
  const permissions: string[] = ((permRows ?? []) as Array<{ role: string; permission: string }>)
    .filter((p) => (roleList as string[]).includes(p.role))
    .map((p) => p.permission);
  const uniquePerms: string[] = Array.from(new Set(permissions)).sort();

  const sessionList = (sessions ?? []).map((s: any) => ({
    ...s,
    durationSec: sessionSeconds(s, nowMs, thresholdMin),
  }));
  const active = sessionList.find((s: any) => !s.ended_at && !s.revoked_at);

  const list = logs ?? [];
  const countWhere = (pred: (l: any) => boolean) => list.filter(pred).length;
  const performance = {
    totalActions: list.length,
    productsCreated: countWhere((l) => l.entity_type === "product" && l.action === "insert"),
    productsEdited: countWhere((l) => l.entity_type === "product" && l.action === "update"),
    imagesUploaded: countWhere((l) => l.action === "PRODUCT_IMAGE_UPLOADED"),
    inventoryUpdates: countWhere(
      (l) => l.entity_type === "inventory" || l.action === "INVENTORY_UPDATED" || l.action === "INVENTORY_ADJUSTED",
    ),
    ordersProcessed: countWhere((l) => l.entity_type === "order" || l.action?.startsWith("ORDER_")),
    couponsCreated: countWhere((l) => l.entity_type === "coupon" && l.action === "insert"),
    customerActions: countWhere((l) => l.entity_type === "customer" || l.action?.startsWith("CUSTOMER_")),
    settingsChanged: countWhere((l) => l.entity_type === "setting" || l.action === "SETTINGS_UPDATED"),
    activeSec: sessionList
      .filter((s: any) => new Date(s.started_at) >= from && new Date(s.started_at) <= to)
      .reduce((sum: number, s: any) => sum + s.durationSec, 0),
  };

  return {
    profile: { id: profile.id, name: profile.full_name || profile.email, email: profile.email, createdAt: profile.created_at },
    roles: roleList,
    permissions: uniquePerms,
    presence: presenceOf(active, nowMs, thresholdMin),
    thresholdMinutes: thresholdMin,
    sessions: sessionList,
    activity: list,
    performance,
    range: { from: from.toISOString(), to: to.toISOString() },
  };
}

// ---------- Leaderboard ----------

export async function getLeaderboard(ctx: StaffCtx, metric: string, days: number) {
  await requirePermission(ctx, "staff.manage");
  const db = ctx.supabase;
  const from = new Date(Date.now() - Math.min(Math.max(days, 1), 90) * 86400000);
  const { data: logs } = await db
    .from("audit_logs")
    .select("actor_id, action, entity_type")
    .gte("created_at", from.toISOString())
    .limit(5000);
  const { data: profiles } = await db.from("profiles").select("id, full_name, email");

  const allowed = ["actions", "orders", "products", "inventory"];
  const m = allowed.includes(metric) ? metric : "actions";
  const score = new Map<string, number>();
  for (const l of logs ?? []) {
    if (!l.actor_id) continue;
    const hit =
      m === "actions" ||
      (m === "orders" && (l.entity_type === "order" || String(l.action).startsWith("ORDER_"))) ||
      (m === "products" && l.entity_type === "product") ||
      (m === "inventory" && (l.entity_type === "inventory" || String(l.action).startsWith("INVENTORY_")));
    if (hit) score.set(l.actor_id, (score.get(l.actor_id) ?? 0) + 1);
  }
  const rows = [...score.entries()]
    .map(([id, value]) => {
      const p = (profiles ?? []).find((x: any) => x.id === id);
      return { id, name: p?.full_name || p?.email || "Staff", value };
    })
    .sort((a, b) => b.value - a.value)
    .slice(0, 10);
  return { metric: m, days, rows };
}

// ---------- Permissions matrix ----------

export async function getPermissionMatrix(ctx: StaffCtx) {
  await requireStaff(ctx);
  const { data, error } = await ctx.supabase.from("role_permissions").select("role, permission");
  if (error) throw new Error(error.message);
  return { rows: data ?? [], catalog: ALL_PERMISSIONS };
}

export async function setRolePermission(
  ctx: StaffCtx,
  input: { role: string; permission: string; allowed: boolean },
) {
  const { data: isSuper } = await ctx.supabase.rpc("has_role", {
    _user_id: ctx.userId,
    _role: "SUPER_ADMIN",
  });
  if (!isSuper) throw new Error("Forbidden: SUPER_ADMIN required");
  if (!ALL_PERMISSIONS.includes(input.permission)) throw new Error("Unknown permission");
  const db = ctx.supabase;
  if (input.allowed) {
    const { error } = await db
      .from("role_permissions")
      .upsert({ role: input.role, permission: input.permission }, { onConflict: "role,permission" });
    if (error) throw new Error(error.message);
  } else {
    const { error } = await db
      .from("role_permissions")
      .delete()
      .eq("role", input.role)
      .eq("permission", input.permission);
    if (error) throw new Error(error.message);
  }
  await db.rpc("log_staff_activity", {
    _action: "PERMISSION_UPDATED",
    _entity_type: "role_permissions",
    _entity_id: `${input.role}:${input.permission}`,
    _entity_name: `${input.role} → ${input.permission}`,
    _metadata: { allowed: input.allowed },
  });
  return { ok: true };
}

// ---------- Audit log search ----------

export async function searchAuditLog(
  ctx: StaffCtx,
  filters: {
    action?: string;
    actorId?: string;
    search?: string;
    fromIso?: string;
    toIso?: string;
  },
) {
  await requirePermission(ctx, "staff.view");
  const db = ctx.supabase;
  let q = db
    .from("audit_logs")
    .select("id, actor_id, action, entity_type, entity_id, entity_name, metadata, ip_address, user_agent, created_at")
    .order("created_at", { ascending: false })
    .limit(300);
  if (filters.action) q = q.ilike("action", `%${filters.action.slice(0, 40)}%`);
  if (filters.actorId) q = q.eq("actor_id", filters.actorId);
  if (filters.fromIso) q = q.gte("created_at", filters.fromIso);
  if (filters.toIso) q = q.lte("created_at", filters.toIso);
  if (filters.search) {
    const s = filters.search.slice(0, 80).replace(/[%_,()"]/g, "");
    if (s) q = q.or(`entity_name.ilike.%${s}%,entity_id.ilike.%${s}%,action.ilike.%${s}%`);
  }
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const actorIds = [...new Set((data ?? []).map((l: any) => l.actor_id).filter(Boolean))];
  const { data: actors } = actorIds.length
    ? await db.from("profiles").select("id, full_name, email").in("id", actorIds)
    : { data: [] };
  const nameOf = (id: string | null) => {
    const a = (actors ?? []).find((p: any) => p.id === id);
    return a ? a.full_name || a.email : "System";
  };
  return (data ?? []).map((l: any) => ({ ...l, actor_name: nameOf(l.actor_id) }));
}
