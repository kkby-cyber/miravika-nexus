import { Fragment } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { getPermissionMatrix, setRolePermission } from "@/lib/staff.functions";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useAuth } from "@/hooks/useAuth";
import {
  PERMISSION_GROUPS,
  ROLE_LABELS,
  SENSITIVE_PERMISSIONS,
  STAFF_ROLES,
} from "@/lib/staff-constants";

export const Route = createFileRoute("/admin/staff/permissions")({
  component: PermissionsPage,
});

function PermissionsPage() {
  const matrixFn = useServerFn(getPermissionMatrix);
  const setFn = useServerFn(setRolePermission);
  const qc = useQueryClient();
  const { roles } = useAuth();
  const isSuper = roles.includes("SUPER_ADMIN");

  const { data, isLoading, error } = useQuery({
    queryKey: ["permission-matrix"],
    queryFn: () => matrixFn(),
  });

  const update = useMutation({
    mutationFn: (v: { role: string; permission: string; allowed: boolean }) => setFn({ data: v }),
    onSuccess: () => {
      toast.success("Permissions updated");
      qc.invalidateQueries({ queryKey: ["permission-matrix"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const has = (role: string, permission: string) =>
    (data?.rows ?? []).some((r: any) => r.role === role && r.permission === permission);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Role permissions</h1>
          <p className="text-sm text-muted-foreground">
            {isSuper
              ? "Only the Owner can change this matrix. Changes are audited."
              : "Read-only view — only the Owner can change permissions."}
          </p>
        </div>
        <Button asChild variant="outline">
          <Link to="/admin/staff">Back to staff</Link>
        </Button>
      </header>

      {isLoading && <p className="text-sm text-muted-foreground">Loading matrix…</p>}
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}

      {data && (
        <Card>
          <CardContent className="overflow-x-auto p-0">
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="sticky left-0 bg-card p-3">Permission</th>
                  {STAFF_ROLES.map((r) => (
                    <th key={r} className="p-3 text-center">
                      {ROLE_LABELS[r]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {PERMISSION_GROUPS.map((group) => (
                  <Fragment key={group.group}>
                    <tr className="bg-muted/40">
                      <td
                        className="p-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                        colSpan={STAFF_ROLES.length + 1}
                      >
                        {group.group}
                      </td>
                    </tr>
                    {group.permissions.map((permission) => (
                      <tr key={permission} className="border-b border-border/60">
                        <td className="sticky left-0 bg-card p-3 font-medium">{permission}</td>
                        {STAFF_ROLES.map((role) => {
                          const locked =
                            !isSuper ||
                            role === "SUPER_ADMIN" ||
                            (SENSITIVE_PERMISSIONS.includes(permission) &&
                              !["SUPER_ADMIN", "ADMIN"].includes(role));
                          return (
                            <td key={role} className="p-3 text-center">
                              <Checkbox
                                checked={has(role, permission)}
                                disabled={locked || update.isPending}
                                onCheckedChange={(v) =>
                                  update.mutate({ role, permission, allowed: v === true })
                                }
                              />
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
