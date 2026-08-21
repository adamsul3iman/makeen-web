-- 056_barcode_store_unique.sql
-- Barcodes are unique per store, not globally.
--
-- Global uniqueness forces every store to relabel stock when two of them
-- carry the same supplier GTIN. Scope uniqueness to (store_id, barcode): a
-- barcode may be reused across stores, and within a store it belongs to one
-- product. The app's upserts and conflict checks already key on
-- (store_id, barcode).

-- Drop the global unique constraint on barcode. IF EXISTS keeps this safe on
-- both install paths (003 created barcode VARCHAR(100) UNIQUE; 001 installed
-- barcode as TEXT PRIMARY KEY instead).
ALTER TABLE product_barcodes
  DROP CONSTRAINT IF EXISTS product_barcodes_barcode_key;

-- 001-style installs made barcode the PRIMARY KEY. Drop that PK when it still
-- points at barcode so shared GTINs are allowed; id-based rows keep their id.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'product_barcodes_pkey'
      AND conrelid = 'product_barcodes'::regclass
      AND pg_get_constraintdef(oid) LIKE '%barcode%'
  ) THEN
    ALTER TABLE product_barcodes DROP CONSTRAINT product_barcodes_pkey;
  END IF;
END
$$;

-- Enforce the new store-scoped uniqueness. Postgres picks a matching index.
ALTER TABLE product_barcodes
  ADD CONSTRAINT uq_product_barcodes_store_barcode UNIQUE (store_id, barcode);
