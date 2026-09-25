import { z } from "zod";

export const checkoutAddressSchema = z.object({
  full_name: z.string().min(2).max(120),
  phone: z.string().min(6).max(20),
  line1: z.string().min(3).max(200),
  line2: z.string().max(200).optional().nullable(),
  city: z.string().min(2).max(80),
  state: z.string().min(2).max(80),
  postal_code: z.string().min(4).max(12),
  country: z.string().min(2).max(2).default("IN"),
});

/** Unknown checkout fields, including browser-supplied items/totals, are stripped. */
export const checkoutBodySchema = z.object({
  email: z.string().email(),
  phone: z.string().min(6).max(20),
  full_name: z.string().min(2).max(120),
  shipping_address: checkoutAddressSchema,
  billing_address: checkoutAddressSchema.optional().nullable(),
  billing_same_as_shipping: z.boolean().default(true),
  shipping_method_id: z.string().uuid().optional().nullable(),
  coupon_code: z.string().max(40).optional().nullable(),
});
