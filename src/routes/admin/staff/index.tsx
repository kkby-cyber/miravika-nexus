import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { getStaffOverview, revokeStaffSession, getStaffLeaderboard } from "@/lib/staff.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ROLE_LABELS, formatDuration, type StaffRole, type Presence } from "@/lib/staff-constants";

export const Route = createFileRoute("/admin/staff/")({
  component: StaffPage,
});

const presenceTone: Record<Presence, string> = {
  ONLINE: "bg-emerald-500",
  IDLE: "bg-amber-500",
  OFFLINE: "bg-muted-foreground/40",
};

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-2xl font-semibold tracking-tight">{value}</p>
      </CardContent>
    </Card>
  );
}

function StaffPage() {
  const overviewFn = useServerFn(getStaffOverview);
  const leaderboardFn = useServerFn(getStaffLeaderboard);
  const revokeFn = useServerFn(revokeStaffSession);
  const qc = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: ["staff-overview"],
    queryFn: () => overviewFn(),
    refetchInterval: 60_000,
  });

  const leaderboard = useQuery({
    queryKey: ["staff-leaderboard"],
    queryFn: () => leaderboardFn({ data: { metric: "actions", days: 7 } }),
    retry: false,
  });

  const revoke = useMutation({
    mutationFn: (sessionId: string) => revokeFn({ data: { sessionId } }),
    onSuccess: () => {
      toast.success("Session revoked");
      qc.invalidateQueries({ queryKey: ["staff-overview"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Staff</h1>
          <p className="text-sm text-muted-foreground">
            Live presence, working hours and productivity across the MIRAVIKA team.
          </p>
        </div>
        <Button asChild variant="outline">
          <Link to="/admin/staff/permissions">Role permissions</Link>
        </Button>
      </header>

      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading && <p className="text-sm text-muted-foreground">Loading staff…</p>}

      {data && (
        <>
          <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Stat label="Staff accounts" value={String(data.totals.staff)} />
            <Stat label="Online now" value={String(data.totals.online)} />
            <Stat label="Idle" value={String(data.totals.idle)} />
            <Stat label="Actions today" value={String(data.totals.todayActions)} />
            <Stat label="Orders touched" value={String(data.totals.todayOrders)} />
            <Stat label="Product edits" value={String(data.totals.todayProducts)} />
            <Stat label="Inventory edits" value={String(data.totals.todayInventory)} />
            <Stat label="Active time today" value={formatDuration(data.totals.todayActiveSec)} />
          </section>

          <section>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Team
            </h2>
            <Card>
              <CardContent className="overflow-x-auto p-0">
                <table className="w-full text-sm">
                  <thead className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="p-3">Member</th>
                      <th className="p-3">Roles</th>
                      <th className="p-3">Status</th>
                      <th className="p-3">Today</th>
                      <th className="p-3">This week</th>
                      <th className="p-3">Actions</th>
                      <th className="p-3" />
                    </tr>
                  </thead>
                  <tbody>
                    {data.staff.length === 0 && (
                      <tr>
                        <td className="p-6 text-muted-foreground" colSpan={7}>
                          No staff accounts yet.
                        </td>
                      </tr>
                    )}
                    {data.staff.map((s) => (
                      <tr key={s.id} className="border-b border-border/60 last:border-0">
                        <td className="p-3">
                          <Link
                            to="/admin/staff/$staffId"
                            params={{ staffId: s.id }}
                            className="font-medium hover:underline"
                          >
                            {s.name}
                          </Link>
                          <p className="text-xs text-muted-foreground">{s.email}</p>
                        </td>
                        <td className="p-3">
                          <div className="flex flex-wrap gap-1">
                            {s.roles.map((r) => (
                              <Badge key={r} variant="outline">
                                {ROLE_LABELS[r as StaffRole] ?? r}
                              </Badge>
                            ))}
                          </div>
                        </td>
                        <td className="p-3">
                          <span className="flex items-center gap-2">
                            <span
                              className={`h-2 w-2 rounded-full ${presenceTone[s.presence as Presence]}`}
                            />
                            {s.presence}
                          </span>
                        </td>
                        <td className="p-3">{formatDuration(s.todayActiveSec)}</td>
                        <td className="p-3">{formatDuration(s.weekActiveSec)}</td>
                        <td className="p-3">
                          {s.todayActions} today · {s.weekActions} week
                        </td>
                        <td className="p-3 text-right">
                          {s.currentSessionId && (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={revoke.isPending}
                              onClick={() => revoke.mutate(s.currentSessionId as string)}
                            >
                              Force sign-out
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          </section>

          {leaderboard.data && leaderboard.data.rows.length > 0 && (
            <section>
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Top performers (7 days)
              </h2>
              <Card>
                <CardContent className="space-y-2 p-4">
                  {leaderboard.data.rows.map((r, i) => (
                    <div key={r.id} className="flex items-center justify-between text-sm">
                      <span>
                        {i + 1}. {r.name}
                      </span>
                      <span className="text-muted-foreground">{r.value} actions</span>
                    </div>
                  ))}
                </CardContent>
              </Card>
            </section>
          )}
        </>
      )}
    </div>
  );
}
