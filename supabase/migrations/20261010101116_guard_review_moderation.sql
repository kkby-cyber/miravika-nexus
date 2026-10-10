-- Reviews: the "own reviews" RLS policy lets a signed-in customer INSERT/UPDATE their own
-- rows directly through the Supabase REST API, including status and verified_purchase, and
-- "public read approved reviews" then publishes them. This trigger keeps moderation and
-- purchase verification under the server (service role) and staff:
--   * customer inserts always start PENDING and unverified;
--   * customer updates cannot change owner, product, status or verification, and any
--     content edit sends the review back to PENDING for re-moderation.
-- Rollback: DROP TRIGGER trg_reviews_guard_moderation ON public.reviews;
--           DROP FUNCTION public.guard_review_moderation();

CREATE OR REPLACE FUNCTION public.guard_review_moderation()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
BEGIN
  IF current_user IN ('service_role', 'postgres', 'supabase_admin')
     OR (auth.uid() IS NOT NULL AND public.is_staff(auth.uid())) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.status := 'PENDING';
    NEW.verified_purchase := false;
    NEW.verified_order_id := NULL;
  ELSE
    NEW.user_id := OLD.user_id;
    NEW.product_id := OLD.product_id;
    NEW.verified_purchase := OLD.verified_purchase;
    NEW.verified_order_id := OLD.verified_order_id;
    NEW.status := CASE
      WHEN (NEW.rating, NEW.title, NEW.body) IS DISTINCT FROM (OLD.rating, OLD.title, OLD.body)
        THEN 'PENDING'
      ELSE OLD.status
    END;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_reviews_guard_moderation BEFORE INSERT OR UPDATE ON public.reviews
  FOR EACH ROW EXECUTE FUNCTION public.guard_review_moderation();

REVOKE EXECUTE ON FUNCTION public.guard_review_moderation() FROM PUBLIC, anon, authenticated;
