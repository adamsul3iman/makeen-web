-- Accounting-grade X/Z shift reporting and persistent anti-fraud signals.

SET search_path = public, extensions;

CREATE TABLE IF NOT EXISTS shift_reports (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id                 UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  shift_id                 UUID NOT NULL,
  close_event_id           UUID NOT NULL REFERENCES sync_events(sync_id) ON DELETE RESTRICT,
  branch_id                UUID REFERENCES branches(id) ON DELETE SET NULL,
  terminal_id              UUID REFERENCES terminals(id) ON DELETE SET NULL,
  cashier_id               UUID REFERENCES cashiers(id) ON DELETE SET NULL,
  cashier_name             TEXT NOT NULL DEFAULT '',
  opened_at                TIMESTAMPTZ NOT NULL,
  closed_at                TIMESTAMPTZ NOT NULL,
  starting_cash            NUMERIC(14,3) NOT NULL DEFAULT 0,
  cash_sales               NUMERIC(14,3) NOT NULL DEFAULT 0,
  visa_sales               NUMERIC(14,3) NOT NULL DEFAULT 0,
  cliq_sales               NUMERIC(14,3) NOT NULL DEFAULT 0,
  debt_sales               NUMERIC(14,3) NOT NULL DEFAULT 0,
  debt_collections         NUMERIC(14,3) NOT NULL DEFAULT 0,
  discounts                NUMERIC(14,3) NOT NULL DEFAULT 0,
  returns                  NUMERIC(14,3) NOT NULL DEFAULT 0,
  expenses                 NUMERIC(14,3) NOT NULL DEFAULT 0,
  total_sales              NUMERIC(14,3) NOT NULL DEFAULT 0,
  expected_cash            NUMERIC(14,3) NOT NULL DEFAULT 0,
  actual_cash              NUMERIC(14,3) NOT NULL DEFAULT 0,
  variance                 NUMERIC(14,3) NOT NULL DEFAULT 0,
  approval_status          TEXT NOT NULL DEFAULT 'NOT_REQUIRED'
                           CHECK (approval_status IN ('NOT_REQUIRED', 'PENDING', 'APPROVED')),
  approved_by              UUID REFERENCES cashiers(id) ON DELETE SET NULL,
  approved_by_name         TEXT,
  approved_at              TIMESTAMPTZ,
  approval_note            TEXT NOT NULL DEFAULT '',
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (store_id, shift_id),
  UNIQUE (close_event_id),
  CHECK (closed_at >= opened_at),
  CHECK (
    (approval_status = 'PENDING' AND variance <> 0 AND approved_at IS NULL)
    OR (approval_status = 'APPROVED' AND variance <> 0 AND approved_at IS NOT NULL)
    OR (approval_status = 'NOT_REQUIRED' AND variance = 0)
  )
);

CREATE INDEX IF NOT EXISTS idx_shift_reports_store_closed
  ON shift_reports (store_id, closed_at DESC);
CREATE INDEX IF NOT EXISTS idx_shift_reports_store_approval
  ON shift_reports (store_id, approval_status, closed_at DESC);
CREATE INDEX IF NOT EXISTS idx_shift_reports_terminal_closed
  ON shift_reports (store_id, terminal_id, closed_at DESC);

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
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'shift_report_financials_are_immutable' USING ERRCODE = '55000';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_protect_shift_report_financials ON shift_reports;
CREATE TRIGGER trg_protect_shift_report_financials
  BEFORE UPDATE ON shift_reports
  FOR EACH ROW EXECUTE FUNCTION protect_shift_report_financials();

CREATE OR REPLACE FUNCTION safe_jsonb_numeric(p_payload jsonb, p_key text)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  RETURN COALESCE(NULLIF(p_payload ->> p_key, '')::numeric, 0);
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
  RETURN 0;
END;
$$;

CREATE OR REPLACE FUNCTION safe_jsonb_timestamptz(
  p_payload jsonb,
  p_key text,
  p_fallback timestamptz
) RETURNS timestamptz
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  RETURN COALESCE(NULLIF(p_payload ->> p_key, '')::timestamptz, p_fallback);
EXCEPTION WHEN OTHERS THEN
  RETURN p_fallback;
END;
$$;

-- Preserve every historical Z event as a first-class immutable report.
INSERT INTO shift_reports (
  store_id, shift_id, close_event_id, branch_id, terminal_id, cashier_name,
  opened_at, closed_at, starting_cash, cash_sales, visa_sales, cliq_sales,
  debt_sales, debt_collections, discounts, returns, expenses, total_sales,
  expected_cash, actual_cash, variance, approval_status
)
SELECT
  event.store_id,
  (event.payload ->> 'shiftId')::uuid,
  event.sync_id,
  event.branch_id,
  event.terminal_id,
  COALESCE(event.cashier_name, ''),
  LEAST(
    safe_jsonb_timestamptz(event.payload, 'startTime', COALESCE(event.client_created_at, event.created_at)),
    safe_jsonb_timestamptz(event.payload, 'closeTime', COALESCE(event.client_created_at, event.created_at))
  ),
  GREATEST(
    safe_jsonb_timestamptz(event.payload, 'startTime', COALESCE(event.client_created_at, event.created_at)),
    safe_jsonb_timestamptz(event.payload, 'closeTime', COALESCE(event.client_created_at, event.created_at))
  ),
  safe_jsonb_numeric(event.payload, 'startingCash'),
  safe_jsonb_numeric(event.payload, 'cashSales'),
  safe_jsonb_numeric(event.payload, 'visaSales'),
  safe_jsonb_numeric(event.payload, 'cliqSales'),
  safe_jsonb_numeric(event.payload, 'debtSales'),
  safe_jsonb_numeric(event.payload, 'debtCollections'),
  safe_jsonb_numeric(event.payload, 'discounts'),
  safe_jsonb_numeric(event.payload, 'returns'),
  safe_jsonb_numeric(event.payload, 'expenses'),
  safe_jsonb_numeric(event.payload, 'totalSales'),
  safe_jsonb_numeric(event.payload, 'expectedCashInDrawer'),
  safe_jsonb_numeric(event.payload, 'actualCash'),
  safe_jsonb_numeric(event.payload, 'variance'),
  CASE WHEN safe_jsonb_numeric(event.payload, 'variance') = 0 THEN 'NOT_REQUIRED' ELSE 'PENDING' END
FROM sync_events event
WHERE event.action_type = 'SHIFT_CLOSED'
  AND event.store_id IS NOT NULL
  AND COALESCE(event.payload ->> 'shiftId', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
ON CONFLICT (store_id, shift_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS risk_events (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id                 UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  event_key                TEXT NOT NULL,
  actor_id                 UUID REFERENCES cashiers(id) ON DELETE SET NULL,
  actor_name               TEXT NOT NULL DEFAULT '',
  branch_id                UUID REFERENCES branches(id) ON DELETE SET NULL,
  terminal_id              UUID REFERENCES terminals(id) ON DELETE SET NULL,
  shift_id                 UUID,
  event_type               TEXT NOT NULL CHECK (event_type IN (
                             'SHIFT_VARIANCE', 'INVOICE_RETURN', 'INVOICE_VOID',
                             'HIGH_DISCOUNT', 'OPEN_DRAWER', 'PRICE_OVERRIDE',
                             'RETURN_MODE', 'FAILED_APPROVAL'
                           )),
  severity                 TEXT NOT NULL CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  score                    INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
  amount                   NUMERIC(14,3) NOT NULL DEFAULT 0,
  target_id                TEXT,
  details                  JSONB NOT NULL DEFAULT '{}'::jsonb,
  status                   TEXT NOT NULL DEFAULT 'OPEN'
                           CHECK (status IN ('OPEN', 'REVIEWED', 'DISMISSED', 'ESCALATED')),
  reviewed_by              UUID REFERENCES cashiers(id) ON DELETE SET NULL,
  reviewed_by_name         TEXT,
  reviewed_at              TIMESTAMPTZ,
  review_note              TEXT NOT NULL DEFAULT '',
  occurred_at              TIMESTAMPTZ NOT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (store_id, event_key)
);

CREATE INDEX IF NOT EXISTS idx_risk_events_store_occurred
  ON risk_events (store_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_risk_events_store_open
  ON risk_events (store_id, status, severity, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_risk_events_actor
  ON risk_events (store_id, actor_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_risk_events_shift
  ON risk_events (store_id, shift_id);

REVOKE ALL ON TABLE shift_reports, risk_events FROM anon, authenticated;
GRANT ALL ON TABLE shift_reports, risk_events TO service_role;

-- Backfill cash-variance signals from historical Z reports.
INSERT INTO risk_events (
  store_id, event_key, actor_id, actor_name, branch_id, terminal_id, shift_id,
  event_type, severity, score, amount, target_id, details, occurred_at
)
SELECT
  report.store_id,
  'shift-variance:' || report.shift_id::text,
  report.cashier_id,
  report.cashier_name,
  report.branch_id,
  report.terminal_id,
  report.shift_id,
  'SHIFT_VARIANCE',
  CASE
    WHEN abs(report.variance) >= 50 THEN 'CRITICAL'
    WHEN abs(report.variance) >= 10 THEN 'HIGH'
    WHEN abs(report.variance) >= 2 THEN 'MEDIUM'
    ELSE 'LOW'
  END,
  LEAST(100, 20 + floor(abs(report.variance) * 2))::integer,
  abs(report.variance),
  report.shift_id::text,
  jsonb_build_object(
    'expectedCash', report.expected_cash,
    'actualCash', report.actual_cash,
    'variance', report.variance
  ),
  report.closed_at
FROM shift_reports report
WHERE report.variance <> 0
ON CONFLICT (store_id, event_key) DO NOTHING;

-- New capabilities are appended to existing role rows without replacing any
-- store-specific customization.
UPDATE staff_roles
SET capabilities = array_append(capabilities, 'risk.view'), updated_at = now()
WHERE code IN ('accountant', 'store_manager')
  AND NOT capabilities @> ARRAY['risk.view'];

UPDATE staff_roles
SET capabilities = array_append(capabilities, 'shifts.x_report'), updated_at = now()
WHERE code IN ('accountant', 'store_manager')
  AND NOT capabilities @> ARRAY['shifts.x_report'];

UPDATE staff_roles
SET capabilities = array_append(capabilities, 'risk.review'), updated_at = now()
WHERE code = 'store_manager'
  AND NOT capabilities @> ARRAY['risk.review'];

-- Keep the existing store-creation trigger current for tenants provisioned
-- after this migration.
CREATE OR REPLACE FUNCTION seed_staff_roles_after_store_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM seed_default_staff_roles(NEW.id);
  UPDATE staff_roles
     SET capabilities = capabilities || ARRAY['shifts.x_report', 'risk.view'],
         updated_at = now()
   WHERE store_id = NEW.id AND code = 'accountant';
  UPDATE staff_roles
     SET capabilities = capabilities || ARRAY['shifts.x_report', 'risk.view', 'risk.review'],
         updated_at = now()
   WHERE store_id = NEW.id AND code = 'store_manager';
  RETURN NEW;
END;
$$;

ALTER TABLE admin_audit_logs DROP CONSTRAINT IF EXISTS admin_audit_logs_action_type_check;
ALTER TABLE admin_audit_logs ADD CONSTRAINT admin_audit_logs_action_type_check
  CHECK (action_type IN (
    'OVERRIDE_PRICE', 'CANCEL_INVOICE', 'OPEN_DRAWER', 'SAVE_CASHIER',
    'DELETE_CASHIER', 'ENTER_RETURN_MODE', 'ADJUST_STOCK',
    'CREATE_SUPPLIER_INVOICE', 'RECORD_SUPPLIER_PAYMENT',
    'SHIFT_VARIANCE', 'SHIFT_VARIANCE_APPROVED', 'REVIEW_RISK_EVENT',
    'SAVE_PRINT_TEMPLATE', 'DELETE_PRINT_TEMPLATE', 'UPDATE_RECEIPT_LOGO'
  ));

CREATE OR REPLACE FUNCTION approve_shift_variance(
  p_store_id uuid,
  p_shift_id uuid,
  p_approved_by uuid,
  p_approved_by_name text,
  p_note text
) RETURNS shift_reports
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_report shift_reports;
  v_approved_at timestamptz := now();
BEGIN
  IF char_length(trim(coalesce(p_note, ''))) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'approval_note_required' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_report
    FROM shift_reports
   WHERE store_id = p_store_id AND shift_id = p_shift_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'shift_report_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_report.variance = 0 THEN
    RAISE EXCEPTION 'variance_approval_not_required' USING ERRCODE = '23514';
  END IF;
  IF v_report.approval_status = 'APPROVED' THEN
    RETURN v_report;
  END IF;

  UPDATE shift_reports
     SET approval_status = 'APPROVED',
         approved_by = p_approved_by,
         approved_by_name = trim(coalesce(p_approved_by_name, '')),
         approved_at = v_approved_at,
         approval_note = trim(p_note)
   WHERE id = v_report.id
   RETURNING * INTO v_report;

  INSERT INTO admin_audit_logs (
    store_id, admin_id, admin_name, action_type, target_id, details
  ) VALUES (
    p_store_id,
    p_approved_by,
    trim(coalesce(p_approved_by_name, '')),
    'SHIFT_VARIANCE_APPROVED',
    p_shift_id::text,
    jsonb_build_object(
      'shiftId', p_shift_id,
      'expectedCash', v_report.expected_cash,
      'actualCash', v_report.actual_cash,
      'variance', v_report.variance,
      'note', trim(p_note)
    )
  );

  UPDATE risk_events
     SET status = 'REVIEWED',
         reviewed_by = p_approved_by,
         reviewed_by_name = trim(coalesce(p_approved_by_name, '')),
         reviewed_at = v_approved_at,
         review_note = trim(p_note)
   WHERE store_id = p_store_id
     AND event_key = 'shift-variance:' || p_shift_id::text
     AND status = 'OPEN';

  RETURN v_report;
END;
$$;

REVOKE ALL ON FUNCTION approve_shift_variance(uuid, uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION approve_shift_variance(uuid, uuid, uuid, text, text) TO service_role;

CREATE OR REPLACE FUNCTION review_risk_event(
  p_store_id uuid,
  p_event_id uuid,
  p_status text,
  p_reviewer_id uuid,
  p_reviewer_name text,
  p_note text
) RETURNS risk_events
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_event risk_events;
BEGIN
  IF p_status NOT IN ('REVIEWED', 'DISMISSED', 'ESCALATED') THEN
    RAISE EXCEPTION 'invalid_risk_status' USING ERRCODE = '22023';
  END IF;
  IF char_length(trim(coalesce(p_note, ''))) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'review_note_required' USING ERRCODE = '22023';
  END IF;

  UPDATE risk_events
     SET status = p_status,
         reviewed_by = p_reviewer_id,
         reviewed_by_name = trim(coalesce(p_reviewer_name, '')),
         reviewed_at = now(),
         review_note = trim(p_note)
   WHERE id = p_event_id AND store_id = p_store_id
   RETURNING * INTO v_event;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'risk_event_not_found' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO admin_audit_logs (
    store_id, admin_id, admin_name, action_type, target_id, details
  ) VALUES (
    p_store_id,
    p_reviewer_id,
    trim(coalesce(p_reviewer_name, '')),
    'REVIEW_RISK_EVENT',
    p_event_id::text,
    jsonb_build_object(
      'eventType', v_event.event_type,
      'riskScore', v_event.score,
      'status', p_status,
      'note', trim(p_note)
    )
  );

  RETURN v_event;
END;
$$;

REVOKE ALL ON FUNCTION review_risk_event(uuid, uuid, text, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION review_risk_event(uuid, uuid, text, uuid, text, text) TO service_role;
