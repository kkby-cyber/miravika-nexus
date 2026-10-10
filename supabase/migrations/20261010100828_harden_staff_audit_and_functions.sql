-- Security advisor remediation.
--  * log_staff_activity was executable by every signed-in user, so customers could write
--    arbitrary entries into the staff audit log. It now requires a staff role.
--  * enforce_payment_status_transition gets a fixed search_path (function_search_path_mutable).
--  * rls_auto_enable is an event-trigger function; it never needs to be callable over RPC.
-- Rollback: re-create log_staff_activity from 20260825145255 and re-grant as before.

CREATE OR REPLACE FUNCTION public.log_staff_activity(_action text, _entity_type text DEFAULT NULL::text, _entity_id text DEFAULT NULL::text, _entity_name text DEFAULT NULL::text, _metadata jsonb DEFAULT '{}'::jsonb, _ip text DEFAULT NULL::text, _user_agent text DEFAULT NULL::text)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF NOT public.is_staff(auth.uid()) THEN
    RAISE EXCEPTION 'staff access required';
  END IF;
  IF length(_action) > 80 THEN
    RAISE EXCEPTION 'action too long';
  END IF;
  INSERT INTO public.audit_logs (actor_id, action, entity_type, entity_id, entity_name, metadata, ip_address, user_agent)
  VALUES (auth.uid(), _action, _entity_type, _entity_id, _entity_name, COALESCE(_metadata, '{}'::jsonb), _ip, _user_agent);
END;
$function$;

ALTER FUNCTION public.enforce_payment_status_transition() SET search_path = public, pg_temp;

REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM PUBLIC, anon, authenticated;
