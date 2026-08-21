-- Owner-authorized, accounting-grade recovery for stale unmatched shifts.

SET search_path = public, extensions;

ALTER TABLE shift_reports
  ADD COLUMN IF NOT EXISTS close_source TEXT NOT NULL DEFAULT 'DEVICE',
  ADD COLUMN IF NOT EXISTS resolved_by UUID REFERENCES cashiers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS resolved_by_name TEXT,
  ADD COLUMN IF NOT EXISTS resolution_note TEXT NOT NULL DEFAULT '';

ALTER TABLE shift_reports DROP CONSTRAINT IF EXISTS shift_reports_close_source_check;
ALTER TABLE shift_reports ADD CONSTRAINT shift_reports_close_source_check
  CHECK (close_source IN ('DEVICE', 'ADMIN_RECOVERY'));

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
     OR NEW.close_source IS DISTINCT FROM OLD.close_source
     OR NEW.resolved_by IS DISTINCT FROM OLD.resolved_by
     OR NEW.resolved_by_name IS DISTINCT FROM OLD.resolved_by_name
     OR NEW.resolution_note IS DISTINCT FROM OLD.resolution_note
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'shift_report_financials_are_immutable' USING ERRCODE = '55000';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER TABLE risk_events DROP CONSTRAINT IF EXISTS risk_events_event_type_check;
ALTER TABLE risk_events ADD CONSTRAINT risk_events_event_type_check CHECK (event_type IN (
  'SHIFT_VARIANCE', 'STALE_SHIFT', 'INVOICE_RETURN', 'INVOICE_VOID',
  'HIGH_DISCOUNT', 'OPEN_DRAWER', 'PRICE_OVERRIDE', 'RETURN_MODE',
  'FAILED_APPROVAL'
));

ALTER TABLE admin_audit_logs DROP CONSTRAINT IF EXISTS admin_audit_logs_action_type_check;
ALTER TABLE admin_audit_logs ADD CONSTRAINT admin_audit_logs_action_type_check
  CHECK (action_type IN (
    'OVERRIDE_PRICE', 'CANCEL_INVOICE', 'OPEN_DRAWER', 'SAVE_CASHIER',
    'DELETE_CASHIER', 'ENTER_RETURN_MODE', 'ADJUST_STOCK',
    'CREATE_SUPPLIER_INVOICE', 'RECORD_SUPPLIER_PAYMENT',
    'SHIFT_VARIANCE', 'SHIFT_VARIANCE_APPROVED', 'SHIFT_STALE_RESOLVED',
    'REVIEW_RISK_EVENT', 'SAVE_PRINT_TEMPLATE', 'DELETE_PRINT_TEMPLATE',
    'UPDATE_RECEIPT_LOGO'
  ));

CREATE OR REPLACE FUNCTION resolve_stale_shift(
  p_store_id uuid,
  p_shift_id uuid,
  p_actual_cash numeric,
  p_resolved_by uuid,
  p_resolved_by_name text,
  p_note text
) RETURNS shift_reports
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_open sync_events;
  v_report shift_reports;
  v_close_event_id uuid := gen_random_uuid();
  v_now timestamptz := now();
  v_opened_at timestamptz;
  v_cashier_id uuid;
  v_cashier_name text;
  v_starting_cash numeric(14,3) := 0;
  v_cash_sales numeric(14,3) := 0;
  v_visa_sales numeric(14,3) := 0;
  v_cliq_sales numeric(14,3) := 0;
  v_debt_sales numeric(14,3) := 0;
  v_debt_collections numeric(14,3) := 0;
  v_discounts numeric(14,3) := 0;
  v_returns numeric(14,3) := 0;
  v_expenses numeric(14,3) := 0;
  v_total_sales numeric(14,3) := 0;
  v_expected_cash numeric(14,3) := 0;
  v_actual_cash numeric(14,3) := round(p_actual_cash, 3);
  v_variance numeric(14,3) := 0;
  v_payload jsonb;
BEGIN
  IF p_actual_cash IS NULL OR p_actual_cash < 0 OR p_actual_cash > 99999999999 THEN
    RAISE EXCEPTION 'actual_cash_invalid' USING ERRCODE = '22023';
  END IF;
  IF char_length(trim(coalesce(p_note, ''))) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'resolution_note_required' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_open
    FROM sync_events
   WHERE store_id = p_store_id
     AND action_type = 'SHIFT_OPENED'
     AND payload ->> 'shiftId' = p_shift_id::text
   ORDER BY client_created_at DESC NULLS LAST, created_at DESC
   LIMIT 1
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'shift_open_event_not_found' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_report
    FROM shift_reports
   WHERE store_id = p_store_id AND shift_id = p_shift_id;
  IF FOUND THEN
    RETURN v_report;
  END IF;

  v_opened_at := safe_jsonb_timestamptz(
    v_open.payload,
    'startTime',
    COALESCE(v_open.client_created_at, v_open.created_at)
  );
  IF v_opened_at > v_now - interval '24 hours' THEN
    RAISE EXCEPTION 'shift_is_not_stale' USING ERRCODE = '55000';
  END IF;

  v_starting_cash := round(safe_jsonb_numeric(v_open.payload, 'startingCash'), 3);
  v_cashier_name := COALESCE(NULLIF(v_open.payload ->> 'cashierName', ''), v_open.cashier_name, '');
  IF COALESCE(v_open.payload ->> 'cashierId', '') ~*
     '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    SELECT id INTO v_cashier_id
      FROM cashiers
     WHERE id = (v_open.payload ->> 'cashierId')::uuid
       AND store_id = p_store_id;
  END IF;

  SELECT
    round(COALESCE(sum(cash_amount), 0), 3),
    round(COALESCE(sum(visa_amount), 0), 3),
    round(COALESCE(sum(cliq_amount), 0), 3),
    round(COALESCE(sum(debt_amount), 0), 3),
    round(COALESCE(sum(abs(discount)), 0), 3),
    round(COALESCE(sum(CASE WHEN is_return OR total < 0 THEN abs(total) ELSE 0 END), 0), 3),
    round(COALESCE(sum(total), 0), 3)
  INTO v_cash_sales, v_visa_sales, v_cliq_sales, v_debt_sales,
       v_discounts, v_returns, v_total_sales
  FROM sales_invoices
  WHERE store_id = p_store_id AND shift_id = p_shift_id;

  SELECT round(COALESCE(sum(amount), 0), 3)
    INTO v_expenses
    FROM expenses
   WHERE store_id = p_store_id AND shift_id = p_shift_id;

  SELECT round(COALESCE(sum(amount), 0), 3)
    INTO v_debt_collections
    FROM customer_transactions
   WHERE store_id = p_store_id
     AND shift_id = p_shift_id
     AND type = 'SETTLEMENT';

  v_expected_cash := round(v_starting_cash + v_cash_sales + v_debt_collections - v_expenses, 3);
  v_variance := round(v_actual_cash - v_expected_cash, 3);
  v_payload := jsonb_build_object(
    'shiftId', p_shift_id,
    'startTime', v_opened_at,
    'closeTime', v_now,
    'startingCash', v_starting_cash,
    'cashSales', v_cash_sales,
    'visaSales', v_visa_sales,
    'cliqSales', v_cliq_sales,
    'debtSales', v_debt_sales,
    'debtCollections', v_debt_collections,
    'discounts', v_discounts,
    'returns', v_returns,
    'expenses', v_expenses,
    'totalSales', v_total_sales,
    'expectedCashInDrawer', v_expected_cash,
    'actualCash', v_actual_cash,
    'variance', v_variance,
    'cashierId', v_cashier_id,
    'cashierName', v_cashier_name,
    'branchId', v_open.branch_id,
    'terminalId', v_open.terminal_id,
    'closeSource', 'ADMIN_RECOVERY',
    'resolutionNote', trim(p_note)
  );

  INSERT INTO sync_events (
    sync_id, store_id, action_type, payload, client_created_at,
    branch_id, terminal_id, cashier_name
  ) VALUES (
    v_close_event_id, p_store_id, 'SHIFT_CLOSED', v_payload, v_now,
    v_open.branch_id, v_open.terminal_id, v_cashier_name
  );

  INSERT INTO shift_reports (
    store_id, shift_id, close_event_id, branch_id, terminal_id,
    cashier_id, cashier_name, opened_at, closed_at, starting_cash,
    cash_sales, visa_sales, cliq_sales, debt_sales, debt_collections,
    discounts, returns, expenses, total_sales, expected_cash, actual_cash,
    variance, approval_status, approved_by, approved_by_name, approved_at,
    approval_note, close_source, resolved_by, resolved_by_name, resolution_note
  ) VALUES (
    p_store_id, p_shift_id, v_close_event_id, v_open.branch_id, v_open.terminal_id,
    v_cashier_id, v_cashier_name, v_opened_at, v_now, v_starting_cash,
    v_cash_sales, v_visa_sales, v_cliq_sales, v_debt_sales, v_debt_collections,
    v_discounts, v_returns, v_expenses, v_total_sales, v_expected_cash, v_actual_cash,
    v_variance, CASE WHEN v_variance = 0 THEN 'NOT_REQUIRED' ELSE 'APPROVED' END,
    CASE WHEN v_variance = 0 THEN NULL ELSE p_resolved_by END,
    CASE WHEN v_variance = 0 THEN NULL ELSE trim(coalesce(p_resolved_by_name, '')) END,
    CASE WHEN v_variance = 0 THEN NULL ELSE v_now END,
    CASE WHEN v_variance = 0 THEN '' ELSE trim(p_note) END,
    'ADMIN_RECOVERY', p_resolved_by, trim(coalesce(p_resolved_by_name, '')), trim(p_note)
  ) RETURNING * INTO v_report;

  INSERT INTO admin_audit_logs (
    store_id, admin_id, admin_name, action_type, target_id, details
  ) VALUES (
    p_store_id, p_resolved_by, trim(coalesce(p_resolved_by_name, '')),
    'SHIFT_STALE_RESOLVED', p_shift_id::text,
    jsonb_build_object(
      'shiftId', p_shift_id,
      'expectedCash', v_expected_cash,
      'actualCash', v_actual_cash,
      'variance', v_variance,
      'invoiceTotal', v_total_sales,
      'closeSource', 'ADMIN_RECOVERY',
      'note', trim(p_note)
    )
  );

  INSERT INTO risk_events (
    store_id, event_key, actor_id, actor_name, branch_id, terminal_id,
    shift_id, event_type, severity, score, amount, target_id, details,
    status, reviewed_by, reviewed_by_name, reviewed_at, review_note, occurred_at
  ) VALUES (
    p_store_id, 'stale-shift:' || p_shift_id::text, v_cashier_id, v_cashier_name,
    v_open.branch_id, v_open.terminal_id, p_shift_id, 'STALE_SHIFT',
    CASE WHEN abs(v_variance) >= 50 THEN 'CRITICAL'
         WHEN abs(v_variance) >= 10 THEN 'HIGH' ELSE 'MEDIUM' END,
    LEAST(100, 45 + floor(abs(v_variance)))::integer,
    abs(v_variance), p_shift_id::text,
    jsonb_build_object(
      'openedAt', v_opened_at,
      'resolvedAt', v_now,
      'expectedCash', v_expected_cash,
      'actualCash', v_actual_cash,
      'variance', v_variance,
      'note', trim(p_note)
    ),
    'REVIEWED', p_resolved_by, trim(coalesce(p_resolved_by_name, '')),
    v_now, trim(p_note), v_now
  )
  ON CONFLICT (store_id, event_key) DO NOTHING;

  RETURN v_report;
END;
$$;

REVOKE ALL ON FUNCTION resolve_stale_shift(uuid, uuid, numeric, uuid, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION resolve_stale_shift(uuid, uuid, numeric, uuid, text, text)
  TO service_role;

