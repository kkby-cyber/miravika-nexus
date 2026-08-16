import { createFileRoute } from "@tanstack/react-router";
import { AdminTablePage } from "@/components/admin/AdminTablePage";

export const Route = createFileRoute("/admin/settings")({
  component: Page,
});

function Page() {
  return <AdminTablePage resource="settings" title="Settings" />;
}
