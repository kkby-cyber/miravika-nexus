import { createFileRoute } from "@tanstack/react-router";
import { AdminTablePage } from "@/components/admin/AdminTablePage";

export const Route = createFileRoute("/admin/collections")({
  component: Page,
});

function Page() {
  return <AdminTablePage resource="collections" title="Collections" />;
}
