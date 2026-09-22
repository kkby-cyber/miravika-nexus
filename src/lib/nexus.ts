const NEXUS_API_URL =
  process.env["NEXUS_API_URL"] ||
  process.env["VITE_NEXUS_API_URL"] ||
  "http://localhost:8080";

async function nexusRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${NEXUS_API_URL}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init.headers ?? {}),
    },
  });

  const text = await response.text();

  let payload: unknown = null;

  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  if (!response.ok) {
    const message =
      typeof payload === "object" &&
      payload !== null &&
      "message" in payload &&
      typeof payload.message === "string"
        ? payload.message
        : `Nexus request failed with status ${response.status}`;

    throw new Error(message);
  }

  return payload as T;
}

export interface NexusShippingQuote {
  serviceable: boolean;
  shipping_charge: number;
  currency: string;
  estimated_days?: number | null;
  etd?: string | null;
  cod_available?: boolean;
  couriers?: Array<{
    courier_name?: string;
    courier_company_id?: number | string;
    rate?: number;
    etd?: string | null;
  }>;
  source?: string;
}

export async function getNexusShippingQuote(options: {
  pincode: string;
  items: Array<{
    sku: string;
    quantity: number;
  }>;
  cod?: boolean;
}) {
  return nexusRequest<NexusShippingQuote>("/api/public/shipping/quote", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      pincode: options.pincode,
      items: options.items,
      cod: options.cod ?? false,
    }),
  });
}
