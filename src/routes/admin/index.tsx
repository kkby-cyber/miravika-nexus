import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { money, shortDate } from "@/lib/format";

export const Route = createFileRoute("/admin/")({
  component: Dashboard,
});

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-2xl font-semibold tracking-tight">{value}</p>
        {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}

function Dashboard() {
  const { data, isLoading } = useQuery({
    queryKey: ["admin-dashboard"],
    queryFn: async () => {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);

      const [orders, todayOrders, customers, inventory, recent] = await Promise.all([
        supabase.from("orders").select("id, status, payment_status, grand_total"),
        supabase
          .from("orders")
          .select("grand_total, payment_status")
          .gte("created_at", startOfDay.toISOString()),
        supabase.from("profiles").select("id", { count: "exact", head: true }),
        supabase.from("inventory").select("sku, available_quantity, low_stock_threshold"),
        supabase
          .from("orders")
          .select("id, order_number, full_name, grand_total, status, payment_status, created_at")
          .order("created_at", { ascending: false })
          .limit(8),
      ]);

      const all = orders.data ?? [];
      const inv = inventory.data ?? [];
      return {
        todaySales: (todayOrders.data ?? [])
          .filter((o) => o.payment_status === "PAID")
          .reduce((s, o) => s + Number(o.grand_total), 0),
        totalOrders: all.length,
        paid: all.filter((o) => o.payment_status === "PAID").length,
        pending: all.filter((o) => o.payment_status === "PENDING").length,
        failed: all.filter((o) => o.payment_status === "FAILED").length,
        refunded: all.filter((o) =>
          ["REFUNDED", "PARTIALLY_REFUNDED"].includes(o.payment_status),
        ).length,
        customers: customers.count ?? 0,
        lowStock: inv.filter(
          (i) => i.available_quantity > 0 && i.available_quantity <= i.low_stock_threshold,
        ).length,
        outOfStock: inv.filter((i) => i.available_quantity === 0).length,
        recent: recent.data ?? [],
      };
    },
  });

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          Live figures from the MIRAVIKA commerce database.
        </p>
      </header>

      {isLoading || !data ? (
        <p className="text-sm text-muted-foreground">Loading metrics…</p>
      ) : (
        <>
          <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Stat label="Today's sales" value={money(data.todaySales)} hint="Paid orders only" />
            <Stat label="Orders" value={String(data.totalOrders)} />
            <Stat label="Paid orders" value={String(data.paid)} />
            <Stat label="Pending payments" value={String(data.pending)} />
            <Stat label="Failed payments" value={String(data.failed)} />
            <Stat label="Refunds" value={String(data.refunded)} />
            <Stat label="Customers" value={String(data.customers)} />
            <Stat
              label="Stock alerts"
              value={`${data.lowStock} low · ${data.outOfStock} out`}
              hint="Across all tracked SKUs"
            />
          </section>

          <section>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Recent orders
              </h2>
              <Link to="/admin/orders" className="text-sm text-muted-foreground hover:text-foreground">
                View all
              </Link>
            </div>
            <Card>
              <CardContent className="p-0">
                {data.recent.length === 0 ? (
                  <p className="p-6 text-sm text-muted-foreground">
                    No orders yet. Orders appear here the moment checkout runs.
                  </p>
                ) : (
                  <table className="w-full text-sm">
                    <thead className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <tr>
                        <th className="p-3">Order</th>
                        <th className="p-3">Customer</th>
                        <th className="p-3">Total</th>
                        <th className="p-3">Payment</th>
                        <th className="p-3">Status</th>
                        <th className="p-3">Placed</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.recent.map((o) => (
                        <tr key={o.id} className="border-b border-border/60 last:border-0">
                          <td className="p-3 font-medium">{o.order_number}</td>
                          <td className="p-3">{o.full_name}</td>
                          <td className="p-3">{money(o.grand_total)}</td>
                          <td className="p-3">
                            <Badge variant="outline">{o.payment_status}</Badge>
                          </td>
                          <td className="p-3">
                            <Badge variant="secondary">{o.status}</Badge>
                          </td>
                          <td className="p-3 text-muted-foreground">{shortDate(o.created_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </CardContent>
            </Card>
          </section>
        </>
      )}
    </div>
  );
}
