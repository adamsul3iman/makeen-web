-- 074_client_sync_mirror_grants.sql
-- The offline sync pipeline moved from the removed /api/sync route (service
-- role) into the POS client itself (services/syncService -> lib/syncMirror).
-- The browser roles already hold broad DML grants (072 hotfix, 071 series),
-- but several ledger tables the mirror writes were still service-role-only.
-- Without these grants every queued INVOICE_CREATED / CASH_MOVEMENT /
-- SHIFT_CLOSED would age into quarantine instead of reaching the books.
--
-- Security posture: identical trust model to 072 — the tenant scope comes
-- from the device session and every mirror write is idempotent per sync_id.
-- RPCs (apply_customer_ledger_event, record_inventory_movement,
-- create_supplier_invoice, record_supplier_payment) are SECURITY DEFINER and
-- were already granted to anon/authenticated (024/031/073).

-- Sales accounting ledger inserts (072 granted SELECT only).
GRANT INSERT, UPDATE ON TABLE sales_invoices      TO anon, authenticated;
GRANT INSERT          ON TABLE sales_invoice_items TO anon, authenticated;

-- Payment rows per sales invoice (never granted to browser roles before).
GRANT SELECT, INSERT ON TABLE sales_payments TO anon, authenticated;

-- Event sourcing inbox. SELECT existed (reports); the mirror upserts rows
-- and rewrites SHIFT_CLOSED payloads after recomputing the drawer.
GRANT INSERT, UPDATE ON TABLE sync_events TO anon, authenticated;

-- Dual-reconciliation drawer movements (065 enabled RLS with no policies,
-- which locked out every role except service_role — see policy below).
GRANT SELECT, INSERT, UPDATE ON TABLE cash_movements TO anon, authenticated;

-- Z-report finalization writes the closed shift summary.
GRANT INSERT, UPDATE ON TABLE shift_reports TO anon, authenticated;

-- Risk engine appends shift-variance / invoice-return signals.
GRANT INSERT ON TABLE risk_events TO anon, authenticated;

-- Variance dedupe reads the audit log before inserting; INSERT existed (072).
GRANT SELECT ON TABLE admin_audit_logs TO anon, authenticated;

-- Barcode-label print requests land here for the /print-server kiosk.
GRANT SELECT, INSERT ON TABLE print_jobs TO anon, authenticated;

-- 065 enabled RLS on cash_movements without creating any policy, silently
-- denying anon/authenticated regardless of grants. Restore parity with every
-- other ledger table (grant-scoped access, no row filtering) so offline
-- drawer movements can drain.
DROP POLICY IF EXISTS cash_movements_browser_access ON cash_movements;
CREATE POLICY cash_movements_browser_access ON cash_movements
  FOR ALL TO anon, authenticated
  USING (true)
  WITH CHECK (true);
