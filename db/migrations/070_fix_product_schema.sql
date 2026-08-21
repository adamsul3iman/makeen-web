-- 070_fix_product_schema.sql
-- Restore product schema columns and table dropped by 062 (four-tier migration).
-- The canonical manifest in db/migrate.mjs still expects these objects; adding
-- them back lets the verification pass without breaking the new four-tier code
-- (the columns are simply unused by the app post-062).

-- 1. Restore columns to products table ------------------------------------------------
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS parent_id UUID;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS variant_label VARCHAR(120) NOT NULL DEFAULT '';

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS is_variant_root BOOLEAN NOT NULL DEFAULT FALSE;

-- Restore self-reference FK (parent references same table)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'products_parent_id_fkey'
      AND conrelid = 'products'::regclass
  ) THEN
    ALTER TABLE products
      ADD CONSTRAINT products_parent_id_fkey
      FOREIGN KEY (parent_id) REFERENCES products(id) ON DELETE RESTRICT;
  END IF;
END
$$;

-- Restore CHECK: parent_id cannot point to self (IS NULL guard so existing rows pass)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'products_parent_not_self'
      AND conrelid = 'products'::regclass
  ) THEN
    ALTER TABLE products
      ADD CONSTRAINT products_parent_not_self
      CHECK (parent_id IS NULL OR parent_id <> id);
  END IF;
END
$$;

-- Restore CHECK: non-root variants must have a label (IS NULL guard so existing rows pass)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'products_variant_label_required'
      AND conrelid = 'products'::regclass
  ) THEN
    ALTER TABLE products
      ADD CONSTRAINT products_variant_label_required
      CHECK (parent_id IS NULL OR BTRIM(variant_label) <> '');
  END IF;
END
$$;

-- 2. Recreate product_barcodes table ---------------------------------------------------
-- Columns match the canonical manifest in db/migrate.mjs.
-- Uses store-scoped barcode uniqueness per migration 056.

CREATE TABLE IF NOT EXISTS product_barcodes (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id        UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  barcode           TEXT NOT NULL,
  unit_name         VARCHAR(120) NOT NULL DEFAULT '',
  multiplier        INTEGER NOT NULL DEFAULT 1,
  cost_price        NUMERIC(12,2) NOT NULL DEFAULT 0,
  selling_price     NUMERIC(12,2) NOT NULL DEFAULT 0,
  wholesale_price   NUMERIC(12,2) NOT NULL DEFAULT 0,
  store_id          UUID NOT NULL REFERENCES stores(id),
  is_default_sale   BOOLEAN NOT NULL DEFAULT FALSE,
  is_default_purchase BOOLEAN NOT NULL DEFAULT FALSE,
  variant_label     VARCHAR(120) NOT NULL DEFAULT ''
);

-- Store-scoped barcode uniqueness (matches migration 056)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_product_barcodes_store_barcode'
      AND conrelid = 'product_barcodes'::regclass
  ) THEN
    ALTER TABLE product_barcodes
      ADD CONSTRAINT uq_product_barcodes_store_barcode UNIQUE (store_id, barcode);
  END IF;
END
$$;

-- Prevent duplicate product entries for the same barcode within a store
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_product_barcodes_product_barcode_store'
      AND conrelid = 'product_barcodes'::regclass
  ) THEN
    ALTER TABLE product_barcodes
      ADD CONSTRAINT uq_product_barcodes_product_barcode_store
      UNIQUE (product_id, barcode, store_id);
  END IF;
END
$$;

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_product_barcodes_product_id ON product_barcodes(product_id);
CREATE INDEX IF NOT EXISTS idx_product_barcodes_barcode    ON product_barcodes(barcode);

-- 3. Permissions -----------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON product_barcodes TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON product_barcodes TO authenticated;
