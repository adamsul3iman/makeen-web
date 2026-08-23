-- 071_grant_anon_reports_read.sql
-- ─────────────────────────────────────────────────────────────────────
-- Migration 033 revoked ALL privileges from anon/authenticated on every
-- table (granting only to service_role). The admin dashboard's client-
-- side reports engine (reportsClient.ts) uses the anon-key Supabase
-- client and needs read access to five tables to compute the overview.
--
-- This migration grants SELECT-only on those five tables to the anon
-- and authenticated roles, matching the precedent of 024, 031, and 070.
-- No INSERT/UPDATE/DELETE is granted — the browser never writes to
-- these tables directly.
-- ─────────────────────────────────────────────────────────────────────

-- Products (catalog read for dashboard product list & stock alerts)
GRANT SELECT ON TABLE products TO anon, authenticated;

-- Product variants / barcodes (barcode-to-product mapping for reports)
GRANT SELECT ON TABLE product_variants TO anon, authenticated;

-- Sync events (invoice payloads parsed for the events-based fallback)
GRANT SELECT ON TABLE sync_events TO anon, authenticated;

-- Sales invoices (primary invoice table for the ledger-based path)
GRANT SELECT ON TABLE sales_invoices TO anon, authenticated;

-- Sales invoice items (line-level data for top-products / profit)
GRANT SELECT ON TABLE sales_invoice_items TO anon, authenticated;
