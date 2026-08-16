import { createFileRoute } from "@tanstack/react-router";
import { AdminTablePage } from "@/components/admin/AdminTablePage";

export const Route = createFileRoute("/admin/inventory")({
  component: Page,
});

function Page() {
  return <AdminTablePage resource="inventory" title="Inventory" />;
}
