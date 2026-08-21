-- 061_merge_variant_parent.sql
-- Phase 4 — admin bulk merge: group standalone products under a NEW parent
-- variant row. Warehouse receiving creates flat standalone products (each new
-- barcode = its own product); the admin re-groups them here in one atomic step.
--
-- merge_into_variant_parent(
--   p_store_id    uuid     the tenant
--   p_parent_name text     name of the new parent shelf product
--   p_base_cost   numeric  optional base cost — aligned onto every child barcode
--   p_base_price  numeric  optional base retail price — aligned onto every child barcode
--   p_child_ids   uuid[]   standalone products to become children
-- )
--
-- The parent inherits shared attributes (category, brand, supplier, tax, unit,
-- flags) from the alphabetically first child. Each child keeps its own
-- barcodes and total_stock; it is relinked via parent_id and given a
-- variant_label derived from the shared prefix with the parent name. Returns a
-- summary JSON with the new parent id and the assigned labels.

CREATE OR REPLACE FUNCTION merge_into_variant_parent(
  p_store_id uuid,
  p_parent_name text,
  p_base_cost numeric DEFAULT NULL,
  p_base_price numeric DEFAULT NULL,
  p_child_ids uuid[] DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_parent_name text;
  v_parent_id uuid;
  v_template products%ROWTYPE;
  v_child products%ROWTYPE;
  v_child_ids uuid[];
  v_label text;
  v_candidate text;
  v_seen text[] := '{}';
  v_suffix integer;
  v_labels jsonb := '[]'::jsonb;
  v_children integer := 0;
  v_bad integer;
  v_common integer;
  v_i integer;
BEGIN
  v_parent_name := trim(COALESCE(p_parent_name, ''));
  IF v_parent_name = '' THEN
    RAISE EXCEPTION 'parent_name_required' USING ERRCODE = '22023';
  END IF;
  IF length(v_parent_name) > 255 THEN
    RAISE EXCEPTION 'parent_name_too_long' USING ERRCODE = '22023';
  END IF;
  IF p_child_ids IS NULL OR cardinality(p_child_ids) = 0 THEN
    RAISE EXCEPTION 'children_required' USING ERRCODE = '22023';
  END IF;
  IF cardinality(p_child_ids) > 30 THEN
    RAISE EXCEPTION 'too_many_children' USING ERRCODE = '22023';
  END IF;
  IF p_base_cost IS NOT NULL AND p_base_cost < 0 THEN
    RAISE EXCEPTION 'invalid_base_cost' USING ERRCODE = '22023';
  END IF;
  IF p_base_price IS NOT NULL AND p_base_price < 0 THEN
    RAISE EXCEPTION 'invalid_base_price' USING ERRCODE = '22023';
  END IF;

  -- Deduplicate the incoming id list (the caller may double-check rows).
  SELECT ARRAY(SELECT DISTINCT id FROM unnest(p_child_ids) AS t(id)) INTO v_child_ids;

  -- Every child must exist in this store and be a standalone leaf product:
  -- no missing rows, no rows already linked to a parent, no variant roots,
  -- and no rows that are themselves a parent of other products.
  SELECT count(*) INTO v_bad
  FROM unnest(v_child_ids) AS cid
  LEFT JOIN products p ON p.id = cid AND p.store_id = p_store_id
  WHERE p.id IS NULL;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'child_not_found' USING ERRCODE = '22023';
  END IF;

  SELECT count(*) INTO v_bad
  FROM products
  WHERE store_id = p_store_id AND id = ANY(v_child_ids)
    AND (parent_id IS NOT NULL OR is_variant_root);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'child_is_variant' USING ERRCODE = '22023';
  END IF;

  SELECT count(*) INTO v_bad
  FROM products
  WHERE store_id = p_store_id AND parent_id = ANY(v_child_ids);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'child_has_children' USING ERRCODE = '22023';
  END IF;

  -- The parent inherits shared attributes from the alphabetically first child.
  SELECT * INTO v_template
  FROM products
  WHERE store_id = p_store_id AND id = ANY(v_child_ids)
  ORDER BY name ASC
  LIMIT 1;

  INSERT INTO products (
    store_id, category_id, brand_id, default_supplier_id,
    name, base_unit, total_stock, is_quick_key,
    tax_percent, tax_included, is_active, show_in_pos,
    is_sellable, is_purchasable, allow_price_change,
    reorder_level, parent_id, variant_label, is_variant_root
  ) VALUES (
    p_store_id, v_template.category_id, v_template.brand_id, v_template.default_supplier_id,
    v_parent_name, v_template.base_unit, 0, false,
    v_template.tax_percent, v_template.tax_included, v_template.is_active, v_template.show_in_pos,
    v_template.is_sellable, v_template.is_purchasable, v_template.allow_price_change,
    v_template.reorder_level, NULL, '', true
  ) RETURNING id INTO v_parent_id;

  FOR v_child IN
    SELECT * FROM products WHERE store_id = p_store_id AND id = ANY(v_child_ids) ORDER BY name ASC
  LOOP
    -- Derive the variant label by stripping the shared prefix between the child
    -- and the parent name. "معطر جو ليمون" under "معطر جو" -> "ليمون";
    -- "Air Freshener Lemon" under "Air Freshener 300ml" -> "Lemon".
    v_common := 0;
    IF starts_with(lower(v_child.name), lower(v_parent_name)) THEN
      v_common := length(v_parent_name);
    ELSE
      FOR v_i IN 1..least(length(v_child.name), length(v_parent_name)) LOOP
        IF lower(substr(v_child.name, v_i, 1)) = lower(substr(v_parent_name, v_i, 1)) THEN
          v_common := v_i;
        ELSE
          EXIT;
        END IF;
      END LOOP;
      WHILE v_common > 0 AND substr(v_child.name, v_common, 1) <> ' ' LOOP
        v_common := v_common - 1;
      END LOOP;
    END IF;
    v_label := trim(both ' ' from substr(v_child.name, v_common + 1));

    IF v_label = '' THEN
      v_label := v_child.name;
    END IF;
    IF length(v_label) > 112 THEN
      v_label := left(v_label, 112);
    END IF;

    -- Variant labels are unique per parent (uq_products_store_parent_variant).
    v_suffix := 2;
    v_candidate := v_label;
    WHILE v_seen @> ARRAY[v_candidate] LOOP
      v_candidate := v_label || ' (' || v_suffix::text || ')';
      v_suffix := v_suffix + 1;
    END LOOP;
    v_label := v_candidate;
    v_seen := v_seen || v_label;

    UPDATE products
    SET parent_id = v_parent_id, variant_label = v_label, is_variant_root = false
    WHERE id = v_child.id AND store_id = p_store_id;

    -- Align prices across the child's barcodes when a base value was given.
    IF p_base_cost IS NOT NULL THEN
      UPDATE product_barcodes SET cost_price = round(p_base_cost, 2)
      WHERE product_id = v_child.id AND store_id = p_store_id;
    END IF;
    IF p_base_price IS NOT NULL THEN
      UPDATE product_barcodes SET selling_price = round(p_base_price, 2)
      WHERE product_id = v_child.id AND store_id = p_store_id;
    END IF;

    v_labels := v_labels || jsonb_build_object(
      'id', v_child.id,
      'name', v_child.name,
      'label', v_label
    );
    v_children := v_children + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'parentId', v_parent_id,
    'parentName', v_parent_name,
    'childCount', v_children,
    'labels', v_labels
  );
END;
$$;

GRANT EXECUTE ON FUNCTION merge_into_variant_parent(uuid, text, numeric, numeric, uuid[]) TO service_role;
