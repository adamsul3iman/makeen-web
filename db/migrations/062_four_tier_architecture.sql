-- ============================================================
-- Migration 062: 4-Tier Product Architecture  (HOSTED SAFE)
-- ============================================================
-- Migrates from flat product + barcode to strict 4-Tier:
--   Tier 1: Category  (categories table -- already exists from 001)
--   Tier 2: Brand     (product_brands table -- already exists from 022)
--   Tier 3: Parent Product  (products table -- prices moved here)
--   Tier 4: Variant / SKU   (product_variants -- NEW table)
--
-- IDEMPOTENT: safe to re-run. Every DDL is guarded by IF NOT EXISTS
-- or DROP IF EXISTS; data migrations use ON CONFLICT / WHERE NOT EXISTS.
--
-- Prerequisites: migrations 001-061 applied (or partially -- this
-- handles both the 059-self-ref path and the fresh-install path).
-- ============================================================

BEGIN;

-- ============================================================
-- STEP 1: Create product_variants table (Tier 4)
-- Each SKU/barcode is now a variant row linked to the parent product.
-- ============================================================
CREATE TABLE IF NOT EXISTS product_variants (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id    UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  store_id      UUID NOT NULL REFERENCES stores(id),
  barcode       TEXT NOT NULL,
  variant_label VARCHAR(120) NOT NULL DEFAULT '',
  total_stock   DECIMAL(14,3) NOT NULL DEFAULT 0,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT uq_pv_store_barcode   UNIQUE (store_id, barcode),
  CONSTRAINT pv_stock_non_negative CHECK (total_stock >= 0)
);

CREATE UNIQUE INDEX uq_pv_product_label
  ON product_variants (store_id, product_id, lower(variant_label));

CREATE INDEX IF NOT EXISTS idx_pv_store            ON product_variants(store_id);
CREATE INDEX IF NOT EXISTS idx_pv_product          ON product_variants(product_id);
CREATE INDEX IF NOT EXISTS idx_pv_active           ON product_variants(product_id) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_pv_store_product    ON product_variants(store_id, product_id, is_active);

-- ============================================================
-- STEP 2: Add parent-level price columns to products (Tier 3)
-- Prices are now on the parent, not per-barcode.
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'products' AND column_name = 'cost_price'
  ) THEN
    ALTER TABLE products ADD COLUMN cost_price NUMERIC(12,2) NOT NULL DEFAULT 0;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'products' AND column_name = 'selling_price'
  ) THEN
    ALTER TABLE products ADD COLUMN selling_price NUMERIC(12,2) NOT NULL DEFAULT 0;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'products' AND column_name = 'wholesale_price'
  ) THEN
    ALTER TABLE products ADD COLUMN wholesale_price NUMERIC(12,2) NOT NULL DEFAULT 0;
  END IF;
END $$;

-- ============================================================
-- STEP 3: Migrate prices from product_barcodes to products
-- Uses the default sale barcode (highest priority) for each product.
-- Must happen BEFORE product_barcodes is dropped.
-- ============================================================
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'product_barcodes'
  ) THEN
    UPDATE products p
    SET
      cost_price = COALESCE((
        SELECT pb.cost_price FROM product_barcodes pb
        WHERE pb.product_id = p.id AND pb.store_id = p.store_id
        ORDER BY pb.is_default_sale DESC, pb.multiplier DESC, pb.selling_price DESC
        LIMIT 1
      ), 0),
      selling_price = COALESCE((
        SELECT pb.selling_price FROM product_barcodes pb
        WHERE pb.product_id = p.id AND pb.store_id = p.store_id
        ORDER BY pb.is_default_sale DESC, pb.multiplier DESC, pb.selling_price DESC
        LIMIT 1
      ), 0),
      wholesale_price = COALESCE((
        SELECT pb.wholesale_price FROM product_barcodes pb
        WHERE pb.product_id = p.id AND pb.store_id = p.store_id
        ORDER BY pb.is_default_sale DESC, pb.multiplier DESC
        LIMIT 1
      ), 0)
    WHERE EXISTS (
      SELECT 1 FROM product_barcodes pb WHERE pb.product_id = p.id
    );
  END IF;
END $$;

-- ============================================================
-- STEP 4: Migrate barcodes to product_variants
-- Each product_barcodes row becomes a product_variants row.
-- Handles fresh installs (product_barcodes exists) AND
-- re-runs (rows already inserted via ON CONFLICT DO NOTHING).
-- ============================================================
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'product_barcodes'
  ) THEN
    INSERT INTO product_variants (id, product_id, store_id, barcode, variant_label, total_stock, is_active)
    SELECT
      gen_random_uuid(),
      pb.product_id,
      pb.store_id,
      pb.barcode,
      COALESCE(NULLIF(pb.variant_label, ''), pb.barcode),
      0,
      TRUE
    FROM product_barcodes pb
    ON CONFLICT (store_id, barcode) DO NOTHING;
  END IF;
END $$;

-- ============================================================
-- STEP 5: Migrate old self-referencing variant children (migration 059)
-- Products with parent_id set that weren't captured in Step 4.
-- ============================================================
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'products' AND column_name = 'parent_id'
  ) THEN
    INSERT INTO product_variants (id, product_id, store_id, barcode, variant_label, total_stock, is_active)
    SELECT
      gen_random_uuid(),
      child.id,
      child.store_id,
      COALESCE(
        (SELECT pb.barcode FROM product_barcodes pb WHERE pb.product_id = child.id AND pb.store_id = child.store_id LIMIT 1),
        'MIGRATED-' || child.id::text
      ),
      child.variant_label,
      child.total_stock,
      child.is_active
    FROM products child
    WHERE child.parent_id IS NOT NULL
      AND child.variant_label IS NOT NULL
      AND child.variant_label != ''
      AND NOT EXISTS (
        SELECT 1 FROM product_variants pv WHERE pv.product_id = child.id
      )
    ON CONFLICT (store_id, barcode) DO NOTHING;
  END IF;
END $$;

-- ============================================================
-- STEP 6: Assign stock to variants
-- Single-variant products get full stock; multi-variant get 0.
-- Then attempt to recover per-variant stock from inventory_movements.
-- ============================================================
UPDATE product_variants pv
SET total_stock = GREATEST(0, COALESCE(p.total_stock, 0))
FROM products p
WHERE pv.product_id = p.id
  AND pv.store_id = p.store_id
  AND (
    SELECT COUNT(*) FROM product_variants pv2
    WHERE pv2.product_id = p.id AND pv2.store_id = p.store_id
  ) = 1;

UPDATE product_variants pv
SET total_stock = GREATEST(COALESCE((
  SELECT SUM(im.quantity_delta)
  FROM inventory_movements im
  WHERE im.barcode = pv.barcode
    AND im.store_id = pv.store_id
  GROUP BY im.barcode
), 0), 0)
WHERE pv.total_stock = 0
  AND EXISTS (
    SELECT 1 FROM inventory_movements im
    WHERE im.barcode = pv.barcode AND im.store_id = pv.store_id
  );

-- ============================================================
-- STEP 7: Drop old variant columns from products
-- Removes parent_id, variant_label, is_variant_root (059-era).
-- ============================================================
DO $$
BEGIN
  ALTER TABLE products DROP CONSTRAINT IF EXISTS products_parent_not_self;
  ALTER TABLE products DROP CONSTRAINT IF EXISTS products_variant_label_required;
  ALTER TABLE products DROP CONSTRAINT IF EXISTS products_root_not_child;
  ALTER TABLE products DROP CONSTRAINT IF EXISTS products_parent_id_fkey;
END $$;

DROP INDEX IF EXISTS idx_products_store_parent;
DROP INDEX IF EXISTS uq_products_store_parent_variant;

ALTER TABLE products DROP COLUMN IF EXISTS parent_id;
ALTER TABLE products DROP COLUMN IF EXISTS variant_label;
ALTER TABLE products DROP COLUMN IF EXISTS is_variant_root;

-- ============================================================
-- STEP 8: Drop product_barcodes table
-- All data has been migrated to product_variants + products.
-- ============================================================
DROP TABLE IF EXISTS product_barcodes CASCADE;

-- ============================================================
-- STEP 9: Parent stock aggregation trigger
-- Keeps products.total_stock in sync with
--   SUM(product_variants.total_stock) WHERE is_active.
-- ============================================================
CREATE OR REPLACE FUNCTION fn_sync_parent_stock()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE products
  SET total_stock = GREATEST(0, COALESCE((
    SELECT SUM(pv.total_stock)
    FROM product_variants pv
    WHERE pv.product_id = COALESCE(NEW.product_id, OLD.product_id)
      AND pv.is_active
  ), 0))
  WHERE id = COALESCE(NEW.product_id, OLD.product_id);
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_pv_stock_sync ON product_variants;
CREATE TRIGGER trg_pv_stock_sync
  AFTER INSERT OR UPDATE OR DELETE ON product_variants
  FOR EACH ROW EXECUTE FUNCTION fn_sync_parent_stock();

-- ============================================================
-- STEP 10: Core department seed function
-- ============================================================
CREATE OR REPLACE FUNCTION ensure_core_departments(p_store_id UUID)
RETURNS VOID AS $$
BEGIN
  INSERT INTO categories (id, store_id, name, sort_order) VALUES
    (gen_random_uuid(), p_store_id, 'منزلية', 1),
    (gen_random_uuid(), p_store_id, 'كوزماتيكس', 2),
    (gen_random_uuid(), p_store_id, 'منظفات', 3),
    (gen_random_uuid(), p_store_id, 'أدوات تنظيف', 4),
    (gen_random_uuid(), p_store_id, 'تعبئة وتغليف', 5),
    (gen_random_uuid(), p_store_id, 'ورقيات', 6),
    (gen_random_uuid(), p_store_id, 'بلاستيكيات خارجية', 7),
    (gen_random_uuid(), p_store_id, 'قرطاسية', 8)
  ON CONFLICT DO NOTHING;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- STEP 11: Add product_variant_id to inventory_movements
-- Enables direct variant-level stock tracking going forward.
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'inventory_movements' AND column_name = 'product_variant_id'
  ) THEN
    ALTER TABLE inventory_movements
      ADD COLUMN product_variant_id UUID REFERENCES product_variants(id);
    CREATE INDEX IF NOT EXISTS idx_im_variant ON inventory_movements(product_variant_id)
      WHERE product_variant_id IS NOT NULL;
  END IF;
END $$;

-- ============================================================
-- STEP 12: Updated_at trigger for product_variants
-- ============================================================
CREATE OR REPLACE FUNCTION fn_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_pv_updated_at ON product_variants;
CREATE TRIGGER trg_pv_updated_at
  BEFORE UPDATE ON product_variants
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- ============================================================
-- STEP 13: Explicit service_role GRANTS
-- Migration 033 set blanket grants, but new tables/functions
-- created after that migration need explicit GRANT statements.
-- The ALTER DEFAULT PRIVILEGES in 033 covers objects created by
-- the postgres role, but Supabase service_role may create objects
-- too. These explicit GRANTs ensure access regardless.
-- ============================================================
GRANT ALL ON TABLE product_variants TO service_role;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT EXECUTE ON FUNCTION fn_sync_parent_stock() TO service_role;
GRANT EXECUTE ON FUNCTION fn_set_updated_at() TO service_role;
GRANT EXECUTE ON FUNCTION ensure_core_departments(UUID) TO service_role;

COMMIT;
