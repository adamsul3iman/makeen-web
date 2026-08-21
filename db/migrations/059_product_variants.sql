-- 059_product_variants.sql
-- Phase 4 product variants: a variant is a child PRODUCT row linked to a
-- parent (the shelf product) via a self-referencing parent_id. Each variant
-- still lives under its own barcodes (per-barcode prices/costs), but the
-- parent supplies the shared category, supplier, tax policy and stock
-- visibility so the catalog can group them under one picker entry.
--
-- Rules enforced here:
--   1) A product can never be its own parent.
--   2) A variant (parent_id set) must carry a variant label.
--   3) A variant root (is_variant_root) is never itself a variant.
--   4) Within a store, (parent_id, variant_label) is unique, case-insensitively.

-- 1. Widen products with the variant columns. IF NOT EXISTS keeps this safe on
--    the 003-style install path where a shared schema may already carry them.
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS parent_id UUID;
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS variant_label VARCHAR(120) NOT NULL DEFAULT '';
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS is_variant_root BOOLEAN NOT NULL DEFAULT FALSE;

-- 2. Self-referencing parent FK. RESTRICT so a parent with live variants can
--    never be deleted out from under its child barcodes and ledgers.
ALTER TABLE products
  DROP CONSTRAINT IF EXISTS products_parent_id_fkey;
ALTER TABLE products
  ADD CONSTRAINT products_parent_id_fkey
  FOREIGN KEY (parent_id) REFERENCES public.products(id) ON DELETE RESTRICT;

-- 3. Structural integrity checks.
ALTER TABLE products
  DROP CONSTRAINT IF EXISTS products_parent_not_self;
ALTER TABLE products
  ADD CONSTRAINT products_parent_not_self
  CHECK (parent_id IS NULL OR parent_id <> id);

ALTER TABLE products
  DROP CONSTRAINT IF EXISTS products_variant_label_required;
ALTER TABLE products
  ADD CONSTRAINT products_variant_label_required
  CHECK (parent_id IS NULL OR BTRIM(variant_label) <> '');

ALTER TABLE products
  DROP CONSTRAINT IF EXISTS products_root_not_child;
ALTER TABLE products
  ADD CONSTRAINT products_root_not_child
  CHECK (NOT (parent_id IS NOT NULL AND is_variant_root));

-- 4. Uniqueness: one labeled variant per parent per store. The partial index
--    only constrains actual variants, so parents stay unlimited.
CREATE UNIQUE INDEX IF NOT EXISTS uq_products_store_parent_variant
  ON products (store_id, parent_id, lower(variant_label))
  WHERE parent_id IS NOT NULL;

-- 5. Variant grouping index: listing a parent's children (catalog picker,
--    receiving, /print-server) scans this range instead of the full table.
CREATE INDEX IF NOT EXISTS idx_products_store_parent
  ON products (store_id, parent_id);
