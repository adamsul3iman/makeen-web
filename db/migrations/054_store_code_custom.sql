-- 054_store_code_custom.sql
-- Custom store codes for the Super Admin console.
--
-- The platform admin can now optionally type a short human-friendly store
-- code (e.g. BURJ, AMMAN1) when provisioning a store instead of receiving the
-- random 6-character code generated in the background. The code is what
-- cashiers and inventory clerks type on the login screen, so it must stay
-- strictly alphanumeric, 4-12 characters (matching /api/login), and unique
-- across the platform.
--
-- Blank / null keeps the automatic generation; a provided code is validated
-- and uniqueness-checked inside the atomic provisioning function (the partial
-- unique index catches any race anyway).

SET search_path = public, extensions;

-- Normalize any legacy lowercase codes, then hard-enforce the login-friendly
-- format at the column level (generated codes are already 6-char uppercase).
UPDATE stores SET code = upper(code)
  WHERE code IS NOT NULL AND (code <> upper(code) OR code !~ '^[A-Z0-9]{4,12}$');

ALTER TABLE stores
  DROP CONSTRAINT IF EXISTS chk_stores_code_format;

ALTER TABLE stores
  ADD CONSTRAINT chk_stores_code_format
  CHECK (code ~ '^[A-Z0-9]{4,12}$');

-- Replace the 6-arg provisioner with one that accepts an optional custom code
-- (7th argument) so the route no longer needs to call a separate API.
DROP FUNCTION IF EXISTS provision_new_store(text, text, text, text, text, text);

CREATE OR REPLACE FUNCTION provision_new_store(
  p_name       text,
  p_owner_name text,
  p_email      text,
  p_phone      text,
  p_password   text,
  p_code       text,
  p_token      text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_store_id   uuid;
  v_branch_id  uuid;
  v_owner_name text;
  v_username   text;
  v_code       text;
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

  v_code := upper(coalesce(nullif(trim(p_code), ''), ''));
  IF v_code <> '' THEN
    IF v_code !~ '^[A-Z0-9]{4,12}$' THEN
      RAISE EXCEPTION 'invalid_store_code' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM stores WHERE code = v_code) THEN
      RAISE EXCEPTION 'store_code_already_used' USING ERRCODE = '23505';
    END IF;
  ELSE
    v_code := generate_store_code();
  END IF;

  v_owner_name := coalesce(nullif(trim(p_owner_name), ''), 'مالك المتجر');
  v_username := lower(
    regexp_replace(split_part(lower(trim(p_email)), '@', 1), '[^[:alnum:]_\-. ]', '', 'g')
  );

  INSERT INTO stores (name, owner_name, email, phone, subscription_status, tax_percent, code)
  VALUES (p_name, v_owner_name, lower(trim(p_email)), p_phone, 'active', 16, v_code)
  RETURNING id INTO v_store_id;

  INSERT INTO cashiers (name, role, store_id, email, password_hash, username)
  VALUES (v_owner_name, 'admin', v_store_id, lower(trim(p_email)), crypt(p_password, gen_salt('bf', 12)), v_username);

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

GRANT EXECUTE ON FUNCTION provision_new_store(text, text, text, text, text, text, text) TO anon, authenticated;
