/**
 * Shared, server-authoritative commerce logic used by the storefront APIs,
 * the checkout flow and the admin console.
 *
 * Nothing here trusts client-supplied prices, totals, stock or discounts:
 * every figure is re-derived from database rows.
 */
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { computeTotals, type CouponRule, type PriceLine, type ShippingRule } from "@/lib/pricing";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = any;

/** Publishable-key client: RLS applies as `anon`. Safe for public reads. */
export function publicClient() {
  const key = process.env["SUPABASE_PUBLISHABLE_KEY"]!;
  return createClient<Database>(process.env["SUPABASE_URL"]!, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (input, init) => {
        const h = new Headers(init?.headers);
        if (key.startsWith("sb_") && h.get("Authorization") === `Bearer ${key}`)
          h.delete("Authorization");
        h.set("apikey", key);
        return fetch(input, { ...init, headers: h });
      },
    },
  });
}

/** Resolves the signed-in customer from an `Authorization: Bearer` header. */
export async function userFromRequest(request: Request) {
  const header = request.headers.get("authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : null;
  if (!token) return null;
  const { data } = await publicClient().auth.getUser(token);
  return data.user ? { id: data.user.id, email: data.user.email ?? null } : null;
}

export type RequestedItem = { sku: string; quantity: number };

export type LineResolution =
  | { ok: true; lines: PriceLine[] }
  | {
      ok: false;
      code: "PRODUCT_UNAVAILABLE" | "OUT_OF_STOCK" | "STORE_UNAVAILABLE";
      message: string;
      sku: string;
    };

/**
 * Turns a list of `{ sku, quantity }` into authoritative price lines,
 * validating status, visibility and available stock along the way.
 */
export async function resolveLines(admin: Admin, items: RequestedItem[]): Promise<LineResolution> {
  const skus = [...new Set(items.map((i) => i.sku))];

  const [
    { data: variants, error: variantsError },
    { data: products, error: productsError },
    { data: inventory, error: inventoryError },
  ] = await Promise.all([
    admin
      .from("product_variants")
      .select("id, product_id, sku, title, price, status")
      .in("sku", skus),
    admin
      .from("products")
      .select("id, sku, title, price, tax_rate, tax_inclusive, status, is_visible, deleted_at")
      .in("sku", skus),
    admin.from("inventory").select("sku, available_quantity").in("sku", skus),
  ]);
  if (variantsError || productsError || inventoryError) {
    return {
      ok: false,
      code: "STORE_UNAVAILABLE",
      message: "Product availability is temporarily unavailable.",
      sku: "",
    };
  }

  const variantBySku = new Map((variants ?? []).map((v: Any) => [v.sku, v]));
  const productBySku = new Map((products ?? []).map((p: Any) => [p.sku, p]));
  const productIds = [...new Set((variants ?? []).map((v: Any) => v.product_id))];

  let parents: Any[] = [];
  if (productIds.length) {
    const { data, error } = await admin
      .from("products")
      .select("id, sku, title, price, tax_rate, tax_inclusive, status, is_visible, deleted_at")
      .in("id", productIds);
    if (error) {
      return {
        ok: false,
        code: "STORE_UNAVAILABLE",
        message: "Product availability is temporarily unavailable.",
        sku: "",
      };
    }
    parents = data ?? [];
  }
  const productById = new Map([...(products ?? []), ...parents].map((p: Any) => [p.id, p]));
  const stockBySku = new Map((inventory ?? []).map((i: Any) => [i.sku, i.available_quantity]));

  const lines: PriceLine[] = [];
  for (const item of items) {
    const variant = variantBySku.get(item.sku) as Any;
    const product = (
      variant ? productById.get(variant.product_id) : productBySku.get(item.sku)
    ) as Any;

    if (
      !product ||
      product.status !== "ACTIVE" ||
      product.is_visible === false ||
      product.deleted_at ||
      (variant && variant.status !== "ACTIVE")
    ) {
      return {
        ok: false,
        code: "PRODUCT_UNAVAILABLE",
        message: "This product is not available for purchase.",
        sku: item.sku,
      };
    }

    const available = Number(stockBySku.get(item.sku) ?? 0);
    if (available < item.quantity) {
      return {
        ok: false,
        code: "OUT_OF_STOCK",
        message: "This product is no longer available in that quantity.",
        sku: item.sku,
      };
    }

    lines.push({
      sku: item.sku,
      title: variant ? `${product.title} — ${variant.title}` : product.title,
      productId: product.id,
      variantId: variant?.id ?? null,
      quantity: item.quantity,
      unitPrice: Number(variant?.price ?? product.price),
      taxRate: Number(product.tax_rate ?? 0),
      taxInclusive: product.tax_inclusive ?? true,
    });
  }

  return { ok: true, lines };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

export type CouponCheck =
  { ok: true; coupon: CouponRule } | { ok: false; code: string; message: string };

/**
 * Full server-side coupon validation: activity window, usage limits,
 * per-customer limits, minimum order value and product/collection scope.
 */
export async function validateCoupon(
  admin: Admin,
  code: string,
  opts: { subtotal: number; userId?: string | null; productIds?: string[] },
): Promise<CouponCheck> {
  const { data: c, error: couponError } = await admin
    .from("coupons")
    .select("*")
    .eq("code", code.trim().toUpperCase())
    .maybeSingle();

  const invalid = {
    ok: false as const,
    code: "INVALID_COUPON",
    message: "This coupon code cannot be used.",
  };
  if (couponError)
    return {
      ok: false,
      code: "COUPON_UNAVAILABLE",
      message: "Coupons are temporarily unavailable.",
    };
  if (!c || !c.is_active) return invalid;

  const now = new Date();
  if (c.starts_at && new Date(c.starts_at) > now)
    return { ok: false, code: "COUPON_NOT_STARTED", message: "This coupon is not active yet." };
  if (c.ends_at && new Date(c.ends_at) < now)
    return { ok: false, code: "COUPON_EXPIRED", message: "This coupon has expired." };
  if (c.usage_limit != null && c.used_count >= c.usage_limit)
    return { ok: false, code: "COUPON_EXHAUSTED", message: "This coupon has been fully redeemed." };
  if (Number(c.min_order_value ?? 0) > opts.subtotal)
    return {
      ok: false,
      code: "COUPON_MIN_ORDER",
      message: `Add more to your bag to use this code (minimum ₹${Number(c.min_order_value)}).`,
    };

  if (opts.userId && c.per_customer_limit != null) {
    const { count, error } = await admin
      .from("coupon_redemptions")
      .select("id", { count: "exact", head: true })
      .eq("coupon_id", c.id)
      .eq("user_id", opts.userId);
    if (error)
      return {
        ok: false,
        code: "COUPON_UNAVAILABLE",
        message: "Coupons are temporarily unavailable.",
      };
    if ((count ?? 0) >= c.per_customer_limit)
      return {
        ok: false,
        code: "COUPON_LIMIT_REACHED",
        message: "You have already used this code.",
      };
  }

  const restrictedProducts: string[] = c.product_ids ?? [];
  const restrictedCollections: string[] = c.collection_ids ?? [];
  if ((restrictedProducts.length || restrictedCollections.length) && opts.productIds?.length) {
    let eligible = opts.productIds.some((id) => restrictedProducts.includes(id));
    if (!eligible && restrictedCollections.length) {
      const { data: links, error } = await admin
        .from("product_collections")
        .select("product_id")
        .in("collection_id", restrictedCollections)
        .in("product_id", opts.productIds);
      if (error)
        return {
          ok: false,
          code: "COUPON_UNAVAILABLE",
          message: "Coupons are temporarily unavailable.",
        };
      eligible = (links ?? []).length > 0;
    }
    if (!eligible)
      return {
        ok: false,
        code: "COUPON_NOT_APPLICABLE",
        message: "This code does not apply to the items in your bag.",
      };
  }

  return {
    ok: true,
    coupon: {
      id: c.id,
      code: c.code,
      discount_type: c.discount_type,
      discount_value: Number(c.discount_value),
      min_order_value: Number(c.min_order_value ?? 0),
      max_discount: c.max_discount == null ? null : Number(c.max_discount),
    },
  };
}

/** Picks the shipping method: an explicit id when valid, else the default. */
export async function resolveShipping(
  admin: Admin,
  methodId?: string | null,
  postalCode?: string | null,
): Promise<
  | (ShippingRule & { id: string; name: string; min_days: number | null; max_days: number | null })
  | null
> {
  const options = await listShippingOptions(
    admin,
    postalCode === undefined ? {} : { postal_code: postalCode },
  );
  const method = (
    methodId ? options.find((option: Any) => option.id === methodId) : options[0]
  ) as Any;
  if (!method) return null;
  return {
    id: method.id,
    name: method.name,
    flat_rate: Number(method.flat_rate),
    free_shipping_threshold:
      method.free_shipping_threshold == null ? null : Number(method.free_shipping_threshold),
    min_days: method.min_days,
    max_days: method.max_days,
  };
}

/** Shipping methods available for a destination, narrowed by zone rules. */
export async function listShippingOptions(
  admin: Admin,
  destination: { country?: string | null; state?: string | null; postal_code?: string | null },
) {
  const { data: zones, error: zonesError } = await admin
    .from("shipping_zones")
    .select("id, name, country, states, postal_prefixes")
    .eq("is_active", true);

  if (zonesError) throw new Error("shipping_zones_lookup_failed");
  const country = (destination.country ?? "IN").toUpperCase();
  const matching = (zones ?? []).filter((z: Any) => {
    if (z.country.toUpperCase() !== country) return false;
    const states: string[] = z.states ?? [];
    const prefixes: string[] = z.postal_prefixes ?? [];
    const stateOk =
      states.length === 0 ||
      (destination.state != null &&
        states.some((s) => s.toLowerCase() === destination.state!.toLowerCase()));
    const pinOk =
      prefixes.length === 0 ||
      (destination.postal_code != null &&
        prefixes.some((p) => destination.postal_code!.startsWith(p)));
    return stateOk && pinOk;
  });

  const zoneIds = matching.map((z: Any) => z.id);
  let query = admin
    .from("shipping_methods")
    .select(
      "id, zone_id, name, description, flat_rate, free_shipping_threshold, min_days, max_days",
    )
    .eq("is_active", true)
    .order("position", { ascending: true });
  if (zones?.length) {
    query = zoneIds.length
      ? query.or(`zone_id.is.null,zone_id.in.(${zoneIds.join(",")})`)
      : query.is("zone_id", null);
  }
  const { data, error } = await query;
  if (error) throw new Error("shipping_methods_lookup_failed");
  return data ?? [];
}

/** Full quote for a set of items: subtotal, discount, tax, shipping, total. */
export async function quote(
  admin: Admin,
  input: {
    items: RequestedItem[];
    couponCode?: string | null;
    shippingMethodId?: string | null;
    userId?: string | null;
    postalCode?: string | null;
  },
) {
  const resolved = await resolveLines(admin, input.items);
  if (!resolved.ok) return resolved;

  const subtotal = resolved.lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0);
  let coupon: CouponRule | null = null;
  if (input.couponCode) {
    const check = await validateCoupon(admin, input.couponCode, {
      subtotal,
      userId: input.userId ?? null,
      productIds: resolved.lines.map((l) => l.productId).filter((id): id is string => Boolean(id)),
    });
    if (!check.ok) return { ok: false as const, code: check.code, message: check.message, sku: "" };
    coupon = check.coupon;
  }

  const shipping = await resolveShipping(admin, input.shippingMethodId, input.postalCode);
  const totals = computeTotals(resolved.lines, coupon, shipping);
  return { ok: true as const, totals, coupon, shipping };
}

/** Default reservation window (minutes) for pending checkouts. */
export async function reservationMinutes(admin: Admin) {
  const { data } = await admin
    .from("site_settings")
    .select("value")
    .eq("key", "checkout")
    .maybeSingle();
  const minutes = Number(data?.value?.reservation_minutes ?? 30);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : 30;
}
