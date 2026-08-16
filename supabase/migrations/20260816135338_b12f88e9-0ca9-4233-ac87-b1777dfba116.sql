
REVOKE ALL ON FUNCTION public.has_role(uuid, public.app_role) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_staff(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.can_manage_catalog(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.can_manage_orders(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_updated_at_column() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.log_order_status_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.next_order_number() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reserve_inventory(text,integer,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_inventory(text,integer,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalize_inventory(text,integer,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.restock_inventory(text,integer,text,public.movement_type) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_staff(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_manage_catalog(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_manage_orders(uuid) TO authenticated;

GRANT EXECUTE ON FUNCTION public.next_order_number() TO service_role;
GRANT EXECUTE ON FUNCTION public.reserve_inventory(text,integer,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_inventory(text,integer,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_inventory(text,integer,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.restock_inventory(text,integer,text,public.movement_type) TO service_role;
