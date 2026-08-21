-- 049_mobile_inventory_clerk.sql
-- Mobile product-add workflow.
--
--   1) Every store gains a short human-friendly `code` used by the mobile
--      login (/api/login/mobile) to bind a phone to a tenant without leaking
--      the SaaS tenant list. Existing stores are backfilled with a random
--      6-character uppercase code; new stores get one from provision_new_store.
--   2) A narrow `inventory_clerk` role (capability `catalog.add` only) is
--      seeded for every store so staff can scan + create products from the
--      camera page without POS sales screens, back office, or financial data.

CREATE OR REPLACE FUNCTION generate_store_code()
RETURNS text
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_code text;
BEGIN
  LOOP
    v_code := upper(substr(md5(gen_random_uuid()::text), 1, 6));
    EXIT WHEN NOT EXISTS (SELECT 1 FROM stores WHERE code = v_code);
  END LOOP;
  RETURN v_code;
END;
$$;

ALTER TABLE stores ADD COLUMN IF NOT EXISTS code TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_stores_code
  ON stores (code) WHERE code IS NOT NULL;

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT id FROM stores WHERE code IS NULL OR code = '' LOOP
    UPDATE stores SET code = generate_store_code() WHERE id = r.id;
  END LOOP;
END $$;

ALTER TABLE stores ALTER COLUMN code SET NOT NULL;

-- Re-provision future stores with a code. Body mirrors 035 with `code` added.
CREATE OR REPLACE FUNCTION provision_new_store(
  p_name       text,
  p_owner_name text,
  p_email      text,
  p_phone      text,
  p_password   text,
  p_token      text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_store_id  uuid;
  v_branch_id uuid;
  v_owner_name text;
BEGIN
  IF p_token IS NULL OR p_token <> (SELECT value FROM platform_secrets WHERE name = 'ops_token') THEN
    RAISE EXCEPTION 'permission_denied' USING ERRCODE = '42501';
  END IF;

  IF p_email IS NULL OR trim(p_email) = '' THEN
    RAISE EXCEPTION 'invalid_email_format' USING ERRCODE = '22023';
  END IF;
  IF lower(trim(p_email)) !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' THEN
    RAISE EXCEPTION 'invalid_email_format' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM cashiers WHERE email = lower(trim(p_email)) AND email IS NOT NULL) THEN
    RAISE EXCEPTION 'email_already_registered' USING ERRCODE = '23505';
  END IF;

  v_owner_name := coalesce(nullif(trim(p_owner_name), ''), 'مالك المتجر');

  INSERT INTO stores (name, owner_name, email, phone, subscription_status, tax_percent, code)
  VALUES (p_name, v_owner_name, lower(trim(p_email)), p_phone, 'active', 16, generate_store_code())
  RETURNING id INTO v_store_id;

  INSERT INTO cashiers (name, role, store_id, email, password_hash)
  VALUES (v_owner_name, 'admin', v_store_id, lower(trim(p_email)), crypt(p_password, gen_salt('bf', 12)));

  INSERT INTO branches (store_id, name)
  VALUES (v_store_id, 'الفرع الرئيسي')
  RETURNING id INTO v_branch_id;

  INSERT INTO terminals (branch_id, name)
  VALUES (v_branch_id, 'نقطة البيع 1');

  RETURN (
    SELECT jsonb_build_object(
      'id',                        id,
      'code',                      code,
      'name',                      name,
      'owner_name',                owner_name,
      'email',                     email,
      'phone',                     phone,
      'logo_url',                  logo_url,
      'address',                   address,
      'receipt_header',            receipt_header,
      'receipt_footer',            receipt_footer,
      'loyalty_enabled',           loyalty_enabled,
      'points_per_spend',          points_per_spend,
      'point_value',               point_value,
      'tax_percent',               tax_percent,
      'tax_number',                tax_number,
      'receipt_show_tax_number',   receipt_show_tax_number,
      'receipt_show_cashier_time', receipt_show_cashier_time,
      'receipt_show_barcode_qr',   receipt_show_barcode_qr,
      'receipt_compact_spacing',   receipt_compact_spacing,
      'subscription_status',       subscription_status,
      'created_at',                created_at
    )
    FROM stores
    WHERE id = v_store_id
  );
END;
$$;

GRANT EXECUTE ON FUNCTION provision_new_store(text, text, text, text, text, text) TO anon, authenticated;

-- Dashboard login snapshot carries the store code too.
CREATE OR REPLACE FUNCTION authenticate_admin(
  p_email    text,
  p_password text,
  p_token    text
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
  IF p_token IS NULL OR p_token <> (SELECT value FROM platform_secrets WHERE name = 'ops_token') THEN
    RAISE EXCEPTION 'permission_denied' USING ERRCODE = '42501';
  END IF;

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
      'id',                        s.id,
      'code',                      s.code,
      'name',                      s.name,
      'owner_name',                s.owner_name,
      'email',                     s.email,
      'phone',                     s.phone,
      'logo_url',                  s.logo_url,
      'address',                   s.address,
      'receipt_header',            s.receipt_header,
      'receipt_footer',            s.receipt_footer,
      'loyalty_enabled',           s.loyalty_enabled,
      'points_per_spend',          s.points_per_spend,
      'point_value',               s.point_value,
      'tax_percent',               s.tax_percent,
      'tax_number',                s.tax_number,
      'receipt_show_tax_number',   s.receipt_show_tax_number,
      'receipt_show_cashier_time', s.receipt_show_cashier_time,
      'receipt_show_barcode_qr',   s.receipt_show_barcode_qr,
      'receipt_compact_spacing',   s.receipt_compact_spacing,
      'subscription_status',       s.subscription_status
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

GRANT EXECUTE ON FUNCTION authenticate_admin(text, text, text) TO anon, authenticated;

-- inventory_clerk: camera-only product creation. No POS, no back office, no
-- reports — just catalog.add on top of a signed device session.
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
    (p_store_id, 'inventory_clerk', 'أمين مخزون',
      'إضافة المنتجات عبر الكاميرا من الموبايل فقط — دون نقطة البيع أو التقارير المالية.',
      ARRAY['catalog.add'],
      '{"maxDiscountPercent":0,"maxRefundAmount":0,"maxPriceReductionPercent":0,"maxCashVarianceWithoutApproval":0}'::jsonb,
      TRUE, 35),
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

GRANT EXECUTE ON FUNCTION seed_default_staff_roles(UUID) TO service_role;
