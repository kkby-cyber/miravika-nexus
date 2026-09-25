# Payments and Orders API

All monetary values are calculated server-side. Clients must not submit totals,
captured amounts, or refundable balances as authoritative values.

## `POST /api/public/checkout`

Creates a pending order, reserves inventory, and creates a Razorpay order from the
server-authoritative Nexus cart. The cart must be created and populated through
`GET/POST /api/public/cart` before checkout.

Authentication is optional. A valid Supabase bearer token binds the order and cart
to that customer. Guest requests must send the opaque `x-cart-token` returned by
the cart API as `cart_token`; the token is the guest-cart ownership credential.
`user_id`, `cart_id`, checkout line items, prices, totals, and payment amounts are
never accepted from the browser.

Checkout accepts contact details, shipping/billing addresses, an optional
`coupon_code`, and an optional `shipping_method_id`. Unknown fields such as
`items`, `subtotal`, `grand_total`, and client totals are ignored. Nexus reloads
the claimed cart, validates product/variant status and inventory, and calculates
all prices server-side. Each attempt receives an internal checkout claim; the
order stores both the exact `cart_id` and claim ID.

The response contains authoritative totals and the public Razorpay `key_id`,
Razorpay order ID, amount, and currency. It never returns a secret. A checkout
claim is released only by the matching order/cart/claim tuple.

Important errors include `GUEST_CART_TOKEN_REQUIRED`, `CART_EMPTY`,
`CART_CHECKOUT_IN_PROGRESS`, `PRODUCT_UNAVAILABLE`, `OUT_OF_STOCK`,
`INVALID_COUPON`, `COUPON_LIMIT_REACHED`, `INVENTORY_UNAVAILABLE`,
`CHECKOUT_UNAVAILABLE`, and `RATE_LIMITED`.

## `POST /api/public/payments/verify`

Verifies the Razorpay checkout signature, retrieves the payment directly from
Razorpay, and checks provider order ID, payment ID, amount in paise, currency,
and captured status before finalization. A frontend callback alone cannot mark
an order paid. Repeated calls with the same payment ID are idempotent; a
different payment ID for an already-paid order is rejected.

Payment finalization retries exact post-payment side effects. If the order is
paid but the exact linked cart cannot be cleared, the endpoint still returns
payment success with `cart_cleanup_pending: true`; the order cleanup state is
retained for staff retry.

Important errors include `SIGNATURE_INVALID`, `PAYMENT_UNVERIFIED`,
`AMOUNT_MISMATCH`, `PAYMENT_NOT_CAPTURED`, `PAYMENT_ID_MISMATCH`, and
`ORDER_FAILED`.

## `POST /api/public/webhooks/razorpay`

Requires `X-Razorpay-Signature`. Razorpay event IDs are stored uniquely in
`payment_events`. A processed duplicate is acknowledged without reapplying
payment or inventory mutations; an unprocessed duplicate resumes safely. The
captured-event path requires a payment entity, provider order identity, captured
status, amount, and currency. A delayed `payment.failed` event cannot release a
newer checkout claim or undo a paid order. Persistence, order, payment,
fulfillment, and event-finalization failures return a retryable non-2xx response.

## Admin refund operation

`adminCreateRefund` is an authenticated server function requiring
`orders.refund`. It requires `orderId`, a positive requested `amount`, a
client-generated `idempotencyKey`, and an optional reason. The server locks the
payment, calculates the remaining refundable balance, creates one refund record,
calls Razorpay, and records the provider refund ID/status. Duplicate
idempotency keys return the original refund without a second provider call.

Refund errors include `INVALID_REFUND_AMOUNT`, `PAYMENT_NOT_REFUNDABLE`,
`RAZORPAY_REFUND_FAILED`, and `REFUND_COMPLETION_FAILED`.

## Reconciliation

`getReconciliationReport` returns pending/authorized payments, paid orders with
unfinished inventory, unprocessed payment events, duplicate provider IDs, and
paid orders with `cart_cleanup_status` in `PENDING` or `FAILED`. It also reports
locally paid payments with no processed capture/order-paid event as explicit
reconciliation candidates; it does not silently change them.

`reconcilePayment` performs an explicit Razorpay lookup and only finalizes a
matching captured payment after provider identity, amount, and currency checks.
`retryOrderCartCleanup` is an authenticated staff operation requiring
`orders.edit`; it retries only the exact order-linked cart and claim. Both
operations create activity records.

## Customer commerce

`GET/POST /api/public/cart` reads or mutates a customer cart. Authenticated
requests derive ownership from the Supabase bearer token. Guest requests use an
opaque `x-cart-token` and receive a generated `cart_token` in the response; the
client must persist and resend it on later cart and checkout requests. Cart
mutations are server-only and re-read product, variant, price, status, and
inventory. Supported actions are `add`, `update`, `remove`, `clear`, and
authenticated `merge`. Duplicate lines merge deterministically; invalid or stale
quantities are rejected. Cart mutations are not accepted while a cart is in
checkout.

The checkout lifecycle is `ACTIVE -> CHECKOUT -> CONVERTED`. Failed or cancelled
pre-payment attempts release only their own claim. A later checkout receives a
new claim, so delayed cleanup cannot release or clear that later attempt. The
claim is not exposed in the public cart response.

`GET/PATCH /api/public/customer` exposes only the authenticated customer's
profile and allows only full name, phone, and marketing opt-in updates.

`GET/POST /api/public/addresses` and `PATCH/DELETE /api/public/addresses/:id`
provide owned address CRUD. Address types are `shipping` or `billing`; the
database enforces one active default per customer/type.

`GET/POST /api/public/wishlist` provides authenticated product wishlist access.
Duplicate adds are idempotent and inactive products are rejected.

`GET /api/public/reviews?product_id=...` returns approved reviews, or a public
summary with `summary=true`. `POST /api/public/reviews` requires authentication;
verified purchase is computed from a paid matching order and cannot be supplied
by the client. Staff moderation is exposed through the authenticated
`adminModerateReview` server function.

`GET/POST/DELETE /api/public/newsletter` provides normalized email status,
subscription, and unsubscribe operations. Subscriber lists are never public; no
email is sent by this data/API foundation.

`GET /api/public/customer-orders` returns only the authenticated customer's
orders and safe order-item/tracking fields. Guest orders remain unavailable from
this endpoint and continue to require the separate order-number/email tracking
verification flow.

## Migration and deployment order

Apply `supabase/migrations/20260925120000_phase6_authoritative_cart_checkout.sql`
before deploying the application code that calls the claim-bound cart RPCs. The
migration is additive for existing orders, revokes direct client cart writes,
and grants the new internal functions only to `service_role`. Verify the
migration against a disposable/local PostgreSQL instance before applying it to a
production project.

## Shipping and tracking

`POST /api/public/shipping/quote` calculates weight and declared value from the
catalogue, applies the configured shipping method, and calls Shiprocket
serviceability server-side when configured. Provider failures return a retryable
error; they are not reported as serviceable zero-cost shipments.

`POST /api/public/webhooks/shiprocket` requires the configured `x-api-key` and
uses a deterministic provider event/status key. Duplicate events are
acknowledged without duplicate shipment events or status mutations. Invalid or
failed persistence returns a retryable response.

Shipment creation, AWB assignment, pickup scheduling, cancellation, and
reconciliation are authenticated server functions. Shiprocket credentials,
AWBs, provider IDs, and tracking status are never accepted from the frontend as
authoritative values.

Canonical shipment states are:

```text
CREATED -> READY_FOR_SHIPMENT -> AWB_ASSIGNED -> PICKUP_SCHEDULED
-> PICKED_UP -> IN_TRANSIT -> OUT_FOR_DELIVERY -> DELIVERED
```

Exception states include `NDR`, `RTO_INITIATED`, `RTO_IN_TRANSIT`,
`RTO_DELIVERED`, `CANCELLED`, `LOST`, `DAMAGED`, and `FAILED`. Terminal states
cannot regress from delivered/RTO-delivered/cancelled/lost/damaged to an earlier
state. `adminReconcileShipment` reports provider/local mismatches, stale sync,
missing provider identifiers, and missing local events; applying a clear
provider status requires `shipping.edit` and creates an audit activity.
