import { createFileRoute } from "@tanstack/react-router";
import { AdminTablePage } from "@/components/admin/AdminTablePage";

export const Route = createFileRoute("/admin/products")({
  component: Page,
});

function Page() {
  return <AdminTablePage resource="products" title="Products" />;
}
