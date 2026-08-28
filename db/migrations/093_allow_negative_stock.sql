-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 093: Allow negative stock (sales past zero + physical counts)
--
-- PROBLEM: Cashiers must be able to sell items even when the inventory count
--   is 0 or negative (pending physical audits). The system already INTENDS to
--   allow this — every SALE path passes p_allow_negative := TRUE and the RPC
--   (migration 091) writes raw negative values when allowed. But two DB layers
--   reject the negative write regardless of p_allow_negative, throwing a 400
--   that blocks the offline sync queue and leaves transactions stuck locally:
--
--   A. `pv_stock_non_negative` — a hard CHECK (total_stock >= 0) on the
--      product_variants table (migration 062). Selling a variant below 0
--      throws a 23514 check_violation (400), even when p_allow_negative is
--      TRUE, because it is a table-level constraint independent of the RPC.
--
--   B. `fn_sync_parent_stock` / `trg_pv_stock_sync` — the live trigger body
--      (migration 090) clamps products.total_stock to GREATEST(0, SUM(variants)).
--      After RPC-091 writes a negative parent value (v_after), this trigger
--      re-fires on the variant UPDATE and silently erases the negative balance.
--
-- COGS / ACCOUNTING IMPACT: LOW. This codebase has NO weighted-average/FIFO
--   engine — COGS is a static snapshot of products.cost_price taken at
--   sale-processing time (never derived from stock-on-hand), so there is no
--   division-by-zero or negative-average-cost failure mode. We keep the
--   existing PO-receipt cost overwrite behavior by design (decision: no new
--   guards). Negative stock therefore does NOT corrupt accounting arithmetic;
--   existing profit-reliability flags (migration 041) still mark zero-cost
--   beyond-stock lines as "unreliable" rather than throwing.
--
-- FIX:
--   A. DROP the pv_stock_non_negative CHECK constraint.
--   B. Recreate fn_sync_parent_stock with a raw COALESCE(SUM(...)) so the
--      parent aggregate passes negatives through (never clamps to 0).
--   C. Recreate record_inventory_movement (exact 091 body) with ONLY the
--      `p_target_balance < 0` guard relaxed to respect p_allow_negative, so
--      STOCKTAKE / physical counts can also record true negative balances.
--
-- IDEMPOTENT: safe to re-run. Uses CREATE OR REPLACE FUNCTION + DROP
--   CONSTRAINT IF EXISTS / DROP TRIGGER IF EXISTS.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Step A: Drop the hard non-negative CHECK on variant stock ────────────────
-- The constraint was introduced in migration 062 (four-tier architecture).
ALTER TABLE product_variants DROP CONSTRAINT IF EXISTS pv_stock_non_negative;

-- ── Step B: Recreate the parent sync trigger WITHOUT the GREATEST(0,…) clamp ─
-- The previous body (migration 090) clamps the parent to >= 0, erasing any
-- negative balance written by the RPC when p_allow_negative = TRUE. The new
-- body passes the raw (possibly negative) variant sum through so the POS can
-- enforce real stock checks against the true figure.
CREATE OR REPLACE FUNCTION public.fn_sync_parent_stock()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE products
  SET total_stock = COALESCE((
    SELECT SUM(pv.total_stock)
    FROM product_variants pv
    WHERE pv.product_id = COALESCE(NEW.product_id, OLD.product_id)
      AND pv.is_active
  ), 0)
  WHERE id = COALESCE(NEW.product_id, OLD.product_id);
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- Trigger definition (recreated idempotently; only the function body changed).
DROP TRIGGER IF EXISTS trg_pv_stock_sync ON product_variants;
CREATE TRIGGER trg_pv_stock_sync
  AFTER INSERT OR UPDATE OR DELETE ON product_variants
  FOR EACH ROW EXECUTE FUNCTION fn_sync_parent_stock();

-- ── Step C: Recreate record_inventory_movement (exact 091 body, relaxed ─────
--    negative-target guard). The ONLY behavioral change from migration 091 is
--    the `p_target_balance < 0` rejection now gated behind p_allow_negative.
--    Everything else is reproduced verbatim so 19-arg positional callers,
--    the idempotency contract, row locking and security semantics are intact.
CREATE OR REPLACE FUNCTION public.record_inventory_movement(
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
    -- Relaxed in migration 093: a negative target is now allowed when
    -- p_allow_negative is TRUE so physical counts can reflect true negatives.
    IF p_target_balance < 0 AND NOT p_allow_negative THEN
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

-- ── Re-assert grants (idempotent) ──
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
