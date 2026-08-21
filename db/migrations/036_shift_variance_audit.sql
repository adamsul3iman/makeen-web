-- 036_shift_variance_audit.sql
-- Audit the blind-count shift closure: when the drawer's actual count
-- differs from the expected cash-in-drawer, the shift-close handler writes a
-- SHIFT_VARIANCE entry into the immutable admin audit log so the store owner
-- can trace who closed short/long and by how much.
--
-- This only widens the action_type allow-list; no table is added and the
-- delete_store() RPC already purges admin_audit_logs by store_id.

ALTER TABLE admin_audit_logs DROP CONSTRAINT IF EXISTS admin_audit_logs_action_type_check;
ALTER TABLE admin_audit_logs ADD CONSTRAINT admin_audit_logs_action_type_check
  CHECK (action_type IN (
    'OVERRIDE_PRICE', 'CANCEL_INVOICE', 'OPEN_DRAWER', 'SAVE_CASHIER',
    'DELETE_CASHIER', 'ENTER_RETURN_MODE', 'ADJUST_STOCK',
    'CREATE_SUPPLIER_INVOICE', 'RECORD_SUPPLIER_PAYMENT',
    'SHIFT_VARIANCE'
  ));
