-- ═══════════════════════════════════════════════════════════════════════
-- 072_hotfix_v010_prod_patch.sql   (v2 — REVISED after 42P01 failure)
-- CONSOLIDATED PRODUCTION HOTFIX — v0.1.0 desktop app (static export)
-- Run manually in Supabase SQL Editor. IDEMPOTENT: safe to re-run.
-- ─────────────────────────────────────────────────────────────────────
-- v1 FAILED with: ERROR 42P01 relation "shortage_flags" does not exist.
-- Root cause: the client DB's applied-migration frontier sits somewhere in
-- 043..05x — print_templates (042) exists but later feature tables were
-- never applied. The single BEGIN..COMMIT rolled everything back, so the
-- database is UNCHANGED; this v2 is a full replacement.
--
-- Symptoms addressed:
--   1. column purchase_orders.expected_date does not exist   -> §1
--   2. print_templates RLS violation                          -> §5 + §6
--   3. empty catalogs / blocked queries                       -> §6 grants
--   4. missing tables entirely (shortage_flags, shift_reports,
--      risk_events, tenant_tax_settings, staff_roles?, product_variants?,
--      print_jobs?)                                           -> §3
--   5. missing SECURITY DEFINER RPCs the browser calls        -> §4 + §6
--
-- Trust model (unchanged from shipped migrations 014/071): sensitive ops
-- self-verify credentials inside the function; tenancy is enforced by the
-- app via store_id filters after authenticate_admin_client. Policies and
-- EXECUTE grants here unblock the gated browser roles exactly like the
-- shipped design does for delete_store / update_admin_credentials.
--
-- Idempotence notes:
--   * Tables/columns/indexes: CREATE/ADD ... IF NOT EXISTS.
--   * Constraints: DROP CONSTRAINT IF EXISTS + ADD (final definition).
--   * Functions: CREATE OR REPLACE (exact bodies copied from migrations
--     046/047/060/061/068 — do not hand-edit).
--   * Overload hygiene: legacy claim_print_job(uuid,text,int,int) from 060
--     is dropped before creating the 068 signature to avoid ambiguity.
-- ═══════════════════════════════════════════════════════════════════════

BEGIN;

-- ─────────────────────────────────────────────────────────────────────
-- SECTION 1 — Schema drift: purchase_orders columns
-- (purchasesClient.ts PO_SELECT selects these five columns)
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS order_number TEXT;
ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS paid_amount DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS expected_date DATE;

-- ─────────────────────────────────────────────────────────────────────
-- SECTION 2 — Schema drift: products 4-tier columns
-- (needed by merge_into_variant_parent §4e and inventory UI)
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE products ADD COLUMN IF NOT EXISTS parent_id UUID;
ALTER TABLE products ADD COLUMN IF NOT EXISTS variant_label VARCHAR(120) NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS is_variant_root BOOLEAN NOT NULL DEFAULT FALSE;

-- ─────────────────────────────────────────────────────────────────────
-- SECTION 3 — Defensive table creation (dependency ordered).
-- Each table: full final-shape CREATE IF NOT EXISTS, then ALTER top-ups
-- so partially-created shapes are also repaired.
-- ─────────────────────────────────────────────────────────────────────

-- ── 3a. staff_roles (migration 045) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS staff_roles (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id      UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  code          TEXT NOT NULL,
  name          TEXT NOT NULL CHECK (length(trim(name)) > 0),
  description   TEXT NOT NULL DEFAULT '',
  capabilities  TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  limits        JSONB NOT NULL DEFAULT '{}'::JSONB,
  is_system     BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_staff_roles_store_code UNIQUE (store_id, code),
  CONSTRAINT uq_staff_roles_id_store UNIQUE (id, store_id),
  CONSTRAINT ck_staff_roles_code CHECK (code ~ '^[a-z][a-z0-9_]*$'),
  CONSTRAINT ck_staff_roles_limits_object CHECK (jsonb_typeof(limits) = 'object')
);
CREATE INDEX IF NOT EXISTS idx_staff_roles_store_sort
  ON staff_roles(store_id, sort_order, name);

CREATE OR REPLACE FUNCTION seed_default_staff_roles(p_store_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO staff_roles (store_id, code, name, description, capabilities, limits, is_system, sort_order)
  VALUES
    (p_store_id, 'cashier', 'كاشير',
      'البيع اليومي مع طلب موافقة المدير للإجراءات الحساسة.',
      ARRAY['pos.sell','pos.hold_invoice','pos.request_discount','pos.request_price_override','pos.request_return','pos.request_void','pos.request_open_drawer','pos.record_expense','pos.collect_debt','pos.close_shift','pos.reprint_receipt'],
      '{"maxDiscountPercent":0,"maxRefundAmount":0,"maxPriceReductionPercent":0,"maxCashVarianceWithoutApproval":0}'::jsonb,
      TRUE, 10),
    (p_store_id, 'senior_cashier', 'كاشير أول',
      'تشغيل نقطة البيع والمصروفات وتسوية الذمم مع بقاء الاعتماد المالي محمياً.',
      ARRAY['pos.sell','pos.hold_invoice','pos.request_discount','pos.request_price_override','pos.request_return','pos.request_void','pos.request_open_drawer','pos.record_expense','pos.collect_debt','pos.close_shift','pos.reprint_receipt','shifts.view'],
      '{"maxDiscountPercent":10,"maxRefundAmount":50,"maxPriceReductionPercent":10,"maxCashVarianceWithoutApproval":1}'::jsonb,
      TRUE, 20),
    (p_store_id, 'accountant', 'محاسب',
      'قراءة التقارير والربحية والورديات وسجل الرقابة دون تعديل الإعدادات.',
      ARRAY['backoffice.access','reports.view','reports.profitability','shifts.view','audit.view'],
      '{"maxDiscountPercent":0,"maxRefundAmount":0,"maxPriceReductionPercent":0,"maxCashVarianceWithoutApproval":0}'::jsonb,
      TRUE, 30),
    (p_store_id, 'inventory_manager', 'مسؤول مخزون',
      'إدارة الأصناف والمخزون والمشتريات والموردين مع تقارير التشغيل.',
      ARRAY['backoffice.access','reports.view','inventory.view','inventory.manage','catalog.manage','purchases.manage','suppliers.manage','print_studio.manage'],
      '{"maxDiscountPercent":0,"maxRefundAmount":0,"maxPriceReductionPercent":0,"maxCashVarianceWithoutApproval":0}'::jsonb,
      TRUE, 40),
    (p_store_id, 'store_manager', 'مدير متجر',
      'إدارة التشغيل والتقارير والمخزون مع استثناء حساب المالك وإعدادات الأمان.',
      ARRAY['pos.sell','pos.hold_invoice','pos.request_discount','pos.request_price_override','pos.request_return','pos.request_void','pos.request_open_drawer','pos.record_expense','pos.collect_debt','pos.close_shift','pos.reprint_receipt','backoffice.access','reports.view','reports.profitability','shifts.view','audit.view','inventory.view','inventory.manage','catalog.manage','purchases.manage','suppliers.manage','customers.manage','print_studio.manage','branches.manage'],
      '{"maxDiscountPercent":25,"maxRefundAmount":250,"maxPriceReductionPercent":25,"maxCashVarianceWithoutApproval":5}'::jsonb,
      TRUE, 50)
  ON CONFLICT (store_id, code) DO NOTHING;
END;
$$;

-- Seed any existing stores that lack role rows (idempotent).
SELECT seed_default_staff_roles(id) FROM stores;

-- Enrich seeded roles with the post-045 capabilities (from migration 046).
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

CREATE OR REPLACE FUNCTION seed_staff_roles_after_store_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM seed_default_staff_roles(NEW.id);
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_seed_staff_roles ON stores;
CREATE TRIGGER trg_seed_staff_roles
AFTER INSERT ON stores
FOR EACH ROW EXECUTE FUNCTION seed_staff_roles_after_store_insert();

-- cashiers.role_id linkage (column + mapping only; FK/CHECK constraints
-- intentionally omitted — data-dependent, not required by the app).
ALTER TABLE cashiers ADD COLUMN IF NOT EXISTS role_id UUID;
UPDATE cashiers c
SET role_id = r.id,
    role = r.code
FROM staff_roles r
WHERE c.store_id = r.store_id
  AND c.role_id IS NULL
  AND c.role NOT IN ('admin', 'مدير')
  AND r.code = CASE
    WHEN c.role IN ('accountant', 'محاسب') THEN 'accountant'
    WHEN c.role IN ('inventory_manager', 'مسؤول مخزون') THEN 'inventory_manager'
    WHEN c.role IN ('store_manager', 'مدير متجر') THEN 'store_manager'
    WHEN c.role IN ('senior_cashier', 'كاشير أول') THEN 'senior_cashier'
    ELSE 'cashier'
  END;

-- ── 3b. shift_reports (migrations 046 + 047 + 065 + 066, final shape) ─
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
  close_source             TEXT NOT NULL DEFAULT 'DEVICE',
  resolved_by              UUID REFERENCES cashiers(id) ON DELETE SET NULL,
  resolved_by_name         TEXT,
  resolution_note          TEXT NOT NULL DEFAULT '',
  expected_card            NUMERIC(14,3) NOT NULL DEFAULT 0,
  actual_card              NUMERIC(14,3) NOT NULL DEFAULT 0,
  card_variance            NUMERIC(14,3) NOT NULL DEFAULT 0,
  expected_cliq            NUMERIC(14,3) NOT NULL DEFAULT 0,
  actual_cliq              NUMERIC(14,3) NOT NULL DEFAULT 0,
  cliq_variance            NUMERIC(14,3) NOT NULL DEFAULT 0,
  cash_in                  NUMERIC(14,3) NOT NULL DEFAULT 0,
  cash_out                 NUMERIC(14,3) NOT NULL DEFAULT 0,
  discrepancy_reason       TEXT NOT NULL DEFAULT '',
  discrepancy_note         TEXT NOT NULL DEFAULT '',
  drawer_open_count        INTEGER NOT NULL DEFAULT 0,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (store_id, shift_id),
  UNIQUE (close_event_id),
  CHECK (closed_at >= opened_at),
  CHECK (
    (approval_status = 'PENDING' AND variance <> 0 AND approved_at IS NULL)
    OR (approval_status = 'APPROVED' AND variance <> 0 AND approved_at IS NOT NULL)
    OR (approval_status = 'NOT_REQUIRED' AND variance = 0)
  ),
  CONSTRAINT shift_reports_close_source_check
    CHECK (close_source IN ('DEVICE', 'ADMIN_RECOVERY'))
);
-- Repair partially-applied shapes (each is a no-op when §3b just created it):
ALTER TABLE shift_reports ADD COLUMN IF NOT EXISTS close_source TEXT NOT NULL DEFAULT 'DEVICE';
ALTER TABLE shift_reports ADD COLUMN IF NOT EXISTS resolved_by UUID REFERENCES cashiers(id) ON DELETE SET NULL;
ALTER TABLE shift_reports ADD COLUMN IF NOT EXISTS resolved_by_name TEXT;
ALTER TABLE shift_reports ADD COLUMN IF NOT EXISTS resolution_note TEXT NOT NULL DEFAULT '';
ALTER TABLE shift_reports ADD COLUMN IF NOT EXISTS expected_card NUMERIC(14,3) NOT NULL DEFAULT 0;
ALTER TABLE shift_reports ADD COLUMN IF NOT EXISTS actual_card NUMERIC(14,3) NOT NULL DEFAULT 0;
ALTER TABLE shift_reports ADD COLUMN IF NOT EXISTS card_variance NUMERIC(14,3) NOT NULL DEFAULT 0;
ALTER TABLE shift_reports ADD COLUMN IF NOT EXISTS expected_cliq NUMERIC(14,3) NOT NULL DEFAULT 0;
ALTER TABLE shift_reports ADD COLUMN IF NOT EXISTS actual_cliq NUMERIC(14,3) NOT NULL DEFAULT 0;
ALTER TABLE shift_reports ADD COLUMN IF NOT EXISTS cliq_variance NUMERIC(14,3) NOT NULL DEFAULT 0;
ALTER TABLE shift_reports ADD COLUMN IF NOT EXISTS cash_in NUMERIC(14,3) NOT NULL DEFAULT 0;
ALTER TABLE shift_reports ADD COLUMN IF NOT EXISTS cash_out NUMERIC(14,3) NOT NULL DEFAULT 0;
ALTER TABLE shift_reports ADD COLUMN IF NOT EXISTS discrepancy_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE shift_reports ADD COLUMN IF NOT EXISTS discrepancy_note TEXT NOT NULL DEFAULT '';
ALTER TABLE shift_reports ADD COLUMN IF NOT EXISTS drawer_open_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE shift_reports DROP CONSTRAINT IF EXISTS shift_reports_close_source_check;
ALTER TABLE shift_reports ADD CONSTRAINT shift_reports_close_source_check
  CHECK (close_source IN ('DEVICE', 'ADMIN_RECOVERY'));

CREATE INDEX IF NOT EXISTS idx_shift_reports_store_closed
  ON shift_reports (store_id, closed_at DESC);
CREATE INDEX IF NOT EXISTS idx_shift_reports_store_approval
  ON shift_reports (store_id, approval_status, closed_at DESC);
CREATE INDEX IF NOT EXISTS idx_shift_reports_terminal_closed
  ON shift_reports (store_id, terminal_id, closed_at DESC);

-- ── 3c. risk_events (migration 046 + 047 event-type widening) ─────────
CREATE TABLE IF NOT EXISTS risk_events (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id                 UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  event_key                TEXT NOT NULL,
  actor_id                 UUID REFERENCES cashiers(id) ON DELETE SET NULL,
  actor_name               TEXT NOT NULL DEFAULT '',
  branch_id                UUID REFERENCES branches(id) ON DELETE SET NULL,
  terminal_id              UUID REFERENCES terminals(id) ON DELETE SET NULL,
  shift_id                 UUID,
  event_type               TEXT NOT NULL,
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
  UNIQUE (store_id, event_key),
  CONSTRAINT risk_events_event_type_check CHECK (event_type IN (
    'SHIFT_VARIANCE', 'STALE_SHIFT', 'INVOICE_RETURN', 'INVOICE_VOID',
    'HIGH_DISCOUNT', 'OPEN_DRAWER', 'PRICE_OVERRIDE', 'RETURN_MODE',
    'FAILED_APPROVAL'
  ))
);
-- Widen event_type on pre-existing copies (no-op when fresh):
ALTER TABLE risk_events DROP CONSTRAINT IF EXISTS risk_events_event_type_check;
ALTER TABLE risk_events ADD CONSTRAINT risk_events_event_type_check CHECK (event_type IN (
  'SHIFT_VARIANCE', 'STALE_SHIFT', 'INVOICE_RETURN', 'INVOICE_VOID',
  'HIGH_DISCOUNT', 'OPEN_DRAWER', 'PRICE_OVERRIDE', 'RETURN_MODE',
  'FAILED_APPROVAL'
));
CREATE INDEX IF NOT EXISTS idx_risk_events_store_occurred
  ON risk_events (store_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_risk_events_store_open
  ON risk_events (store_id, status, severity, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_risk_events_actor
  ON risk_events (store_id, actor_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_risk_events_shift
  ON risk_events (store_id, shift_id);

-- ── 3d. tenant_tax_settings (migration 050) ───────────────────────────
CREATE TABLE IF NOT EXISTS tenant_tax_settings (
  store_id           UUID PRIMARY KEY REFERENCES stores(id) ON DELETE CASCADE,
  tax_number         TEXT NOT NULL DEFAULT '',
  istd_client_id     TEXT NOT NULL DEFAULT '',
  istd_client_secret TEXT NOT NULL DEFAULT '',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE tenant_tax_settings ENABLE ROW LEVEL SECURITY;
CREATE OR REPLACE FUNCTION touch_tenant_tax_settings_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, extensions
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_touch_tenant_tax_settings ON tenant_tax_settings;
CREATE TRIGGER trg_touch_tenant_tax_settings
BEFORE UPDATE ON tenant_tax_settings
FOR EACH ROW EXECUTE FUNCTION touch_tenant_tax_settings_updated_at();

-- ── 3e. shortage_flags (migration 057 — the table that failed v1) ─────
CREATE TABLE IF NOT EXISTS shortage_flags (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id        UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  product_id      TEXT NOT NULL,
  product_name    TEXT NOT NULL DEFAULT '',
  current_stock   NUMERIC(14,3) NOT NULL DEFAULT 0,
  reason          TEXT,
  cashier_id      UUID REFERENCES cashiers(id) ON DELETE SET NULL,
  cashier_name    TEXT NOT NULL DEFAULT '',
  branch_id       UUID REFERENCES branches(id) ON DELETE SET NULL,
  terminal_id     UUID REFERENCES terminals(id) ON DELETE SET NULL,
  source_event_id UUID REFERENCES sync_events(sync_id) ON DELETE RESTRICT,
  resolved        BOOLEAN NOT NULL DEFAULT FALSE,
  resolved_by     TEXT,
  resolved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_event_id),
  CHECK (current_stock >= 0)
);
CREATE INDEX IF NOT EXISTS idx_shortage_flags_store_created
  ON shortage_flags (store_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shortage_flags_store_open
  ON shortage_flags (store_id, resolved, created_at DESC);

-- ── 3f. product_variants (migrations 059/062/067/070, final shape) ────
CREATE TABLE IF NOT EXISTS product_variants (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id    UUID REFERENCES products(id) ON DELETE CASCADE,
  store_id      UUID REFERENCES stores(id),
  barcode       TEXT NOT NULL,
  variant_label VARCHAR(120) NOT NULL DEFAULT '',
  total_stock   DECIMAL(14,3) NOT NULL DEFAULT 0,
  cost_price       NUMERIC(12,3) DEFAULT 0,
  selling_price    NUMERIC(12,3) DEFAULT 0,
  wholesale_price  NUMERIC(12,3) DEFAULT 0,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Repair legacy/partial shapes:
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS product_id UUID REFERENCES products(id) ON DELETE CASCADE;
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS store_id UUID REFERENCES stores(id);
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS barcode TEXT;
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS variant_label VARCHAR(120) NOT NULL DEFAULT '';
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS total_stock DECIMAL(14,3) NOT NULL DEFAULT 0;
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS cost_price NUMERIC(12,3) DEFAULT 0;
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS selling_price NUMERIC(12,3) DEFAULT 0;
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS wholesale_price NUMERIC(12,3) DEFAULT 0;
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
-- Unique constraints are added separately because legacy rows may need care:
CREATE UNIQUE INDEX IF NOT EXISTS uq_pv_store_barcode
  ON product_variants (store_id, barcode);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pv_product_label
  ON product_variants (store_id, product_id, lower(variant_label));
CREATE INDEX IF NOT EXISTS idx_pv_store         ON product_variants(store_id);
CREATE INDEX IF NOT EXISTS idx_pv_product       ON product_variants(product_id);
CREATE INDEX IF NOT EXISTS idx_pv_active        ON product_variants(product_id) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_pv_store_product ON product_variants(store_id, product_id, is_active);

-- ── 3g. print_jobs (migration 060 base + 068 extensions) ──────────────
CREATE TABLE IF NOT EXISTS print_jobs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id    UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL DEFAULT 'BARCODE_LABEL',
  status      TEXT NOT NULL DEFAULT 'QUEUED'
              CHECK (status IN ('QUEUED', 'CLAIMED', 'PRINTED', 'FAILED')),
  payload     JSONB NOT NULL,
  priority    INTEGER NOT NULL DEFAULT 0 CHECK (priority >= 0),
  attempts    INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_worker TEXT,
  source_event_id UUID,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at  TIMESTAMPTZ,
  printed_at  TIMESTAMPTZ,
  expires_at  TIMESTAMPTZ NOT NULL DEFAULT now() + interval '24 hours'
);
CREATE INDEX IF NOT EXISTS idx_print_jobs_claim
  ON print_jobs (store_id, status, priority DESC, created_at);
CREATE INDEX IF NOT EXISTS idx_print_jobs_purge
  ON print_jobs (status, expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_print_jobs_source_event
  ON print_jobs (source_event_id);
-- 068 receipt/report printing extensions:
ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS printer_kind TEXT;
ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS rendered_html TEXT;
ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS terminal_id UUID REFERENCES terminals(id);
ALTER TABLE print_jobs DROP CONSTRAINT IF EXISTS print_jobs_kind_check;
ALTER TABLE print_jobs
  ADD CONSTRAINT print_jobs_kind_check
  CHECK (kind IN ('BARCODE_LABEL', 'RECEIPT', 'Z_REPORT', 'X_REPORT', 'INVOICE'));
ALTER TABLE print_jobs DROP CONSTRAINT IF EXISTS print_jobs_printer_kind_check;
ALTER TABLE print_jobs
  ADD CONSTRAINT print_jobs_printer_kind_check
  CHECK (printer_kind IS NULL OR printer_kind IN ('THERMAL', 'A4', 'LABEL'));
CREATE INDEX IF NOT EXISTS idx_print_jobs_terminal
  ON print_jobs (terminal_id, status, created_at)
  WHERE terminal_id IS NOT NULL;

-- ── 3h. print_server_configs (never had a migration — pure drift) ─────
CREATE TABLE IF NOT EXISTS print_server_configs (
  store_id   UUID PRIMARY KEY REFERENCES stores(id) ON DELETE CASCADE,
  endpoint   TEXT,
  token      TEXT,
  enabled    BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────────
-- SECTION 4 — SECURITY DEFINER RPCs called directly by the browser app.
-- Bodies copied verbatim from migrations 046/047/060/061/068.
-- ─────────────────────────────────────────────────────────────────────

-- ── 4a. JSONB coercion helpers (required by 4b/4c) ────────────────────
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

-- ── 4b. shift_reports immutability guard (final 047 version) ──────────
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

DROP TRIGGER IF EXISTS trg_protect_shift_report_financials ON shift_reports;
CREATE TRIGGER trg_protect_shift_report_financials
  BEFORE UPDATE ON shift_reports
  FOR EACH ROW EXECUTE FUNCTION protect_shift_report_financials();

-- Historical Z-event backfill (idempotent, guarded).
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

-- Backfill cash-variance risk signals from the reports above.
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

-- Final audit-log action vocabulary (046 ∪ 047).
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

-- ── 4c. approve_shift_variance (046 verbatim) ─────────────────────────
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

-- ── 4d. review_risk_event (046 verbatim) ──────────────────────────────
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

-- ── 4e. resolve_stale_shift (047 verbatim) ────────────────────────────
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

-- ── 4f. claim_print_job (060 + 068 merged, corrected) ─────────────────
-- NOTE: migration 068 as shipped renamed p_timeout_seconds out of its
-- signature while its body still referenced it — that definition can never
-- be created with check_function_bodies enabled. This is the corrected
-- union of both shipped versions: stale-claim requeue + attempts cap +
-- optional terminal filter.
DROP FUNCTION IF EXISTS claim_print_job(UUID, TEXT, INTEGER, INTEGER);
DROP FUNCTION IF EXISTS claim_print_job(UUID, TEXT, UUID, INTEGER);
CREATE OR REPLACE FUNCTION claim_print_job(
  p_store_id        uuid,
  p_worker_id       text DEFAULT 'print-server',
  p_terminal_id     uuid DEFAULT NULL,
  p_timeout_seconds int DEFAULT 120,
  p_max_attempts    int DEFAULT 8
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_job jsonb;
BEGIN
  -- Requeue stale CLAIMED jobs
  UPDATE print_jobs
     SET status = 'QUEUED', claimed_at = NULL
   WHERE store_id = p_store_id
     AND status = 'CLAIMED'
     AND claimed_at < now() - make_interval(secs => p_timeout_seconds);

  -- Fail jobs that exceeded max attempts
  UPDATE print_jobs
     SET status = 'FAILED'
   WHERE store_id = p_store_id
     AND status = 'QUEUED'
     AND attempts >= p_max_attempts;

  -- Claim the oldest eligible job (optionally filtered by terminal)
  SELECT to_jsonb(pj.*) INTO v_job
    FROM print_jobs pj
   WHERE pj.store_id = p_store_id
     AND pj.status = 'QUEUED'
     AND (p_terminal_id IS NULL OR pj.terminal_id = p_terminal_id OR pj.terminal_id IS NULL)
   ORDER BY pj.priority DESC, pj.created_at ASC
   LIMIT 1
   FOR UPDATE SKIP LOCKED;

  IF v_job IS NULL THEN
    RETURN NULL;
  END IF;

  UPDATE print_jobs
     SET status = 'CLAIMED',
         last_worker = p_worker_id,
         attempts = attempts + 1,
         claimed_at = now()
   WHERE id = (v_job->>'id')::uuid;

  RETURN v_job;
END;
$$;

-- ── 4g. resolve_print_job (060 verbatim) ──────────────────────────────
CREATE OR REPLACE FUNCTION resolve_print_job(
  p_store_id uuid,
  p_job_id uuid,
  p_printed boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_status text;
BEGIN
  UPDATE print_jobs
  SET status = CASE WHEN p_printed THEN 'PRINTED' ELSE 'FAILED' END,
      printed_at = CASE WHEN p_printed THEN now() ELSE printed_at END
  WHERE id = p_job_id
    AND store_id = p_store_id
    AND status = 'CLAIMED'
  RETURNING status INTO v_status;

  IF v_status IS NULL THEN
    RETURN jsonb_build_object('ok', false);
  END IF;
  RETURN jsonb_build_object('ok', true, 'status', v_status);
END;
$$;

-- ── 4h. merge_into_variant_parent (061 verbatim) ──────────────────────
CREATE OR REPLACE FUNCTION merge_into_variant_parent(
  p_store_id uuid,
  p_parent_name text,
  p_base_cost numeric DEFAULT NULL,
  p_base_price numeric DEFAULT NULL,
  p_child_ids uuid[] DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_parent_name text;
  v_parent_id uuid;
  v_template products%ROWTYPE;
  v_child products%ROWTYPE;
  v_child_ids uuid[];
  v_label text;
  v_candidate text;
  v_seen text[] := '{}';
  v_suffix integer;
  v_labels jsonb := '[]'::jsonb;
  v_children integer := 0;
  v_bad integer;
  v_common integer;
  v_i integer;
BEGIN
  v_parent_name := trim(COALESCE(p_parent_name, ''));
  IF v_parent_name = '' THEN
    RAISE EXCEPTION 'parent_name_required' USING ERRCODE = '22023';
  END IF;
  IF length(v_parent_name) > 255 THEN
    RAISE EXCEPTION 'parent_name_too_long' USING ERRCODE = '22023';
  END IF;
  IF p_child_ids IS NULL OR cardinality(p_child_ids) = 0 THEN
    RAISE EXCEPTION 'children_required' USING ERRCODE = '22023';
  END IF;
  IF cardinality(p_child_ids) > 30 THEN
    RAISE EXCEPTION 'too_many_children' USING ERRCODE = '22023';
  END IF;
  IF p_base_cost IS NOT NULL AND p_base_cost < 0 THEN
    RAISE EXCEPTION 'invalid_base_cost' USING ERRCODE = '22023';
  END IF;
  IF p_base_price IS NOT NULL AND p_base_price < 0 THEN
    RAISE EXCEPTION 'invalid_base_price' USING ERRCODE = '22023';
  END IF;

  SELECT ARRAY(SELECT DISTINCT id FROM unnest(p_child_ids) AS t(id)) INTO v_child_ids;

  SELECT count(*) INTO v_bad
  FROM unnest(v_child_ids) AS cid
  LEFT JOIN products p ON p.id = cid AND p.store_id = p_store_id
  WHERE p.id IS NULL;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'child_not_found' USING ERRCODE = '22023';
  END IF;

  SELECT count(*) INTO v_bad
  FROM products
  WHERE store_id = p_store_id AND id = ANY(v_child_ids)
    AND (parent_id IS NOT NULL OR is_variant_root);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'child_is_variant' USING ERRCODE = '22023';
  END IF;

  SELECT count(*) INTO v_bad
  FROM products
  WHERE store_id = p_store_id AND parent_id = ANY(v_child_ids);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'child_has_children' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_template
  FROM products
  WHERE store_id = p_store_id AND id = ANY(v_child_ids)
  ORDER BY name ASC
  LIMIT 1;

  INSERT INTO products (
    store_id, category_id, brand_id, default_supplier_id,
    name, base_unit, total_stock, is_quick_key,
    tax_percent, tax_included, is_active, show_in_pos,
    is_sellable, is_purchasable, allow_price_change,
    reorder_level, parent_id, variant_label, is_variant_root
  ) VALUES (
    p_store_id, v_template.category_id, v_template.brand_id, v_template.default_supplier_id,
    v_parent_name, v_template.base_unit, 0, false,
    v_template.tax_percent, v_template.tax_included, v_template.is_active, v_template.show_in_pos,
    v_template.is_sellable, v_template.is_purchasable, v_template.allow_price_change,
    v_template.reorder_level, NULL, '', true
  ) RETURNING id INTO v_parent_id;

  FOR v_child IN
    SELECT * FROM products WHERE store_id = p_store_id AND id = ANY(v_child_ids) ORDER BY name ASC
  LOOP
    v_common := 0;
    IF starts_with(lower(v_child.name), lower(v_parent_name)) THEN
      v_common := length(v_parent_name);
    ELSE
      FOR v_i IN 1..least(length(v_child.name), length(v_parent_name)) LOOP
        IF lower(substr(v_child.name, v_i, 1)) = lower(substr(v_parent_name, v_i, 1)) THEN
          v_common := v_i;
        ELSE
          EXIT;
        END IF;
      END LOOP;
      WHILE v_common > 0 AND substr(v_child.name, v_common, 1) <> ' ' LOOP
        v_common := v_common - 1;
      END LOOP;
    END IF;
    v_label := trim(both ' ' from substr(v_child.name, v_common + 1));

    IF v_label = '' THEN
      v_label := v_child.name;
    END IF;
    IF length(v_label) > 112 THEN
      v_label := left(v_label, 112);
    END IF;

    v_suffix := 2;
    v_candidate := v_label;
    WHILE v_seen @> ARRAY[v_candidate] LOOP
      v_candidate := v_label || ' (' || v_suffix::text || ')';
      v_suffix := v_suffix + 1;
    END LOOP;
    v_label := v_candidate;
    v_seen := v_seen || v_label;

    UPDATE products
    SET parent_id = v_parent_id, variant_label = v_label, is_variant_root = false
    WHERE id = v_child.id AND store_id = p_store_id;

    IF p_base_cost IS NOT NULL THEN
      UPDATE product_barcodes SET cost_price = round(p_base_cost, 2)
      WHERE product_id = v_child.id AND store_id = p_store_id;
    END IF;
    IF p_base_price IS NOT NULL THEN
      UPDATE product_barcodes SET selling_price = round(p_base_price, 2)
      WHERE product_id = v_child.id AND store_id = p_store_id;
    END IF;

    v_labels := v_labels || jsonb_build_object(
      'id', v_child.id,
      'name', v_child.name,
      'label', v_label
    );
    v_children := v_children + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'parentId', v_parent_id,
    'parentName', v_parent_name,
    'childCount', v_children,
    'labels', v_labels
  );
END;
$$;

-- ── 4i. authenticate_admin_client (069 verbatim) ──────────────────────
-- The client-safe admin gate for the static export: SECURITY DEFINER,
-- verifies bcrypt internally, returns NULL on mismatch.
CREATE OR REPLACE FUNCTION authenticate_admin_client(
  p_email    text,
  p_password text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_store_id       uuid;
  v_cashier_id     uuid;
  v_cashier_name   text;
  v_cashier_role   text;
  v_cashier_email  text;
  v_result         jsonb;
BEGIN
  SELECT c.store_id, c.id, c.name, c.role, c.email
    INTO v_store_id, v_cashier_id, v_cashier_name, v_cashier_role, v_cashier_email
  FROM cashiers c
  JOIN stores s ON s.id = c.store_id
  WHERE lower(c.email) = lower(p_email)
    AND c.role = 'admin'
    AND c.email IS NOT NULL
    AND c.password_hash IS NOT NULL
    AND c.password_hash = crypt(p_password, c.password_hash)
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT jsonb_build_object(
    'store_id', s.id,
    'cashier', jsonb_build_object(
      'id', v_cashier_id, 'name', v_cashier_name, 'role', v_cashier_role, 'email', v_cashier_email
    ),
    'store', jsonb_build_object(
      'id',                  s.id,
      'code',                s.code,
      'name',                s.name,
      'owner_name',          s.owner_name,
      'email',               s.email,
      'phone',               s.phone,
      'logo_url',            s.logo_url,
      'address',             s.address,
      'receipt_header',      s.receipt_header,
      'receipt_footer',      s.receipt_footer,
      'loyalty_enabled',     s.loyalty_enabled,
      'points_per_spend',    s.points_per_spend,
      'point_value',         s.point_value,
      'tax_percent',         s.tax_percent,
      'tax_number',          s.tax_number,
      'receipt_show_tax_number',     s.receipt_show_tax_number,
      'receipt_show_cashier_time',   s.receipt_show_cashier_time,
      'receipt_show_barcode_qr',     s.receipt_show_barcode_qr,
      'receipt_compact_spacing',     s.receipt_compact_spacing,
      'subscription_status', s.subscription_status
    ),
    'branches', coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', b.id, 'name', b.name) ORDER BY b.created_at)
      FROM branches b WHERE b.store_id = s.id
    ), '[]'::jsonb),
    'terminals', coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', t.id, 'branch_id', t.branch_id, 'name', t.name) ORDER BY t.created_at)
      FROM terminals t JOIN branches b ON t.branch_id = b.id WHERE b.store_id = s.id
    ), '[]'::jsonb)
  ) INTO v_result
  FROM stores s
  WHERE s.id = v_store_id;

  RETURN v_result;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────
-- SECTION 5 — RLS policies for browser-managed tables
-- PostgreSQL has no CREATE OR REPLACE POLICY: DROP IF EXISTS + CREATE.
-- ─────────────────────────────────────────────────────────────────────

-- print_templates (042 enabled RLS with zero policies -> symptom #2)
DROP POLICY IF EXISTS p_print_templates_select ON print_templates;
DROP POLICY IF EXISTS p_print_templates_insert ON print_templates;
DROP POLICY IF EXISTS p_print_templates_update ON print_templates;
DROP POLICY IF EXISTS p_print_templates_delete ON print_templates;
CREATE POLICY p_print_templates_select ON print_templates
  FOR SELECT TO anon, authenticated
  USING (true);
CREATE POLICY p_print_templates_insert ON print_templates
  FOR INSERT TO anon, authenticated
  WITH CHECK (store_id IS NOT NULL);
CREATE POLICY p_print_templates_update ON print_templates
  FOR UPDATE TO anon, authenticated
  USING (true)
  WITH CHECK (true);
CREATE POLICY p_print_templates_delete ON print_templates
  FOR DELETE TO anon, authenticated
  USING (true);

-- tenant_tax_settings (050 enabled RLS with zero policies)
DROP POLICY IF EXISTS p_tenant_tax_select ON tenant_tax_settings;
DROP POLICY IF EXISTS p_tenant_tax_insert ON tenant_tax_settings;
DROP POLICY IF EXISTS p_tenant_tax_update ON tenant_tax_settings;
CREATE POLICY p_tenant_tax_select ON tenant_tax_settings
  FOR SELECT TO anon, authenticated
  USING (true);
CREATE POLICY p_tenant_tax_insert ON tenant_tax_settings
  FOR INSERT TO anon, authenticated
  WITH CHECK (store_id IS NOT NULL);
CREATE POLICY p_tenant_tax_update ON tenant_tax_settings
  FOR UPDATE TO anon, authenticated
  USING (true)
  WITH CHECK (true);

-- ─────────────────────────────────────────────────────────────────────
-- SECTION 6 — Grant matrix completion (browser roles)
-- Re-applies both 071 files verbatim (idempotent) then extends to every
-- table lib/*Client.ts touches. Read-only where the client only reads.
-- ─────────────────────────────────────────────────────────────────────

-- 6a. Staff login path (071_grant_anon_browser_access)
GRANT SELECT ON TABLE stores        TO anon, authenticated;
GRANT SELECT ON TABLE cashiers      TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE cashiers TO anon, authenticated;
GRANT SELECT ON TABLE staff_roles   TO anon, authenticated;
GRANT SELECT ON TABLE branches      TO anon, authenticated;
GRANT SELECT ON TABLE terminals     TO anon, authenticated;

-- 6b. Admin dashboard / reports engine (071_grant_anon_reports_read)
GRANT SELECT ON TABLE products            TO anon, authenticated;
GRANT SELECT ON TABLE product_variants    TO anon, authenticated;
GRANT SELECT ON TABLE sync_events         TO anon, authenticated;
GRANT SELECT ON TABLE sales_invoices      TO anon, authenticated;
GRANT SELECT ON TABLE sales_invoice_items TO anon, authenticated;

-- 6c. Catalog management (071_grant_anon_browser_access)
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE categories    TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE product_brands TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE suppliers     TO anon, authenticated;

-- 6d. Inventory movements page (read-only) + audit inserts
GRANT SELECT ON TABLE inventory_movements TO anon, authenticated;
GRANT INSERT ON TABLE admin_audit_logs    TO anon, authenticated;

-- 6e. Catalog writes (inventory page create/edit/merge flows)
GRANT INSERT, UPDATE, DELETE ON TABLE products         TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE product_variants TO anon, authenticated;

-- 6f. Branches & terminals management (branchesClient)
GRANT INSERT, UPDATE, DELETE ON TABLE branches  TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE terminals TO anon, authenticated;

-- 6g. Store branding / logo / super-admin updates
GRANT UPDATE ON TABLE stores TO anon, authenticated;

-- 6h. Customers, debts & loyalty
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE customers             TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE customer_transactions TO anon, authenticated;
GRANT SELECT, INSERT ON TABLE              loyalty_events           TO anon, authenticated;

-- 6i. Expenses
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE expenses TO anon, authenticated;

-- 6j. Purchasing (completes symptom #1 end-to-end)
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE purchase_orders      TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE purchase_order_items TO anon, authenticated;

-- 6k. Supplier invoices / payments (accounts payable pages)
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE supplier_invoices      TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE supplier_invoice_items TO anon, authenticated;
GRANT SELECT, INSERT                  ON TABLE supplier_payments     TO anon, authenticated;

-- 6l. Shortages & shifts (admin readers/writers)
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE shortage_flags TO anon, authenticated;
GRANT SELECT ON TABLE                 shift_reports          TO anon, authenticated;

-- 6m. Risk engine (read-only from browser)
GRANT SELECT ON TABLE risk_events TO anon, authenticated;

-- 6n. Tax settings (usable thanks to Section 5 policies)
GRANT SELECT, INSERT, UPDATE ON TABLE tenant_tax_settings TO anon, authenticated;

-- 6o. Print studio & kiosk config (resolves symptom #2)
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE print_templates      TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE          ON TABLE print_server_configs TO anon, authenticated;

-- 6p. EXECUTE on browser-called SECURITY DEFINER RPCs
-- (mirrors shipped precedent: 014 already grants delete_store /
--  update_admin_credentials to anon+authenticated; those functions verify
--  credentials internally.)
GRANT EXECUTE ON FUNCTION approve_shift_variance(uuid, uuid, uuid, text, text)
  TO anon, authenticated;
GRANT EXECUTE ON FUNCTION review_risk_event(uuid, uuid, text, uuid, text, text)
  TO anon, authenticated;
GRANT EXECUTE ON FUNCTION resolve_stale_shift(uuid, uuid, numeric, uuid, text, text)
  TO anon, authenticated;
GRANT EXECUTE ON FUNCTION claim_print_job(uuid, text, uuid, integer, integer)
  TO anon, authenticated;
GRANT EXECUTE ON FUNCTION resolve_print_job(uuid, uuid, boolean)
  TO anon, authenticated;
GRANT EXECUTE ON FUNCTION merge_into_variant_parent(uuid, text, numeric, numeric, uuid[])
  TO anon, authenticated;
GRANT EXECUTE ON FUNCTION authenticate_admin_client(text, text)
  TO anon, authenticated;

COMMIT;

-- ─────────────────────────────────────────────────────────────────────
-- SECTION 7 — Post-flight verification (optional; one result tab each)
-- ─────────────────────────────────────────────────────────────────────

-- 7.1 Every table the browser needs must now exist:
SELECT t.table_name
FROM unnest(ARRAY[
  'stores','branches','terminals','cashiers','staff_roles','categories',
  'product_brands','products','product_variants','suppliers',
  'supplier_invoices','supplier_invoice_items','supplier_payments',
  'purchase_orders','purchase_order_items','customers',
  'customer_transactions','loyalty_events','expenses','inventory_movements',
  'sales_invoices','sales_invoice_items','sync_events','shortage_flags',
  'shift_reports','risk_events','admin_audit_logs','tenant_tax_settings',
  'print_templates','print_jobs','print_server_configs'
]) AS t(table_name)
LEFT JOIN information_schema.tables i
  ON i.table_schema = 'public' AND i.table_name = t.table_name
WHERE i.table_name IS NULL;
-- Expected result: 0 rows.

-- 7.2 Drift columns present:
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'purchase_orders'
  AND column_name IN ('order_number','paid_amount','notes','expected_date')
ORDER BY column_name;

-- 7.3 Policies registered:
SELECT tablename, policyname, cmd
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('print_templates','tenant_tax_settings')
ORDER BY tablename, policyname;

-- 7.4 Browser RPCs executable:
SELECT p.proname
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('approve_shift_variance','review_risk_event',
                    'resolve_stale_shift','claim_print_job','resolve_print_job',
                    'merge_into_variant_parent','authenticate_admin_client');
-- Expected result: 7 rows.

-- ─────────────────────────────────────────────────────────────────────
-- SECTION 8 — Refresh PostgREST cache (required after DDL)
-- ─────────────────────────────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';
