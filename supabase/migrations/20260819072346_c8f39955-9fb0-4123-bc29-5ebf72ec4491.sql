-- 1. Product merchandising flags
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS is_featured boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_bestseller boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_trending boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_visible boolean NOT NULL DEFAULT true;

ALTER TABLE public.product_images
  ADD COLUMN IF NOT EXISTS storage_key text;

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS reservation_expires_at timestamptz;

-- 2. Human readable order numbers: MIR-2026-000001
CREATE OR REPLACE FUNCTION public.next_order_number()
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT 'MIR-' || to_char(now(), 'YYYY') || '-' ||
         lpad(nextval('public.order_number_seq')::text, 6, '0');
$$;

ALTER TABLE public.orders ALTER COLUMN order_number SET DEFAULT public.next_order_number();

-- 3. Duplicate protection
CREATE UNIQUE INDEX IF NOT EXISTS coupon_redemptions_coupon_order_key
  ON public.coupon_redemptions (coupon_id, order_id) WHERE order_id IS NOT NULL;

-- 4. Performance indexes
CREATE INDEX IF NOT EXISTS idx_products_slug ON public.products (slug);
CREATE INDEX IF NOT EXISTS idx_products_featured ON public.products (is_featured) WHERE is_featured;
CREATE INDEX IF NOT EXISTS idx_product_variants_product ON public.product_variants (product_id);
CREATE INDEX IF NOT EXISTS idx_product_images_product ON public.product_images (product_id);
CREATE INDEX IF NOT EXISTS idx_product_collections_collection ON public.product_collections (collection_id);
CREATE INDEX IF NOT EXISTS idx_inventory_product ON public.inventory (product_id);
CREATE INDEX IF NOT EXISTS idx_inventory_variant ON public.inventory (variant_id);
CREATE INDEX IF NOT EXISTS idx_inventory_movements_inventory ON public.inventory_movements (inventory_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cart_items_cart ON public.cart_items (cart_id);
CREATE INDEX IF NOT EXISTS idx_carts_user ON public.carts (user_id);
CREATE INDEX IF NOT EXISTS idx_orders_user ON public.orders (user_id);
CREATE INDEX IF NOT EXISTS idx_orders_email ON public.orders (email);
CREATE INDEX IF NOT EXISTS idx_orders_reservation ON public.orders (reservation_expires_at)
  WHERE payment_status = 'PENDING';
CREATE INDEX IF NOT EXISTS idx_payments_order ON public.payments (order_id);
CREATE INDEX IF NOT EXISTS idx_payment_events_order ON public.payment_events (order_id);
CREATE INDEX IF NOT EXISTS idx_order_status_history_order ON public.order_status_history (order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_status ON public.notifications (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_events_name ON public.analytics_events (event_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON public.audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON public.audit_logs (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_addresses_user ON public.addresses (user_id);
CREATE INDEX IF NOT EXISTS idx_wishlist_items_wishlist ON public.wishlist_items (wishlist_id);
CREATE INDEX IF NOT EXISTS idx_reviews_product ON public.reviews (product_id, status);
CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_user ON public.coupon_redemptions (coupon_id, user_id);

-- 5. Generic audit trigger
CREATE OR REPLACE FUNCTION public.audit_row_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  entity text := TG_ARGV[0];
  eid text;
  meta jsonb := '{}'::jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    eid := (to_jsonb(OLD) ->> 'id');
  ELSE
    eid := (to_jsonb(NEW) ->> 'id');
  END IF;

  IF TG_OP = 'UPDATE' THEN
    SELECT jsonb_object_agg(n.key, jsonb_build_object('from', o.value, 'to', n.value))
      INTO meta
      FROM jsonb_each(to_jsonb(NEW)) n
      JOIN jsonb_each(to_jsonb(OLD)) o ON o.key = n.key
     WHERE n.value IS DISTINCT FROM o.value
       AND n.key <> 'updated_at';
    IF meta IS NULL OR meta = '{}'::jsonb THEN
      RETURN NEW;
    END IF;
  END IF;

  INSERT INTO public.audit_logs (actor_id, action, entity_type, entity_id, metadata)
  VALUES (auth.uid(), lower(TG_OP), entity, eid, COALESCE(meta, '{}'::jsonb));

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_audit_products ON public.products;
CREATE TRIGGER trg_audit_products AFTER INSERT OR UPDATE OR DELETE ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change('product');

DROP TRIGGER IF EXISTS trg_audit_variants ON public.product_variants;
CREATE TRIGGER trg_audit_variants AFTER INSERT OR UPDATE OR DELETE ON public.product_variants
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change('product_variant');

DROP TRIGGER IF EXISTS trg_audit_coupons ON public.coupons;
CREATE TRIGGER trg_audit_coupons AFTER INSERT OR UPDATE OR DELETE ON public.coupons
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change('coupon');

DROP TRIGGER IF EXISTS trg_audit_settings ON public.site_settings;
CREATE TRIGGER trg_audit_settings AFTER INSERT OR UPDATE OR DELETE ON public.site_settings
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change('setting');

DROP TRIGGER IF EXISTS trg_audit_roles ON public.user_roles;
CREATE TRIGGER trg_audit_roles AFTER INSERT OR UPDATE OR DELETE ON public.user_roles
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change('user_role');

DROP TRIGGER IF EXISTS trg_audit_shipping_methods ON public.shipping_methods;
CREATE TRIGGER trg_audit_shipping_methods AFTER INSERT OR UPDATE OR DELETE ON public.shipping_methods
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_change('shipping_method');

-- 6. Default configuration (only when absent)
INSERT INTO public.shipping_zones (name, country, states, postal_prefixes, is_active)
SELECT 'India', 'IN', ARRAY[]::text[], ARRAY[]::text[], true
WHERE NOT EXISTS (SELECT 1 FROM public.shipping_zones);

INSERT INTO public.shipping_methods (zone_id, name, description, flat_rate, free_shipping_threshold, min_days, max_days, is_active, position)
SELECT z.id, 'Standard Delivery', 'Delivered in 3-7 business days', 99, 1999, 3, 7, true, 1
FROM public.shipping_zones z
WHERE NOT EXISTS (SELECT 1 FROM public.shipping_methods);

INSERT INTO public.tax_rules (name, product_type, hsn_code, rate, inclusive, is_active)
SELECT 'GST 5% (default)', NULL, NULL, 5, true, true
WHERE NOT EXISTS (SELECT 1 FROM public.tax_rules);

INSERT INTO public.site_settings (key, value, description, is_public) VALUES
  ('store', '{"name":"MIRAVIKA","currency":"INR","support_email":"","support_phone":""}'::jsonb, 'Core store identity', true),
  ('checkout', '{"reservation_minutes":30,"min_order_value":0}'::jsonb, 'Checkout behaviour', false),
  ('analytics', '{"ga_measurement_id":"","google_ads_id":"","meta_pixel_id":""}'::jsonb, 'Public analytics identifiers', true),
  ('notifications', '{"provider":"none","from_email":"","from_name":"MIRAVIKA"}'::jsonb, 'Transactional email provider', false)
ON CONFLICT (key) DO NOTHING;