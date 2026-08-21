-- 007_store_branding.sql
-- Dynamic tenant branding: each store's receipt + settings draw from these
-- columns instead of the hardcoded "متجر التجزئة" defaults.
--
-- `phone` is re-asserted with IF NOT EXISTS for safety (006 created it).

ALTER TABLE stores ADD COLUMN IF NOT EXISTS logo_url TEXT NOT NULL DEFAULT '';
ALTER TABLE stores ADD COLUMN IF NOT EXISTS address TEXT NOT NULL DEFAULT '';
ALTER TABLE stores ADD COLUMN IF NOT EXISTS phone TEXT NOT NULL DEFAULT '';
ALTER TABLE stores ADD COLUMN IF NOT EXISTS receipt_header TEXT NOT NULL DEFAULT '';
ALTER TABLE stores ADD COLUMN IF NOT EXISTS receipt_footer TEXT NOT NULL DEFAULT '';
