-- ============================================================
-- Migration 094: Multi-Category Join Table (catalog Excel import)
-- ============================================================
-- Enables TRUE many-to-many categories for catalog Excel import/export
-- round-trips. Decision (approved):
--   * products.category_id is RETAINED as the primary/denormalized FK so no
--     existing app read breaks — it becomes the "first" category.
--   * product_categories is ADDITIVE (a new join table) — no FK is dropped,
--     nothing is altered on products.
--
-- Also wires the new table into the two cross-device sync channels so a
-- bulk import refreshes every POS lane:
--   1. catalog_stamps version bump (guaranteed polling floor, migration 083)
--   2. supabase_realtime publication membership (migration 083)
--
-- IDEMPOTENT: safe to re-run.
-- ============================================================

BEGIN;

SET search_path = public, extensions;

-- ============================================================
-- STEP 1: product_categories join table
-- ============================================================
CREATE TABLE IF NOT EXISTS product_categories (
  product_id  UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  category_id UUID NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, category_id)
);

CREATE INDEX IF NOT EXISTS idx_pc_category ON product_categories(category_id);
CREATE INDEX IF NOT EXISTS idx_pc_product  ON product_categories(product_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE product_categories TO anon, authenticated;

-- ============================================================
-- STEP 2: Backfill — existing products.category_id becomes the
-- first join row (re-runs are no-ops via ON CONFLICT DO NOTHING).
-- ============================================================
INSERT INTO product_categories (product_id, category_id)
SELECT id, category_id FROM products
WHERE category_id IS NOT NULL
ON CONFLICT (product_id, category_id) DO NOTHING;

-- ============================================================
-- STEP 3: catalog_stamps bump trigger (mirrors 083)
-- ============================================================
DROP TRIGGER IF EXISTS trg_catalog_stamp_product_categories ON product_categories;
CREATE TRIGGER trg_catalog_stamp_product_categories
  AFTER INSERT OR UPDATE OR DELETE ON product_categories
  FOR EACH ROW EXECUTE FUNCTION fn_bump_catalog_stamp();

COMMIT;

-- ============================================================
-- STEP 4: Realtime publication membership (outside txn, guarded)
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename  = 'product_categories'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.product_categories;
  END IF;
EXCEPTION
  WHEN undefined_object THEN
    RAISE NOTICE 'publication supabase_realtime missing; skipping product_categories (enable Realtime in Supabase dashboard)';
  WHEN OTHERS THEN
    RAISE NOTICE 'could not add product_categories to publication: %', SQLERRM;
END $$;
