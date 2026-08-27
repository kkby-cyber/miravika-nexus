import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { searchAuditLog } from "@/lib/staff.functions";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { actionLabel } from "@/lib/staff-constants";

export const Route = createFileRoute("/admin/audit-logs")({
  component: AuditLogsPage,
});

function AuditLogsPage() {
  const searchFn = useServerFn(searchAuditLog);
  const [form, setForm] = useState({ search: "", action: "", fromIso: "", toIso: "" });
  const [filters, setFilters] = useState(form);

  const { data, isLoading, error, isFetching } = useQuery({
    queryKey: ["audit-logs", filters],
    queryFn: () =>
      searchFn({
        data: {
          search: filters.search || undefined,
          action: filters.action || undefined,
          fromIso: filters.fromIso ? new Date(filters.fromIso).toISOString() : undefined,
          toIso: filters.toIso ? new Date(filters.toIso).toISOString() : undefined,
        },
      }),
  });

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Audit logs</h1>
        <p className="text-sm text-muted-foreground">
          Every staff action recorded across the commerce core.
        </p>
      </header>

      <form
        className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5"
        onSubmit={(e) => {
          e.preventDefault();
          setFilters(form);
        }}
      >
        <Input
          placeholder="Search entity or action"
          value={form.search}
          onChange={(e) => setForm({ ...form, search: e.target.value })}
        />
        <Input
          placeholder="Action (e.g. update)"
          value={form.action}
          onChange={(e) => setForm({ ...form, action: e.target.value })}
        />
        <Input
          type="date"
          value={form.fromIso}
          onChange={(e) => setForm({ ...form, fromIso: e.target.value })}
        />
        <Input
          type="date"
          value={form.toIso}
          onChange={(e) => setForm({ ...form, toIso: e.target.value })}
        />
        <Button type="submit" disabled={isFetching}>
          {isFetching ? "Filtering…" : "Apply filters"}
        </Button>
      </form>

      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}

      <Card>
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="p-3">When</th>
                <th className="p-3">Staff</th>
                <th className="p-3">Action</th>
                <th className="p-3">Entity</th>
                <th className="p-3">IP</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr>
                  <td className="p-6 text-muted-foreground" colSpan={5}>
                    Loading logs…
                  </td>
                </tr>
              )}
              {data?.length === 0 && (
                <tr>
                  <td className="p-6 text-muted-foreground" colSpan={5}>
                    No log entries match these filters.
                  </td>
                </tr>
              )}
              {(data ?? []).map((l) => (
                <tr key={l.id} className="border-b border-border/60 last:border-0">
                  <td className="p-3 text-muted-foreground">
                    {new Date(l.created_at).toLocaleString("en-IN")}
                  </td>
                  <td className="p-3">{l.actor_name}</td>
                  <td className="p-3">
                    <Badge variant="outline">{actionLabel(l.action)}</Badge>
                  </td>
                  <td className="p-3">
                    {l.entity_name ?? l.entity_id ?? "—"}
                    {l.entity_type && (
                      <span className="ml-2 text-xs text-muted-foreground">{l.entity_type}</span>
                    )}
                  </td>
                  <td className="p-3 text-muted-foreground">{l.ip_address ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
