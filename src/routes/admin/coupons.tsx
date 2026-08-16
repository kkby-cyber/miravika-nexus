import { createFileRoute } from "@tanstack/react-router";
import { AdminTablePage } from "@/components/admin/AdminTablePage";

export const Route = createFileRoute("/admin/coupons")({
  component: Page,
});

function Page() {
  return <AdminTablePage resource="coupons" title="Coupons" />;
}
