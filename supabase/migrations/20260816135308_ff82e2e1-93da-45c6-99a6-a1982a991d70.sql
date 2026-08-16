
REVOKE EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) FROM anon;
REVOKE EXECUTE ON FUNCTION public.is_staff(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.can_manage_catalog(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.can_manage_orders(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.update_updated_at_column() FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.next_order_number()
RETURNS text LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $$
  SELECT 'MIR-' || to_char(now(),'YYMM') || '-' || nextval('public.order_number_seq');
$$;
REVOKE EXECUTE ON FUNCTION public.next_order_number() FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.reserve_inventory(_sku text, _qty integer, _reference_id text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE inv_id uuid;
BEGIN
  IF _qty <= 0 THEN RAISE EXCEPTION 'INVALID_QUANTITY'; END IF;
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
  UPDATE public.inventory
     SET available_quantity = available_quantity + _qty,
         reserved_quantity = GREATEST(reserved_quantity - _qty, 0)
   WHERE sku = _sku
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
  UPDATE public.inventory
     SET reserved_quantity = GREATEST(reserved_quantity - _qty, 0),
         sold_quantity = sold_quantity + _qty
   WHERE sku = _sku
   RETURNING id INTO inv_id;
  IF inv_id IS NULL THEN RETURN false; END IF;
  INSERT INTO public.inventory_movements (inventory_id, type, quantity, reference_type, reference_id)
  VALUES (inv_id, 'sale', -_qty, 'order', _reference_id);
  RETURN true;
END; $$;

CREATE OR REPLACE FUNCTION public.restock_inventory(_sku text, _qty integer, _reference_id text, _type public.movement_type)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE inv_id uuid;
BEGIN
  UPDATE public.inventory
     SET available_quantity = available_quantity + _qty,
         sold_quantity = GREATEST(sold_quantity - _qty, 0)
   WHERE sku = _sku
   RETURNING id INTO inv_id;
  IF inv_id IS NULL THEN RETURN false; END IF;
  INSERT INTO public.inventory_movements (inventory_id, type, quantity, reference_type, reference_id)
  VALUES (inv_id, _type, _qty, 'order', _reference_id);
  RETURN true;
END; $$;

REVOKE EXECUTE ON FUNCTION public.reserve_inventory(text,integer,text) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.release_inventory(text,integer,text) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.finalize_inventory(text,integer,text) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.restock_inventory(text,integer,text,public.movement_type) FROM anon, authenticated;

-- log order status changes automatically
CREATE OR REPLACE FUNCTION public.log_order_status_change()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO public.order_status_history (order_id, from_status, to_status, changed_by)
    VALUES (NEW.id, OLD.status, NEW.status, auth.uid());
  END IF;
  RETURN NEW;
END; $$;
REVOKE EXECUTE ON FUNCTION public.log_order_status_change() FROM anon, authenticated;
CREATE TRIGGER trg_order_status_log AFTER UPDATE ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.log_order_status_change();
