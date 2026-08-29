-- 1. Extend order lifecycle statuses
ALTER TYPE public.order_status ADD VALUE IF NOT EXISTS 'CONFIRMED';
ALTER TYPE public.order_status ADD VALUE IF NOT EXISTS 'SHIPMENT_CREATED';
ALTER TYPE public.order_status ADD VALUE IF NOT EXISTS 'AWB_ASSIGNED';
ALTER TYPE public.order_status ADD VALUE IF NOT EXISTS 'PICKUP_SCHEDULED';
ALTER TYPE public.order_status ADD VALUE IF NOT EXISTS 'RTO_INITIATED';
ALTER TYPE public.order_status ADD VALUE IF NOT EXISTS 'RTO_DELIVERED';
ALTER TYPE public.order_status ADD VALUE IF NOT EXISTS 'PAYMENT_FAILED';

-- 2. Shipping fields on orders
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS shipping_status text NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS shipping_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS shipping_last_error text;

-- 3. Shipments
CREATE TABLE IF NOT EXISTS public.shipments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL UNIQUE REFERENCES public.orders(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'shiprocket',
  provider_order_id text,
  provider_shipment_id text,
  awb_code text,
  courier_name text,
  courier_company_id text,
  status text NOT NULL DEFAULT 'CREATED',
  tracking_url text,
  label_url text,
  manifest_url text,
  invoice_url text,
  pickup_scheduled_date timestamptz,
  estimated_delivery_date timestamptz,
  shipped_at timestamptz,
  delivered_at timestamptz,
  cancelled_at timestamptz,
  freight_charge numeric(12,2),
  applied_weight numeric(10,3),
  last_error text,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.shipments TO authenticated;
GRANT ALL ON public.shipments TO service_role;
ALTER TABLE public.shipments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Customers view own shipments"
  ON public.shipments FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.orders o WHERE o.id = shipments.order_id AND o.user_id = auth.uid()));

CREATE POLICY "Order staff view shipments"
  ON public.shipments FOR SELECT TO authenticated
  USING (public.can_manage_orders(auth.uid()));

CREATE POLICY "Order staff update shipments"
  ON public.shipments FOR UPDATE TO authenticated
  USING (public.can_manage_orders(auth.uid()))
  WITH CHECK (public.can_manage_orders(auth.uid()));

CREATE INDEX IF NOT EXISTS shipments_awb_idx ON public.shipments (awb_code);
CREATE INDEX IF NOT EXISTS shipments_status_idx ON public.shipments (status);

CREATE TRIGGER update_shipments_updated_at
  BEFORE UPDATE ON public.shipments
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 4. Shipment tracking events
CREATE TABLE IF NOT EXISTS public.shipment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id uuid NOT NULL REFERENCES public.shipments(id) ON DELETE CASCADE,
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  status text NOT NULL,
  status_code text,
  location text,
  note text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.shipment_events TO authenticated;
GRANT ALL ON public.shipment_events TO service_role;
ALTER TABLE public.shipment_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Customers view own shipment events"
  ON public.shipment_events FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.orders o WHERE o.id = shipment_events.order_id AND o.user_id = auth.uid()));

CREATE POLICY "Order staff view shipment events"
  ON public.shipment_events FOR SELECT TO authenticated
  USING (public.can_manage_orders(auth.uid()));

CREATE UNIQUE INDEX IF NOT EXISTS shipment_events_dedupe_idx
  ON public.shipment_events (shipment_id, status, occurred_at);
CREATE INDEX IF NOT EXISTS shipment_events_order_idx ON public.shipment_events (order_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS orders_shipping_status_idx ON public.orders (shipping_status, paid_at);