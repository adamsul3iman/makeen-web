-- ============================================================
-- Migration 086: Fix catalog_stamps schema drift (entity_type 42703)
-- ============================================================
-- Production reported during a quick price update:
--   column "entity_type" of relation "catalog_stamps" does not exist
--
-- Root cause: environment drift on fn_bump_catalog_stamp(). The repo
-- canonical body (083, hardened by 084) bumps ONE row per store:
--   INSERT INTO catalog_stamps (store_id, version, updated_at) ...
-- and nothing in the codebase references entity_type. The live database,
-- however, carries a re-authored per-entity variant of the trigger that
-- inserts (entity_type, entity_id, stamp) — columns the table never had,
-- so every catalog write (products/variants/units/categories/brands)
-- failed with 42703 and took the whole statement down with it.
--
-- Convergence strategy — fix BOTH sides so this class of drift cannot
-- break catalog writes again, whichever body is present after deploy:
--   1. Table gains entity_type/entity_id/stamp as NOT NULL DEFAULT ''
--      columns: the canonical function omits them (defaults fill in) and
--      any drifted per-entity body finds its columns present. Idempotent.
--   2. fn_bump_catalog_stamp() is re-issued verbatim from the canonical
--      084 definition (SECURITY DEFINER, pinned search_path, store-level
--      version bump) so the client polling contract
--      (lib/catalogInvalidation.ts fetchCatalogStamp -> version) holds.
--   3. Grants re-asserted; missing store rows reseeded.
--
-- IDEMPOTENT: safe to re-run.
-- ============================================================

BEGIN;

SET search_path = public, extensions;

-- ============================================================
-- STEP 1: tolerate both stamp shapes at the table level
-- ============================================================
ALTER TABLE catalog_stamps ADD COLUMN IF NOT EXISTS entity_type TEXT NOT NULL DEFAULT '';
ALTER TABLE catalog_stamps ADD COLUMN IF NOT EXISTS entity_id   TEXT NOT NULL DEFAULT '';
ALTER TABLE catalog_stamps ADD COLUMN IF NOT EXISTS stamp       TEXT NOT NULL DEFAULT '';

-- ============================================================
-- STEP 2: restore the canonical store-level bump function
-- (verbatim 084 body — SECURITY DEFINER fixes the historical 401 where
-- cashiers could UPDATE categories but not write catalog_stamps)
-- ============================================================
CREATE OR REPLACE FUNCTION fn_bump_catalog_stamp()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
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
$$;

-- Belt-and-braces (084 posture): even under INVOKER semantics the
-- browser roles can bump stamps directly.
GRANT SELECT, INSERT, UPDATE ON TABLE catalog_stamps TO anon, authenticated;

-- ============================================================
-- STEP 3: reseed stamps for stores created after the last apply
-- so first polls return non-empty for every tenant.
-- ============================================================
INSERT INTO catalog_stamps (store_id, version)
SELECT id, gen_random_uuid()::text FROM stores
ON CONFLICT (store_id) DO NOTHING;

COMMIT;

-- ============================================================
-- STEP 4: refresh the PostgREST schema cache immediately
-- ============================================================
DO $$
BEGIN
  NOTIFY pgrst, 'reload schema';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pgrst reload skipped: %', SQLERRM;
END $$;
