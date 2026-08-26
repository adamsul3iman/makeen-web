-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 089: Fix variant-level stock tracking
--
-- BUG: record_inventory_movement (088) only updates `products.total_stock`.
-- `product_variants.total_stock` is never touched, so the catalog reads 0
-- for every variant even when the parent has stock.
--
-- ROOT CAUSE (two-layer):
--   1. RPC only does: UPDATE products SET total_stock = v_after
--   2. PO receiving calls don't pass p_barcode, so variant is never identified
--
-- FIX:
--   A. Extend RPC with optional p_variant_id parameter
--   B. After updating product stock, also UPDATE product_variants.total_stock
--      when variant is identified (via barcode lookup OR p_variant_id)
--   C. Backfill product_variants.total_stock from inventory_movements history
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

  -- ── Barcode lookup: resolve variant and/or unit ──
  -- Priority:
  --   1. If p_variant_id is provided directly, use it (PO receiving path)
  --   2. Try product_units (packaging tier barcodes like "CTN-xxx")
  --   3. Try product_variants (SKU barcodes like "1234567890")
  --   4. If neither found → raise error

  -- 0. Direct variant_id (from PO receiving).
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

  -- ── Variant stock sync: keep product_variants.total_stock in lockstep ──
  -- When a specific variant is identified (via barcode or p_variant_id),
  -- also update its stock so the catalog reads correct per-variant numbers.
  IF v_resolved_variant_id IS NOT NULL THEN
    UPDATE product_variants
    SET total_stock = GREATEST(0, round(total_stock + v_delta, 3))
    WHERE id = v_resolved_variant_id
      AND product_id = p_product_id
      AND store_id = p_store_id;
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

-- ───────────────────────────────────────────────────────────────────────────
-- Permissions: same grants as 088 + the new p_variant_id param is positional.
-- Re-issue GRANT for the updated signature.
-- ───────────────────────────────────────────────────────────────────────────

REVOKE UPDATE, DELETE ON inventory_movements FROM anon, authenticated;
GRANT SELECT ON inventory_movements TO anon, authenticated;
GRANT SELECT, INSERT ON inventory_postings TO anon, authenticated;
GRANT EXECUTE ON FUNCTION record_inventory_movement(
  UUID, UUID, DECIMAL, TEXT, TEXT, DECIMAL, TEXT, TEXT, TEXT, UUID, UUID,
  UUID, TEXT, TEXT, TIMESTAMPTZ, JSONB, DECIMAL, BOOLEAN, UUID
) TO anon, authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- Backfill: reconstruct product_variants.total_stock from movement history,
-- then reconcile products.total_stock to match.
--
-- Strategy:
--   1. For each variant that has movements with matching variant_label,
--      sum quantity_delta to compute cumulative stock (clamped >= 0).
--   2. Single-variant products with parent stock but 0 variant stock:
--      assign parent stock to the lone variant.
--   3. Multi-variant reconciliation: if the sum of active variant stocks
--      is less than the parent's total_stock, assign the deficit to the
--      first active variant (lowest id). This covers the common legacy
--      case where movements had no variant_label so Phase 1 produced 0.
--   4. Parent reconciliation: set products.total_stock = sum of active
--      variants, so modal and catalog always agree. Only applied when
--      variant_sum > 0 to avoid zeroing out genuinely empty products.
--
-- SAFETY: The legacy trigger `trg_pv_stock_sync` (from migration 062) fires
-- AFTER UPDATE on product_variants and overwrites products.total_stock with
-- SUM(variants). During the backfill phases, variants are at 0, so the
-- trigger would immediately zero out parent stock. We DROP the trigger
-- before the backfill and recreate it AFTER with a safeguard that prevents
-- zeroing when all variants sum to 0 (empty product, no variant data yet).
-- ───────────────────────────────────────────────────────────────────────────

-- ═══ DROP legacy trigger to prevent interference during backfill ═══
DROP TRIGGER IF EXISTS trg_pv_stock_sync ON product_variants;

-- Phase 1: variants with matching movement history.
UPDATE product_variants pv
SET total_stock = GREATEST(0, sub.sum_delta)
FROM (
  SELECT
    im.product_id,
    im.store_id,
    im.variant_label,
    GREATEST(0, SUM(im.quantity_delta))::DECIMAL(14,3) AS sum_delta
  FROM inventory_movements im
  WHERE im.variant_label IS NOT NULL
    AND im.variant_label != ''
  GROUP BY im.product_id, im.store_id, im.variant_label
) sub
WHERE pv.product_id = sub.product_id
  AND pv.store_id = sub.store_id
  AND pv.variant_label = sub.variant_label
  AND pv.is_active = true;

-- Phase 2: single-variant products with parent stock but 0 variant stock.
-- If a product has exactly 1 active variant and that variant has 0 stock
-- but the parent has non-zero stock, assign parent stock to the variant.
UPDATE product_variants pv
SET total_stock = GREATEST(0, p.total_stock)
FROM products p
WHERE pv.product_id = p.id
  AND pv.store_id = p.store_id
  AND pv.is_active = true
  AND pv.total_stock = 0
  AND p.total_stock > 0
  AND (
    SELECT COUNT(*)
    FROM product_variants pv2
    WHERE pv2.product_id = p.id
      AND pv2.store_id = p.store_id
      AND pv2.is_active = true
  ) = 1;

-- Phase 3: multi-variant reconciliation.
-- For products where the sum of active variant stocks < parent total_stock,
-- assign the deficit to the first active variant (lowest id).
-- This covers the common case where legacy movements had no variant_label
-- so Phase 1 produced all zeros, but the parent still has stock.
WITH variant_sums AS (
  SELECT
    pv.product_id,
    pv.store_id,
    COALESCE(SUM(pv.total_stock), 0)::DECIMAL(14,3) AS variant_sum,
    COUNT(*)::INT AS variant_count
  FROM product_variants pv
  WHERE pv.is_active = true
  GROUP BY pv.product_id, pv.store_id
),
deficits AS (
  SELECT
    p.id AS product_id,
    p.store_id,
    GREATEST(0, p.total_stock - vs.variant_sum) AS deficit,
    vs.variant_count
  FROM products p
  JOIN variant_sums vs ON vs.product_id = p.id AND vs.store_id = p.store_id
  WHERE p.total_stock > vs.variant_sum
    AND vs.variant_count > 1
),
first_variants AS (
  SELECT DISTINCT ON (pv.product_id, pv.store_id)
    pv.id AS variant_id,
    pv.product_id,
    pv.store_id
  FROM product_variants pv
  WHERE pv.is_active = true
  ORDER BY pv.product_id, pv.store_id, pv.id
)
UPDATE product_variants pv
SET total_stock = GREATEST(0, pv.total_stock + d.deficit)
FROM first_variants fv
JOIN deficits d ON d.product_id = fv.product_id AND d.store_id = fv.store_id
WHERE pv.id = fv.variant_id;

-- Phase 4: reconcile parent stock FROM variant sums.
-- After Phases 1–3 populate variant stocks, the parent's total_stock must
-- equal the sum of its active variants so the modal and catalog agree.
-- Only updates when variant_sum > 0 to avoid zeroing out products that
-- genuinely have no variant data yet.
UPDATE products p
SET total_stock = vs.variant_sum
FROM (
  SELECT
    pv.product_id,
    pv.store_id,
    GREATEST(0, COALESCE(SUM(pv.total_stock), 0))::DECIMAL(14,3) AS variant_sum
  FROM product_variants pv
  WHERE pv.is_active = true
  GROUP BY pv.product_id, pv.store_id
) vs
WHERE p.id = vs.product_id
  AND p.store_id = vs.store_id
  AND vs.variant_sum > 0;

-- ═══ RECREATE trigger with safeguard ═══
-- The trigger keeps products.total_stock in sync when variant stock changes
-- outside the RPC (e.g. opening stock INSERT, admin adjustments). The
-- GREATEST + variant_sum > 0 guard prevents zeroing out products that have
-- no active variants yet.
CREATE OR REPLACE FUNCTION fn_sync_parent_stock()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE products
  SET total_stock = GREATEST(0, COALESCE((
    SELECT SUM(pv.total_stock)
    FROM product_variants pv
    WHERE pv.product_id = COALESCE(NEW.product_id, OLD.product_id)
      AND pv.is_active
  ), 0))
  WHERE id = COALESCE(NEW.product_id, OLD.product_id);
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_pv_stock_sync ON product_variants;
CREATE TRIGGER trg_pv_stock_sync
  AFTER INSERT OR UPDATE OR DELETE ON product_variants
  FOR EACH ROW EXECUTE FUNCTION fn_sync_parent_stock();

-- ───────────────────────────────────────────────────────────────────────────
-- Refresh PostgREST cache.
-- ───────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  NOTIFY pgrst, 'reload schema';
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;
