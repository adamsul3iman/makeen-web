-- 071_grant_anon_browser_access.sql
-- ─────────────────────────────────────────────────────────────────────
-- Migration 033 revoked ALL privileges from anon/authenticated on every
-- table (granting only to service_role). However, the static-export POS
-- makes direct PostgREST queries from the browser using the anon key:
--
--   • Staff login (usePosStore) reads stores, cashiers, staff_roles,
--     branches, terminals; and writes to cashiers (save/delete).
--   • Admin dashboard (reportsClient) reads products, product_variants,
--     sync_events, sales_invoices, sales_invoice_items.
--
-- This migration restores the minimum required grants. Every table gets
-- SELECT for reads; cashiers additionally gets INSERT/UPDATE/DELETE for
-- the owner's cashier-management UI (gated by authenticate_admin_client
-- RPC + the owner password, not by RLS).
-- ─────────────────────────────────────────────────────────────────────

-- ── Staff login path ──────────────────────────────────────────────
GRANT SELECT ON TABLE stores TO anon, authenticated;
GRANT SELECT ON TABLE cashiers TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE cashiers TO anon, authenticated;
GRANT SELECT ON TABLE staff_roles TO anon, authenticated;
GRANT SELECT ON TABLE branches TO anon, authenticated;
GRANT SELECT ON TABLE terminals TO anon, authenticated;

-- ── Admin dashboard / reports engine ──────────────────────────────
GRANT SELECT ON TABLE products TO anon, authenticated;
GRANT SELECT ON TABLE product_variants TO anon, authenticated;
GRANT SELECT ON TABLE sync_events TO anon, authenticated;
GRANT SELECT ON TABLE sales_invoices TO anon, authenticated;
GRANT SELECT ON TABLE sales_invoice_items TO anon, authenticated;

-- ── Catalog management (inventory/categories pages) ───────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE categories TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE product_brands TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE suppliers TO anon, authenticated;

-- ── Inventory movements page (read-only from browser) ─────────────
GRANT SELECT ON TABLE inventory_movements TO anon, authenticated;

-- ── Audit log (movements page inserts after adjustments) ──────────
GRANT INSERT ON TABLE admin_audit_logs TO anon, authenticated;
