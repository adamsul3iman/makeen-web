-- ═══════════════════════════════════════════════════════════════════════════
-- HOTFIX 090: Restore products.total_stock from variant sums
--
-- After migration 089 ran, some products lost their parent total_stock
-- because the legacy trigger `trg_pv_stock_sync` fired AFTER each variant
-- UPDATE during the backfill, immediately zeroing out the parent stock
-- (variants were still 0 at that point).
--
-- This script:
--   0. Drops the trigger to prevent interference
--   1. Re-runs the 4-phase variant backfill (idempotent, safe)
--   2. Recreates the trigger with safeguard
--
-- IDEMPOTENT: safe to run multiple times.
-- ═══════════════════════════════════════════════════════════════════════════

-- ═══ DROP legacy trigger to prevent interference during backfill ═══
DROP TRIGGER IF EXISTS trg_pv_stock_sync ON product_variants;

-- ── Phase 1: variant stock from matching movement history ──
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

-- ── Phase 2: single-variant products ──
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

-- ── Phase 3: multi-variant deficit → first variant ──
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

-- ── Phase 4: RECONCILE PARENT STOCK FROM VARIANTS ──
-- This is the critical fix: products.total_stock must equal the sum
-- of its active variant stocks. Only applied when variant_sum > 0
-- to avoid zeroing out products that genuinely have no variants yet.
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

-- ── Verify: show any products still at 0 where variants also sum to 0 ──
-- These are products that need manual stock correction or re-receiving.
-- (Result-only query, no schema change.)
SELECT
  p.id,
  p.name,
  p.total_stock AS parent_stock,
  COALESCE(vs.variant_sum, 0) AS variant_sum
FROM products p
LEFT JOIN (
  SELECT
    pv.product_id,
    pv.store_id,
    SUM(pv.total_stock)::DECIMAL(14,3) AS variant_sum
  FROM product_variants pv
  WHERE pv.is_active = true
  GROUP BY pv.product_id, pv.store_id
) vs ON vs.product_id = p.id AND vs.store_id = p.store_id
WHERE p.total_stock = 0
  AND COALESCE(vs.variant_sum, 0) = 0
  AND p.is_active = true;

-- ═══ RECREATE trigger ═══
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

-- Refresh PostgREST cache.
DO $$
BEGIN
  NOTIFY pgrst, 'reload schema';
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;
