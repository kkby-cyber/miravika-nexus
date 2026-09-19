ALTER TABLE public.addresses
  ADD COLUMN IF NOT EXISTS address_type text NOT NULL DEFAULT 'shipping',
  ADD COLUMN IF NOT EXISTS landmark text,
  ADD CONSTRAINT addresses_type_check CHECK (address_type IN ('shipping', 'billing')),
  ADD CONSTRAINT addresses_postal_code_check CHECK (postal_code ~ '^[A-Za-z0-9 -]{4,12}$');

CREATE UNIQUE INDEX IF NOT EXISTS addresses_one_default_per_type
  ON public.addresses (user_id, address_type) WHERE is_default AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS addresses_owner_type_idx ON public.addresses (user_id, address_type, deleted_at);

ALTER TABLE public.reviews
  ADD COLUMN IF NOT EXISTS verified_purchase boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS verified_order_id uuid REFERENCES public.orders(id) ON DELETE SET NULL,
  ADD CONSTRAINT reviews_title_length CHECK (title IS NULL OR char_length(title) <= 200),
  ADD CONSTRAINT reviews_body_length CHECK (char_length(body) BETWEEN 10 AND 5000);
CREATE INDEX IF NOT EXISTS reviews_public_product_idx ON public.reviews (product_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS reviews_verified_order_idx ON public.reviews (verified_order_id);

ALTER TABLE public.wishlist_items
  ADD COLUMN IF NOT EXISTS variant_id uuid REFERENCES public.product_variants(id) ON DELETE CASCADE;
ALTER TABLE public.wishlist_items DROP CONSTRAINT IF EXISTS wishlist_items_wishlist_id_product_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS wishlist_items_product_variant_key
  ON public.wishlist_items (wishlist_id, product_id, COALESCE(variant_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE TABLE IF NOT EXISTS public.newsletter_subscribers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'SUBSCRIBED' CHECK (status IN ('SUBSCRIBED', 'UNSUBSCRIBED')),
  subscribed_at timestamptz,
  unsubscribed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.newsletter_subscribers TO service_role;
ALTER TABLE public.newsletter_subscribers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "staff read newsletter subscribers" ON public.newsletter_subscribers FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));
CREATE TRIGGER trg_newsletter_updated BEFORE UPDATE ON public.newsletter_subscribers FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS trg_audit_newsletter ON public.newsletter_subscribers;
CREATE TRIGGER trg_audit_newsletter
AFTER INSERT OR UPDATE ON public.newsletter_subscribers
FOR EACH ROW EXECUTE FUNCTION public.audit_row_change();