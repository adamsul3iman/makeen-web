-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 091: Drop old RPC overload + fix negative-stock clamping
--
-- BUG-001: PostgREST cannot choose between the 18-arg (migration 088) and
--   19-arg (migration 089) record_inventory_movement signatures when callers
--   omit p_variant_id.  Drop the old 18-arg signature so ALL callers route
--   unambiguously to the 19-arg version (p_variant_id DEFAULT NULL).
--
-- BUG-002: The RPC always clamps variant stock with GREATEST(0, …) even when
--   p_allow_negative is TRUE.  After the variant update the parent-sync
--   trigger fires and overwrites products.total_stock with the clamped
--   variant sum, silently erasing the negative balance.
--
-- FIX: Re-create the 19-arg function with:
--   A. Variant update uses GREATEST(0) ONLY when p_allow_negative is FALSE.
--   B. Parent product total_stock is set to v_after (which may be negative
--      when p_allow_negative is TRUE), NOT re-derived from the trigger's
--      clamped sum.
--
-- IDEMPOTENT: safe to re-run. Uses CREATE OR REPLACE FUNCTION.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Step 1: Explicitly drop the old 18-arg overload ──
-- PostgREST uses argument count + types for overload resolution.
-- Dropping the 18-arg version removes the ambiguity.
DROP FUNCTION IF EXISTS record_inventory_movement(
  UUID, UUID, DECIMAL, TEXT, TEXT, DECIMAL, TEXT, TEXT, TEXT, UUID, UUID,
  UUID, TEXT, TEXT, TIMESTAMPTZ, JSONB, DECIMAL, BOOLEAN
);

-- ── Step 2: Re-create the single canonical 19-arg signature ──
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
  p_allow_negative BOOLEAN DEFAULT FALSE,
  p_variant_id UUID DEFAULT NULL
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
  v_resolved_variant_id UUID := NULL;
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

  -- ── Barcode / variant lookup (priority order) ──
  --   1. Direct p_variant_id (from PO receiving)
  --   2. product_units (packaging-tier barcodes)
  --   3. product_variants (SKU barcodes)

  IF p_variant_id IS NOT NULL THEN
    SELECT variant_label INTO v_variant_label
    FROM product_variants
    WHERE id = p_variant_id
      AND product_id = p_product_id
      AND store_id = p_store_id
      AND is_active = true;
    IF FOUND THEN
      v_resolved_variant_id := p_variant_id;
      v_unit_name := COALESCE(NULLIF(v_variant_label, ''), v_base_unit);
    END IF;
  END IF;

  IF v_barcode IS NOT NULL AND v_resolved_variant_id IS NULL THEN
    SELECT unit_name, qty_multiplier
      INTO v_unit_name, v_multiplier
    FROM product_units
    WHERE barcode = v_barcode
      AND product_id = p_product_id
      AND store_id = p_store_id
      AND is_active = true
    LIMIT 1;

    IF NOT FOUND THEN
      SELECT id, variant_label
        INTO v_resolved_variant_id, v_variant_label
      FROM product_variants
      WHERE barcode = v_barcode
        AND product_id = p_product_id
        AND store_id = p_store_id
        AND is_active = true;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'barcode_not_owned_by_product' USING ERRCODE = '22023';
      END IF;
      v_unit_name := COALESCE(NULLIF(v_variant_label, ''), v_base_unit);
      v_multiplier := 1;
    END IF;
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

  -- Update the parent product stock.
  UPDATE products
  SET total_stock = v_after
  WHERE id = p_product_id AND store_id = p_store_id;

  -- ── Variant stock sync ──
  -- When allow_negative is TRUE, store the raw (potentially negative) value
  -- so the POS can enforce hard-stock checks against the real number.
  -- When FALSE, clamp to zero — the safety net for non-negative stores.
  IF v_resolved_variant_id IS NOT NULL THEN
    IF p_allow_negative THEN
      UPDATE product_variants
      SET total_stock = round(total_stock + v_delta, 3)
      WHERE id = v_resolved_variant_id
        AND product_id = p_product_id
        AND store_id = p_store_id;
    ELSE
      UPDATE product_variants
      SET total_stock = GREATEST(0, round(total_stock + v_delta, 3))
      WHERE id = v_resolved_variant_id
        AND product_id = p_product_id
        AND store_id = p_store_id;
    END IF;
  END IF;

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

-- ── Permissions: single 19-arg signature only ──
REVOKE UPDATE, DELETE ON inventory_movements FROM anon, authenticated;
GRANT SELECT ON inventory_movements TO anon, authenticated;
GRANT SELECT, INSERT ON inventory_postings TO anon, authenticated;
GRANT EXECUTE ON FUNCTION record_inventory_movement(
  UUID, UUID, DECIMAL, TEXT, TEXT, DECIMAL, TEXT, TEXT, TEXT, UUID, UUID,
  UUID, TEXT, TEXT, TIMESTAMPTZ, JSONB, DECIMAL, BOOLEAN, UUID
) TO anon, authenticated;

-- ── Refresh PostgREST cache ──
DO $$
BEGIN
  NOTIFY pgrst, 'reload schema';
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;
