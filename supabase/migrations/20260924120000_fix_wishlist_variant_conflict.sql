ALTER TABLE public.wishlist_items
  ADD COLUMN IF NOT EXISTS variant_key uuid
  GENERATED ALWAYS AS (
    COALESCE(
      variant_id,
      '00000000-0000-0000-0000-000000000000'::uuid
    )
  ) STORED;

DROP INDEX IF EXISTS public.wishlist_items_product_variant_key;

ALTER TABLE public.wishlist_items
  DROP CONSTRAINT IF EXISTS wishlist_items_wishlist_product_variant_key;

ALTER TABLE public.wishlist_items
  ADD CONSTRAINT wishlist_items_wishlist_product_variant_key
  UNIQUE (wishlist_id, product_id, variant_key);
