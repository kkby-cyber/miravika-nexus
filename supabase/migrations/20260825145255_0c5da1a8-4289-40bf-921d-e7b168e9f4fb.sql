-- 1. Staff session tracking
CREATE TABLE public.staff_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  ip_address text,
  user_agent text,
  revoked_at timestamptz,
  revoked_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  end_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX staff_sessions_user_idx ON public.staff_sessions (user_id, started_at DESC);
CREATE INDEX staff_sessions_active_idx ON public.staff_sessions (last_activity_at DESC) WHERE ended_at IS NULL;

GRANT SELECT, INSERT, UPDATE ON public.staff_sessions TO authenticated;
GRANT ALL ON public.staff_sessions TO service_role;

ALTER TABLE public.staff_sessions ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER trg_staff_sessions_updated BEFORE UPDATE ON public.staff_sessions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 2. Role permission matrix
CREATE TABLE public.role_permissions (
  role public.app_role NOT NULL,
  permission text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role, permission)
);

GRANT SELECT ON public.role_permissions TO authenticated;
GRANT INSERT, DELETE ON public.role_permissions TO authenticated;
GRANT ALL ON public.role_permissions TO service_role;

ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;

-- 3. Permission check (security definer, no recursion)
CREATE OR REPLACE FUNCTION public.has_permission(_user_id uuid, _permission text)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    JOIN public.role_permissions rp ON rp.role = ur.role
    WHERE ur.user_id = _user_id
      AND rp.permission = _permission
  );
$$;

-- 4. Session policies
CREATE POLICY "Staff read own sessions, managers read all"
  ON public.staff_sessions FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.has_permission(auth.uid(), 'staff.view'));

CREATE POLICY "Staff start own session"
  ON public.staff_sessions FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() AND public.is_staff(auth.uid()));

CREATE POLICY "Staff heartbeat own session, managers revoke"
  ON public.staff_sessions FOR UPDATE TO authenticated
  USING (user_id = auth.uid() OR public.has_permission(auth.uid(), 'staff.manage'))
  WITH CHECK (user_id = auth.uid() OR public.has_permission(auth.uid(), 'staff.manage'));

-- 5. Permission matrix policies
CREATE POLICY "Staff can read permission matrix"
  ON public.role_permissions FOR SELECT TO authenticated
  USING (public.is_staff(auth.uid()));

CREATE POLICY "Super admin inserts permissions"
  ON public.role_permissions FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'SUPER_ADMIN'));

CREATE POLICY "Super admin deletes permissions"
  ON public.role_permissions FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'SUPER_ADMIN'));

-- 6. Audit log enrichment
ALTER TABLE public.audit_logs ADD COLUMN IF NOT EXISTS entity_name text;
ALTER TABLE public.audit_logs ADD COLUMN IF NOT EXISTS ip_address text;
ALTER TABLE public.audit_logs ADD COLUMN IF NOT EXISTS user_agent text;
CREATE INDEX IF NOT EXISTS audit_logs_actor_idx ON public.audit_logs (actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_action_idx ON public.audit_logs (action, created_at DESC);

-- 7. Secure staff activity writer (audit rows stay immutable: no UPDATE/DELETE grants exist)
CREATE OR REPLACE FUNCTION public.log_staff_activity(
  _action text,
  _entity_type text DEFAULT NULL,
  _entity_id text DEFAULT NULL,
  _entity_name text DEFAULT NULL,
  _metadata jsonb DEFAULT '{}'::jsonb,
  _ip text DEFAULT NULL,
  _user_agent text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF length(_action) > 80 THEN
    RAISE EXCEPTION 'action too long';
  END IF;
  INSERT INTO public.audit_logs (actor_id, action, entity_type, entity_id, entity_name, metadata, ip_address, user_agent)
  VALUES (auth.uid(), _action, _entity_type, _entity_id, _entity_name, COALESCE(_metadata, '{}'::jsonb), _ip, _user_agent);
END;
$$;
GRANT EXECUTE ON FUNCTION public.log_staff_activity(text, text, text, text, jsonb, text, text) TO authenticated;

-- 8. Recognise new roles in existing manager checks
CREATE OR REPLACE FUNCTION public.can_manage_catalog(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id
    AND role IN ('SUPER_ADMIN','ADMIN','CATALOG_MANAGER','MANAGER','CATALOG_STAFF'));
$$;

CREATE OR REPLACE FUNCTION public.can_manage_orders(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id
    AND role IN ('SUPER_ADMIN','ADMIN','ORDER_MANAGER','MANAGER','ORDER_STAFF','SUPPORT'));
$$;

-- 9. Default permission matrix
INSERT INTO public.role_permissions (role, permission)
SELECT 'SUPER_ADMIN'::public.app_role, p.permission
FROM (VALUES
  ('products.view'), ('products.create'), ('products.edit'), ('products.delete'),
  ('collections.view'), ('collections.create'), ('collections.edit'), ('collections.delete'),
  ('inventory.view'), ('inventory.edit'),
  ('orders.view'), ('orders.edit'), ('orders.fulfill'), ('orders.cancel'), ('orders.refund'),
  ('customers.view'), ('customers.edit'),
  ('coupons.view'), ('coupons.create'), ('coupons.edit'), ('coupons.delete'),
  ('shipping.view'), ('shipping.edit'),
  ('analytics.view'),
  ('staff.view'), ('staff.manage'),
  ('settings.view'), ('settings.manage'),
  ('payment_settings.view'), ('payment_settings.manage')
) AS p(permission)
ON CONFLICT DO NOTHING;

INSERT INTO public.role_permissions (role, permission) VALUES
  ('ADMIN','products.view'),('ADMIN','products.create'),('ADMIN','products.edit'),('ADMIN','products.delete'),
  ('ADMIN','collections.view'),('ADMIN','collections.create'),('ADMIN','collections.edit'),('ADMIN','collections.delete'),
  ('ADMIN','inventory.view'),('ADMIN','inventory.edit'),
  ('ADMIN','orders.view'),('ADMIN','orders.edit'),('ADMIN','orders.fulfill'),('ADMIN','orders.cancel'),('ADMIN','orders.refund'),
  ('ADMIN','customers.view'),('ADMIN','customers.edit'),
  ('ADMIN','coupons.view'),('ADMIN','coupons.create'),('ADMIN','coupons.edit'),('ADMIN','coupons.delete'),
  ('ADMIN','shipping.view'),('ADMIN','shipping.edit'),
  ('ADMIN','analytics.view'),('ADMIN','staff.view'),('ADMIN','staff.manage'),
  ('ADMIN','settings.view'),('ADMIN','settings.manage'),('ADMIN','payment_settings.view'),
  ('MANAGER','products.view'),('MANAGER','products.create'),('MANAGER','products.edit'),
  ('MANAGER','collections.view'),('MANAGER','collections.create'),('MANAGER','collections.edit'),
  ('MANAGER','inventory.view'),('MANAGER','inventory.edit'),
  ('MANAGER','orders.view'),('MANAGER','orders.edit'),('MANAGER','orders.fulfill'),('MANAGER','orders.cancel'),
  ('MANAGER','customers.view'),('MANAGER','customers.edit'),
  ('MANAGER','coupons.view'),('MANAGER','coupons.create'),('MANAGER','coupons.edit'),
  ('MANAGER','shipping.view'),('MANAGER','shipping.edit'),
  ('MANAGER','analytics.view'),('MANAGER','staff.view'),('MANAGER','settings.view'),
  ('CATALOG_MANAGER','products.view'),('CATALOG_MANAGER','products.create'),('CATALOG_MANAGER','products.edit'),('CATALOG_MANAGER','products.delete'),
  ('CATALOG_MANAGER','collections.view'),('CATALOG_MANAGER','collections.create'),('CATALOG_MANAGER','collections.edit'),('CATALOG_MANAGER','collections.delete'),
  ('CATALOG_MANAGER','inventory.view'),('CATALOG_MANAGER','inventory.edit'),
  ('CATALOG_STAFF','products.view'),('CATALOG_STAFF','products.create'),('CATALOG_STAFF','products.edit'),
  ('CATALOG_STAFF','collections.view'),('CATALOG_STAFF','collections.create'),('CATALOG_STAFF','collections.edit'),
  ('CATALOG_STAFF','inventory.view'),('CATALOG_STAFF','inventory.edit'),
  ('ORDER_MANAGER','orders.view'),('ORDER_MANAGER','orders.edit'),('ORDER_MANAGER','orders.fulfill'),('ORDER_MANAGER','orders.cancel'),('ORDER_MANAGER','orders.refund'),
  ('ORDER_MANAGER','customers.view'),('ORDER_MANAGER','customers.edit'),
  ('ORDER_MANAGER','shipping.view'),('ORDER_MANAGER','analytics.view'),
  ('ORDER_STAFF','orders.view'),('ORDER_STAFF','orders.edit'),('ORDER_STAFF','orders.fulfill'),
  ('ORDER_STAFF','customers.view'),('ORDER_STAFF','shipping.view'),
  ('MARKETING_STAFF','coupons.view'),('MARKETING_STAFF','coupons.create'),('MARKETING_STAFF','coupons.edit'),
  ('MARKETING_STAFF','collections.view'),('MARKETING_STAFF','products.view'),('MARKETING_STAFF','analytics.view'),
  ('SUPPORT','orders.view'),('SUPPORT','customers.view'),('SUPPORT','customers.edit'),('SUPPORT','shipping.view')
ON CONFLICT DO NOTHING;