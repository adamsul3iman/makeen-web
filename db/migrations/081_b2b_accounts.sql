-- ============================================================
-- Migration 081: B2B / Delivery Partner Accounts (ذمم الشركات)
-- ============================================================
-- Flexible credit-account system for delivery aggregators (Talabat,
-- Careem, ...) and wholesale buyers. NOT hardcoded to any company:
-- each account carries its own markup %, commission %, and credit terms.
--
-- Ledger model mirrors customers/customer_transactions (004):
--   positive balance = the account OWES the store (شراء بالذمة).
--   INVOICE      → balance += amount   (goods delivered on credit)
--   PAYMENT      → balance -= amount   (settlement received)
--   ADJUSTMENT   → balance += amount   (signed: can be negative)
--
-- The transactions table is an append-only ledger: DELETE is revoked
-- from anon (same immutability posture as customer_transactions in 076);
-- corrections are posted as ADJUSTMENT rows.
--
-- IDEMPOTENT: safe to re-run.
-- ============================================================

BEGIN;

SET search_path = public, extensions;

-- ============================================================
-- STEP 1: b2b_accounts
-- ============================================================
CREATE TABLE IF NOT EXISTS b2b_accounts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id            UUID NOT NULL REFERENCES stores(id),
  name                TEXT NOT NULL,
  account_type        TEXT NOT NULL DEFAULT 'DELIVERY_PARTNER'
                      CONSTRAINT b2b_account_type_check
                      CHECK (account_type IN ('DELIVERY_PARTNER', 'WHOLESALE')),
  phone               TEXT,
  -- % added to item prices when this account is active on a cart
  -- (e.g. 10 = +10% markup on every line before discounts/tax).
  default_markup_pct  NUMERIC(5,2) NOT NULL DEFAULT 0
                      CONSTRAINT b2b_markup_range CHECK (default_markup_pct >= 0 AND default_markup_pct <= 500),
  -- % of invoiced total owed back to the platform as commission.
  commission_pct      NUMERIC(5,2) NOT NULL DEFAULT 0
                      CONSTRAINT b2b_commission_range CHECK (commission_pct >= 0 AND commission_pct <= 100),
  credit_limit        NUMERIC(12,2),
  payment_terms_days  INT NOT NULL DEFAULT 0,
  -- Running credit balance maintained by fn_apply_b2b_balance below.
  balance             NUMERIC(12,2) NOT NULL DEFAULT 0,
  notes               TEXT,
  is_active           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Case-insensitive account name per store (expression → must be an index).
CREATE UNIQUE INDEX IF NOT EXISTS uq_b2b_store_name
  ON b2b_accounts (store_id, lower(name));

CREATE INDEX IF NOT EXISTS idx_b2b_accounts_store ON b2b_accounts(store_id, is_active);

-- ============================================================
-- STEP 2: b2b_transactions (append-only ledger)
-- ============================================================
CREATE TABLE IF NOT EXISTS b2b_transactions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id            UUID NOT NULL REFERENCES stores(id),
  account_id          UUID NOT NULL REFERENCES b2b_accounts(id) ON DELETE CASCADE,
  type                TEXT NOT NULL
                      CONSTRAINT b2b_tx_type_check
                      CHECK (type IN ('INVOICE', 'PAYMENT', 'ADJUSTMENT')),
  amount              NUMERIC(12,2) NOT NULL
                      CONSTRAINT b2b_tx_amount_nonzero CHECK (amount <> 0)
                      CONSTRAINT b2b_tx_invoice_positive CHECK (type <> 'INVOICE' OR amount > 0)
                      CONSTRAINT b2b_tx_payment_positive CHECK (type <> 'PAYMENT' OR amount > 0),
  -- Balance snapshot after this row was applied (audit convenience).
  balance_after       NUMERIC(12,2),
  -- Link to the sales invoice that created the debt (sync_events.sync_id).
  ref_invoice_sync_id TEXT,
  shift_id            TEXT,
  note                TEXT,
  actor_name          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_b2b_tx_account ON b2b_transactions(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_b2b_tx_store   ON b2b_transactions(store_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_b2b_tx_invoice ON b2b_transactions(ref_invoice_sync_id) WHERE ref_invoice_sync_id IS NOT NULL;

-- ============================================================
-- STEP 3: balance maintenance trigger
-- ============================================================
CREATE OR REPLACE FUNCTION fn_apply_b2b_balance()
RETURNS TRIGGER AS $$
DECLARE
  v_delta NUMERIC(12,2);
BEGIN
  v_delta := CASE NEW.type
    WHEN 'INVOICE' THEN NEW.amount
    WHEN 'PAYMENT' THEN -NEW.amount
    ELSE NEW.amount  -- ADJUSTMENT carries its sign
  END;

  UPDATE b2b_accounts
  SET balance = COALESCE(balance, 0) + v_delta
  WHERE id = NEW.account_id
  RETURNING balance INTO v_delta;

  -- Stamp the post-application snapshot onto the ledger row.
  UPDATE b2b_transactions SET balance_after = v_delta WHERE id = NEW.id;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_b2b_balance ON b2b_transactions;
CREATE TRIGGER trg_b2b_balance
  AFTER INSERT ON b2b_transactions
  FOR EACH ROW EXECUTE FUNCTION fn_apply_b2b_balance();

-- ============================================================
-- STEP 4: updated_at trigger for accounts
-- ============================================================
DROP TRIGGER IF EXISTS trg_b2b_accounts_updated_at ON b2b_accounts;
CREATE TRIGGER trg_b2b_accounts_updated_at
  BEFORE UPDATE ON b2b_accounts
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- ============================================================
-- STEP 5: Grants + ledger immutability
-- ============================================================
GRANT SELECT, INSERT, UPDATE ON TABLE b2b_accounts TO anon, authenticated;
GRANT SELECT, INSERT ON TABLE b2b_transactions TO anon, authenticated;
REVOKE DELETE ON TABLE b2b_transactions FROM anon, authenticated;

COMMIT;
