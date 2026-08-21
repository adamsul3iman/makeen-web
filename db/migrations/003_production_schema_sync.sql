-- 003_production_schema_sync.sql
-- Historical record of the production Supabase schema as executed manually.
-- Mirrors the live tables exactly so the repo stays in sync with the DB.
--
-- The statements below are idempotent and converge BOTH starting points onto
-- the canonical shape the application queries (see types/database.types.ts):
--   * a fresh database (001 creates the tables first), or
--   * a legacy database that already carries the 001-style columns
--     (barcode PK, qty_multiplier, price — no total_stock / is_quick_key /
--     multiplier / selling_price). ADD COLUMN IF NOT EXISTS upgrades it.
-- Seed rows are guarded so re-runs never duplicate or violate constraints.

-- Upgrade 001-style products / product_barcodes to the canonical columns.
ALTER TABLE products ADD COLUMN IF NOT EXISTS total_stock INTEGER NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS is_quick_key BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE product_barcodes ADD COLUMN IF NOT EXISTS multiplier INTEGER NOT NULL DEFAULT 1;
ALTER TABLE product_barcodes ADD COLUMN IF NOT EXISTS selling_price DECIMAL(10,2) NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS cashiers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  pin VARCHAR(4) UNIQUE NOT NULL,
  role VARCHAR(50) DEFAULT 'cashier'
);
INSERT INTO cashiers (name, pin, role) VALUES ('أحمد', '1234', 'cashier'), ('آدم', '0000', 'admin') ON CONFLICT (pin) DO NOTHING;

CREATE TABLE IF NOT EXISTS categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id UUID REFERENCES categories(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  base_unit VARCHAR(50) NOT NULL,
  total_stock INTEGER DEFAULT 0,
  is_quick_key BOOLEAN DEFAULT false
);

CREATE TABLE IF NOT EXISTS product_barcodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID REFERENCES products(id) ON DELETE CASCADE,
  barcode VARCHAR(100) UNIQUE NOT NULL,
  unit_name VARCHAR(50) NOT NULL,
  multiplier INTEGER DEFAULT 1,
  cost_price DECIMAL(10,2) NOT NULL,
  selling_price DECIMAL(10,2) NOT NULL
);

DO $$
DECLARE cat_plastic UUID; cat_paper UUID; prod_id UUID;
BEGIN
  SELECT id INTO cat_plastic FROM categories WHERE name = 'بلاستيكيات' LIMIT 1;
  IF cat_plastic IS NULL THEN
    INSERT INTO categories (name) VALUES ('بلاستيكيات') RETURNING id INTO cat_plastic;
  END IF;

  SELECT id INTO cat_paper FROM categories WHERE name = 'ورقيات' LIMIT 1;
  IF cat_paper IS NULL THEN
    INSERT INTO categories (name) VALUES ('ورقيات') RETURNING id INTO cat_paper;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM product_barcodes WHERE barcode = '11112222') THEN
    SELECT id INTO prod_id FROM products WHERE name = 'كاسات بلاستيك 50 اونصة' LIMIT 1;
    IF prod_id IS NULL THEN
      INSERT INTO products (category_id, name, base_unit, is_quick_key) VALUES (cat_plastic, 'كاسات بلاستيك 50 اونصة', 'حبة', true) RETURNING id INTO prod_id;
    END IF;
    INSERT INTO product_barcodes (product_id, barcode, unit_name, multiplier, cost_price, selling_price) VALUES (prod_id, '11112222', 'حبة', 1, 0.10, 0.15);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM product_barcodes WHERE barcode = '33334444') THEN
    SELECT id INTO prod_id FROM products WHERE name = 'رول سفرة مقوى' LIMIT 1;
    IF prod_id IS NULL THEN
      INSERT INTO products (category_id, name, base_unit, is_quick_key) VALUES (cat_paper, 'رول سفرة مقوى', 'رول', true) RETURNING id INTO prod_id;
    END IF;
    INSERT INTO product_barcodes (product_id, barcode, unit_name, multiplier, cost_price, selling_price) VALUES (prod_id, '33334444', 'رول', 1, 1.00, 1.50);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS sync_events (
  sync_id UUID PRIMARY KEY,
  action_type VARCHAR(50) NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  client_created_at TIMESTAMP WITH TIME ZONE
);
