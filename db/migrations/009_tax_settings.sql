-- 009_tax_settings.sql
-- Fiscal tax settings (Phase 25).
--
-- Adds per-tenant VAT configuration used by the thermal receipt:
--   * stores.tax_percent   VAT percentage applied at checkout (0 = tax-free)
--   * stores.tax_number    fiscal/tax identification number printed in the
--                          legally-compliant Smart QR code
--
-- Fully additive and store-scoped like every other operational column. A
-- tax_percent of 0 (or a missing tax_number) hides the tax breakdown and the
-- QR on receipts, so unconfigured tenants keep printing classic receipts.

ALTER TABLE stores ADD COLUMN IF NOT EXISTS tax_percent NUMERIC(10,2) NOT NULL DEFAULT 0;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS tax_number VARCHAR(30) NOT NULL DEFAULT '';

-- Backward compatibility: stores that existed before fiscal settings keep
-- their legacy 16% VAT behaviour until the owner opts out in Store Settings
-- (setting tax_percent to 0 hides the tax breakdown + QR). Runs once at
-- migration time; later edits by the owner are never overwritten.
UPDATE stores SET tax_percent = 16 WHERE tax_percent = 0;
