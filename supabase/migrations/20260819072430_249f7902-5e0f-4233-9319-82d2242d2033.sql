REVOKE ALL ON FUNCTION public.audit_row_change() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.next_order_number() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.next_order_number() TO service_role;