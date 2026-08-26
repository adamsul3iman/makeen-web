-- ============================================================
-- Migration 087: Cost/price history + PO variant/unit tracking
-- ============================================================
-- Adds three capabilities for the ERP upgrade:
--   1. product_cost_history — append-only audit trail for cost and
--      selling price changes. Every price mutation (PO receipt,
--      mobile receiving, manual update) logs old→new here.
--   2. log_cost_history RPC — Security Definer helper so the
--      anon browser role can atomically log a price change.
--   3. purchase_order_items enrichment — variant_id, unit_id,
--      qty_in_unit columns so the PO builder can track exactly
--      which variant and packaging tier was ordered.
--
-- IDEMPOTENT: safe to re-run. Every DDL guarded.
-- ============================================================

BEGIN;

SET search_path = public, extensions;

-- ============================================================
-- STEP 1: product_cost_history table
-- ============================================================
CREATE TABLE IF NOT EXISTS product_cost_history (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id          UUID NOT NULL REFERENCES stores(id),
  product_id        UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  old_cost_price    NUMERIC(12,3),
  new_cost_price    NUMERIC(12,3),
  old_selling_price NUMERIC(12,3),
  new_selling_price NUMERIC(12,3),
  -- 'PO_RECEIPT' | 'PO_RECONCILIATION' | 'MANUAL_ADJUSTMENT' | 'MOBILE_RECEIVING'
  source            VARCHAR(40) NOT NULL,
  reference_type    VARCHAR(40),
  reference_id      TEXT,
  changed_by        TEXT NOT NULL DEFAULT '',
  changed_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Optimized indexes for the two hot query patterns:
--   1. "Show cost history for product X" — most common (popover)
--   2. "Show recent changes across store" — admin dashboard
CREATE INDEX IF NOT EXISTS idx_pch_store_product
  ON product_cost_history (store_id, product_id, changed_at DESC);

CREATE INDEX IF NOT EXISTS idx_pch_store_recent
  ON product_cost_history (store_id, changed_at DESC);

-- RLS: same posture as inventory_movements (SELECT + INSERT only)
ALTER TABLE product_cost_history ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'pch_store_isolation' AND tablename = 'product_cost_history'
  ) THEN
    CREATE POLICY pch_store_isolation ON product_cost_history
     USING (store_id = (current_setting('request.jwt.claims', true)::jsonb->>'store_id')::uuid);
  END IF;
END $$;

GRANT SELECT, INSERT ON TABLE product_cost_history TO anon, authenticated;

-- ============================================================
-- STEP 2: log_cost_history RPC (Security Definer)
-- ============================================================
-- Reads the current prices BEFORE the caller updates them, then
-- inserts an audit row. Returns void — callers continue with
-- their own price update after this call.

CREATE OR REPLACE FUNCTION log_cost_history(
  p_store_id      UUID,
  p_product_id    UUID,
  p_new_cost      NUMERIC,
  p_new_selling   NUMERIC,
  p_source        TEXT,
  p_ref_type      TEXT DEFAULT NULL,
  p_ref_id        TEXT DEFAULT NULL,
  p_actor         TEXT DEFAULT ''
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_old_cost    NUMERIC;
  v_old_selling NUMERIC;
BEGIN
  -- Snapshot current prices before the caller updates them.
  SELECT cost_price, selling_price
    INTO v_old_cost, v_old_selling
  FROM products
  WHERE id = p_product_id AND store_id = p_store_id;

  -- Skip logging if nothing actually changed (idempotent).
  IF (v_old_cost IS NOT DISTINCT FROM p_new_cost)
     AND (v_old_selling IS NOT DISTINCT FROM p_new_selling) THEN
    RETURN;
  END IF;

  INSERT INTO product_cost_history (
    store_id, product_id,
    old_cost_price, new_cost_price,
    old_selling_price, new_selling_price,
    source, reference_type, reference_id, changed_by
  ) VALUES (
    p_store_id, p_product_id,
    v_old_cost, p_new_cost,
    v_old_selling, p_new_selling,
    p_source, p_ref_type, p_ref_id, p_actor
  );
END;
$$;

GRANT EXECUTE ON FUNCTION log_cost_history(
  UUID, UUID, NUMERIC, NUMERIC, TEXT, TEXT, TEXT, TEXT
) TO anon, authenticated;

-- ============================================================
-- STEP 3: purchase_order_items enrichment
-- ============================================================
-- variant_id  — links to product_variants (the specific SKU ordered)
-- unit_id     — links to product_units (the packaging tier, e.g. carton)
-- qty_in_unit — quantity expressed in the unit's own scale (e.g. 3 cartons)
--               vs. quantity which stays in base pieces (e.g. 36 pieces)

ALTER TABLE purchase_order_items
  ADD COLUMN IF NOT EXISTS variant_id UUID REFERENCES product_variants(id) ON DELETE SET NULL;

ALTER TABLE purchase_order_items
  ADD COLUMN IF NOT EXISTS unit_id UUID REFERENCES product_units(id) ON DELETE SET NULL;

ALTER TABLE purchase_order_items
  ADD COLUMN IF NOT EXISTS qty_in_unit NUMERIC(12,3);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'poi_qty_in_unit_positive'
  ) THEN
    ALTER TABLE purchase_order_items
      ADD CONSTRAINT poi_qty_in_unit_positive
      CHECK (qty_in_unit IS NULL OR qty_in_unit > 0) NOT VALID;
  END IF;
END $$;

-- Indexes for the PO builder modal queries:
--   "Get all PO items for a variant" or "for a unit"
CREATE INDEX IF NOT EXISTS idx_poi_variant
  ON purchase_order_items (variant_id) WHERE variant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_poi_unit
  ON purchase_order_items (unit_id) WHERE unit_id IS NOT NULL;

-- ============================================================
-- STEP 4: Refresh PostgREST cache
-- ============================================================
DO $$ BEGIN
  NOTIFY pgrst, 'reload schema';
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

COMMIT;
