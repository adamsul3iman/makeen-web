-- 022_product_master_and_line_tax.sql
-- Product Master 2.0: normalized brands, per-product tax policy, operational
-- sale flags, and explicit default sale/purchase packaging units.

CREATE TABLE IF NOT EXISTS product_brands (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id   UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  name       VARCHAR(120) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_product_brands_store_name
  ON product_brands (store_id, lower(name));

ALTER TABLE products ADD COLUMN IF NOT EXISTS brand_id UUID REFERENCES product_brands(id) ON DELETE SET NULL;
ALTER TABLE products ADD COLUMN IF NOT EXISTS tax_percent DECIMAL(5,2);
ALTER TABLE products ADD COLUMN IF NOT EXISTS tax_included BOOLEAN;
ALTER TABLE products ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE products ADD COLUMN IF NOT EXISTS show_in_pos BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE products ADD COLUMN IF NOT EXISTS is_sellable BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE products ADD COLUMN IF NOT EXISTS is_purchasable BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE products ADD COLUMN IF NOT EXISTS allow_price_change BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE products ADD COLUMN IF NOT EXISTS reorder_level INTEGER NOT NULL DEFAULT 0;

-- Preserve the checkout semantics of existing products during rollout. New
-- products default to Jordan's standard 16% VAT with customer-facing prices
-- treated as VAT-inclusive.
UPDATE products p
SET tax_percent = COALESCE(s.tax_percent, 16)
FROM stores s
WHERE p.store_id = s.id AND p.tax_percent IS NULL;
UPDATE products SET tax_percent = 16 WHERE tax_percent IS NULL;
UPDATE products SET tax_included = FALSE WHERE tax_included IS NULL;
ALTER TABLE products ALTER COLUMN tax_percent SET DEFAULT 16;
ALTER TABLE products ALTER COLUMN tax_percent SET NOT NULL;
ALTER TABLE products ALTER COLUMN tax_included SET DEFAULT TRUE;
ALTER TABLE products ALTER COLUMN tax_included SET NOT NULL;
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_tax_percent_range;
ALTER TABLE products ADD CONSTRAINT products_tax_percent_range
  CHECK (tax_percent >= 0 AND tax_percent <= 100);
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_reorder_level_nonnegative;
ALTER TABLE products ADD CONSTRAINT products_reorder_level_nonnegative
  CHECK (reorder_level >= 0);

ALTER TABLE product_barcodes ADD COLUMN IF NOT EXISTS wholesale_price DECIMAL(10,2) NOT NULL DEFAULT 0;
ALTER TABLE product_barcodes ADD COLUMN IF NOT EXISTS is_default_sale BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE product_barcodes ADD COLUMN IF NOT EXISTS is_default_purchase BOOLEAN NOT NULL DEFAULT FALSE;

-- Pick one deterministic default for legacy products. Prefer the package with
-- the largest multiplier, then the highest retail price.
WITH ranked AS (
  SELECT barcode,
         row_number() OVER (
           PARTITION BY product_id
           ORDER BY multiplier DESC, selling_price DESC, barcode
         ) AS rn
  FROM product_barcodes
)
UPDATE product_barcodes pb
SET is_default_sale = TRUE
FROM ranked r
WHERE pb.barcode = r.barcode
  AND r.rn = 1
  AND NOT EXISTS (
    SELECT 1 FROM product_barcodes existing
    WHERE existing.product_id = pb.product_id AND existing.is_default_sale
  );

WITH ranked AS (
  SELECT barcode,
         row_number() OVER (
           PARTITION BY product_id
           ORDER BY multiplier DESC, cost_price DESC, barcode
         ) AS rn
  FROM product_barcodes
)
UPDATE product_barcodes pb
SET is_default_purchase = TRUE
FROM ranked r
WHERE pb.barcode = r.barcode
  AND r.rn = 1
  AND NOT EXISTS (
    SELECT 1 FROM product_barcodes existing
    WHERE existing.product_id = pb.product_id AND existing.is_default_purchase
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_product_barcodes_one_default_sale
  ON product_barcodes (product_id) WHERE is_default_sale;
CREATE UNIQUE INDEX IF NOT EXISTS idx_product_barcodes_one_default_purchase
  ON product_barcodes (product_id) WHERE is_default_purchase;

ALTER TABLE sales_invoice_items ADD COLUMN IF NOT EXISTS tax_percent DECIMAL(5,2) NOT NULL DEFAULT 0;
ALTER TABLE sales_invoice_items ADD COLUMN IF NOT EXISTS tax_included BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE sales_invoice_items ADD COLUMN IF NOT EXISTS tax_amount DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE sales_invoice_items ADD COLUMN IF NOT EXISTS net_total DECIMAL(12,2) NOT NULL DEFAULT 0;

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
