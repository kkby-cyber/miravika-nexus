import { createFileRoute, Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  LayoutDashboard,
  Package,
  Layers,
  Boxes,
  ShoppingCart,
  Ticket,
  Users,
  Settings,
  Upload,
  LogOut,
  UserCog,
  ScrollText,
  Menu,
  X,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useStaffSession } from "@/hooks/useStaffSession";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Toaster } from "@/components/ui/sonner";
import { MiravikaLogo } from "@/components/brand/MiravikaLogo";
import { ROLE_LABELS, type StaffRole } from "@/lib/staff-constants";

export const Route = createFileRoute("/admin")({
  head: () => ({
    meta: [
      { title: "Admin Console | MIRAVIKA Commerce" },
      { name: "description", content: "MIRAVIKA commerce administration console." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AdminLayout,
});

const NAV = [
  { to: "/admin", label: "Dashboard", icon: LayoutDashboard, exact: true },
  { to: "/admin/products", label: "Products", icon: Package },
  { to: "/admin/collections", label: "Collections", icon: Layers },
  { to: "/admin/inventory", label: "Inventory", icon: Boxes },
  { to: "/admin/orders", label: "Orders", icon: ShoppingCart },
  { to: "/admin/customers", label: "Customers", icon: Users },
  { to: "/admin/coupons", label: "Coupons", icon: Ticket },
  { to: "/admin/import", label: "Import", icon: Upload },
  { to: "/admin/staff", label: "Staff", icon: UserCog },
  { to: "/admin/audit-logs", label: "Audit Logs", icon: ScrollText },
  { to: "/admin/settings", label: "Settings", icon: Settings },
] as Array<{ to: string; label: string; icon: typeof LayoutDashboard; exact?: boolean }>;

function AdminLayout() {
  const { user, roles, isStaff, loading } = useAuth();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [open, setOpen] = useState(false);
  const { endSession } = useStaffSession(isStaff ? (user?.id ?? null) : null);

  useEffect(() => {
    if (!loading && !user) navigate({ to: "/auth" });
  }, [loading, user, navigate]);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  if (loading || !user) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-secondary">
        <MiravikaLogo size={72} />
        <p className="text-xs uppercase tracking-[0.35em] text-muted-foreground">Loading console</p>
      </div>
    );
  }

  if (!isStaff) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-secondary px-6 text-center">
        <MiravikaLogo size={64} />
        <h1 className="font-display text-xl">No staff access</h1>
        <p className="max-w-md text-sm text-muted-foreground">
          Your account ({user.email}) has no MIRAVIKA staff role yet. An Owner must assign one before
          the console unlocks.
        </p>
        <Button variant="outline" onClick={() => supabase.auth.signOut()}>
          Sign out
        </Button>
      </div>
    );
  }

  async function signOut() {
    await endSession("logout");
    await supabase.auth.signOut();
    navigate({ to: "/auth" });
  }

  const sidebar = (
    <div className="flex h-full flex-col px-3 py-6">
      <div className="flex flex-col items-center px-3 pb-6">
        <MiravikaLogo size={56} />
        <p className="mt-3 font-display text-sm tracking-[0.3em] text-sidebar-foreground">MIRAVIKA</p>
        <p className="mt-1 text-[9px] uppercase tracking-[0.35em] text-sidebar-primary">
          Commerce Core
        </p>
      </div>
      <nav className="flex flex-1 flex-col gap-1 overflow-y-auto">
        {NAV.map((item) => {
          const active = item.exact ? pathname === item.to : pathname.startsWith(item.to);
          return (
            <Link
              key={item.to}
              to={item.to}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
                active
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
              )}
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className="mt-6 border-t border-sidebar-border px-3 pt-4 text-xs text-sidebar-foreground/70">
        <p className="truncate">{user.email}</p>
        <p className="mt-1 text-sidebar-primary">
          {roles.map((r) => ROLE_LABELS[r as StaffRole] ?? r).join(", ")}
        </p>
        <button
          className="mt-3 flex items-center gap-2 text-sidebar-foreground/70 hover:text-sidebar-accent-foreground"
          onClick={signOut}
        >
          <LogOut className="h-3.5 w-3.5" /> Sign out
        </button>
      </div>
    </div>
  );

  return (
    <div className="flex min-h-screen bg-secondary">
      <aside className="hidden w-60 shrink-0 bg-sidebar text-sidebar-foreground md:block">
        {sidebar}
      </aside>

      {open && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div className="absolute inset-0 bg-foreground/40" onClick={() => setOpen(false)} />
          <aside className="absolute left-0 top-0 h-full w-64 bg-sidebar text-sidebar-foreground">
            <button
              className="absolute right-3 top-3 text-sidebar-foreground/70"
              onClick={() => setOpen(false)}
              aria-label="Close navigation"
            >
              <X className="h-4 w-4" />
            </button>
            {sidebar}
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-border bg-background px-4 py-3 md:hidden">
          <button onClick={() => setOpen(true)} aria-label="Open navigation">
            <Menu className="h-5 w-5" />
          </button>
          <MiravikaLogo size={28} />
          <span className="font-display text-sm tracking-[0.25em]">MIRAVIKA</span>
        </header>
        <main className="min-w-0 flex-1 p-4 md:p-8">
          <Outlet />
        </main>
      </div>
      <Toaster />
    </div>
  );
}
