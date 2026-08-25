-- Lock down trigger/internal functions entirely (triggers fire regardless of EXECUTE grants)
REVOKE EXECUTE ON FUNCTION public.audit_row_change() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.log_order_status_change() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.update_updated_at_column() FROM PUBLIC, anon, authenticated;

-- Inventory + order-number helpers: service_role only (checkout runs server-side)
REVOKE EXECUTE ON FUNCTION public.reserve_inventory(text, integer, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.release_inventory(text, integer, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.finalize_inventory(text, integer, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.restock_inventory(text, integer, text, public.movement_type) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.next_order_number() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_inventory(text, integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_inventory(text, integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_inventory(text, integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.restock_inventory(text, integer, text, public.movement_type) TO service_role;
GRANT EXECUTE ON FUNCTION public.next_order_number() TO service_role;

-- RBAC helpers: used by authenticated-scoped RLS policies and server functions,
-- so authenticated must keep EXECUTE; remove PUBLIC/anon exposure.
REVOKE EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.is_staff(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.can_manage_catalog(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.can_manage_orders(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.has_permission(uuid, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.log_staff_activity(text, text, text, text, jsonb, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_staff(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_manage_catalog(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_manage_orders(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_permission(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.log_staff_activity(text, text, text, text, jsonb, text, text) TO authenticated;