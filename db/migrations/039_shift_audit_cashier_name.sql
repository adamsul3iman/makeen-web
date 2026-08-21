-- 039_shift_audit_cashier_name.sql
-- Phase 3 (Shift Audit): persist the cashier who opened/closed a shift as a
-- first-class column on sync_events so the admin timeline can attribute each
-- shift session to the exact cashier. The name was previously only carried on
-- the transient POST body and never written to the event ledger.

ALTER TABLE sync_events
    ADD COLUMN IF NOT EXISTS cashier_name TEXT NOT NULL DEFAULT '';

-- Accelerate the shift-audit dashboard: date-range scans on closed shifts and
-- cashier attribution filters.
CREATE INDEX IF NOT EXISTS idx_sync_events_shift_audit
    ON sync_events (store_id, action_type, client_created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sync_events_cashier_name
    ON sync_events (store_id, cashier_name);
