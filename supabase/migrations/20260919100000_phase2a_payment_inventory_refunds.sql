-- Phase 2A: make inventory RPCs reference-idempotent and reservation-aware.
ALTER TABLE public.inventory_movements
  ADD CONSTRAINT inventory_movements_nonzero_quantity CHECK (quantity <> 0);

CREATE OR REPLACE FUNCTION public.reserve_inventory(_sku text, _qty integer, _reference_id text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE inv_id uuid;
BEGIN
  IF _qty <= 0 OR _reference_id IS NULL OR _reference_id = '' THEN
    RAISE EXCEPTION 'INVALID_RESERVATION';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.inventory_movements m
    JOIN public.inventory i ON i.id = m.inventory_id
    WHERE i.sku = _sku AND m.type = 'reservation' AND m.reference_type = 'order' AND m.reference_id = _reference_id
  ) THEN
    RETURN true;
  END IF;
  UPDATE public.inventory
  SET available_quantity = available_quantity - _qty,
      reserved_quantity = reserved_quantity + _qty
  WHERE sku = _sku AND available_quantity >= _qty
  RETURNING id INTO inv_id;
  IF inv_id IS NULL THEN RETURN false; END IF;
  INSERT INTO public.inventory_movements (inventory_id, type, quantity, reference_type, reference_id)
  VALUES (inv_id, 'reservation', -_qty, 'order', _reference_id);
  RETURN true;
END; $$;

CREATE OR REPLACE FUNCTION public.release_inventory(_sku text, _qty integer, _reference_id text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE inv_id uuid;
BEGIN
  IF _qty <= 0 OR _reference_id IS NULL OR _reference_id = '' THEN
    RAISE EXCEPTION 'INVALID_RELEASE';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.inventory_movements m
    JOIN public.inventory i ON i.id = m.inventory_id
    WHERE i.sku = _sku AND m.type = 'release' AND m.reference_type = 'order' AND m.reference_id = _reference_id
  ) THEN
    RETURN true;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.inventory_movements m
    JOIN public.inventory i ON i.id = m.inventory_id
    WHERE i.sku = _sku AND m.type = 'reservation' AND m.reference_type = 'order' AND m.reference_id = _reference_id
  ) THEN
    RETURN false;
  END IF;
  UPDATE public.inventory
  SET available_quantity = available_quantity + _qty,
      reserved_quantity = reserved_quantity - _qty
  WHERE sku = _sku AND reserved_quantity >= _qty
  RETURNING id INTO inv_id;
  IF inv_id IS NULL THEN RETURN false; END IF;
  INSERT INTO public.inventory_movements (inventory_id, type, quantity, reference_type, reference_id)
  VALUES (inv_id, 'release', _qty, 'order', _reference_id);
  RETURN true;
END; $$;

CREATE OR REPLACE FUNCTION public.finalize_inventory(_sku text, _qty integer, _reference_id text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE inv_id uuid;
BEGIN
  IF _qty <= 0 OR _reference_id IS NULL OR _reference_id = '' THEN
    RAISE EXCEPTION 'INVALID_FINALIZATION';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.inventory_movements m
    JOIN public.inventory i ON i.id = m.inventory_id
    WHERE i.sku = _sku AND m.type = 'sale' AND m.reference_type = 'order' AND m.reference_id = _reference_id
  ) THEN
    RETURN true;
  END IF;
  UPDATE public.inventory
  SET reserved_quantity = reserved_quantity - _qty,
      sold_quantity = sold_quantity + _qty
  WHERE sku = _sku AND reserved_quantity >= _qty
  RETURNING id INTO inv_id;
  IF inv_id IS NULL THEN RETURN false; END IF;
  INSERT INTO public.inventory_movements (inventory_id, type, quantity, reference_type, reference_id)
  VALUES (inv_id, 'sale', -_qty, 'order', _reference_id);
  RETURN true;
END; $$;

CREATE OR REPLACE FUNCTION public.confirm_order_paid(
  _order_id uuid,
  _razorpay_payment_id text,
  _method text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE o public.orders%ROWTYPE; i record; payment_row public.payments%ROWTYPE;
BEGIN
  SELECT * INTO o FROM public.orders WHERE id = _order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ORDER_NOT_FOUND'; END IF;
  IF o.payment_status = 'PAID' AND o.inventory_finalized THEN
    RETURN jsonb_build_object('ok', true, 'duplicate', true);
  END IF;

  FOR i IN SELECT sku, quantity FROM public.order_items WHERE order_id = _order_id LOOP
    IF NOT public.finalize_inventory(i.sku, i.quantity, _order_id::text) THEN
      RAISE EXCEPTION 'INVENTORY_FINALIZE_FAILED';
    END IF;
  END LOOP;

  UPDATE public.payments
  SET status = 'PAID', captured_amount = amount, captured_at = COALESCE(captured_at, now()),
      razorpay_payment_id = _razorpay_payment_id, method = _method, razorpay_signature_verified = true
  WHERE order_id = _order_id AND status IN ('PENDING','AUTHORIZED')
  RETURNING * INTO payment_row;
  IF NOT FOUND THEN
    SELECT * INTO payment_row FROM public.payments WHERE order_id = _order_id AND status = 'PAID' LIMIT 1;
    IF NOT FOUND THEN RAISE EXCEPTION 'PAYMENT_NOT_PENDING'; END IF;
  END IF;

  UPDATE public.orders
  SET status = CASE WHEN status = 'PENDING_PAYMENT' THEN 'PAID'::public.order_status ELSE status END,
      payment_status = 'PAID', razorpay_payment_id = _razorpay_payment_id,
      inventory_finalized = true, paid_at = COALESCE(paid_at, now())
  WHERE id = _order_id;
  RETURN jsonb_build_object('ok', true, 'duplicate', false, 'payment_id', payment_row.id);
END; $$;

CREATE OR REPLACE FUNCTION public.restock_inventory(_sku text, _qty integer, _reference_id text, _type public.movement_type)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE inv_id uuid;
BEGIN
  IF _qty <= 0 OR _reference_id IS NULL OR _reference_id = '' THEN
    RAISE EXCEPTION 'INVALID_RESTOCK';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.inventory_movements m
    JOIN public.inventory i ON i.id = m.inventory_id
    WHERE i.sku = _sku AND m.type = _type AND m.reference_type = 'order' AND m.reference_id = _reference_id
  ) THEN
    RETURN true;
  END IF;
  UPDATE public.inventory
  SET available_quantity = available_quantity + _qty,
      sold_quantity = sold_quantity - _qty
  WHERE sku = _sku AND sold_quantity >= _qty
  RETURNING id INTO inv_id;
  IF inv_id IS NULL THEN RETURN false; END IF;
  INSERT INTO public.inventory_movements (inventory_id, type, quantity, reference_type, reference_id)
  VALUES (inv_id, _type, _qty, 'order', _reference_id);
  RETURN true;
END; $$;

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS captured_amount numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS captured_at timestamptz,
  ADD COLUMN IF NOT EXISTS failed_at timestamptz,
  ADD COLUMN IF NOT EXISTS refunded_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_error text;

UPDATE public.payments
SET captured_amount = amount,
    captured_at = COALESCE(captured_at, updated_at)
WHERE status IN ('PAID', 'PARTIALLY_REFUNDED', 'REFUNDED') AND captured_amount = 0;

ALTER TABLE public.payments
  ADD CONSTRAINT payments_amount_nonnegative CHECK (amount >= 0),
  ADD CONSTRAINT payments_captured_amount_valid CHECK (captured_amount >= 0 AND captured_amount <= amount),
  ADD CONSTRAINT payments_refunded_amount_valid CHECK (refunded_amount >= 0 AND refunded_amount <= captured_amount);

CREATE OR REPLACE FUNCTION public.enforce_payment_status_transition()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  IF current_setting('app.refund_compensation', true) = 'on' THEN RETURN NEW; END IF;
  IF NOT (
    (OLD.status = 'PENDING' AND NEW.status IN ('AUTHORIZED','PAID','FAILED','CANCELLED')) OR
    (OLD.status = 'AUTHORIZED' AND NEW.status IN ('PAID','FAILED','CANCELLED')) OR
    (OLD.status = 'PAID' AND NEW.status IN ('PARTIALLY_REFUNDED','REFUNDED')) OR
    (OLD.status = 'PARTIALLY_REFUNDED' AND NEW.status = 'REFUNDED')
  ) THEN
    RAISE EXCEPTION 'INVALID_PAYMENT_STATUS_TRANSITION: % -> %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_payment_status_transition ON public.payments;
CREATE TRIGGER trg_payment_status_transition
BEFORE UPDATE OF status ON public.payments
FOR EACH ROW EXECUTE FUNCTION public.enforce_payment_status_transition();

CREATE TABLE IF NOT EXISTS public.refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id uuid NOT NULL REFERENCES public.payments(id) ON DELETE RESTRICT,
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL UNIQUE,
  razorpay_refund_id text UNIQUE,
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  status text NOT NULL DEFAULT 'PROCESSING' CHECK (status IN ('PROCESSING','CREATED','PROCESSED','FAILED')),
  reason text,
  provider_status text,
  error text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.refunds TO authenticated;
GRANT ALL ON public.refunds TO service_role;
ALTER TABLE public.refunds ENABLE ROW LEVEL SECURITY;
CREATE POLICY "staff read refunds" ON public.refunds FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));
CREATE INDEX refunds_order_idx ON public.refunds(order_id, created_at DESC);
CREATE INDEX refunds_payment_idx ON public.refunds(payment_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.prepare_refund(
  _payment_id uuid,
  _amount numeric,
  _idempotency_key text,
  _reason text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE p public.payments%ROWTYPE; r public.refunds%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.refunds WHERE idempotency_key = _idempotency_key;
  IF FOUND THEN RETURN jsonb_build_object('duplicate', true, 'refund_id', r.id, 'amount', r.amount, 'status', r.status); END IF;
  SELECT * INTO p FROM public.payments WHERE id = _payment_id FOR UPDATE;
  IF NOT FOUND OR p.status NOT IN ('PAID','PARTIALLY_REFUNDED') THEN RAISE EXCEPTION 'PAYMENT_NOT_REFUNDABLE'; END IF;
  IF _amount <= 0 OR _amount > (p.captured_amount - p.refunded_amount) THEN RAISE EXCEPTION 'INVALID_REFUND_AMOUNT'; END IF;
  INSERT INTO public.refunds(payment_id, order_id, idempotency_key, amount, reason)
  VALUES (_payment_id, p.order_id, _idempotency_key, _amount, _reason)
  RETURNING * INTO r;
  UPDATE public.payments
  SET refunded_amount = refunded_amount + _amount,
      status = CASE WHEN refunded_amount + _amount = captured_amount THEN 'REFUNDED'::public.payment_status ELSE 'PARTIALLY_REFUNDED'::public.payment_status END,
      refunded_at = CASE WHEN refunded_amount + _amount = captured_amount THEN now() ELSE refunded_at END
  WHERE id = _payment_id;
  RETURN jsonb_build_object('duplicate', false, 'refund_id', r.id, 'amount', r.amount, 'razorpay_payment_id', p.razorpay_payment_id);
END; $$;

CREATE OR REPLACE FUNCTION public.complete_refund(_refund_id uuid, _provider_refund_id text, _provider_status text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.refunds%ROWTYPE;
BEGIN
  UPDATE public.refunds SET razorpay_refund_id = _provider_refund_id, provider_status = _provider_status,
    status = CASE WHEN lower(_provider_status) IN ('processed','completed') THEN 'PROCESSED' ELSE 'CREATED' END,
    processed_at = CASE WHEN lower(_provider_status) IN ('processed','completed') THEN now() ELSE processed_at END
  WHERE id = _refund_id RETURNING * INTO r;
  IF NOT FOUND THEN RAISE EXCEPTION 'REFUND_NOT_FOUND'; END IF;
  RETURN jsonb_build_object('refund_id', r.id, 'status', r.status, 'amount', r.amount, 'razorpay_refund_id', r.razorpay_refund_id);
END; $$;

CREATE OR REPLACE FUNCTION public.fail_refund(_refund_id uuid, _reason text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.refunds%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.refunds WHERE id = _refund_id FOR UPDATE;
  IF NOT FOUND OR r.status = 'FAILED' THEN RETURN true; END IF;
  IF r.status IN ('CREATED','PROCESSED') THEN RETURN false; END IF;
  PERFORM set_config('app.refund_compensation', 'on', true);
  UPDATE public.payments SET refunded_amount = refunded_amount - r.amount,
    status = CASE WHEN refunded_amount - r.amount = 0 THEN 'PAID'::public.payment_status ELSE 'PARTIALLY_REFUNDED'::public.payment_status END
  WHERE id = r.payment_id;
  UPDATE public.refunds SET status = 'FAILED', error = left(_reason, 500) WHERE id = r.id;
  RETURN true;
END; $$;

REVOKE EXECUTE ON FUNCTION public.prepare_refund(uuid,numeric,text,text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.complete_refund(uuid,text,text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fail_refund(uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_refund(uuid,numeric,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_refund(uuid,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_refund(uuid,text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.confirm_order_paid(uuid,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_order_paid(uuid,text,text) TO service_role;

ALTER TABLE public.audit_logs ADD COLUMN IF NOT EXISTS request_id text;

DROP TRIGGER IF EXISTS trg_audit_inventory_movements ON public.inventory_movements;
CREATE TRIGGER trg_audit_inventory_movements
AFTER INSERT ON public.inventory_movements
FOR EACH ROW EXECUTE FUNCTION public.audit_row_change();

DROP TRIGGER IF EXISTS trg_audit_refunds ON public.refunds;
CREATE TRIGGER trg_audit_refunds
AFTER INSERT OR UPDATE ON public.refunds
FOR EACH ROW EXECUTE FUNCTION public.audit_row_change();