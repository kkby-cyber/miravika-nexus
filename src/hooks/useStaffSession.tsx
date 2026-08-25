import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import {
  endStaffSession,
  recordStaffActivity,
  staffHeartbeat,
  startStaffSession,
} from "@/lib/staff.functions";

const STORAGE_KEY = "mv_staff_session";
const HEARTBEAT_MS = 45_000;

/**
 * Staff session tracker: starts a tracked session on admin mount, heartbeats
 * while the tab is active, records one PAGE_VIEW per module per session, and
 * force-logs-out the user if their session is revoked by an owner/manager.
 */
export function useStaffSession(userId: string | null) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const idRef = useRef<string | null>(null);
  const viewedRef = useRef<Set<string>>(new Set());
  const lastBeatRef = useRef(0);

  const beat = useCallback(async (id: string) => {
    try {
      const res = await staffHeartbeat({ data: { sessionId: id } });
      if (res.status !== "ACTIVE") {
        sessionStorage.removeItem(STORAGE_KEY);
        await supabase.auth.signOut();
        navigate({ to: "/auth" });
      }
    } catch {
      // transient network errors: keep the session, next beat retries
    }
  }, [navigate]);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    async function boot() {
      let id = sessionStorage.getItem(STORAGE_KEY);
      if (id) {
        try {
          const res = await staffHeartbeat({ data: { sessionId: id } });
          if (res.status !== "ACTIVE") id = null;
        } catch {
          id = null;
        }
      }
      if (!id) {
        try {
          const res = await startStaffSession();
          id = res.sessionId;
        } catch {
          id = null;
        }
      }
      if (cancelled || !id) return;
      sessionStorage.setItem(STORAGE_KEY, id);
      idRef.current = id;
      setSessionId(id);
      lastBeatRef.current = Date.now();
      timer = setInterval(() => {
        if (idRef.current) beat(idRef.current);
      }, HEARTBEAT_MS);
    }

    void boot();

    const onActivity = () => {
      const id = idRef.current;
      if (!id) return;
      if (Date.now() - lastBeatRef.current < 30_000) return;
      lastBeatRef.current = Date.now();
      void beat(id);
    };
    window.addEventListener("pointerdown", onActivity);
    window.addEventListener("keydown", onActivity);

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      window.removeEventListener("pointerdown", onActivity);
      window.removeEventListener("keydown", onActivity);
    };
  }, [userId, beat]);

  // One PAGE_VIEW per module per session.
  useEffect(() => {
    const id = sessionId;
    if (!id || !userId) return;
    const module = pathname.replace(/\/+$/, "") || "/admin";
    if (viewedRef.current.has(module)) return;
    viewedRef.current.add(module);
    void recordStaffActivity({
      data: { action: "PAGE_VIEW", entityType: "module", entityId: module, entityName: module },
    }).catch(() => undefined);
  }, [pathname, sessionId, userId]);

  const endSession = useCallback(
    async (reason: string) => {
      const id = idRef.current;
      idRef.current = null;
      sessionStorage.removeItem(STORAGE_KEY);
      if (id) {
        try {
          await endStaffSession({ data: { sessionId: id, reason } });
        } catch {
          // best effort
        }
      }
    },
    [],
  );

  return { sessionId, endSession };
}
