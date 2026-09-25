-- Phase 6: bind checkout orders to an authoritative, claim-bound Nexus cart.
-- Existing orders remain valid with nullable cart metadata. Cart rows are never
-- deleted by a payment callback; only the exact cart/claim is converted.

ALTER TABLE public.carts
  ADD COLUMN IF NOT EXISTS checkout_claim_id uuid;

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS cart_id uuid REFERENCES public.carts(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS cart_claim_id uuid,
  ADD COLUMN IF NOT EXISTS cart_cleanup_status text NOT NULL DEFAULT 'NOT_REQUIRED',
  ADD COLUMN IF NOT EXISTS cart_cleanup_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cart_cleanup_last_error text,
  ADD COLUMN IF NOT EXISTS cart_cleared_at timestamptz;

ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS dedupe_key text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'orders_cart_id_fkey'
      AND conrelid = 'public.orders'::regclass
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_cart_id_fkey
      FOREIGN KEY (cart_id) REFERENCES public.carts(id) ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'orders_cart_cleanup_status_check'
      AND conrelid = 'public.orders'::regclass
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_cart_cleanup_status_check
      CHECK (cart_cleanup_status IN ('NOT_REQUIRED', 'PENDING', 'CLEARED', 'FAILED'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'orders_cart_claim_pair_check'
      AND conrelid = 'public.orders'::regclass
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_cart_claim_pair_check
      CHECK ((cart_id IS NULL AND cart_claim_id IS NULL)
          OR (cart_id IS NOT NULL AND cart_claim_id IS NOT NULL));
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_orders_cart_id ON public.orders (cart_id);
CREATE INDEX IF NOT EXISTS idx_orders_cart_cleanup_pending
  ON public.orders (cart_cleanup_status, updated_at)
  WHERE cart_cleanup_status IN ('PENDING', 'FAILED');
CREATE UNIQUE INDEX IF NOT EXISTS orders_one_open_cart_idx
  ON public.orders (cart_id)
  WHERE cart_id IS NOT NULL AND payment_status IN ('PENDING', 'AUTHORIZED');
CREATE UNIQUE INDEX IF NOT EXISTS orders_cart_claim_id_idx
  ON public.orders (cart_claim_id)
  WHERE cart_claim_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedupe_key_idx
  ON public.notifications (dedupe_key)
  WHERE dedupe_key IS NOT NULL;

-- Cart and cart-item writes are server APIs only. The RLS policies remain as
-- defense in depth, but clients no longer receive direct mutation privileges.
REVOKE INSERT, UPDATE, DELETE ON public.carts FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.cart_items FROM anon, authenticated;

-- Claiming is performed in one atomic update. A fresh UUID claim is returned to
-- the trusted server layer and is required for every later release/conversion.
CREATE OR REPLACE FUNCTION public.claim_checkout_cart(
  _cart_id uuid,
  _user_id uuid,
  _session_token text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  claimed_id uuid;
  claimed_claim_id uuid;
BEGIN
  IF _cart_id IS NULL
     OR (_user_id IS NULL AND coalesce(length(_session_token), 0) NOT BETWEEN 32 AND 128) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'INVALID_CART_CLAIM');
  END IF;

  UPDATE public.carts
  SET status = 'CHECKOUT',
      checkout_claim_id = gen_random_uuid()
  WHERE id = _cart_id
    AND status = 'ACTIVE'
    AND (
      (_user_id IS NOT NULL AND user_id = _user_id)
      OR (_user_id IS NULL AND session_token = _session_token)
    )
  RETURNING id, checkout_claim_id INTO claimed_id, claimed_claim_id;

  IF claimed_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'CART_NOT_AVAILABLE');
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'cart_id', claimed_id,
    'checkout_claim_id', claimed_claim_id
  );
END;
$$;

-- A failed pre-payment attempt may release only its own claim. A delayed call
-- therefore cannot release a newer checkout attempt on the same cart row.
CREATE OR REPLACE FUNCTION public.release_checkout_cart(
  _cart_id uuid,
  _checkout_claim_id uuid,
  _user_id uuid,
  _session_token text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.carts
  SET status = 'ACTIVE', checkout_claim_id = NULL
  WHERE id = _cart_id
    AND status = 'CHECKOUT'
    AND checkout_claim_id = _checkout_claim_id
    AND (
      (_user_id IS NOT NULL AND user_id = _user_id)
      OR (_user_id IS NULL AND session_token = _session_token)
    );
  RETURN FOUND;
END;
$$;


-- Releases only the claim recorded on the order. A reused cart with a newer
-- claim is deliberately left untouched.
CREATE OR REPLACE FUNCTION public.release_order_cart_checkout(_order_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target_order public.orders%ROWTYPE;
  cart_released_count integer;
BEGIN
  SELECT * INTO target_order
  FROM public.orders
  WHERE id = _order_id
  FOR UPDATE;

  IF NOT FOUND OR target_order.payment_status IN ('PAID', 'PARTIALLY_REFUNDED', 'REFUNDED') THEN
    RETURN false;
  END IF;

  IF target_order.cart_id IS NULL OR target_order.cart_claim_id IS NULL THEN
    UPDATE public.orders
    SET cart_cleanup_status = 'NOT_REQUIRED', cart_cleanup_last_error = NULL
    WHERE id = _order_id;
    RETURN true;
  END IF;

  UPDATE public.carts
  SET status = 'ACTIVE', checkout_claim_id = NULL
  WHERE id = target_order.cart_id
    AND status = 'CHECKOUT'
    AND checkout_claim_id = target_order.cart_claim_id;
  GET DIAGNOSTICS cart_released_count = ROW_COUNT;

  UPDATE public.orders
  SET cart_cleanup_status = 'NOT_REQUIRED', cart_cleanup_last_error = NULL
  WHERE id = _order_id;

  RETURN cart_released_count > 0
    OR EXISTS (
      SELECT 1 FROM public.carts
      WHERE id = target_order.cart_id
        AND status = 'ACTIVE'
        AND checkout_claim_id IS NULL
    );
END;
$$;

-- Converts only the exact order/cart/claim tuple. No lookup of a replacement or
-- current cart is performed here. The function is safe to retry after success
-- or after a transient post-payment failure.
CREATE OR REPLACE FUNCTION public.clear_order_cart(_order_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target_order public.orders%ROWTYPE;
  target_cart public.carts%ROWTYPE;
  cart_updated_count integer;
BEGIN
  SELECT * INTO target_order
  FROM public.orders
  WHERE id = _order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ORDER_NOT_FOUND');
  END IF;

  IF target_order.cart_id IS NULL THEN
    UPDATE public.orders
    SET cart_cleanup_status = 'NOT_REQUIRED', cart_cleanup_last_error = NULL
    WHERE id = _order_id;
    RETURN jsonb_build_object('ok', true, 'duplicate', true, 'status', 'NOT_REQUIRED');
  END IF;

  IF target_order.payment_status NOT IN ('PAID', 'PARTIALLY_REFUNDED', 'REFUNDED') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ORDER_NOT_PAID');
  END IF;

  IF target_order.cart_cleanup_status = 'CLEARED' THEN
    RETURN jsonb_build_object('ok', true, 'duplicate', true, 'status', 'CLEARED');
  END IF;

  SELECT * INTO target_cart
  FROM public.carts
  WHERE id = target_order.cart_id
  FOR UPDATE;

  IF NOT FOUND THEN
    UPDATE public.orders
    SET cart_cleanup_status = 'FAILED',
        cart_cleanup_attempts = cart_cleanup_attempts + 1,
        cart_cleanup_last_error = 'CART_NOT_FOUND'
    WHERE id = _order_id;
    RETURN jsonb_build_object('ok', false, 'error', 'CART_NOT_FOUND');
  END IF;

  IF target_order.cart_claim_id IS NULL
     OR target_cart.checkout_claim_id IS DISTINCT FROM target_order.cart_claim_id THEN
    UPDATE public.orders
    SET cart_cleanup_status = 'FAILED',
        cart_cleanup_attempts = cart_cleanup_attempts + 1,
        cart_cleanup_last_error = 'CART_CLAIM_MISMATCH'
    WHERE id = _order_id;
    RETURN jsonb_build_object('ok', false, 'error', 'CART_CLAIM_MISMATCH');
  END IF;

  IF target_cart.status = 'CONVERTED' THEN
    UPDATE public.orders
    SET cart_cleanup_status = 'CLEARED',
        cart_cleanup_attempts = cart_cleanup_attempts + 1,
        cart_cleanup_last_error = NULL,
        cart_cleared_at = coalesce(cart_cleared_at, now())
    WHERE id = _order_id;
    RETURN jsonb_build_object('ok', true, 'duplicate', true, 'status', 'CLEARED');
  END IF;

  IF target_cart.status <> 'CHECKOUT' THEN
    UPDATE public.orders
    SET cart_cleanup_status = 'FAILED',
        cart_cleanup_attempts = cart_cleanup_attempts + 1,
        cart_cleanup_last_error = 'CART_NOT_CHECKOUT'
    WHERE id = _order_id;
    RETURN jsonb_build_object('ok', false, 'error', 'CART_NOT_CHECKOUT');
  END IF;

  -- The trigger allows this exact cleanup delete, but rejects all normal
  -- mutations against CHECKOUT/CONVERTED carts.
  PERFORM set_config('app.cart_cleanup', 'on', true);
  DELETE FROM public.cart_items WHERE cart_id = target_order.cart_id;
  UPDATE public.carts
  SET status = 'CONVERTED'
  WHERE id = target_order.cart_id
    AND status = 'CHECKOUT'
    AND checkout_claim_id = target_order.cart_claim_id;
  GET DIAGNOSTICS cart_updated_count = ROW_COUNT;
  PERFORM set_config('app.cart_cleanup', 'off', true);

  IF cart_updated_count = 0 THEN
    RAISE EXCEPTION 'CART_CLAIM_CHANGED';
  END IF;

  UPDATE public.orders
  SET cart_cleanup_status = 'CLEARED',
      cart_cleanup_attempts = cart_cleanup_attempts + 1,
      cart_cleanup_last_error = NULL,
      cart_cleared_at = coalesce(cart_cleared_at, now())
  WHERE id = _order_id;

  RETURN jsonb_build_object('ok', true, 'duplicate', false, 'status', 'CLEARED');
EXCEPTION
  WHEN OTHERS THEN
    UPDATE public.orders
    SET cart_cleanup_status = 'FAILED',
        cart_cleanup_attempts = cart_cleanup_attempts + 1,
        cart_cleanup_last_error = left(SQLERRM, 500)
    WHERE id = _order_id;
    RETURN jsonb_build_object('ok', false, 'error', 'CART_CLEAR_FAILED');
END;
$$;


-- Re-check the provider payment identity while holding the same order lock used
-- for inventory finalization. A second payment ID can therefore never overwrite
-- or masquerade as the original capture.
CREATE OR REPLACE FUNCTION public.confirm_order_paid(
  _order_id uuid,
  _razorpay_payment_id text,
  _method text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  o public.orders%ROWTYPE;
  i record;
  payment_row public.payments%ROWTYPE;
BEGIN
  IF _razorpay_payment_id IS NULL OR btrim(_razorpay_payment_id) = '' THEN
    RAISE EXCEPTION 'PAYMENT_REFERENCE_REQUIRED';
  END IF;

  SELECT * INTO o
  FROM public.orders
  WHERE id = _order_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORDER_NOT_FOUND'; END IF;

  IF o.razorpay_payment_id IS NOT NULL
     AND o.razorpay_payment_id IS DISTINCT FROM _razorpay_payment_id THEN
    RAISE EXCEPTION 'PAYMENT_ID_MISMATCH';
  END IF;

  IF o.inventory_finalized
     AND o.payment_status IN ('PAID', 'PARTIALLY_REFUNDED', 'REFUNDED') THEN
    RETURN jsonb_build_object('ok', true, 'duplicate', true);
  END IF;

  FOR i IN
    SELECT sku, quantity
    FROM public.order_items
    WHERE order_id = _order_id
  LOOP
    IF NOT public.finalize_inventory(i.sku, i.quantity, _order_id::text) THEN
      RAISE EXCEPTION 'INVENTORY_FINALIZE_FAILED';
    END IF;
  END LOOP;

  UPDATE public.payments
  SET status = 'PAID',
      captured_amount = amount,
      captured_at = coalesce(captured_at, now()),
      razorpay_payment_id = _razorpay_payment_id,
      method = _method,
      razorpay_signature_verified = true
  WHERE order_id = _order_id
    AND status IN ('PENDING', 'AUTHORIZED')
    AND (razorpay_payment_id IS NULL OR razorpay_payment_id = _razorpay_payment_id)
  RETURNING * INTO payment_row;

  IF NOT FOUND THEN
    SELECT * INTO payment_row
    FROM public.payments
    WHERE order_id = _order_id
      AND status IN ('PAID', 'PARTIALLY_REFUNDED', 'REFUNDED')
      AND razorpay_payment_id = _razorpay_payment_id
    LIMIT 1;
    IF NOT FOUND THEN RAISE EXCEPTION 'PAYMENT_NOT_PENDING'; END IF;
  END IF;

  UPDATE public.orders
  SET status = CASE
        WHEN status = 'PENDING_PAYMENT' THEN 'PAID'::public.order_status
        ELSE status
      END,
      payment_status = 'PAID',
      razorpay_payment_id = _razorpay_payment_id,
      inventory_finalized = true,
      paid_at = coalesce(paid_at, now())
  WHERE id = _order_id;

  RETURN jsonb_build_object(
    'ok', true,
    'duplicate', false,
    'payment_id', payment_row.id
  );
END;
$$;

-- Releasing all reservations and the order status is one transaction. This keeps
-- a failed/cancelled order from partially releasing stock or touching a newer
-- checkout claim.
CREATE OR REPLACE FUNCTION public.release_order_inventory(
  _order_id uuid,
  _next_payment_status public.payment_status
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target_order public.orders%ROWTYPE;
  item record;
  released_one boolean;
  already_released boolean;
  cart_released_count integer;
BEGIN
  IF _next_payment_status NOT IN ('FAILED', 'CANCELLED') THEN
    RAISE EXCEPTION 'INVALID_RELEASE_STATUS';
  END IF;

  SELECT * INTO target_order
  FROM public.orders
  WHERE id = _order_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ORDER_NOT_FOUND');
  END IF;

  IF target_order.inventory_finalized
     OR target_order.payment_status IN ('PAID', 'PARTIALLY_REFUNDED', 'REFUNDED') THEN
    RETURN jsonb_build_object('ok', true, 'duplicate', true);
  END IF;

  FOR item IN
    SELECT sku, quantity
    FROM public.order_items
    WHERE order_id = _order_id
  LOOP
    released_one := public.release_inventory(item.sku, item.quantity, _order_id::text);
    IF NOT released_one THEN
      SELECT EXISTS (
        SELECT 1
        FROM public.inventory_movements m
        JOIN public.inventory i ON i.id = m.inventory_id
        WHERE i.sku = item.sku
          AND m.type = 'release'
          AND m.reference_type = 'order'
          AND m.reference_id = _order_id::text
      ) INTO already_released;
      IF NOT already_released THEN
        RETURN jsonb_build_object('ok', false, 'error', 'INVENTORY_RELEASE_FAILED');
      END IF;
    END IF;
  END LOOP;

  UPDATE public.orders
  SET payment_status = _next_payment_status,
      status = CASE
        WHEN _next_payment_status = 'CANCELLED' THEN 'CANCELLED'::public.order_status
        ELSE status
      END,
      cancelled_at = CASE
        WHEN _next_payment_status = 'CANCELLED' THEN now()
        ELSE cancelled_at
      END
  WHERE id = _order_id;

  IF target_order.cart_id IS NOT NULL AND target_order.cart_claim_id IS NOT NULL THEN
    UPDATE public.carts
    SET status = 'ACTIVE', checkout_claim_id = NULL
    WHERE id = target_order.cart_id
      AND status = 'CHECKOUT'
      AND checkout_claim_id = target_order.cart_claim_id;
    GET DIAGNOSTICS cart_released_count = ROW_COUNT;
  ELSE
    cart_released_count := 0;
  END IF;

  UPDATE public.orders
  SET cart_cleanup_status = 'NOT_REQUIRED', cart_cleanup_last_error = NULL
  WHERE id = _order_id;

  RETURN jsonb_build_object(
    'ok', true,
    'duplicate', false,
    'cart_released', cart_released_count > 0
  );
END;
$$;


-- Coupon redemption and usage counting are one idempotent transaction. The
-- existing partial unique index makes retries safe without inflating usage.
CREATE OR REPLACE FUNCTION public.redeem_order_coupon(_order_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target_order public.orders%ROWTYPE;
  target_coupon public.coupons%ROWTYPE;
  redemption_id uuid;
BEGIN
  SELECT * INTO target_order
  FROM public.orders
  WHERE id = _order_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'ORDER_NOT_FOUND'); END IF;
  IF target_order.payment_status NOT IN ('PAID', 'PARTIALLY_REFUNDED', 'REFUNDED')
     OR target_order.coupon_code IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'COUPON_NOT_APPLICABLE');
  END IF;

  SELECT * INTO target_coupon
  FROM public.coupons
  WHERE code = target_order.coupon_code
  FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'COUPON_NOT_FOUND'); END IF;

  INSERT INTO public.coupon_redemptions(coupon_id, user_id, order_id, amount)
  VALUES (target_coupon.id, target_order.user_id, target_order.id, target_order.discount_total)
  ON CONFLICT (coupon_id, order_id) WHERE order_id IS NOT NULL DO NOTHING
  RETURNING id INTO redemption_id;

  IF redemption_id IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'duplicate', true);
  END IF;

  UPDATE public.coupons
  SET used_count = used_count + 1
  WHERE id = target_coupon.id;

  RETURN jsonb_build_object('ok', true, 'duplicate', false);
EXCEPTION
  WHEN unique_violation THEN
    RETURN jsonb_build_object('ok', true, 'duplicate', true);
END;
$$;

-- Reject direct cart-item writes while a cart is claimed or converted. The
-- service role may still perform the explicitly marked cleanup delete above.
CREATE OR REPLACE FUNCTION public.enforce_cart_item_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  cart_status text;
  target_cart_id uuid;
BEGIN
  IF current_setting('app.cart_cleanup', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  target_cart_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.cart_id ELSE NEW.cart_id END;
  SELECT status INTO cart_status
  FROM public.carts
  WHERE id = target_cart_id;

  IF cart_status IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'CART_NOT_MUTABLE';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_cart_items_mutable ON public.cart_items;
CREATE TRIGGER trg_cart_items_mutable
BEFORE INSERT OR UPDATE OR DELETE ON public.cart_items
FOR EACH ROW EXECUTE FUNCTION public.enforce_cart_item_mutation();

-- Enforce the order/cart/claim tuple at insertion time and make it immutable.
-- The service role still supplies the tuple, but the database refuses a stale
-- claim or an owner/cart mismatch.
CREATE OR REPLACE FUNCTION public.enforce_order_cart_binding()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  cart_row public.carts%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.cart_id IS DISTINCT FROM OLD.cart_id
       OR NEW.cart_claim_id IS DISTINCT FROM OLD.cart_claim_id THEN
      RAISE EXCEPTION 'ORDER_CART_BINDING_IMMUTABLE';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.cart_id IS NULL THEN
    IF NEW.cart_claim_id IS NOT NULL THEN RAISE EXCEPTION 'ORDER_CART_CLAIM_REQUIRED'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.cart_claim_id IS NULL THEN RAISE EXCEPTION 'ORDER_CART_CLAIM_REQUIRED'; END IF;

  SELECT * INTO cart_row
  FROM public.carts
  WHERE id = NEW.cart_id
  FOR UPDATE;
  IF NOT FOUND
     OR cart_row.status <> 'CHECKOUT'
     OR cart_row.checkout_claim_id IS DISTINCT FROM NEW.cart_claim_id
     OR NEW.user_id IS DISTINCT FROM cart_row.user_id THEN
    RAISE EXCEPTION 'ORDER_CART_CLAIM_MISMATCH';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_orders_cart_binding ON public.orders;
CREATE TRIGGER trg_orders_cart_binding
BEFORE INSERT OR UPDATE ON public.orders
FOR EACH ROW EXECUTE FUNCTION public.enforce_order_cart_binding();

REVOKE EXECUTE ON FUNCTION public.claim_checkout_cart(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.release_checkout_cart(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.release_order_cart_checkout(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.clear_order_cart(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.confirm_order_paid(uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.release_order_inventory(uuid, public.payment_status) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.redeem_order_coupon(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.enforce_cart_item_mutation() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.enforce_order_cart_binding() FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.claim_checkout_cart(uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_checkout_cart(uuid, uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_order_cart_checkout(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.clear_order_cart(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.confirm_order_paid(uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_order_inventory(uuid, public.payment_status) TO service_role;
GRANT EXECUTE ON FUNCTION public.redeem_order_coupon(uuid) TO service_role;
