-- 021_sales_accounting_ledger.sql
-- Relational sales ledger for accounting-grade reports.
--
-- sync_events remains the immutable offline event log. These tables are a
-- query-friendly mirror: one invoice row, normalized item rows, and payment
-- rows. The mirror is idempotent by sync_id, so offline retries never double
-- count sales, profit, tax, stock, or cash.

CREATE TABLE IF NOT EXISTS sales_invoices (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sync_id                  UUID NOT NULL UNIQUE REFERENCES sync_events(sync_id) ON DELETE CASCADE,
  store_id                 UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  branch_id                UUID REFERENCES branches(id) ON DELETE SET NULL,
  terminal_id              UUID REFERENCES terminals(id) ON DELETE SET NULL,
  shift_id                 UUID,
  cashier_id               UUID REFERENCES cashiers(id) ON DELETE SET NULL,
  cashier_name             TEXT NOT NULL DEFAULT '',
  customer_id              UUID REFERENCES customers(id) ON DELETE SET NULL,
  customer_name            TEXT NOT NULL DEFAULT '',
  payment_method           VARCHAR(20) NOT NULL CHECK (payment_method IN ('CASH', 'VISA', 'SPLIT', 'DEBT', 'UNKNOWN')),
  subtotal                 DECIMAL(12,2) NOT NULL DEFAULT 0,
  tax                      DECIMAL(12,2) NOT NULL DEFAULT 0,
  discount                 DECIMAL(12,2) NOT NULL DEFAULT 0,
  total                    DECIMAL(12,2) NOT NULL DEFAULT 0,
  amount_paid              DECIMAL(12,2) NOT NULL DEFAULT 0,
  change_amount            DECIMAL(12,2) NOT NULL DEFAULT 0,
  cash_amount              DECIMAL(12,2) NOT NULL DEFAULT 0,
  visa_amount              DECIMAL(12,2) NOT NULL DEFAULT 0,
  debt_amount              DECIMAL(12,2) NOT NULL DEFAULT 0,
  item_count               DECIMAL(12,3) NOT NULL DEFAULT 0,
  gross_profit             DECIMAL(12,2) NOT NULL DEFAULT 0,
  is_return                BOOLEAN NOT NULL DEFAULT FALSE,
  is_cancellation          BOOLEAN NOT NULL DEFAULT FALSE,
  original_invoice_sync_id UUID,
  completed_at             TIMESTAMPTZ NOT NULL,
  payload                  JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sales_invoices_store_completed
  ON sales_invoices (store_id, completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_sales_invoices_store_cashier
  ON sales_invoices (store_id, cashier_id, completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_sales_invoices_store_branch_terminal
  ON sales_invoices (store_id, branch_id, terminal_id, completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_sales_invoices_original
  ON sales_invoices (store_id, original_invoice_sync_id)
  WHERE original_invoice_sync_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS sales_invoice_items (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id     UUID NOT NULL REFERENCES sales_invoices(id) ON DELETE CASCADE,
  store_id       UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  line_no        INTEGER NOT NULL CHECK (line_no >= 1),
  product_id     UUID REFERENCES products(id) ON DELETE SET NULL,
  product_name   TEXT NOT NULL DEFAULT '',
  barcode        TEXT NOT NULL DEFAULT '',
  unit_name      TEXT NOT NULL DEFAULT '',
  qty            DECIMAL(12,3) NOT NULL DEFAULT 0,
  multiplier     DECIMAL(12,3) NOT NULL DEFAULT 1,
  unit_price     DECIMAL(12,2) NOT NULL DEFAULT 0,
  line_subtotal  DECIMAL(12,2) NOT NULL DEFAULT 0,
  line_discount  DECIMAL(12,2) NOT NULL DEFAULT 0,
  line_total     DECIMAL(12,2) NOT NULL DEFAULT 0,
  cost_price     DECIMAL(12,2) NOT NULL DEFAULT 0,
  cost_total     DECIMAL(12,2) NOT NULL DEFAULT 0,
  gross_profit   DECIMAL(12,2) NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (invoice_id, line_no)
);

CREATE INDEX IF NOT EXISTS idx_sales_invoice_items_store_product
  ON sales_invoice_items (store_id, product_id);
CREATE INDEX IF NOT EXISTS idx_sales_invoice_items_store_barcode
  ON sales_invoice_items (store_id, barcode)
  WHERE barcode <> '';

CREATE TABLE IF NOT EXISTS sales_payments (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES sales_invoices(id) ON DELETE CASCADE,
  store_id   UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  method     VARCHAR(20) NOT NULL CHECK (method IN ('CASH', 'VISA', 'DEBT', 'UNKNOWN')),
  amount     DECIMAL(12,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (invoice_id, method)
);

CREATE INDEX IF NOT EXISTS idx_sales_payments_store_method
  ON sales_payments (store_id, method);

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

  DELETE FROM sales_payments         WHERE store_id = p_store_id;
  DELETE FROM sales_invoice_items    WHERE store_id = p_store_id;
  DELETE FROM sales_invoices         WHERE store_id = p_store_id;
  DELETE FROM customer_transactions  WHERE store_id = p_store_id;
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
