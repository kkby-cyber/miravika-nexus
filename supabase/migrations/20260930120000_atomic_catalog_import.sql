CREATE OR REPLACE FUNCTION public.commit_catalog_import(_batch_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_batch public.import_batches%ROWTYPE;
  v_row jsonb;
  v_sku text;
  v_title text;
  v_slug text;
  v_base_slug text;
  v_product_id uuid;
  v_variant_id uuid;
  v_inventory_id uuid;
  v_inventory_product_id uuid;
  v_inventory_variant_id uuid;
  v_inventory_found boolean;
  v_collection_id uuid;
  v_image jsonb;
  v_collection jsonb;
  v_old_available integer;
  v_delta integer;
  v_created integer := 0;
  v_updated integer := 0;
  v_position integer;
  v_stock integer;
  v_price numeric;
  v_mrp numeric;
  v_compare numeric;
  v_tax numeric;
  v_seen text[] := ARRAY[]::text[];
  v_attrs jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  IF NOT public.has_permission(v_actor, 'products.create')
     OR NOT public.has_permission(v_actor, 'inventory.edit') THEN
    RAISE EXCEPTION 'insufficient catalog import permissions';
  END IF;

  SELECT *
    INTO v_batch
    FROM public.import_batches
   WHERE id = _batch_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Import preview batch not found';
  END IF;

  IF v_batch.created_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'You can only commit your own import preview';
  END IF;

  IF v_batch.status <> 'PREVIEW' THEN
    RAISE EXCEPTION 'Import batch cannot be committed (status: %)', v_batch.status;
  END IF;

  IF v_batch.invalid_count IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'Import blocked: preview contains invalid rows';
  END IF;

  IF jsonb_typeof(v_batch.rows) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Import blocked: preview rows must be a JSON array';
  END IF;

  IF jsonb_array_length(v_batch.rows) = 0 THEN
    RAISE EXCEPTION 'Import blocked: preview contains no rows';
  END IF;

  -- Validate all rows before changing any catalog data.
  FOR v_row IN SELECT value FROM jsonb_array_elements(v_batch.rows)
  LOOP
    IF jsonb_typeof(v_row) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'Import blocked: preview row must be a JSON object';
    END IF;

    IF jsonb_typeof(v_row->'errors') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'Import blocked: preview row has malformed errors';
    END IF;

    IF jsonb_array_length(v_row->'errors') <> 0 THEN
      RAISE EXCEPTION 'Import blocked: preview contains invalid rows';
    END IF;

    v_sku := NULLIF(btrim(v_row->>'sku'), '');
    v_title := NULLIF(btrim(v_row->>'title'), '');

    IF v_sku IS NULL OR v_title IS NULL THEN
      RAISE EXCEPTION 'Import blocked: SKU and title are required';
    END IF;

    IF v_sku = ANY(v_seen) THEN
      RAISE EXCEPTION 'Import blocked: duplicate SKU %', v_sku;
    END IF;
    v_seen := array_append(v_seen, v_sku);

    IF jsonb_typeof(v_row->'price') IS DISTINCT FROM 'number'
       OR (v_row->>'price')::numeric <= 0 THEN
      RAISE EXCEPTION 'Import blocked: invalid price for SKU %', v_sku;
    END IF;

    IF v_row->>'stock' IS NOT NULL
       AND (jsonb_typeof(v_row->'stock') <> 'number'
            OR (v_row->>'stock')::numeric < 0
            OR (v_row->>'stock')::numeric <> trunc((v_row->>'stock')::numeric)) THEN
      RAISE EXCEPTION 'Import blocked: invalid stock for SKU %', v_sku;
    END IF;

    IF jsonb_typeof(v_row->'image_urls') IS DISTINCT FROM 'array'
       OR jsonb_typeof(v_row->'collections') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'Import blocked: malformed image or collection data for SKU %', v_sku;
    END IF;
  END LOOP;

  FOR v_row IN SELECT value FROM jsonb_array_elements(v_batch.rows)
  LOOP
    v_sku := btrim(v_row->>'sku');
    v_title := btrim(v_row->>'title');
    v_price := (v_row->>'price')::numeric;
    v_mrp := NULLIF(v_row->>'mrp', '')::numeric;
    v_compare := NULLIF(v_row->>'compare_at_price', '')::numeric;
    v_tax := COALESCE(NULLIF(v_row->>'tax_rate', '')::numeric, 0);

    IF v_tax < 0 OR v_tax > 100 THEN
      RAISE EXCEPTION 'Invalid tax rate for SKU %', v_sku;
    END IF;

    IF v_mrp IS NOT NULL AND v_mrp < 0
       OR v_compare IS NOT NULL AND v_compare < 0 THEN
      RAISE EXCEPTION 'Invalid MRP or compare-at price for SKU %', v_sku;
    END IF;

    IF v_mrp IS NOT NULL AND v_price > v_mrp THEN
      RAISE EXCEPTION 'Selling price exceeds MRP for SKU %', v_sku;
    END IF;

    IF EXISTS (
      SELECT 1 FROM public.products
       WHERE sku = v_sku AND deleted_at IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'SKU % belongs to a deleted product; restore it before importing', v_sku;
    END IF;

    v_base_slug := trim(both '-' from
      regexp_replace(lower(v_title), '[^a-z0-9]+', '-', 'g')
    );
    IF v_base_slug = '' THEN
      v_base_slug := 'product';
    END IF;

    v_base_slug := v_base_slug || '-' ||
      trim(both '-' from regexp_replace(lower(v_sku), '[^a-z0-9]+', '-', 'g'));

    IF EXISTS (
      SELECT 1 FROM public.products
       WHERE slug = v_base_slug AND sku <> v_sku
    ) THEN
      v_slug := v_base_slug || '-' || substr(md5(v_sku), 1, 8);
    ELSE
      v_slug := v_base_slug;
    END IF;

    IF EXISTS (SELECT 1 FROM public.products WHERE sku = v_sku) THEN
      v_updated := v_updated + 1;
    ELSE
      v_created := v_created + 1;
    END IF;

    INSERT INTO public.products (
      sku, title, slug, description, short_description, brand,
      product_type, material, size, color, mrp, price, compare_at_price,
      tax_rate, tax_inclusive, hsn_code, weight_grams,
      length_cm, width_cm, height_cm, status,
      seo_title, seo_description, seo_keywords,
      is_featured, is_bestseller, is_trending, is_visible
    ) VALUES (
      v_sku, v_title, v_slug,
      v_row->>'description', v_row->>'short_description',
      COALESCE(NULLIF(v_row->>'brand', ''), 'MIRAVIKA'),
      v_row->>'product_type', v_row->>'material', v_row->>'size',
      v_row->>'color', v_mrp, v_price, v_compare,
      v_tax, COALESCE((v_row->>'tax_inclusive')::boolean, true),
      v_row->>'hsn_code',
      NULLIF(v_row->>'weight_grams', '')::integer,
      NULLIF(v_row->>'length_cm', '')::numeric,
      NULLIF(v_row->>'width_cm', '')::numeric,
      NULLIF(v_row->>'height_cm', '')::numeric,
      'ACTIVE',
      v_row->>'seo_title', v_row->>'seo_description', v_row->>'seo_keywords',
      COALESCE((v_row->>'is_featured')::boolean, false),
      COALESCE((v_row->>'is_bestseller')::boolean, false),
      COALESCE((v_row->>'is_trending')::boolean, false),
      COALESCE((v_row->>'is_visible')::boolean, true)
    )
    ON CONFLICT (sku) DO UPDATE SET
      title = EXCLUDED.title,
      slug = EXCLUDED.slug,
      description = EXCLUDED.description,
      short_description = EXCLUDED.short_description,
      brand = EXCLUDED.brand,
      product_type = EXCLUDED.product_type,
      material = EXCLUDED.material,
      size = EXCLUDED.size,
      color = EXCLUDED.color,
      mrp = EXCLUDED.mrp,
      price = EXCLUDED.price,
      compare_at_price = EXCLUDED.compare_at_price,
      tax_rate = EXCLUDED.tax_rate,
      tax_inclusive = EXCLUDED.tax_inclusive,
      hsn_code = EXCLUDED.hsn_code,
      weight_grams = EXCLUDED.weight_grams,
      length_cm = EXCLUDED.length_cm,
      width_cm = EXCLUDED.width_cm,
      height_cm = EXCLUDED.height_cm,
      status = 'ACTIVE',
      seo_title = EXCLUDED.seo_title,
      seo_description = EXCLUDED.seo_description,
      seo_keywords = EXCLUDED.seo_keywords,
      is_featured = EXCLUDED.is_featured,
      is_bestseller = EXCLUDED.is_bestseller,
      is_trending = EXCLUDED.is_trending,
      is_visible = EXCLUDED.is_visible
    RETURNING id INTO v_product_id;

    v_attrs := jsonb_build_object(
      'size', v_row->'size',
      'color', v_row->'color',
      'material', v_row->'material'
    );

    IF EXISTS (
      SELECT 1 FROM public.product_variants
       WHERE sku = v_sku AND product_id <> v_product_id
    ) THEN
      RAISE EXCEPTION 'Variant SKU % is already assigned to another product', v_sku;
    END IF;

    INSERT INTO public.product_variants (
      product_id, sku, title, price, mrp, attributes, position, status, deleted_at
    ) VALUES (
      v_product_id, v_sku, v_title, v_price, v_mrp,
      v_attrs, 0, 'ACTIVE', NULL
    )
    ON CONFLICT (sku) DO UPDATE SET
      product_id = EXCLUDED.product_id,
      title = EXCLUDED.title,
      price = EXCLUDED.price,
      mrp = EXCLUDED.mrp,
      attributes = EXCLUDED.attributes,
      position = 0,
      status = 'ACTIVE',
      deleted_at = NULL
    RETURNING id INTO v_variant_id;

    PERFORM pg_advisory_xact_lock(hashtextextended(v_product_id::text, 0));

    FOR v_position IN
      SELECT ordinality::integer - 1
        FROM jsonb_array_elements(v_row->'image_urls') WITH ORDINALITY
    LOOP
      v_image := v_row->'image_urls'->v_position;
      IF jsonb_typeof(v_image) <> 'string' OR btrim(v_image #>> '{}') = '' THEN
        CONTINUE;
      END IF;

      UPDATE public.product_images
         SET alt_text = v_title,
             position = v_position,
             is_main = (v_position = 0)
       WHERE product_id = v_product_id
         AND url = v_image #>> '{}';

      IF NOT FOUND THEN
        INSERT INTO public.product_images (product_id, url, alt_text, position, is_main)
        VALUES (v_product_id, v_image #>> '{}', v_title, v_position, v_position = 0);
      END IF;
    END LOOP;

    FOR v_position IN
      SELECT ordinality::integer - 1
        FROM jsonb_array_elements(v_row->'collections') WITH ORDINALITY
    LOOP
      v_collection := v_row->'collections'->v_position;
      IF jsonb_typeof(v_collection) <> 'string'
         OR btrim(v_collection #>> '{}') = '' THEN
        CONTINUE;
      END IF;

      SELECT id INTO v_collection_id
        FROM public.collections
       WHERE deleted_at IS NULL
         AND (slug = trim(both '-' from regexp_replace(lower(btrim(v_collection #>> '{}')), '[^a-z0-9]+', '-', 'g'))
              OR lower(title) = lower(btrim(v_collection #>> '{}')))
       ORDER BY CASE WHEN slug = trim(both '-' from regexp_replace(lower(btrim(v_collection #>> '{}')), '[^a-z0-9]+', '-', 'g')) THEN 0 ELSE 1 END
       LIMIT 1;

      IF v_collection_id IS NOT NULL THEN
        INSERT INTO public.product_collections (product_id, collection_id, position)
        VALUES (v_product_id, v_collection_id, v_position)
        ON CONFLICT (product_id, collection_id)
        DO UPDATE SET position = EXCLUDED.position;
      END IF;
      v_collection_id := NULL;
    END LOOP;

    IF v_row->'stock' IS NOT NULL AND v_row->'stock' <> 'null'::jsonb THEN
      v_stock := (v_row->>'stock')::integer;
      SELECT id, available_quantity, product_id, variant_id
        INTO v_inventory_id, v_old_available,
             v_inventory_product_id, v_inventory_variant_id
        FROM public.inventory
       WHERE sku = v_sku
       FOR UPDATE;
      v_inventory_found := FOUND;

      IF v_inventory_found AND (
        (v_inventory_product_id IS NOT NULL
         AND v_inventory_product_id <> v_product_id)
        OR
        (v_inventory_variant_id IS NOT NULL
         AND v_inventory_variant_id <> v_variant_id)
      ) THEN
        RAISE EXCEPTION 'Inventory SKU % is assigned to another product or variant', v_sku;
      END IF;

      IF NOT v_inventory_found THEN
        v_old_available := 0;
        INSERT INTO public.inventory (
          product_id, variant_id, sku, available_quantity,
          reserved_quantity, sold_quantity, low_stock_threshold
        ) VALUES (
          v_product_id, v_variant_id, v_sku, v_stock, 0, 0, 5
        )
        RETURNING id INTO v_inventory_id;
      ELSE
        UPDATE public.inventory
           SET product_id = v_product_id,
               variant_id = v_variant_id,
               available_quantity = v_stock,
               low_stock_threshold = 5
         WHERE id = v_inventory_id;
      END IF;

      v_delta := v_stock - v_old_available;
      IF v_delta <> 0 THEN
        INSERT INTO public.inventory_movements (
          inventory_id, type, quantity, reference_type, note, created_by
        ) VALUES (
          v_inventory_id, 'import', v_delta, 'catalog_import',
          'Catalog import for SKU ' || v_sku, v_actor
        );
      END IF;
    END IF;
  END LOOP;

  UPDATE public.import_batches
     SET status = 'COMMITTED',
         new_count = v_created,
         update_count = v_updated
   WHERE id = _batch_id;

  PERFORM public.log_staff_activity(
    'CATALOG_IMPORT_COMMITTED',
    'import_batch',
    _batch_id::text,
    v_batch.filename,
    jsonb_build_object(
      'total', jsonb_array_length(v_batch.rows),
      'created', v_created,
      'updated', v_updated
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'filename', v_batch.filename,
    'total', jsonb_array_length(v_batch.rows),
    'created', v_created,
    'updated', v_updated
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.commit_catalog_import(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.commit_catalog_import(uuid) TO authenticated;
