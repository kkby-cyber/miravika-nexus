ALTER TABLE public.shipments
  ADD COLUMN IF NOT EXISTS provider_status text,
  ADD COLUMN IF NOT EXISTS provider_status_at timestamptz,
  ADD COLUMN IF NOT EXISTS provider_event_id text,
  ADD COLUMN IF NOT EXISTS ndr_attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ndr_reason text,
  ADD COLUMN IF NOT EXISTS ndr_action text,
  ADD COLUMN IF NOT EXISTS ndr_last_at timestamptz,
  ADD COLUMN IF NOT EXISTS rto_reason text,
  ADD COLUMN IF NOT EXISTS rto_initiated_at timestamptz,
  ADD COLUMN IF NOT EXISTS rto_delivered_at timestamptz,
  ADD COLUMN IF NOT EXISTS provider_last_synced_at timestamptz;

ALTER TABLE public.shipment_events
  ADD COLUMN IF NOT EXISTS event_key text,
  ADD COLUMN IF NOT EXISTS provider_event_id text,
  ADD COLUMN IF NOT EXISTS provider_status text,
  ADD COLUMN IF NOT EXISTS provider_occurred_at timestamptz;

UPDATE public.shipment_events
SET event_key = COALESCE(event_key, 'legacy:' || id::text)
WHERE event_key IS NULL;

ALTER TABLE public.shipment_events
  ALTER COLUMN event_key SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS shipment_events_event_key_idx
  ON public.shipment_events (shipment_id, event_key);
CREATE UNIQUE INDEX IF NOT EXISTS shipments_provider_order_unique
  ON public.shipments (provider_order_id);
CREATE UNIQUE INDEX IF NOT EXISTS shipments_provider_shipment_unique
  ON public.shipments (provider_shipment_id);
CREATE INDEX IF NOT EXISTS shipments_stale_tracking_idx
  ON public.shipments (provider_last_synced_at, status);

CREATE TABLE IF NOT EXISTS public.shipment_ndr_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shipment_id uuid NOT NULL REFERENCES public.shipments(id) ON DELETE CASCADE,
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  event_key text NOT NULL,
  provider_event_id text,
  reason text,
  attempt_number integer NOT NULL DEFAULT 1 CHECK (attempt_number > 0),
  customer_action text,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'ACTIONED', 'ESCALATED', 'CLOSED')),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shipment_id, event_key)
);
GRANT SELECT ON public.shipment_ndr_events TO authenticated;
GRANT ALL ON public.shipment_ndr_events TO service_role;
ALTER TABLE public.shipment_ndr_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Customers view own NDR events" ON public.shipment_ndr_events FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.orders o WHERE o.id = order_id AND o.user_id = auth.uid()));
CREATE POLICY "Order staff view NDR events" ON public.shipment_ndr_events FOR SELECT TO authenticated
  USING (public.can_manage_orders(auth.uid()));
CREATE INDEX shipment_ndr_events_order_idx ON public.shipment_ndr_events(order_id, occurred_at DESC);

DROP TRIGGER IF EXISTS trg_audit_shipment_ndr ON public.shipment_ndr_events;
CREATE TRIGGER trg_audit_shipment_ndr
AFTER INSERT OR UPDATE ON public.shipment_ndr_events
FOR EACH ROW EXECUTE FUNCTION public.audit_row_change();