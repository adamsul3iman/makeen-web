-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 088: Fix record_inventory_movement — product_barcodes → product_variants
--
-- BUG: record_inventory_movement (defined/replaced in 085) still queries
-- the `product_barcodes` table which was DROP'd in migration 062 and replaced
-- by `product_variants` (SKUs with barcodes) + `product_units` (packaging tiers
-- with optional dedicated barcodes). Every POS sale sync hits:
--   ERROR: relation "product_barcodes" does not exist
-- causing the RPC to 404, the sync to fail, and the POS to fall back to
-- offline mode ("تم حفظ الفاتورة محلياً").
--
-- FIX: Rewrite the barcode-lookup block to query the correct tables:
--   1. product_units  (by barcode) → get unit_name + qty_multiplier
--   2. product_variants (by barcode) → get variant_label, default to base unit
--
-- IDEMPOTENT: safe to re-run. Uses CREATE OR REPLACE FUNCTION.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION record_inventory_movement(
  p_store_id UUID,
  p_product_id UUID,
  p_quantity_delta DECIMAL,
  p_movement_type TEXT,
  p_idempotency_key TEXT,
  p_unit_quantity DECIMAL DEFAULT NULL,
  p_barcode TEXT DEFAULT NULL,
  p_reference_type TEXT DEFAULT NULL,
  p_reference_id TEXT DEFAULT NULL,
  p_branch_id UUID DEFAULT NULL,
  p_terminal_id UUID DEFAULT NULL,
  p_actor_id UUID DEFAULT NULL,
  p_actor_name TEXT DEFAULT '',
  p_reason TEXT DEFAULT '',
  p_occurred_at TIMESTAMPTZ DEFAULT now(),
  p_metadata JSONB DEFAULT '{}'::jsonb,
  p_target_balance DECIMAL DEFAULT NULL,
  p_allow_negative BOOLEAN DEFAULT FALSE
) RETURNS inventory_movements
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_existing inventory_movements%ROWTYPE;
  v_result inventory_movements%ROWTYPE;
  v_before DECIMAL(14,3);
  v_after DECIMAL(14,3);
  v_delta DECIMAL(14,3);
  v_base_unit TEXT;
  v_unit_name TEXT;
  v_multiplier DECIMAL(12,3) := 1;
  v_variant_label TEXT := '';
  v_barcode TEXT := NULLIF(trim(COALESCE(p_barcode, '')), '');
BEGIN
  IF p_store_id IS NULL OR p_product_id IS NULL THEN
    RAISE EXCEPTION 'store_and_product_required' USING ERRCODE = '22023';
  END IF;
  IF trim(COALESCE(p_idempotency_key, '')) = '' OR length(p_idempotency_key) > 180 THEN
    RAISE EXCEPTION 'invalid_idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF p_movement_type NOT IN (
    'OPENING', 'SALE', 'RETURN', 'PURCHASE_RECEIPT', 'ADJUSTMENT_IN',
    'ADJUSTMENT_OUT', 'STOCKTAKE', 'DAMAGE', 'TRANSFER_IN', 'TRANSFER_OUT'
  ) THEN
    RAISE EXCEPTION 'invalid_movement_type' USING ERRCODE = '22023';
  END IF;

  -- Idempotency: return the existing row if this key was already processed.
  SELECT * INTO v_existing
  FROM inventory_movements
  WHERE store_id = p_store_id AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN v_existing;
  END IF;

  -- Lock the product row and read current stock + base unit name.
  SELECT total_stock, base_unit INTO v_before, v_base_unit
  FROM products
  WHERE id = p_product_id AND store_id = p_store_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'product_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- Default: base unit with multiplier 1.
  v_unit_name := v_base_unit;

  -- ── Barcode lookup: 088 replaces the dropped `product_barcodes` table ──
  -- Strategy:
  --   1. Try product_units (packaging tier barcodes like "CTN-xxx")
  --   2. Try product_variants (SKU barcodes like "1234567890")
  --   3. If neither found → raise error
  IF v_barcode IS NOT NULL THEN
    -- 1a. Packaging-unit barcode (product_units.barcode)?
    SELECT unit_name, qty_multiplier
      INTO v_unit_name, v_multiplier
    FROM product_units
    WHERE barcode = v_barcode
      AND product_id = p_product_id
      AND store_id = p_store_id
      AND is_active = true
    LIMIT 1;

    IF NOT FOUND THEN
      -- 1b. Variant/SKU barcode (product_variants.barcode)?
      SELECT variant_label
        INTO v_variant_label
      FROM product_variants
      WHERE barcode = v_barcode
        AND product_id = p_product_id
        AND store_id = p_store_id
        AND is_active = true;

      IF NOT FOUND THEN
        -- Barcode exists in neither table for this product — hard error.
        RAISE EXCEPTION 'barcode_not_owned_by_product' USING ERRCODE = '22023';
      END IF;
      -- Found as a variant barcode: default to base unit, multiplier stays 1.
      v_unit_name := COALESCE(NULLIF(v_variant_label, ''), v_base_unit);
      v_multiplier := 1;
    END IF;
    -- If found in product_units, v_unit_name and v_multiplier are already set.
  END IF;

  -- Compute the stock delta.
  IF p_target_balance IS NOT NULL THEN
    IF p_target_balance < 0 THEN
      RAISE EXCEPTION 'target_balance_must_be_nonnegative' USING ERRCODE = '22023';
    END IF;
    v_delta := round(p_target_balance - v_before, 3);
  ELSE
    v_delta := round(COALESCE(p_quantity_delta, 0), 3);
  END IF;
  IF v_delta = 0 THEN
    RAISE EXCEPTION 'no_stock_change' USING ERRCODE = '22023';
  END IF;

  v_after := round(v_before + v_delta, 3);
  IF v_after < 0 AND NOT p_allow_negative THEN
    RAISE EXCEPTION 'insufficient_stock' USING ERRCODE = '23514';
  END IF;

  -- Update the product stock.
  UPDATE products
  SET total_stock = v_after
  WHERE id = p_product_id AND store_id = p_store_id;

  -- Record the movement.
  INSERT INTO inventory_movements (
    store_id,
    product_id,
    branch_id,
    terminal_id,
    actor_id,
    actor_name,
    movement_type,
    quantity_delta,
    unit_quantity,
    unit_name,
    multiplier,
    balance_before,
    balance_after,
    barcode,
    variant_label,
    reference_type,
    reference_id,
    idempotency_key,
    reason,
    metadata,
    occurred_at
  ) VALUES (
    p_store_id,
    p_product_id,
    p_branch_id,
    p_terminal_id,
    p_actor_id,
    COALESCE(p_actor_name, ''),
    p_movement_type,
    v_delta,
    round(COALESCE(p_unit_quantity, v_delta / v_multiplier), 3),
    COALESCE(v_unit_name, v_base_unit, ''),
    v_multiplier,
    v_before,
    v_after,
    v_barcode,
    COALESCE(v_variant_label, ''),
    NULLIF(trim(COALESCE(p_reference_type, '')), ''),
    NULLIF(trim(COALESCE(p_reference_id, '')), ''),
    p_idempotency_key,
    COALESCE(p_reason, ''),
    COALESCE(p_metadata, '{}'::jsonb),
    COALESCE(p_occurred_at, now())
  ) RETURNING * INTO v_result;

  RETURN v_result;
END;
$$;

-- ───────────────────────────────────────────────────────────────────────────
-- Permissions: keep the same grants as 085 (idempotent re-issuance).
-- ───────────────────────────────────────────────────────────────────────────

REVOKE UPDATE, DELETE ON inventory_movements FROM anon, authenticated;
GRANT SELECT ON inventory_movements TO anon, authenticated;
GRANT SELECT, INSERT ON inventory_postings TO anon, authenticated;
GRANT EXECUTE ON FUNCTION record_inventory_movement(
  UUID, UUID, DECIMAL, TEXT, TEXT, DECIMAL, TEXT, TEXT, TEXT, UUID, UUID,
  UUID, TEXT, TEXT, TIMESTAMPTZ, JSONB, DECIMAL, BOOLEAN
) TO anon, authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- Refresh PostgREST cache.
-- ───────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  NOTIFY pgrst, 'reload schema';
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;
