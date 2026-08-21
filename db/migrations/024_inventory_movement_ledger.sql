-- 024_inventory_movement_ledger.sql
-- Append-only stock card with atomic balance updates and barcode-level labels.

ALTER TABLE products ALTER COLUMN total_stock DROP DEFAULT;
ALTER TABLE products
  ALTER COLUMN total_stock TYPE DECIMAL(14,3)
  USING total_stock::DECIMAL(14,3);
ALTER TABLE products ALTER COLUMN total_stock SET DEFAULT 0;

ALTER TABLE product_barcodes
  ADD COLUMN IF NOT EXISTS variant_label VARCHAR(120) NOT NULL DEFAULT '';

ALTER TABLE sales_invoice_items
  ADD COLUMN IF NOT EXISTS variant_label VARCHAR(120) NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS inventory_movements (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id            UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  product_id          UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  branch_id           UUID REFERENCES branches(id) ON DELETE SET NULL,
  terminal_id         UUID REFERENCES terminals(id) ON DELETE SET NULL,
  actor_id            UUID REFERENCES cashiers(id) ON DELETE SET NULL,
  actor_name          TEXT NOT NULL DEFAULT '',
  movement_type       VARCHAR(30) NOT NULL CHECK (
    movement_type IN (
      'OPENING',
      'SALE',
      'RETURN',
      'PURCHASE_RECEIPT',
      'ADJUSTMENT_IN',
      'ADJUSTMENT_OUT',
      'STOCKTAKE',
      'DAMAGE',
      'TRANSFER_IN',
      'TRANSFER_OUT'
    )
  ),
  quantity_delta      DECIMAL(14,3) NOT NULL CHECK (quantity_delta <> 0),
  unit_quantity       DECIMAL(14,3) NOT NULL,
  unit_name           VARCHAR(50) NOT NULL DEFAULT '',
  multiplier          DECIMAL(12,3) NOT NULL DEFAULT 1 CHECK (multiplier > 0),
  balance_before      DECIMAL(14,3) NOT NULL,
  balance_after       DECIMAL(14,3) NOT NULL,
  barcode             TEXT,
  variant_label       VARCHAR(120) NOT NULL DEFAULT '',
  reference_type      VARCHAR(40),
  reference_id        TEXT,
  idempotency_key     TEXT NOT NULL,
  reason              TEXT NOT NULL DEFAULT '',
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT inventory_movement_balance_math
    CHECK (balance_after = balance_before + quantity_delta)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_movements_idempotency
  ON inventory_movements (store_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_inventory_movements_product_created
  ON inventory_movements (store_id, product_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_inventory_movements_reference
  ON inventory_movements (store_id, reference_type, reference_id);
CREATE INDEX IF NOT EXISTS idx_inventory_movements_barcode
  ON inventory_movements (store_id, barcode, occurred_at DESC)
  WHERE barcode IS NOT NULL;

CREATE TABLE IF NOT EXISTS inventory_postings (
  sync_id    UUID PRIMARY KEY REFERENCES sync_events(sync_id) ON DELETE CASCADE,
  store_id   UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  posted_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inventory_postings_store
  ON inventory_postings (store_id, posted_at DESC);

-- Every invoice that predates this ledger already passed through the legacy
-- stock updater. Mark it posted so a late offline retry cannot consume stock
-- for a second time after deployment.
INSERT INTO inventory_postings (sync_id, store_id)
SELECT sync_id, store_id
FROM sync_events
WHERE action_type = 'INVOICE_CREATED'
ON CONFLICT (sync_id) DO NOTHING;

-- Existing balances become explicit opening entries so the stock card starts
-- reconciled on the exact balance that was already in production.
INSERT INTO inventory_movements (
  store_id,
  product_id,
  movement_type,
  quantity_delta,
  unit_quantity,
  unit_name,
  multiplier,
  balance_before,
  balance_after,
  reference_type,
  reference_id,
  idempotency_key,
  reason,
  occurred_at
)
SELECT
  p.store_id,
  p.id,
  'OPENING',
  p.total_stock,
  p.total_stock,
  p.base_unit,
  1,
  0,
  p.total_stock,
  'MIGRATION',
  p.id::TEXT,
  'opening:' || p.id::TEXT,
  'رصيد افتتاحي عند تفعيل دفتر المخزون',
  now()
FROM products p
WHERE p.total_stock <> 0
ON CONFLICT (store_id, idempotency_key) DO NOTHING;

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

ALTER TABLE admin_audit_logs
  DROP CONSTRAINT IF EXISTS admin_audit_logs_action_type_check;
ALTER TABLE admin_audit_logs
  ADD CONSTRAINT admin_audit_logs_action_type_check
  CHECK (
    action_type IN (
      'OVERRIDE_PRICE',
      'CANCEL_INVOICE',
      'OPEN_DRAWER',
      'SAVE_CASHIER',
      'DELETE_CASHIER',
      'ENTER_RETURN_MODE',
      'ADJUST_STOCK'
    )
  );

CREATE OR REPLACE FUNCTION delete_store(p_store_id uuid, p_token text) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_deleted integer := 0;
BEGIN
  IF p_token IS NULL OR p_token <> (SELECT value FROM platform_secrets WHERE name = 'ops_token') THEN
    RAISE EXCEPTION 'permission_denied' USING ERRCODE = '42501';
  END IF;

  DELETE FROM sales_payments          WHERE store_id = p_store_id;
  DELETE FROM sales_invoice_items     WHERE store_id = p_store_id;
  DELETE FROM sales_invoices          WHERE store_id = p_store_id;
  DELETE FROM inventory_movements     WHERE store_id = p_store_id;
  DELETE FROM inventory_postings      WHERE store_id = p_store_id;
  DELETE FROM customer_transactions   WHERE store_id = p_store_id;
  DELETE FROM purchase_order_items    WHERE store_id = p_store_id;
  DELETE FROM product_barcodes        WHERE store_id = p_store_id;
  DELETE FROM loyalty_events          WHERE store_id = p_store_id;
  DELETE FROM expenses                WHERE store_id = p_store_id;
  DELETE FROM sync_events             WHERE store_id = p_store_id;
  DELETE FROM terminals               WHERE branch_id IN (SELECT id FROM branches WHERE store_id = p_store_id);

  PERFORM set_config('app.allow_audit_log_delete', 'on', true);
  DELETE FROM admin_audit_logs        WHERE store_id = p_store_id;
  PERFORM set_config('app.allow_audit_log_delete', 'off', true);

  DELETE FROM customers               WHERE store_id = p_store_id;
  DELETE FROM purchase_orders         WHERE store_id = p_store_id;
  DELETE FROM products                WHERE store_id = p_store_id;
  DELETE FROM product_brands          WHERE store_id = p_store_id;
  DELETE FROM categories              WHERE store_id = p_store_id;
  DELETE FROM suppliers               WHERE store_id = p_store_id;
  DELETE FROM cashiers                WHERE store_id = p_store_id;
  DELETE FROM branches                WHERE store_id = p_store_id;
  DELETE FROM stores                  WHERE id = p_store_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  RETURN v_deleted > 0;
END;
$$;

GRANT EXECUTE ON FUNCTION delete_store(uuid, text) TO anon, authenticated;
