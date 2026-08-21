-- 035_receipt_layout_customization.sql
-- Store Settings -> Receipt Customization: merchants can now show/hide the
-- tax number, the cashier name + exact timestamp, and the footer barcode /
-- fiscal QR, and switch between standard and compact vertical spacing on the
-- 80mm thermal receipt.

SET search_path = public, extensions;

ALTER TABLE stores ADD COLUMN IF NOT EXISTS receipt_show_tax_number    BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS receipt_show_cashier_time BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS receipt_show_barcode_qr   BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS receipt_compact_spacing   BOOLEAN NOT NULL DEFAULT FALSE;

-- Keep the provisioning RPCs (register + super-admin store creation) in step
-- so a brand-new tenant snapshot already carries the four layout flags.
-- Body mirrors 020_default_jordan_tax.sql with the new columns appended.
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

  INSERT INTO stores (name, owner_name, email, phone, subscription_status, tax_percent)
  VALUES (p_name, v_owner_name, lower(trim(p_email)), p_phone, 'active', 16)
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

-- Dashboard login snapshot. Body mirrors 015_rpc_ops_token_gate.sql with the
-- layout flags appended to the store block.
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
