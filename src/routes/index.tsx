import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ArrowRight,
  Boxes,
  CreditCard,
  LayoutDashboard,
  Package,
  ClipboardList,
  ShieldCheck,
  ShoppingCart,
  TicketPercent,
  Users,
} from "lucide-react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "MIRAVIKA Commerce Core — Backend & Admin Console" },
      {
        name: "description",
        content:
          "MIRAVIKA Commerce Core: production-grade ecommerce backend with inventory reservation, Razorpay payments, coupons, orders, and a staff admin console.",
      },
      {
        property: "og:title",
        content: "MIRAVIKA Commerce Core — Backend & Admin Console",
      },
      {
        property: "og:description",
        content:
          "Production-grade ecommerce backend: catalog, inventory, checkout, Razorpay payments, orders, coupons, and admin console.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
      {
        name: "twitter:title",
        content: "MIRAVIKA Commerce Core — Backend & Admin Console",
      },
      {
        name: "twitter:description",
        content:
          "Production-grade ecommerce backend: catalog, inventory, checkout, Razorpay payments, orders, coupons, and admin console.",
      },
    ],
  }),
  component: Index,
});

const modules = [
  {
    icon: Package,
    title: "Catalog",
    body: "Products, variants, collections, and merchandising flags with audit-tracked changes.",
  },
  {
    icon: Boxes,
    title: "Inventory",
    body: "Atomic reserve / release / finalize operations so stock can never go negative.",
  },
  {
    icon: ShoppingCart,
    title: "Checkout",
    body: "Server-authoritative pricing, GST tax rules, coupons, and address capture.",
  },
  {
    icon: CreditCard,
    title: "Razorpay Payments",
    body: "Order creation, client verification, and signed webhooks with idempotent processing.",
  },
  {
    icon: ClipboardList,
    title: "Orders",
    body: "Human-readable order numbers, full status history, and lifecycle management.",
  },
  {
    icon: TicketPercent,
    title: "Coupons",
    body: "Percentage and fixed discounts with usage limits and per-customer targeting.",
  },
  {
    icon: Users,
    title: "Customers & RBAC",
    body: "Profiles, addresses, and role-based staff access enforced by row-level security.",
  },
  {
    icon: ShieldCheck,
    title: "Audit Logs",
    body: "Every catalog, coupon, and settings change is recorded automatically.",
  },
];

const endpoints = [
  { method: "GET", path: "/api/public/products", note: "Storefront product listing" },
  { method: "GET", path: "/api/public/products/:slug", note: "Product detail" },
  { method: "GET", path: "/api/public/collections", note: "Collections" },
  { method: "POST", path: "/api/public/checkout", note: "Validate, reserve stock, create Razorpay order" },
  { method: "POST", path: "/api/public/payments/verify", note: "Verify Razorpay signature & finalize" },
  { method: "POST", path: "/api/public/webhooks/razorpay", note: "Signed webhook ingestion" },
];

function Index() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Header */}
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-baseline gap-2">
            <span className="text-lg font-semibold tracking-[0.25em]">MIRAVIKA</span>
            <span className="text-xs uppercase tracking-widest text-muted-foreground">
              Commerce Core
            </span>
          </div>
          <nav className="flex items-center gap-3">
            <Link
              to="/auth"
              className="rounded-md border border-input bg-background px-4 py-2 text-sm font-medium transition-colors hover:bg-accent"
            >
              Staff sign in
            </Link>
            <Link
              to="/admin"
              className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              <LayoutDashboard className="h-4 w-4" />
              Admin Console
            </Link>
          </nav>
        </div>
      </header>

      {/* Hero */}
      <section className="border-b border-border">
        <div className="mx-auto max-w-6xl px-6 py-16 md:py-24">
          <p className="text-xs font-medium uppercase tracking-[0.3em] text-gold">
            Backend systems online
          </p>
          <h1 className="mt-4 max-w-2xl text-4xl font-bold leading-tight tracking-tight md:text-5xl">
            MIRAVIKA Commerce Core
          </h1>
          <p className="mt-4 max-w-2xl text-base leading-relaxed text-muted-foreground md:text-lg">
            The standalone production backend for MIRAVIKA — catalog, inventory
            reservation, checkout, Razorpay payments, orders, coupons, customer
            accounts, and a staff admin console. Built API-first, ready to power
            the storefront.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link
              to="/admin"
              className="inline-flex items-center gap-2 rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              Open Admin Console
              <ArrowRight className="h-4 w-4" />
            </Link>
            <a
              href="#api"
              className="inline-flex items-center rounded-md border border-input bg-card px-5 py-2.5 text-sm font-medium transition-colors hover:bg-accent"
            >
              View API surface
            </a>
          </div>
        </div>
      </section>

      {/* Modules */}
      <section className="mx-auto max-w-6xl px-6 py-14">
        <h2 className="text-xl font-semibold tracking-tight">What this backend runs</h2>
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {modules.map((m) => (
            <div
              key={m.title}
              className="rounded-lg border border-border bg-card p-5 shadow-sm"
            >
              <m.icon className="h-5 w-5 text-gold" />
              <h3 className="mt-3 text-sm font-semibold">{m.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                {m.body}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* API surface */}
      <section id="api" className="border-t border-border bg-card">
        <div className="mx-auto max-w-6xl px-6 py-14">
          <h2 className="text-xl font-semibold tracking-tight">Public API surface</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            CORS-enabled endpoints the MIRAVIKA storefront will call.
          </p>
          <div className="mt-6 overflow-hidden rounded-lg border border-border">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/50">
                  <th className="px-4 py-3 font-medium">Method</th>
                  <th className="px-4 py-3 font-medium">Endpoint</th>
                  <th className="hidden px-4 py-3 font-medium md:table-cell">
                    Purpose
                  </th>
                </tr>
              </thead>
              <tbody>
                {endpoints.map((e) => (
                  <tr key={e.path} className="border-b border-border last:border-0">
                    <td className="px-4 py-3">
                      <span
                        className={
                          e.method === "GET"
                            ? "rounded bg-success/10 px-2 py-0.5 font-mono text-xs font-semibold text-success"
                            : "rounded bg-gold/15 px-2 py-0.5 font-mono text-xs font-semibold text-gold"
                        }
                      >
                        {e.method}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs md:text-sm">{e.path}</td>
                    <td className="hidden px-4 py-3 text-muted-foreground md:table-cell">
                      {e.note}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-6 py-6 text-xs text-muted-foreground md:flex-row">
          <span className="tracking-[0.25em]">MIRAVIKA</span>
          <span>Commerce Core — API-first backend, ready for storefront connection.</span>
        </div>
      </footer>
    </div>
  );
}
