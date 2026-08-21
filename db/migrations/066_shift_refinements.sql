-- 066: Shift management refinements.
-- Adds CliQ tri-reconciliation and drawer open count to shift_reports.

SET search_path = public, extensions;

-- ============================================================
-- A. Extend shift_reports with CliQ reconciliation + drawer count
-- ============================================================
ALTER TABLE shift_reports
  ADD COLUMN IF NOT EXISTS expected_cliq      NUMERIC(14,3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS actual_cliq        NUMERIC(14,3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cliq_variance      NUMERIC(14,3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS drawer_open_count  INTEGER NOT NULL DEFAULT 0;

-- ============================================================
-- B. Update immutability trigger to cover new columns
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
     OR NEW.expected_cliq IS DISTINCT FROM OLD.expected_cliq
     OR NEW.actual_cliq IS DISTINCT FROM OLD.actual_cliq
     OR NEW.cliq_variance IS DISTINCT FROM OLD.cliq_variance
     OR NEW.drawer_open_count IS DISTINCT FROM OLD.drawer_open_count
     OR NEW.discrepancy_reason IS DISTINCT FROM OLD.discrepancy_reason
     OR NEW.discrepancy_note IS DISTINCT FROM OLD.discrepancy_note
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'shift_report_financials_are_immutable' USING ERRCODE = '55000';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
