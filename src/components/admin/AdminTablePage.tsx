import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { money, shortDate } from "@/lib/format";

type Resource =
  | "products"
  | "collections"
  | "inventory"
  | "orders"
  | "coupons"
  | "customers"
  | "import"
  | "settings";

const CONFIG: Record<
  Resource,
  { table: string | null; columns: string[]; description: string }
> = {
  products: {
    table: "products",
    columns: ["title", "slug", "status", "base_price", "created_at"],
    description: "Catalogue records synced with the storefront API.",
  },
  collections: {
    table: "collections",
    columns: ["title", "slug", "is_active", "created_at"],
    description: "Merchandising groups exposed to the storefront.",
  },
  inventory: {
    table: "inventory",
    columns: ["sku", "available_quantity", "reserved_quantity", "low_stock_threshold"],
    description: "Live stock, including quantities reserved by pending checkouts.",
  },
  orders: {
    table: "orders",
    columns: ["order_number", "full_name", "grand_total", "payment_status", "status", "created_at"],
    description: "Every order created through the checkout API.",
  },
  coupons: {
    table: "coupons",
    columns: ["code", "discount_type", "discount_value", "is_active", "usage_count"],
    description: "Discount codes validated server-side at checkout.",
  },
  customers: {
    table: "profiles",
    columns: ["full_name", "email", "phone", "created_at"],
    description: "Registered shoppers and their contact details.",
  },
  import: {
    table: null,
    columns: [],
    description: "Bulk CSV import for products and inventory.",
  },
  settings: {
    table: null,
    columns: [],
    description: "Store configuration, tax rates and payment keys.",
  },
};

function renderCell(column: string, value: unknown) {
  if (value === null || value === undefined || value === "") return "—";
  if (column.endsWith("_at")) return shortDate(String(value));
  if (column.includes("price") || column.includes("total") || column === "discount_value")
    return money(Number(value));
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

export function AdminTablePage({ resource, title }: { resource: string; title: string }) {
  const config = CONFIG[resource as Resource];

  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-resource", resource],
    enabled: Boolean(config?.table),
    queryFn: async () => {
      const { data, error } = await supabase
        .from(config.table as never)
        .select(config.columns.join(", "))
        .order(config.columns.includes("created_at") ? "created_at" : config.columns[0]!, {
          ascending: !config.columns.includes("created_at"),
        })
        .limit(100);
      if (error) throw error;
      return (data ?? []) as unknown as Record<string, unknown>[];
    },
  });

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="text-sm text-muted-foreground">{config?.description}</p>
      </header>

      <Card>
        <CardContent className="p-0">
          {!config?.table ? (
            <p className="p-6 text-sm text-muted-foreground">
              This section is scaffolded and ready for the next build step.
            </p>
          ) : isLoading ? (
            <p className="p-6 text-sm text-muted-foreground">Loading…</p>
          ) : error ? (
            <p className="p-6 text-sm text-destructive">
              {error instanceof Error ? error.message : "Could not load records."}
            </p>
          ) : !data || data.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">No records yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    {config.columns.map((c) => (
                      <th key={c} className="whitespace-nowrap p-3">
                        {c.replace(/_/g, " ")}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.map((row, i) => (
                    <tr key={i} className="border-b border-border/60 last:border-0">
                      {config.columns.map((c) => (
                        <td key={c} className="whitespace-nowrap p-3">
                          {renderCell(c, row[c])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
