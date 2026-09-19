# Miravika Commerce Core

MIRAVIKA — CUSTOM ECOMMERCE BACKEND

SHOPIFY-INDEPENDENT COMMERCE SYSTEM

MASTER BUILD PROMPT

PROJECT: MIRAVIKA CUSTOM COMMERCE BACKEND

IMPORTANT:

This is a NEW standalone backend/admin project for MIRAVIKA.

Do NOT modify or depend on the existing MIRAVIKA Shopify storefront.

Do NOT import Shopify architecture into this project.

The long-term objective is to completely replace Shopify with a secure, production-ready custom ecommerce backend.

The existing MIRAVIKA frontend will be connected to this backend later.

==================================================

1. CORE ARCHITECTURE

==================================================

Build a production-ready ecommerce backend with:

- PostgreSQL database

- Secure backend API

- Admin dashboard

- Product management

- Collection management

- Inventory management

- Customer management

- Cart system

- Checkout system

- Order management

- Razorpay payment integration

- Razorpay webhook verification

- Coupon/discount system

- Wishlist

- Shipping configuration

- Tax calculation

- Email/order notifications

- Google Analytics purchase tracking support

- Google Ads conversion support

- Meta Pixel / Conversions API support

- Audit logs

- Authentication

- Role-based access

- Security controls

The architecture must be API-first.

Frontend should NEVER directly access sensitive database/payment credentials.

==================================================

2. DATABASE

==================================================

Create a properly normalized PostgreSQL database.

Required tables/entities:

users

admin_users

customers

products

product_variants

product_images

collections

product_collections

inventory

inventory_movements

carts

cart_items

orders

order_items

payments

payment_events

shipping_methods

shipping_zones

addresses

coupons

coupon_redemptions

wishlists

wishlist_items

reviews

notifications

audit_logs

site_settings

Use UUIDs or secure unique IDs.

Every important record must have:

id

created_at

updated_at

Where applicable also include:

deleted_at

status

Use foreign keys and database constraints.

Never rely only on frontend validation.

==================================================

3. PRODUCT MODEL

==================================================

Products must support:

- Product ID

- SKU

- Product title

- Slug

- Description

- Short description

- Brand

- Product type

- Material

- Size

- Color

- MRP

- Selling price

- Compare-at price

- Tax information

- HSN code

- Weight

- Dimensions

- Product images

- Product status

- SEO title

- SEO description

- SEO keywords

- Availability

- Created date

- Updated date

Variants must support:

- Variant SKU

- Variant title

- Variant price

- Variant MRP

- Variant inventory

- Variant attributes

- Barcode where available

Never hardcode products in frontend code.

==================================================

4. MIRAVIKA CATALOG

==================================================

MIRAVIKA is the only official brand/catalog.

Do NOT add:

- CJ Dropshipping products

- Supplier products

- Generic demo products

- Fake products

- Placeholder products as real inventory

- Other marketplace brands

The current MIRAVIKA catalog should eventually be imported from the verified marketplace/product data.

Important:

Do NOT automatically create products merely because a marketplace listing exists.

Every product must have sufficient verified information.

Do not invent product specifications, materials, dimensions, stock or claims.

==================================================

5. SKU SYSTEM

==================================================

SKU is the primary product identity.

SKU must be unique.

Never create duplicate products with the same SKU.

Example existing MIRAVIKA SKU patterns include:

MIR-BOW-LP-2PC

MIR-FLW-CLT-WHT-YLW-3

MIR-CRYSTAL-RAKHI-001

MIRA-JHUMKA-001

MIR-EAR-009

Do not change an existing SKU without explicit admin action.

==================================================

6. COLLECTIONS

==================================================

Create only these main MIRAVIKA collections:

New Arrivals

Trending Now

Women's Fashion

Jewelry & Accessories

Beauty & Personal Care

Gifts

Best Sellers

DO NOT create:

Home & Kitchen

Electronics & Accessories

Those categories are intentionally removed from MIRAVIKA.

Products can belong to multiple collections where appropriate.

Collection assignment must be manageable from the admin dashboard.

==================================================

7. INVENTORY

==================================================

Create a real inventory system.

Each SKU/variant must have:

available_quantity

reserved_quantity

sold_quantity

Inventory movements must be recorded.

Supported movement types:

purchase/import

manual_adjustment

reservation

release

sale

refund

return

cancellation

Never allow inventory to become negative.

When checkout begins:

reserve inventory.

When payment succeeds:

convert reservation to sold.

When payment fails/expires:

release reservation.

When an order is cancelled:

restore inventory according to order status.

Use database transactions to prevent race conditions.

==================================================

8. CART

==================================================

Build a real server-backed cart.

Cart must support:

- Add item

- Update quantity

- Remove item

- Clear cart

- Calculate subtotal

- Calculate discount

- Calculate tax

- Calculate shipping

- Calculate final total

Cart totals must be calculated on the backend.

Never trust price/total values sent by the browser.

At checkout:

Backend must re-fetch current product prices and inventory.

==================================================

9. CHECKOUT

==================================================

Build a secure custom checkout.

Required customer fields:

- Full name

- Email

- Phone

- Shipping address

- City

- State

- Postal code

- Country

Support billing address.

Allow:

"Billing address same as shipping"

Recalculate everything server-side before creating payment.

Order should initially have:

PENDING_PAYMENT

Never mark an order PAID based on frontend JavaScript.

==================================================

10. RAZORPAY

==================================================

Integrate Razorpay ONLY through the backend.

IMPORTANT SECURITY:

Razorpay Key Secret must NEVER appear in:

- frontend code

- browser bundle

- public environment variables

- GitHub

- client-side API responses

- HTML

- logs

Use server-side environment variables.

Required environment variables:

RAZORPAY_KEY_ID

RAZORPAY_KEY_SECRET

RAZORPAY_WEBHOOK_SECRET

Payment flow:

Customer clicks Pay

↓

Backend validates cart

↓

Backend validates inventory

↓

Backend calculates final amount

↓

Backend creates internal order

↓

Backend creates Razorpay Order

↓

Frontend opens Razorpay Checkout

↓

Customer pays

↓

Razorpay sends payment result/webhook

↓

Backend verifies signature

↓

Backend verifies payment/order

↓

Order becomes PAID

↓

Inventory is finalized

↓

Purchase tracking event is generated

↓

Customer receives confirmation

NEVER trust only the Razorpay frontend success callback.

==================================================

11. RAZORPAY WEBHOOKS

==================================================

Create secure webhook endpoint.

Example:

POST /api/webhooks/razorpay

Verify Razorpay webhook signature using the secret.

Handle relevant events such as:

payment.captured

payment.failed

order.paid

refund.created

refund.processed

Make webhook processing idempotent.

The same webhook received multiple times must NOT:

- create duplicate orders

- deduct inventory twice

- create duplicate purchase events

Store webhook/event IDs.

==================================================

12. PAYMENT STATES

==================================================

Support:

PENDING

AUTHORIZED

PAID

FAILED

REFUNDED

PARTIALLY_REFUNDED

CANCELLED

Maintain payment history.

Do not overwrite historical payment records.

==================================================

13. ORDER SYSTEM

==================================================

Order statuses:

PENDING_PAYMENT

PAID

PROCESSING

PACKED

SHIPPED

OUT_FOR_DELIVERY

DELIVERED

CANCELLED

REFUND_REQUESTED

REFUNDED

RETURN_REQUESTED

RETURNED

Each status change must be logged.

Order must contain:

- Order number

- Customer

- Items

- SKU

- Quantity

- Price at purchase

- Discount

- Tax

- Shipping

- Total

- Payment status

- Order status

- Shipping address

- Billing address

- Razorpay order ID

- Razorpay payment ID

- Tracking number if available

- Created timestamp

Historical order prices must never change when product prices later change.

==================================================

14. ADMIN DASHBOARD

==================================================

Build a professional MIRAVIKA Admin Dashboard.

Dashboard:

- Today's sales

- Orders

- Paid orders

- Pending payments

- Failed payments

- Refunds

- Customers

- Low stock

- Out of stock

- Top products

- Recent orders

Product management:

- Add

- Edit

- Delete/archive

- Search

- Filter

- Bulk actions

- SKU management

- Image management

- Inventory management

- Collection assignment

- SEO

Order management:

- Search orders

- Filter by status

- View order

- Payment details

- Customer details

- Update status

- Add tracking

- Cancel

- Refund workflow

==================================================

15. ADMIN AUTHENTICATION

==================================================

Do NOT use a simple hidden URL/password.

Implement secure authentication.

Support:

- Admin login

- Secure password hashing

- Session management

- Logout

- Password reset

- Role-based permissions

Roles:

SUPER_ADMIN

ADMIN

ORDER_MANAGER

CATALOG_MANAGER

Never expose admin APIs publicly without authentication.

==================================================

16. CUSTOMER ACCOUNTS

==================================================

Support:

- Customer registration

- Login

- Logout

- Password reset

- Profile

- Saved addresses

- Order history

- Wishlist

Passwords must be securely hashed.

Never store plaintext passwords.

==================================================

17. WISHLIST

==================================================

Wishlist must be database-backed.

Support:

Add

Remove

View wishlist

Do not use only localStorage as the permanent wishlist.

==================================================

18. COUPONS

==================================================

Build coupon system supporting:

- Percentage discount

- Fixed discount

- Minimum order value

- Maximum discount

- Start date

- End date

- Usage limit

- Per-customer usage limit

- Product/collection restrictions

- Active/inactive status

Coupon validation must happen server-side.

==================================================

19. SHIPPING

==================================================

Create configurable shipping system.

Support:

- India

- Shipping zones

- Postal code

- Flat shipping

- Free shipping threshold

- Different shipping methods

- Estimated delivery time

Do NOT hardcode shipping prices into frontend.

Admin must be able to change shipping rules.

==================================================

20. TAX

==================================================

Build configurable tax calculation.

Store tax amount separately on:

- order

- order item

Never change historical tax calculations after order creation.

Do not invent tax rates.

Make tax rules configurable from admin.

==================================================

21. PRODUCT IMAGES

==================================================

Use secure image storage.

Support:

- Multiple images

- Main image

- Gallery

- Image ordering

- Alt text

Do not expose private storage credentials.

Optimize images for website performance.

==================================================

22. EMAILS

==================================================

Prepare transactional email system for:

- Order confirmation

- Payment confirmation

- Payment failure

- Order shipped

- Order delivered

- Cancellation

- Refund

Do not fake email sending.

Use a configurable email provider through environment variables.

==================================================

23. ANALYTICS

==================================================

Prepare clean event architecture.

Events:

view_item

add_to_cart

remove_from_cart

begin_checkout

add_payment_info

purchase

refund

Purchase event must fire ONLY after confirmed paid order.

Required purchase data:

transaction_id

value

currency

tax

shipping

items

transaction_id must be unique.

Never fire purchase twice for the same order.

==================================================

24. GOOGLE + META

==================================================

Prepare integration architecture for:

Google Analytics 4

Google Ads conversion tracking

Meta Pixel

Meta Conversions API

Backend purchase event should be based on confirmed order/payment.

Use order ID as transaction/event deduplication key.

Never send payment secrets.

==================================================

25. SECURITY

==================================================

Implement:

- HTTPS-ready architecture

- Input validation

- Schema validation

- Authentication

- Authorization

- Rate limiting

- CSRF protection where applicable

- Secure cookies

- CORS configuration

- SQL injection protection

- XSS protection

- Request validation

- Secure headers

- Secret management

- Webhook signature validation

- Audit logs

Never expose:

Razorpay secret

Database credentials

Admin secrets

JWT signing secrets

Webhook secrets

==================================================

26. API DESIGN

==================================================

Create clean REST/JSON APIs.

Example:

GET /api/products

GET /api/products/:slug

GET /api/collections

GET /api/collections/:slug

POST /api/cart

POST /api/cart/items

PATCH /api/cart/items/:id

DELETE /api/cart/items/:id

POST /api/checkout

POST /api/payments/create

POST /api/webhooks/razorpay

GET /api/orders

GET /api/orders/:id

POST /api/wishlist

DELETE /api/wishlist/:productId

Admin:

GET /api/admin/products

POST /api/admin/products

PATCH /api/admin/products/:id

GET /api/admin/orders

PATCH /api/admin/orders/:id

Use proper HTTP status codes.

==================================================

27. API RESPONSE SECURITY

==================================================

Never return:

- Password hashes

- Secret keys

- Payment secrets

- Internal database credentials

- Private admin information

Return only required fields.

==================================================

28. MIGRATION IMPORT SYSTEM

==================================================

Build an admin import system for MIRAVIKA product Excel/CSV data.

Import process:

Upload file

↓

Parse

↓

Validate

↓

Normalize SKU

↓

Detect duplicates

↓

Preview changes

↓

Admin approval

↓

Import

NEVER directly overwrite the entire catalog without preview.

Show:

NEW

UPDATE

DUPLICATE

INVALID

MISSING DATA

before import.

==================================================

29. MARKETPLACE REFERENCE

==================================================

MIRAVIKA currently sells products through marketplaces including Flipkart.

Marketplace data can be used for:

- SKU identification

- Product matching

- Catalog reconciliation

- Initial product import

But marketplace listings must NOT become a permanent dependency of the website.

MIRAVIKA custom backend is the source of truth after migration.

==================================================

30. NO SHOPIFY DEPENDENCY

==================================================

Search the entire new project for Shopify references.

Do NOT use:

Shopify Storefront API

Shopify Admin API

Shopify Cart API

Shopify Checkout

Shopify product objects

Shopify collections

The final backend must operate independently.

Do not add Shopify as a hidden fallback.

==================================================

31. FRONTEND INTEGRATION READY

==================================================

The existing MIRAVIKA frontend will later consume this backend.

Create:

API base URL configuration

Environment-based configuration

Typed API responses

Authentication handling

Error handling

Loading states

Empty states

Do not build a second MIRAVIKA storefront in this backend project unless needed for admin.

==================================================

32. ADMIN DESIGN

==================================================

Admin UI should be clean and professional.

Use MIRAVIKA-inspired:

Ivory

White

Champagne Gold

Warm Beige

Charcoal

But prioritize usability over decorative design.

Desktop-first admin with responsive tablet/mobile support.

==================================================

33. LOGGING

==================================================

Create structured logs.

Never log:

Razorpay secrets

Passwords

Full payment credentials

Sensitive authentication tokens

Log:

request ID

endpoint

status

timestamp

error category

order ID where appropriate

==================================================

34. ERROR HANDLING

==================================================

Every API must return predictable errors.

Example:

{

  "success": false,

  "error": {

    "code": "OUT_OF_STOCK",

    "message": "This product is no longer available."

  }

}

Never expose stack traces to customers.

==================================================

35. TESTING

==================================================

Create tests for:

Product creation

Product retrieval

SKU uniqueness

Inventory

Cart

Cart totals

Checkout

Coupon

Tax

Shipping

Order creation

Razorpay order creation

Razorpay webhook verification

Duplicate webhook

Payment success

Payment failure

Refund

Inventory reservation

Inventory release

Purchase event deduplication

Admin authentication

Authorization

==================================================

36. PAYMENT TEST MODE

==================================================

Initially use Razorpay TEST MODE.

Do NOT request live credentials in code.

Use environment variables.

Create clear configuration instructions for:

RAZORPAY_KEY_ID

RAZORPAY_KEY_SECRET

RAZORPAY_WEBHOOK_SECRET

Only switch to LIVE mode after complete QA.

==================================================

37. PRODUCTION READINESS

==================================================

Before declaring completion, verify:

✓ Database migrations work

✓ Database constraints work

✓ Admin authentication works

✓ Product CRUD works

✓ SKU uniqueness works

✓ Inventory works

✓ Cart works

✓ Checkout works

✓ Razorpay test order works

✓ Webhook verification works

✓ Duplicate webhook is safely ignored

✓ Paid order created correctly

✓ Inventory deducted exactly once

✓ Failed payment does not create paid order

✓ Customer receives order confirmation

✓ Admin sees order

✓ Refund workflow works

✓ Analytics events are deduplicated

✓ No Shopify dependency

✓ No CJ/dropshipping dependency

✓ No hardcoded catalog

✓ No exposed secrets

✓ No console errors

✓ No critical API errors

==================================================

38. DO NOT FAKE SUCCESS

==================================================

VERY IMPORTANT:

Do not say Razorpay is working unless an actual test-mode payment/webhook flow has been verified.

Do not say email is working unless email delivery has been tested.

Do not say database migration is complete unless records were actually checked.

Do not say production-ready if critical functionality is only mocked.

Clearly report:

DONE

TESTED

REQUIRES CONFIGURATION

REQUIRES MANUAL ACTION

==================================================

39. BUILD ORDER

==================================================

Build in this exact order:

PHASE 1

Project architecture + database

PHASE 2

Authentication + admin

PHASE 3

Products + collections + images

PHASE 4

Inventory

PHASE 5

Customers + addresses

PHASE 6

Cart

PHASE 7

Checkout

PHASE 8

Razorpay test integration

PHASE 9

Razorpay webhook + payment verification

PHASE 10

Orders + inventory finalization

PHASE 11

Coupons + shipping + tax

PHASE 12

Wishlist

PHASE 13

Email notifications

PHASE 14

Analytics + Google/Meta conversion architecture

PHASE 15

Excel/CSV import + reconciliation

PHASE 16

Security hardening

PHASE 17

Automated tests

PHASE 18

Production QA

==================================================

40. FINAL OUTPUT

==================================================

When finished, provide a concise technical report:

1. Database created

2. Tables created

3. APIs created

4. Admin dashboard status

5. Product system status

6. Inventory status

7. Cart status

8. Checkout status

9. Razorpay status

10. Webhook status

11. Order system status

12. Analytics status

13. Security status

14. Tests passed

15. Remaining manual configuration

16. Environment variables required

17. Exact steps to connect the existing MIRAVIKA frontend

DO NOT connect or modify the existing Shopify storefront yet.

First build and test this backend independently.

FINAL GOAL:

A secure, scalable MIRAVIKA-owned ecommerce backend that can completely replace Shopify after migration and successful end-to-end payment/order testing.

This project was built with [Lovable](https://lovable.dev).

**Live app**: https://miravika-nexus.lovable.app

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/8a5c5894-bc49-4945-b000-f5f466c05c83).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
