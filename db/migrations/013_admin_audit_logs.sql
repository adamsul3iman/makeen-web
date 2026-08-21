-- 013_admin_audit_logs.sql
-- Immutable admin audit log (P3).
--
-- Every sensitive intervention performed from Admin Mode ("God Mode") —
-- inline price overrides, invoice cancellations, manual cash-drawer opens,
-- and cashier roster changes — is appended here so a store owner can answer
-- exactly "who did what, when, and to which entity". The table is
-- append-only: there is no UPDATE/DELETE endpoint or trigger, so entries can
-- only ever be read back.
--
-- Trust model: the acting admin is resolved server-side from the
-- `x-pos-admin-email` header against the store's cashiers table (role
-- 'admin'), so the log records the real cashier id + name snapshot instead
-- of trusting a client-supplied name. The destructive P2 actions themselves
-- are additionally gated by the owner password re-verification endpoint.

CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id    UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  admin_id    UUID REFERENCES cashiers(id) ON DELETE SET NULL,
  admin_name  TEXT,
  action_type TEXT NOT NULL CHECK (
    action_type IN ('OVERRIDE_PRICE', 'CANCEL_INVOICE', 'OPEN_DRAWER', 'SAVE_CASHIER')
  ),
  target_id   TEXT,
  details     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_store_created
  ON admin_audit_logs (store_id, created_at DESC);

-- Hard immutability: the ledger can only ever grow. A later, authorized
-- rotation/archive migration would need to drop this trigger explicitly.
CREATE OR REPLACE FUNCTION prevent_admin_audit_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'admin_audit_logs is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_admin_audit_no_update ON admin_audit_logs;
CREATE TRIGGER trg_admin_audit_no_update
  BEFORE UPDATE OR DELETE ON admin_audit_logs
  FOR EACH ROW EXECUTE FUNCTION prevent_admin_audit_mutation();
