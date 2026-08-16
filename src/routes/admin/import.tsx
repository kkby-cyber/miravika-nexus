import { createFileRoute } from "@tanstack/react-router";
import { AdminTablePage } from "@/components/admin/AdminTablePage";

export const Route = createFileRoute("/admin/import")({
  component: Page,
});

function Page() {
  return <AdminTablePage resource="import" title="Import" />;
}
