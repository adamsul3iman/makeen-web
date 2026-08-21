-- 018_owner_account_name.sql
-- The owner account is the person who runs one store — NOT the platform's
-- "مدير النظام" console role. Migration 017 seeded every owner row with the
-- hard-coded display name 'مدير النظام', which made the POS admin-mode badge
-- read "وضع المدير • مدير النظام" and blurred the line between a store owner
-- and the /super-admin platform operator.
--
-- This migration:
--   1) re-creates `provision_new_store` so future owner rows are named after
--      the store's actual owner (p_owner_name), falling back to 'مالك المتجر';
--   2) re-labels existing owner rows that still carry the generic 'مدير النظام'
--      name to the store's real owner_name (fallback 'مالك المتجر').
--
-- The `super_admins` console row (separate table, PIN 7777) is untouched.

SET search_path = public, extensions;

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

  INSERT INTO stores (name, owner_name, email, phone, subscription_status)
  VALUES (p_name, p_owner_name, lower(trim(p_email)), p_phone, 'active')
  RETURNING id INTO v_store_id;

  -- Owner account: dashboard credentials only — NO pin_salt / pin_hash.
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
      'subscription_status', subscription_status,
      'created_at',          created_at
    )
    FROM stores
    WHERE id = v_store_id
  );
END;
$$;

-- Re-label existing owner rows away from the generic 'مدير النظام' title.
UPDATE cashiers c
SET name = coalesce(nullif(trim(s.owner_name), ''), 'مالك المتجر')
FROM stores s
WHERE c.store_id = s.id
  AND c.role IN ('admin', 'مدير')
  AND (c.name = 'مدير النظام' OR c.name IS NULL OR trim(c.name) = '');

GRANT EXECUTE ON FUNCTION provision_new_store(text, text, text, text, text, text) TO anon, authenticated;
