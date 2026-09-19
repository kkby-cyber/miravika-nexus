/**
 * Shiprocket API access. Server-only: credentials are read from process.env
 * inside functions and are never returned to a client or logged.
 *
 * The auth token is cached in `site_settings` (key `shiprocket_token`) because
 * Shiprocket tokens are valid for 10 days and the login endpoint is rate
 * limited. Workers are stateless, so an in-memory cache is not enough.
 */
import { logEvent } from "@/lib/api-response";

const BASE = "https://apiv2.shiprocket.in/v1/external";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

export type ShiprocketConfig = {
  email: string;
  password: string;
  pickupLocation: string;
  pickupPincode: string;
};

export function getShiprocketConfig(): ShiprocketConfig | null {
  const email = process.env["SHIPROCKET_EMAIL"];
  const password = process.env["SHIPROCKET_PASSWORD"];
  if (!email || !password) return null;
  return {
    email,
    password,
    pickupLocation: process.env["SHIPROCKET_PICKUP_LOCATION"] ?? "Primary",
    pickupPincode: process.env["SHIPROCKET_PICKUP_PINCODE"] ?? "",
  };
}

export const SHIPROCKET_NOT_CONFIGURED = "SHIPROCKET_NOT_CONFIGURED" as const;

type TokenResult = { token: string } | { error: string };

async function login(config: ShiprocketConfig): Promise<TokenResult> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: config.email, password: config.password }),
    });
  } catch {
    logEvent("error", "shiprocket_login_unavailable", {});
    return { error: "SHIPROCKET_NETWORK_ERROR" };
  }
  if (!res.ok) {
    logEvent("error", "shiprocket_login_failed", { status: res.status });
    return { error: "SHIPROCKET_AUTH_FAILED" };
  }
  let body: { token?: string };
  try {
    body = (await res.json()) as { token?: string };
  } catch {
    return { error: "SHIPROCKET_AUTH_FAILED" };
  }
  if (!body.token) return { error: "SHIPROCKET_AUTH_FAILED" };
  return { token: body.token };
}

/** Returns a valid Shiprocket bearer token, refreshing and caching as needed. */
export async function getToken(admin: Admin, force = false): Promise<TokenResult> {
  const config = getShiprocketConfig();
  if (!config) return { error: SHIPROCKET_NOT_CONFIGURED };

  if (!force) {
    const { data, error } = await admin
      .from("site_settings")
      .select("value")
      .eq("key", "shiprocket_token")
      .maybeSingle();
    if (error) return { error: "SHIPROCKET_TOKEN_LOOKUP_FAILED" };
    const cached = data?.value as { token?: string; expires_at?: string } | undefined;
    if (cached?.token && cached.expires_at && new Date(cached.expires_at) > new Date()) {
      return { token: cached.token };
    }
  }

  const fresh = await login(config);
  if ("error" in fresh) return fresh;

  // Shiprocket tokens live 10 days; refresh a day early.
  const expiresAt = new Date(Date.now() + 9 * 24 * 60 * 60 * 1000).toISOString();
  const { error } = await admin.from("site_settings").upsert(
    {
      key: "shiprocket_token",
      value: { token: fresh.token, expires_at: expiresAt },
      description: "Cached Shiprocket API token (server-only).",
      is_public: false,
    },
    { onConflict: "key" },
  );
  if (error) {
    logEvent("error", "shiprocket_token_cache_failed", {});
    return { error: "SHIPROCKET_TOKEN_CACHE_FAILED" };
  }
  return fresh;
}

type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string; detail?: string };

/** Authenticated Shiprocket call with a single automatic token refresh on 401. */
export async function srFetch<T = Json>(
  admin: Admin,
  path: string,
  init: { method?: string; body?: unknown } = {},
  retry = true,
): Promise<ApiResult<T>> {
  const auth = await getToken(admin);
  if ("error" in auth) return { ok: false, error: auth.error };

  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${auth.token}`,
        "content-type": "application/json",
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  } catch {
    logEvent("error", "shiprocket_network_error", { path });
    return { ok: false, error: "SHIPROCKET_NETWORK_ERROR" };
  }

  if (res.status === 401 && retry) {
    const refreshed = await getToken(admin, true);
    if ("error" in refreshed) return { ok: false, error: refreshed.error };
    return srFetch<T>(admin, path, init, false);
  }

  if ((res.status === 429 || res.status >= 500) && retry) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    return srFetch<T>(admin, path, init, false);
  }

  const text = await res.text();
  let parsed: Json = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text };
  }

  if (!res.ok) {
    logEvent("error", "shiprocket_request_failed", { path, status: res.status });
    return {
      ok: false,
      error: "SHIPROCKET_REQUEST_FAILED",
      detail: typeof parsed?.message === "string" ? parsed.message : `HTTP ${res.status}`,
    };
  }
  return { ok: true, data: parsed as T };
}

/** Courier serviceability + live rates for a destination pincode. */
export async function checkServiceability(
  admin: Admin,
  input: { deliveryPincode: string; weightKg: number; cod: boolean; declaredValue: number },
) {
  const config = getShiprocketConfig();
  if (!config) return { ok: false as const, error: SHIPROCKET_NOT_CONFIGURED };
  const params = new URLSearchParams({
    pickup_postcode: config.pickupPincode,
    delivery_postcode: input.deliveryPincode,
    weight: String(input.weightKg),
    cod: input.cod ? "1" : "0",
    declared_value: String(input.declaredValue),
  });
  const res = await srFetch<Json>(admin, `/courier/serviceability/?${params.toString()}`);
  if (!res.ok) return res;
  const couriers: Json[] = res.data?.data?.available_courier_companies ?? [];
  return {
    ok: true as const,
    couriers: couriers.map((c) => ({
      courier_company_id: String(c.courier_company_id),
      courier_name: String(c.courier_name),
      rate: Number(c.rate ?? 0),
      etd: c.etd ?? null,
      estimated_delivery_days: c.estimated_delivery_days ?? null,
      cod_available: Boolean(c.cod),
    })),
  };
}

export type ShiprocketOrderInput = {
  orderNumber: string;
  orderDate: string;
  billing: {
    name: string;
    address: string;
    address2?: string | null;
    city: string;
    state: string;
    pincode: string;
    country: string;
    email: string;
    phone: string;
  };
  items: Array<{
    name: string;
    sku: string;
    units: number;
    sellingPrice: number;
    hsn?: string | null;
  }>;
  subTotal: number;
  weightKg: number;
  dimensionsCm: { length: number; breadth: number; height: number };
  paymentMethod: "Prepaid" | "COD";
};

/** Creates the Shiprocket (adhoc) order. */
export async function createShiprocketOrder(admin: Admin, input: ShiprocketOrderInput) {
  const config = getShiprocketConfig();
  if (!config) return { ok: false as const, error: SHIPROCKET_NOT_CONFIGURED };

  return srFetch<Json>(admin, "/orders/create/adhoc", {
    method: "POST",
    body: {
      order_id: input.orderNumber,
      order_date: input.orderDate,
      pickup_location: config.pickupLocation,
      billing_customer_name: input.billing.name,
      billing_last_name: "",
      billing_address: input.billing.address,
      billing_address_2: input.billing.address2 ?? "",
      billing_city: input.billing.city,
      billing_pincode: input.billing.pincode,
      billing_state: input.billing.state,
      billing_country: input.billing.country === "IN" ? "India" : input.billing.country,
      billing_email: input.billing.email,
      billing_phone: input.billing.phone,
      shipping_is_billing: true,
      order_items: input.items.map((i) => ({
        name: i.name,
        sku: i.sku,
        units: i.units,
        selling_price: i.sellingPrice,
        hsn: i.hsn ?? "",
      })),
      payment_method: input.paymentMethod,
      sub_total: input.subTotal,
      length: input.dimensionsCm.length,
      breadth: input.dimensionsCm.breadth,
      height: input.dimensionsCm.height,
      weight: input.weightKg,
    },
  });
}

export async function assignAwb(admin: Admin, shipmentId: string, courierId?: string | null) {
  return srFetch<Json>(admin, "/courier/assign/awb", {
    method: "POST",
    body: courierId
      ? { shipment_id: shipmentId, courier_id: courierId }
      : { shipment_id: shipmentId },
  });
}

export async function requestPickup(admin: Admin, shipmentId: string) {
  return srFetch<Json>(admin, "/courier/generate/pickup", {
    method: "POST",
    body: { shipment_id: [shipmentId] },
  });
}

export async function generateLabel(admin: Admin, shipmentId: string) {
  return srFetch<Json>(admin, "/courier/generate/label", {
    method: "POST",
    body: { shipment_id: [shipmentId] },
  });
}

export async function generateInvoice(admin: Admin, orderId: string) {
  return srFetch<Json>(admin, "/orders/print/invoice", {
    method: "POST",
    body: { ids: [orderId] },
  });
}

export async function trackByAwb(admin: Admin, awb: string) {
  return srFetch<Json>(admin, `/courier/track/awb/${encodeURIComponent(awb)}`);
}

export async function cancelShipment(admin: Admin, awb: string) {
  return srFetch<Json>(admin, "/orders/cancel/shipment/awbs", {
    method: "POST",
    body: { awbs: [awb] },
  });
}
