-- ============================================================
-- Migration 063: Clamp fn_sync_parent_stock to non-negative
-- ============================================================
-- Patches the trigger from 062 so that aggregated parent stock
-- is never negative.  A variant row with negative stock would
-- otherwise propagate a negative total_stock to the parent.
-- ============================================================

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

GRANT EXECUTE ON FUNCTION fn_sync_parent_stock() TO service_role;
