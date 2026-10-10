# Cash on Delivery — readiness checklist

**Status: disabled.** `COD_ENABLED` is unset/false in every environment. The storefront does
not offer COD, `/api/public/shipping/quote` reports `cod_available: false`, and
`/api/public/checkout` refuses `payment_method: "cod"` (409 `COD_UNAVAILABLE`). Even with the
flag on, checkout returns 501 `COD_NOT_SUPPORTED` until the order path below exists, so a COD
order can never be processed as prepaid by accident.

## Business decisions needed (owner)

- [ ] Order value limits (minimum / maximum) for COD.
- [ ] COD fee: none, flat amount, or percentage — and whether it is taxable.
- [ ] PIN-code eligibility: all Shiprocket COD-serviceable PINs, or an allow/deny list.
- [ ] Customer eligibility: guests allowed? verified phone (OTP) required? limits per customer?
- [ ] Handling of refused / RTO COD parcels and repeat refusers.
- [ ] Whether COD orders may use coupons.
- [ ] Confirmation that the Shiprocket account has COD activated and the remittance cycle.

## Engineering work once approved

1. Migration: `orders.payment_method` (`razorpay` | `cod`) and optional `cod_fee`.
2. Checkout COD branch: same authoritative pricing, reservation and claim flow; no Razorpay
   order; order status `CONFIRMED`, `payment_status` `PENDING`; inventory finalised on
   confirmation; server-side eligibility + fee in `quote()`.
3. Exclude COD orders from the unpaid-order expiry in payment reconciliation.
4. Clear the cart once the COD order is confirmed (not on redirect).
5. Shiprocket: pass `payment_method: "COD"` and the collectable amount for COD orders
   (currently hard-coded `Prepaid` in `shipment.server.ts`).
6. Admin: "COD collected" action (marks `payment_status` `PAID` on remittance), RTO handling.
7. Storefront: COD option shown only when the quote returns `cod_available: true`; thank-you
   page and analytics must not report a COD order as a paid purchase until collected.
8. Tests for each rule, then enable `COD_ENABLED=true` in staging first.
