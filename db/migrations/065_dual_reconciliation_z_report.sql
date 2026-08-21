-- 065: Z-Report dual-reconciliation engine.
-- Extends shift_reports with card reconciliation + discrepancy fields.
-- Creates cash_movements table for manual Cash In / Cash Out during a shift.

SET search_path = public, extensions;

-- ============================================================
-- A. Extend shift_reports with card reconciliation + discrepancy
-- ============================================================
ALTER TABLE shift_reports
  ADD COLUMN IF NOT EXISTS expected_card       NUMERIC(14,3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS actual_card         NUMERIC(14,3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS card_variance       NUMERIC(14,3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cash_in             NUMERIC(14,3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cash_out            NUMERIC(14,3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS discrepancy_reason  TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS discrepancy_note    TEXT NOT NULL DEFAULT '';

-- ============================================================
-- B. New table: cash_movements (manual Cash In / Cash Out)
-- ============================================================
CREATE TABLE IF NOT EXISTS cash_movements (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id      UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  shift_id      UUID NOT NULL,
  type          TEXT NOT NULL CHECK (type IN ('CASH_IN', 'CASH_OUT')),
  amount        NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  reason        TEXT NOT NULL DEFAULT '',
  notes         TEXT NOT NULL DEFAULT '',
  cashier_id    UUID REFERENCES cashiers(id) ON DELETE SET NULL,
  cashier_name  TEXT NOT NULL DEFAULT '',
  branch_id     UUID REFERENCES branches(id) ON DELETE SET NULL,
  terminal_id   UUID REFERENCES terminals(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cash_movements_shift
  ON cash_movements (store_id, shift_id);
CREATE INDEX IF NOT EXISTS idx_cash_movements_store_created
  ON cash_movements (store_id, created_at DESC);

-- ============================================================
-- C. Protect shift_reports new columns from post-close mutation
--    (extend the existing immutability trigger)
-- ============================================================
CREATE OR REPLACE FUNCTION protect_shift_report_financials()
RETURNS trigger AS $$
BEGIN
  IF NEW.store_id IS DISTINCT FROM OLD.store_id
     OR NEW.shift_id IS DISTINCT FROM OLD.shift_id
     OR NEW.close_event_id IS DISTINCT FROM OLD.close_event_id
     OR NEW.branch_id IS DISTINCT FROM OLD.branch_id
     OR NEW.terminal_id IS DISTINCT FROM OLD.terminal_id
     OR NEW.cashier_id IS DISTINCT FROM OLD.cashier_id
     OR NEW.cashier_name IS DISTINCT FROM OLD.cashier_name
     OR NEW.opened_at IS DISTINCT FROM OLD.opened_at
     OR NEW.closed_at IS DISTINCT FROM OLD.closed_at
     OR NEW.starting_cash IS DISTINCT FROM OLD.starting_cash
     OR NEW.cash_sales IS DISTINCT FROM OLD.cash_sales
     OR NEW.visa_sales IS DISTINCT FROM OLD.visa_sales
     OR NEW.cliq_sales IS DISTINCT FROM OLD.cliq_sales
     OR NEW.debt_sales IS DISTINCT FROM OLD.debt_sales
     OR NEW.debt_collections IS DISTINCT FROM OLD.debt_collections
     OR NEW.discounts IS DISTINCT FROM OLD.discounts
     OR NEW.returns IS DISTINCT FROM OLD.returns
     OR NEW.expenses IS DISTINCT FROM OLD.expenses
     OR NEW.total_sales IS DISTINCT FROM OLD.total_sales
     OR NEW.expected_cash IS DISTINCT FROM OLD.expected_cash
     OR NEW.actual_cash IS DISTINCT FROM OLD.actual_cash
     OR NEW.variance IS DISTINCT FROM OLD.variance
     OR NEW.expected_card IS DISTINCT FROM OLD.expected_card
     OR NEW.actual_card IS DISTINCT FROM OLD.actual_card
     OR NEW.card_variance IS DISTINCT FROM OLD.card_variance
     OR NEW.cash_in IS DISTINCT FROM OLD.cash_in
     OR NEW.cash_out IS DISTINCT FROM OLD.cash_out
     OR NEW.discrepancy_reason IS DISTINCT FROM OLD.discrepancy_reason
     OR NEW.discrepancy_note IS DISTINCT FROM OLD.discrepancy_note
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'shift_report_financials_are_immutable' USING ERRCODE = '55000';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- D. RLS: only service_role can touch cash_movements
-- ============================================================
ALTER TABLE cash_movements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE cash_movements FROM anon, authenticated;
GRANT ALL ON TABLE cash_movements TO service_role;
