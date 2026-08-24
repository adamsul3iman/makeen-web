-- ============================================================
-- Migration 083: Catalog Change Stamps + Realtime Publication
-- ============================================================
-- Two cooperating pieces for real-time inventory→POS sync:
--
-- 1. catalog_stamps — a per-store change token bumped by triggers on
--    every catalog table (products, variants, categories, brands,
--    units). The register remembers the last stamp it hydrated; any
--    poll that returns a different stamp triggers a full hydrate.
--    A stamp table (instead of MAX(updated_at)) is required because
--    products/categories/brands carry no updated_at and DELETEs must
--    invalidate too. This is the guaranteed polling floor that keeps
--    every device converging even when the Realtime socket is down.
--
-- 2. supabase_realtime publication membership — lets browsers subscribe
--    to postgres_changes on these tables for ~1s push updates.
--    SECURITY NOTE: RLS is disabled store-wide by design (no Supabase
--    Auth; anon grants are the access model). Realtime therefore
--    broadcasts row events without server-side tenant filtering — the
--    client filters store_id. Exposure equals the existing REST read
--    surface granted since 071 (anon SELECT on the same tables), so this
--    introduces no new data-access capability, only a delivery channel.
--
-- IDEMPOTENT: safe to re-run.
-- ============================================================

BEGIN;

SET search_path = public, extensions;

-- ============================================================
-- STEP 1: catalog_stamps
-- ============================================================
CREATE TABLE IF NOT EXISTS catalog_stamps (
  store_id   UUID PRIMARY KEY REFERENCES stores(id) ON DELETE CASCADE,
  -- Opaque change token (any fresh unique value works).
  version    TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed one stamp per existing store so first polls return non-empty.
INSERT INTO catalog_stamps (store_id, version)
SELECT id, gen_random_uuid()::text FROM stores
ON CONFLICT (store_id) DO NOTHING;

GRANT SELECT ON TABLE catalog_stamps TO anon, authenticated;

-- ============================================================
-- STEP 2: bump trigger — generic, derives the tenant from the row.
-- ============================================================
CREATE OR REPLACE FUNCTION fn_bump_catalog_stamp()
RETURNS TRIGGER AS $$
DECLARE
  v_store UUID := COALESCE(NEW.store_id, OLD.store_id);
BEGIN
  INSERT INTO catalog_stamps (store_id, version, updated_at)
  VALUES (v_store, gen_random_uuid()::text, now())
  ON CONFLICT (store_id) DO UPDATE
    SET version = EXCLUDED.version,
        updated_at = now();
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_catalog_stamp_products ON products;
CREATE TRIGGER trg_catalog_stamp_products
  AFTER INSERT OR UPDATE OR DELETE ON products
  FOR EACH ROW EXECUTE FUNCTION fn_bump_catalog_stamp();

DROP TRIGGER IF EXISTS trg_catalog_stamp_variants ON product_variants;
CREATE TRIGGER trg_catalog_stamp_variants
  AFTER INSERT OR UPDATE OR DELETE ON product_variants
  FOR EACH ROW EXECUTE FUNCTION fn_bump_catalog_stamp();

DROP TRIGGER IF EXISTS trg_catalog_stamp_categories ON categories;
CREATE TRIGGER trg_catalog_stamp_categories
  AFTER INSERT OR UPDATE OR DELETE ON categories
  FOR EACH ROW EXECUTE FUNCTION fn_bump_catalog_stamp();

DROP TRIGGER IF EXISTS trg_catalog_stamp_brands ON product_brands;
CREATE TRIGGER trg_catalog_stamp_brands
  AFTER INSERT OR UPDATE OR DELETE ON product_brands
  FOR EACH ROW EXECUTE FUNCTION fn_bump_catalog_stamp();

DROP TRIGGER IF EXISTS trg_catalog_stamp_units ON product_units;
CREATE TRIGGER trg_catalog_stamp_units
  AFTER INSERT OR UPDATE OR DELETE ON product_units
  FOR EACH ROW EXECUTE FUNCTION fn_bump_catalog_stamp();

COMMIT;

-- ============================================================
-- STEP 3: Realtime publication membership (outside the main txn —
-- ALTER PUBLICATION is fine in a transaction, but we keep each table's
-- add independently guarded so one oddity never blocks the rest).
-- ============================================================
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'public.products',
    'public.product_variants',
    'public.categories',
    'public.product_brands',
    'public.product_units',
    'public.pos_orders'
  ]
  LOOP
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime'
          AND schemaname = split_part(t, '.', 1)
          AND tablename  = split_part(t, '.', 2)
      ) THEN
        EXECUTE format(
          'ALTER PUBLICATION supabase_realtime ADD TABLE %I.%I',
          split_part(t, '.', 1),
          split_part(t, '.', 2)
        );
      END IF;
    EXCEPTION
      WHEN undefined_object THEN
        RAISE NOTICE 'publication supabase_realtime missing; skipping % (enable Realtime in Supabase dashboard)', t;
      WHEN OTHERS THEN
        RAISE NOTICE 'could not add % to publication: %', t, SQLERRM;
    END;
  END LOOP;
END $$;
