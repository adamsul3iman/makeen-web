-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 5 hotfix: inventory-movement RPC permissions + purchase-order overhaul.
--
-- Production reported: `permission denied for function record_inventory_movement`
-- when submitting a manual adjustment from /admin/inventory/movements/. The
-- function body in 024 is already SECURITY DEFINER, so the live database has
-- drifted (older body without SECURITY DEFINER, or a revoked EXECUTE grant).
-- This migration re-issues the exact 024 definition and re-grants EXECUTE,
-- making the fix idempotent regardless of which drift happened.
--
-- It also prepares purchase orders for the procurement overhaul:
--   * purchase_order_items.new_selling_price  — selling price captured at PO
--     time and pushed onto the product when the order is received.
--   * purchase_orders.received_at             — belt-and-braces (005 defines it;
--     re-added here in case of environment drift).
--   * status casing normalization             — the CHECK constraint only allows
--     'pending'/'received'; any legacy uppercase rows are folded to lowercase.
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────────────
-- STEP 1: record_inventory_movement — verbatim 024 body, SECURITY DEFINER,
-- with explicit EXECUTE grants for the browser roles.
-- ───────────────────────────────────────────────────────────────────────────

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
  p_allow_negative BOOLEAN DEFAULT FALSE
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

  SELECT * INTO v_existing
  FROM inventory_movements
  WHERE store_id = p_store_id AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN v_existing;
  END IF;

  SELECT total_stock, base_unit INTO v_before, v_base_unit
  FROM products
  WHERE id = p_product_id AND store_id = p_store_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'product_not_found' USING ERRCODE = 'P0002';
  END IF;

  v_unit_name := v_base_unit;
  IF v_barcode IS NOT NULL THEN
    SELECT unit_name, multiplier, variant_label
      INTO v_unit_name, v_multiplier, v_variant_label
    FROM product_barcodes
    WHERE barcode = v_barcode
      AND product_id = p_product_id
      AND store_id = p_store_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'barcode_not_owned_by_product' USING ERRCODE = '22023';
    END IF;
  END IF;

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

  UPDATE products
  SET total_stock = v_after
  WHERE id = p_product_id AND store_id = p_store_id;

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

REVOKE UPDATE, DELETE ON inventory_movements FROM anon, authenticated;
GRANT SELECT ON inventory_movements TO anon, authenticated;
GRANT SELECT, INSERT ON inventory_postings TO anon, authenticated;
GRANT EXECUTE ON FUNCTION record_inventory_movement(
  UUID, UUID, DECIMAL, TEXT, TEXT, DECIMAL, TEXT, TEXT, TEXT, UUID, UUID,
  UUID, TEXT, TEXT, TIMESTAMPTZ, JSONB, DECIMAL, BOOLEAN
) TO anon, authenticated;

-- ───────────────────────────────────────────────────────────────────────────
-- STEP 2: purchase-order schema additions for the procurement overhaul.
-- ───────────────────────────────────────────────────────────────────────────

ALTER TABLE purchase_order_items
  ADD COLUMN IF NOT EXISTS new_selling_price DECIMAL(12,2);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'purchase_order_items_new_selling_price_check'
  ) THEN
    ALTER TABLE purchase_order_items
      ADD CONSTRAINT purchase_order_items_new_selling_price_check
      CHECK (new_selling_price IS NULL OR new_selling_price >= 0) NOT VALID;
  END IF;
END $$;

ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_purchase_order_items_order
  ON purchase_order_items (purchase_order_id);

-- Fold any legacy uppercase statuses into the CHECK-constraint vocabulary.
UPDATE purchase_orders SET status = 'received' WHERE status <> 'received' AND upper(status) = 'RECEIVED';

-- ───────────────────────────────────────────────────────────────────────────
-- STEP 3: refresh PostgREST cache so the new column + RPC signature resolve.
-- ───────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  NOTIFY pgrst, 'reload schema';
EXCEPTION WHEN OTHERS THEN
  -- PostgREST may not be listening in non-hosted environments; ignore.
  NULL;
END $$;
