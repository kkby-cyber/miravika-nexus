
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
