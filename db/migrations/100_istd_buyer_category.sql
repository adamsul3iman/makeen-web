-- 100_istd_buyer_category.sql
-- ISTD (JoFotara) e-invoicing: configurable buyer registration category.
--
-- The receipt QR / fiscal mapping currently classifies every invoice only as
-- credit vs general_sales. Jordan's e-invoicing also distinguishes business
-- (B2B) from consumer (B2C) buyers, which affects how the buyer block and TIN
-- are reported. This migration adds:
--
--   1. tenant_tax_settings.istd_buyer_category — the STORE-LEVEL default
--      registration category (B2B / B2C) an admin chooses in Settings. It is
--      applied to every ISTD submission unless a given invoice overrides it.
--
--   2. customers.buyer_tin — the OPTIONAL buyer VAT/TIN number, captured per
--      customer. When present (and the invoice maps as B2B) it is reported as
--      the buyer's tax ID; consumers leave it blank (B2C).

ALTER TABLE tenant_tax_settings
  ADD COLUMN IF NOT EXISTS istd_buyer_category TEXT NOT NULL DEFAULT 'B2C'
  CONSTRAINT tenant_tax_istd_buyer_category_check
  CHECK (istd_buyer_category IN ('B2B', 'B2C'));

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS buyer_tin TEXT;
