-- 053_staff_active_status.sql
-- Staff account status (active / suspended).
--
-- Security hardening: every staff account must be hashable to a PIN that an
-- admin can revoke. `is_active` lets the store owner suspend an employee
-- without deleting their history — an inactive row is rejected by the
-- unified /api/login (403 «الحساب موقوف») and excluded from the shipped
-- catalog so the register's offline unlock cannot be used either.
--
-- Existing rows default to active; nothing else changes.

SET search_path = public, extensions;

ALTER TABLE cashiers ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

CREATE INDEX IF NOT EXISTS idx_cashiers_store_active
  ON cashiers (store_id, is_active);
