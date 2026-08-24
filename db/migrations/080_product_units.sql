-- ============================================================
-- Migration 080: Product Packaging Units (UoM architecture)
-- ============================================================
-- Adds the packaging dimension to the 4-tier catalog:
--   Tier 1: Category          (categories)
--   Tier 2: Brand             (product_brands)
--   Tier 3: Parent Product    (products — owns prices/flags)
--   Tier 3.5: Packaging Unit  (product_units — NEW: قطعة / كرتون ...)
--   Tier 4: Variant/SKU       (product_variants — owns stock + barcode)
--
-- A unit is a sellable/purchasable packaging level of a product with its
-- own qty multiplier relative to the BASE PIECE, its own prices, and an
-- optional dedicated barcode (cartons get their own EAN). Stock is NEVER
-- stored on units — variants keep owning stock in base pieces, so a carton
-- sale deducts qty × qty_multiplier pieces through the existing
-- record_inventory_movement path.
--
-- IDEMPOTENT: safe to re-run. Every DDL guarded; seed uses WHERE NOT EXISTS.
--
-- NOTE (app-level invariant): unit barcodes share the same per-store
-- namespace as variant barcodes. Postgres cannot express a cross-table
-- unique constraint, so lib/catalogProducts.assertNoBarcodeConflict must
-- validate BOTH tables before any write (it already centralizes this).
-- ============================================================

BEGIN;

SET search_path = public, extensions;

-- ============================================================
-- STEP 1: product_units table (Tier 3.5)
-- ============================================================
CREATE TABLE IF NOT EXISTS product_units (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id           UUID NOT NULL REFERENCES stores(id),
  product_id         UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  -- Display name of the package level ('قطعة', 'كرتون', 'دستة', ...).
  unit_name          VARCHAR(60) NOT NULL,
  -- Base pieces contained in one of this unit. 1 = the piece itself.
  qty_multiplier     NUMERIC(12,3) NOT NULL DEFAULT 1,
  cost_price         NUMERIC(12,3) NOT NULL DEFAULT 0,
  selling_price      NUMERIC(12,3) NOT NULL DEFAULT 0,
  wholesale_price    NUMERIC(12,3) NOT NULL DEFAULT 0,
  -- Dedicated barcode for this package level (NULL = piece-level only,
  -- reachable via the unit picker in the cart, not by scanning).
  barcode            TEXT,
  is_default_sale    BOOLEAN NOT NULL DEFAULT FALSE,
  is_default_purchase BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order         INT NOT NULL DEFAULT 0,
  is_active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT pu_multiplier_positive CHECK (qty_multiplier > 0),
  CONSTRAINT uq_pu_store_barcode UNIQUE (store_id, barcode)
);

-- One unit_name per product per store, case-insensitive.
CREATE UNIQUE INDEX IF NOT EXISTS uq_pu_product_unit_name
  ON product_units (store_id, product_id, lower(unit_name));

-- Exactly ONE default sale unit and ONE default purchase unit per product.
CREATE UNIQUE INDEX IF NOT EXISTS uq_pu_default_sale
  ON product_units (store_id, product_id) WHERE is_default_sale;
CREATE UNIQUE INDEX IF NOT EXISTS uq_pu_default_purchase
  ON product_units (store_id, product_id) WHERE is_default_purchase;

CREATE INDEX IF NOT EXISTS idx_pu_store   ON product_units(store_id);
CREATE INDEX IF NOT EXISTS idx_pu_product ON product_units(product_id) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_pu_barcode ON product_units(store_id, barcode) WHERE barcode IS NOT NULL;

-- ============================================================
-- STEP 2: product_variants.default_unit_id
-- Optional pointer so a color variant can prefer a specific package
-- when scanned/ring-ed up (NULL = use the product's default sale unit).
-- ============================================================
ALTER TABLE product_variants
  ADD COLUMN IF NOT EXISTS default_unit_id UUID REFERENCES product_units(id);

-- ============================================================
-- STEP 3: Seed one default piece unit for every product that has none.
-- Prices copied from the parent product; base_unit becomes the unit name.
-- The first seeded row is both the default sale and purchase unit.
-- ============================================================
INSERT INTO product_units
  (store_id, product_id, unit_name, qty_multiplier,
   cost_price, selling_price, wholesale_price,
   is_default_sale, is_default_purchase, sort_order)
SELECT
  p.store_id,
  p.id,
  LEFT(COALESCE(NULLIF(TRIM(p.base_unit), ''), 'قطعة'), 60),
  1,
  COALESCE(p.cost_price, 0),
  COALESCE(p.selling_price, 0),
  COALESCE(p.wholesale_price, 0),
  TRUE,
  TRUE,
  0
FROM products p
WHERE NOT EXISTS (
  SELECT 1 FROM product_units pu
  WHERE pu.store_id = p.store_id AND pu.product_id = p.id
);

-- ============================================================
-- STEP 4: updated_at trigger — reuses fn_set_updated_at from 062.
-- ============================================================
DROP TRIGGER IF EXISTS trg_pu_updated_at ON product_units;
CREATE TRIGGER trg_pu_updated_at
  BEFORE UPDATE ON product_units
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- ============================================================
-- STEP 5: Grants — browser catalog management writes units directly
-- (same anon posture as categories/product_brands since 071).
-- ============================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE product_units TO anon, authenticated;

COMMIT;
