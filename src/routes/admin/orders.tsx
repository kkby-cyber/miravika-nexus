import { createFileRoute } from "@tanstack/react-router";
import { AdminTablePage } from "@/components/admin/AdminTablePage";

export const Route = createFileRoute("/admin/orders")({
  component: Page,
});

function Page() {
  return <AdminTablePage resource="orders" title="Orders" />;
}
