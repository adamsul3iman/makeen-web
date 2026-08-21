-- 020_default_jordan_tax.sql
-- Jordan deployment default: stores are taxable at 16% unless the owner
-- explicitly opts out later from Store Settings.

SET search_path = public, extensions;

ALTER TABLE stores
  ALTER COLUMN tax_percent SET DEFAULT 16;

-- Existing tenant rows created after 009 inherited the old default 0. The
-- product brief for this deployment is Jordan VAT 16%, so bring unconfigured
-- stores back to the launch default. Owners can still set 0 intentionally in
-- Settings if a store is genuinely tax-free.
UPDATE stores
SET tax_percent = 16
WHERE tax_percent = 0;

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
      'id',                  id,
      'name',                name,
      'owner_name',          owner_name,
      'email',               email,
      'phone',               phone,
      'logo_url',            logo_url,
      'address',             address,
      'receipt_header',      receipt_header,
      'receipt_footer',      receipt_footer,
      'loyalty_enabled',     loyalty_enabled,
      'points_per_spend',    points_per_spend,
      'point_value',         point_value,
      'tax_percent',         tax_percent,
      'tax_number',          tax_number,
      'subscription_status', subscription_status,
      'created_at',          created_at
    )
    FROM stores
    WHERE id = v_store_id
  );
END;
$$;

GRANT EXECUTE ON FUNCTION provision_new_store(text, text, text, text, text, text) TO anon, authenticated;
