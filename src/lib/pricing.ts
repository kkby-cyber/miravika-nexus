/**
 * Pure, server-authoritative pricing math. Never trust browser totals:
 * every value here is derived from database rows only.
 */

export type PriceLine = {
  sku: string;
  title: string;
  productId: string | null;
  variantId: string | null;
  quantity: number;
  unitPrice: number;
  taxRate: number;
  taxInclusive: boolean;
};

export type CouponRule = {
  id: string;
  code: string;
  discount_type: "PERCENTAGE" | "FIXED";
  discount_value: number;
  min_order_value: number;
  max_discount: number | null;
};

export type ShippingRule = {
  id: string;
  flat_rate: number;
  free_shipping_threshold: number | null;
};

export type Totals = {
  items: Array<
    PriceLine & {
      discountAmount: number;
      taxAmount: number;
      lineTotal: number;
    }
  >;
  subtotal: number;
  discountTotal: number;
  taxTotal: number;
  shippingTotal: number;
  grandTotal: number;
};

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export function computeTotals(
  lines: PriceLine[],
  coupon: CouponRule | null,
  shipping: ShippingRule | null,
): Totals {
  const subtotal = round2(lines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0));

  let discountTotal = 0;
  if (coupon && subtotal >= Number(coupon.min_order_value ?? 0)) {
    discountTotal =
      coupon.discount_type === "PERCENTAGE"
        ? (subtotal * Number(coupon.discount_value)) / 100
        : Number(coupon.discount_value);
    if (coupon.max_discount != null) {
      discountTotal = Math.min(discountTotal, Number(coupon.max_discount));
    }
    discountTotal = round2(Math.min(discountTotal, subtotal));
  }

  const items = lines.map((l) => {
    const lineGross = l.unitPrice * l.quantity;
    const share = subtotal > 0 ? lineGross / subtotal : 0;
    const discountAmount = round2(discountTotal * share);
    const net = lineGross - discountAmount;
    const taxAmount = l.taxInclusive
      ? round2(net - net / (1 + l.taxRate / 100))
      : round2((net * l.taxRate) / 100);
    const lineTotal = round2(l.taxInclusive ? net : net + taxAmount);
    return { ...l, discountAmount, taxAmount, lineTotal };
  });

  const taxTotal = round2(items.reduce((s, i) => s + i.taxAmount, 0));
  const itemsTotal = round2(items.reduce((s, i) => s + i.lineTotal, 0));

  let shippingTotal = 0;
  if (shipping) {
    const freeAt = shipping.free_shipping_threshold;
    shippingTotal =
      freeAt != null && itemsTotal >= Number(freeAt) ? 0 : round2(Number(shipping.flat_rate));
  }

  return {
    items,
    subtotal,
    discountTotal,
    taxTotal,
    shippingTotal,
    grandTotal: round2(itemsTotal + shippingTotal),
  };
}

export const toPaise = (rupees: number) => Math.round(rupees * 100);
