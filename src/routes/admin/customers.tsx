import { createFileRoute } from "@tanstack/react-router";
import { AdminTablePage } from "@/components/admin/AdminTablePage";

export const Route = createFileRoute("/admin/customers")({
  component: Page,
});

function Page() {
  return <AdminTablePage resource="customers" title="Customers" />;
}
