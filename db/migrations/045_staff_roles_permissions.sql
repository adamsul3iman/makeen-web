-- 045_staff_roles_permissions.sql
-- Tenant-scoped RBAC foundation. The owner remains an email/password admin;
-- PIN employees receive a role whose capabilities are cached for offline POS
-- use and re-checked from the database by protected server routes.

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

SELECT seed_default_staff_roles(id) FROM stores;

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

ALTER TABLE cashiers ADD COLUMN IF NOT EXISTS role_id UUID;

UPDATE cashiers c
SET role_id = r.id,
    role = r.code
FROM staff_roles r
WHERE c.store_id = r.store_id
  AND c.role NOT IN ('admin', 'مدير')
  AND r.code = CASE
    WHEN c.role IN ('accountant', 'محاسب') THEN 'accountant'
    WHEN c.role IN ('inventory_manager', 'مسؤول مخزون') THEN 'inventory_manager'
    WHEN c.role IN ('store_manager', 'مدير متجر') THEN 'store_manager'
    WHEN c.role IN ('senior_cashier', 'كاشير أول') THEN 'senior_cashier'
    ELSE 'cashier'
  END;

ALTER TABLE cashiers DROP CONSTRAINT IF EXISTS fk_cashiers_staff_role_tenant;
ALTER TABLE cashiers
  ADD CONSTRAINT fk_cashiers_staff_role_tenant
  FOREIGN KEY (role_id, store_id)
  REFERENCES staff_roles(id, store_id)
  ON DELETE RESTRICT;

ALTER TABLE cashiers DROP CONSTRAINT IF EXISTS ck_cashiers_owner_or_staff_role;
ALTER TABLE cashiers
  ADD CONSTRAINT ck_cashiers_owner_or_staff_role
  CHECK (
    (role IN ('admin', 'مدير') AND role_id IS NULL)
    OR
    (role NOT IN ('admin', 'مدير') AND role_id IS NOT NULL)
  );

REVOKE ALL ON TABLE staff_roles FROM anon, authenticated;
GRANT ALL ON TABLE staff_roles TO service_role;
GRANT EXECUTE ON FUNCTION seed_default_staff_roles(UUID) TO service_role;
