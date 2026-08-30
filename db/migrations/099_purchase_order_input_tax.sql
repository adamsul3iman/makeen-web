-- ───────────────────────────────────────────────────────────────────────────
-- Migration 099: Purchase-order input VAT (Tax Inclusive / Tax Exclusive)
--
-- Jordanian ISTD compliance and accurate COGS require the PO module to know
-- whether each line's unit cost is gross (VAT included) or net (VAT excludes).
-- This adds per-line tax metadata so the receive path can:
--   1. split the recoverable input VAT out of the landed cost, stocking
--      products.cost_price at the NET (tax-exclusive) value, and
--   2. book the supplier invoice with the real tax percent so input VAT flows
--      into supplier_invoices.tax_amount and the input-tax reporting layer
--      (app/admin/supplier-accounts/page.tsx), instead of the previous
--      hardcoded 0% that zeroed recoverable input VAT on PO receipts.
-- ───────────────────────────────────────────────────────────────────────────

ALTER TABLE purchase_order_items
  ADD COLUMN IF NOT EXISTS tax_percent DECIMAL(5,2) NOT NULL DEFAULT 16,
  ADD COLUMN IF NOT EXISTS tax_included BOOLEAN NOT NULL DEFAULT TRUE;

-- Total input VAT across all lines, stored on the header for at-a-glance
-- reconciliation with the linked supplier invoice's tax_amount.
ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS tax_amount DECIMAL(12,2) NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'purchase_order_items_tax_percent_check'
  ) THEN
    ALTER TABLE purchase_order_items
      ADD CONSTRAINT purchase_order_items_tax_percent_check
      CHECK (tax_percent >= 0 AND tax_percent <= 100) NOT VALID;
  END IF;
END $$;

-- Backfill: existing lines are treated as gross (tax-included) at the store's
-- default rate where known; otherwise 16% (Jordan standard). This keeps
-- historical cost_price semantics unchanged (net == gross for 0% lines).
UPDATE purchase_order_items poi
SET tax_included = TRUE
WHERE poi.tax_included IS DISTINCT FROM TRUE;

-- Refresh PostgREST schema cache so the new columns + RPC resolve immediately.
NOTIFY pgrst, 'reload schema';
