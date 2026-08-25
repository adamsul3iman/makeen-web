-- ============================================================
-- Migration 084: QA Hotfix — catalog_stamps writes + pos_orders drift
-- ============================================================
-- Two production findings from Phase 4 manual QA:
--
-- 1. `PATCH /rest/v1/categories` → 401 "permission denied for table
--    catalog_stamps". Migration 083 attached fn_bump_catalog_stamp() as a
--    plain INVOKER trigger: the authenticated cashier role may UPDATE
--    categories but has only SELECT on catalog_stamps, so the stamp bump
--    inside the same statement failed and took the whole UPDATE with it.
--    Fix: flip the function to SECURITY DEFINER (runs as its owner, which
--    owns catalog_stamps) and pin its search_path. Also grant INSERT/UPDATE
--    directly as belt-and-braces for environments where the function owner
--    differs from the table owner.
--
-- 2. `POST /rest/v1/pos_orders` → 400 on some environments where an earlier
--    partial 082 apply left the table without columns that the repo schema
--    (and future clients) define. Converge every environment to the full
--    082 shape idempotently and refresh the PostgREST schema cache so the
--    REST layer sees the final column set.
--
-- IDEMPOTENT: safe to re-run.
-- ============================================================

BEGIN;

SET search_path = public, extensions;

-- ============================================================
-- STEP 1: catalog stamp bump runs as definer (fixes 401 on catalog writes)
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

-- Belt-and-braces: even under INVOKER semantics (e.g. someone re-created
-- the function without SECURITY DEFINER), catalog writers can bump stamps.
GRANT SELECT, INSERT, UPDATE ON TABLE catalog_stamps TO anon, authenticated;

-- ============================================================
-- STEP 2: converge pos_orders to the full migration-082 shape
-- (no-ops when the table is already current)
-- ============================================================
ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS totals         JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS payments       JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS b2b_account_id UUID REFERENCES b2b_accounts(id);
ALTER TABLE pos_orders ADD COLUMN IF NOT EXISTS b2b_markup_pct NUMERIC(5,2) NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pos_orders_status_check'
  ) THEN
    ALTER TABLE pos_orders ADD CONSTRAINT pos_orders_status_check
      CHECK (status IN ('OPEN', 'CLOSED', 'CANCELLED'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pos_orders_closed_needs_invoice'
  ) THEN
    ALTER TABLE pos_orders ADD CONSTRAINT pos_orders_closed_needs_invoice
      CHECK (status <> 'CLOSED' OR invoice_sync_id IS NOT NULL);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_pos_orders_store_number'
  ) THEN
    ALTER TABLE pos_orders ADD CONSTRAINT uq_pos_orders_store_number
      UNIQUE (store_id, order_number);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_pos_orders_board
  ON pos_orders (store_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_pos_orders_invoice
  ON pos_orders (store_id, invoice_sync_id) WHERE invoice_sync_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_pos_orders_updated_at ON pos_orders;
CREATE TRIGGER trg_pos_orders_updated_at
  BEFORE UPDATE ON pos_orders
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

GRANT SELECT, INSERT, UPDATE ON TABLE pos_orders TO anon, authenticated;

COMMIT;

-- ============================================================
-- STEP 3: refresh the PostgREST schema cache so /rest/v1 sees the
-- converged columns immediately (no dashboard reload needed).
-- ============================================================
DO $$
BEGIN
  BEGIN
    NOTIFY pgrst, 'reload schema';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pgrst reload skipped: %', SQLERRM;
  END;
END $$;
