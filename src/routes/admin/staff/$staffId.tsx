import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getStaffDetail } from "@/lib/staff.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { actionLabel, formatDuration, ROLE_LABELS, type StaffRole } from "@/lib/staff-constants";

export const Route = createFileRoute("/admin/staff/$staffId")({
  component: StaffDetailPage,
});

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-xl font-semibold tracking-tight">{value}</p>
      </CardContent>
    </Card>
  );
}

function StaffDetailPage() {
  const { staffId } = Route.useParams();
  const detailFn = useServerFn(getStaffDetail);
  const from = new Date(Date.now() - 30 * 86400000).toISOString();

  const { data, isLoading, error } = useQuery({
    queryKey: ["staff-detail", staffId],
    queryFn: () => detailFn({ data: { staffId, fromIso: from } }),
  });

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {data?.profile.name ?? "Staff member"}
          </h1>
          <p className="text-sm text-muted-foreground">Last 30 days of activity and sessions.</p>
        </div>
        <Button asChild variant="outline">
          <Link to="/admin/staff">Back to staff</Link>
        </Button>
      </header>

      {isLoading && <p className="text-sm text-muted-foreground">Loading profile…</p>}
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}

      {data && (
        <>
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span>{data.profile.email}</span>
            <span>·</span>
            <Badge variant="secondary">{data.presence}</Badge>
            {data.roles.map((r) => (
              <Badge key={r} variant="outline">
                {ROLE_LABELS[r as StaffRole] ?? r}
              </Badge>
            ))}
          </div>

          <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Metric label="Active time" value={formatDuration(data.performance.activeSec)} />
            <Metric label="Total actions" value={data.performance.totalActions} />
            <Metric label="Products created" value={data.performance.productsCreated} />
            <Metric label="Products edited" value={data.performance.productsEdited} />
            <Metric label="Inventory updates" value={data.performance.inventoryUpdates} />
            <Metric label="Orders processed" value={data.performance.ordersProcessed} />
            <Metric label="Coupons created" value={data.performance.couponsCreated} />
            <Metric label="Settings changed" value={data.performance.settingsChanged} />
          </section>

          <section>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Permissions
            </h2>
            <div className="flex flex-wrap gap-1">
              {data.permissions.length === 0 && (
                <p className="text-sm text-muted-foreground">No permissions granted.</p>
              )}
              {data.permissions.map((p) => (
                <Badge key={p} variant="outline">
                  {p}
                </Badge>
              ))}
            </div>
          </section>

          <section>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Sessions
            </h2>
            <Card>
              <CardContent className="overflow-x-auto p-0">
                <table className="w-full text-sm">
                  <thead className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="p-3">Started</th>
                      <th className="p-3">Duration</th>
                      <th className="p-3">Ended</th>
                      <th className="p-3">IP</th>
                      <th className="p-3">Device</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.sessions.length === 0 && (
                      <tr>
                        <td className="p-6 text-muted-foreground" colSpan={5}>
                          No sessions recorded.
                        </td>
                      </tr>
                    )}
                    {data.sessions.map((s: any) => (
                      <tr key={s.id} className="border-b border-border/60 last:border-0">
                        <td className="p-3">{new Date(s.started_at).toLocaleString("en-IN")}</td>
                        <td className="p-3">{formatDuration(s.durationSec)}</td>
                        <td className="p-3 text-muted-foreground">
                          {s.ended_at || s.revoked_at
                            ? `${new Date((s.ended_at ?? s.revoked_at) as string).toLocaleString("en-IN")} (${s.end_reason ?? "ended"})`
                            : "Active"}
                        </td>
                        <td className="p-3 text-muted-foreground">{s.ip_address ?? "—"}</td>
                        <td className="max-w-[220px] truncate p-3 text-muted-foreground">
                          {s.user_agent ?? "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          </section>

          <section>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Activity
            </h2>
            <Card>
              <CardContent className="divide-y divide-border/60 p-0">
                {data.activity.length === 0 && (
                  <p className="p-6 text-sm text-muted-foreground">No activity in this range.</p>
                )}
                {data.activity.map((a: any) => (
                  <div key={a.id} className="flex items-center justify-between gap-4 p-3 text-sm">
                    <span>
                      {actionLabel(a.action)}
                      {a.entity_name ? ` — ${a.entity_name}` : a.entity_type ? ` — ${a.entity_type}` : ""}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {new Date(a.created_at).toLocaleString("en-IN")}
                    </span>
                  </div>
                ))}
              </CardContent>
            </Card>
          </section>
        </>
      )}
    </div>
  );
}
