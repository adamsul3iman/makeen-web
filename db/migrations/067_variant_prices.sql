-- 067_variant_prices.sql
-- Add per-variant price columns to product_variants so each barcode
-- can have its own cost, selling, and wholesale price.

ALTER TABLE product_variants
  ADD COLUMN IF NOT EXISTS cost_price numeric(12,3) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS selling_price numeric(12,3) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS wholesale_price numeric(12,3) DEFAULT 0;

COMMENT ON COLUMN product_variants.cost_price IS 'Per-variant cost price override (0 = use product default)';
COMMENT ON COLUMN product_variants.selling_price IS 'Per-variant selling price override (0 = use product default)';
COMMENT ON COLUMN product_variants.wholesale_price IS 'Per-variant wholesale price override (0 = use product default)';
