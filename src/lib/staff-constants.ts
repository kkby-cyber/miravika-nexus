// Client-safe staff CRM constants shared between UI and server code.

export const STAFF_ROLES = [
  "SUPER_ADMIN",
  "ADMIN",
  "MANAGER",
  "CATALOG_MANAGER",
  "CATALOG_STAFF",
  "ORDER_MANAGER",
  "ORDER_STAFF",
  "MARKETING_STAFF",
  "SUPPORT",
] as const;

export type StaffRole = (typeof STAFF_ROLES)[number];

export const ROLE_LABELS: Record<StaffRole, string> = {
  SUPER_ADMIN: "Owner",
  ADMIN: "Administrator",
  MANAGER: "Manager",
  CATALOG_MANAGER: "Catalog Manager",
  CATALOG_STAFF: "Catalog Staff",
  ORDER_MANAGER: "Order Manager",
  ORDER_STAFF: "Order Staff",
  MARKETING_STAFF: "Marketing Staff",
  SUPPORT: "Support",
};

export const PERMISSION_GROUPS: Array<{ group: string; permissions: string[] }> = [
  { group: "Products", permissions: ["products.view", "products.create", "products.edit", "products.delete"] },
  { group: "Collections", permissions: ["collections.view", "collections.create", "collections.edit", "collections.delete"] },
  { group: "Inventory", permissions: ["inventory.view", "inventory.edit"] },
  { group: "Orders", permissions: ["orders.view", "orders.edit", "orders.fulfill", "orders.cancel", "orders.refund"] },
  { group: "Customers", permissions: ["customers.view", "customers.edit"] },
  { group: "Coupons", permissions: ["coupons.view", "coupons.create", "coupons.edit", "coupons.delete"] },
  { group: "Shipping", permissions: ["shipping.view", "shipping.edit"] },
  { group: "Analytics", permissions: ["analytics.view"] },
  { group: "Staff", permissions: ["staff.view", "staff.manage"] },
  { group: "Settings", permissions: ["settings.view", "settings.manage"] },
  { group: "Payment settings", permissions: ["payment_settings.view", "payment_settings.manage"] },
];

export const ALL_PERMISSIONS = PERMISSION_GROUPS.flatMap((g) => g.permissions);

/** Permissions that must never be granted to non-admin roles from the UI. */
export const SENSITIVE_PERMISSIONS = ["payment_settings.view", "payment_settings.manage", "staff.manage", "settings.manage"];

export const DEFAULT_INACTIVITY_MINUTES = 15;
export const ONLINE_WINDOW_MINUTES = 15;

export type Presence = "ONLINE" | "IDLE" | "OFFLINE";

/** Map raw audit action strings to friendly labels. */
export function actionLabel(action: string): string {
  const map: Record<string, string> = {
    LOGIN: "Logged in",
    LOGOUT: "Logged out",
    SESSION_REVOKED: "Session revoked",
    PAGE_VIEW: "Viewed module",
    PERMISSION_UPDATED: "Permission changed",
    insert: "Created record",
    update: "Updated record",
    delete: "Deleted record",
  };
  return map[action] ?? action.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
}

export function formatDuration(totalSeconds: number): string {
  if (!totalSeconds || totalSeconds <= 0) return "0m";
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.round((totalSeconds % 3600) / 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}
