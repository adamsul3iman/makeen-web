-- 023_catalog_references.sql
-- First-class catalog references: products may be uncategorized and may carry
-- one preferred supplier used to prefill purchasing workflows.

ALTER TABLE products ALTER COLUMN category_id DROP NOT NULL;

ALTER TABLE products DROP CONSTRAINT IF EXISTS products_category_id_fkey;
ALTER TABLE products ADD CONSTRAINT products_category_id_fkey
  FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL;

ALTER TABLE products ADD COLUMN IF NOT EXISTS default_supplier_id UUID;
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_default_supplier_id_fkey;
ALTER TABLE products ADD CONSTRAINT products_default_supplier_id_fkey
  FOREIGN KEY (default_supplier_id) REFERENCES suppliers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_products_default_supplier_id
  ON products (default_supplier_id);
