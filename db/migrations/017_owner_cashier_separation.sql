-- 017_owner_cashier_separation.sql
-- Full owner / cashier separation (approved design).
--
-- Before this migration a store's owner account was ALSO a PIN carrier: the
-- owner lived in `cashiers` with role 'admin', email + password_hash for the
-- dashboard, AND a `pin_salt`/`pin_hash` derived from the hard-coded default
-- '1234' (migration 016). That meant the store owner could unlock a register
-- with a shared default PIN, and (legacy) plain cashiers could carry
-- dashboard credentials.
--
-- After this migration the split is absolute and enforced in the database:
--
--   1) `provision_new_store` seeds the owner row with email + password_hash
--      and NO PIN material — a fresh store's owner can never PIN-login.
--   2) existing owner rows are stripped of all PIN material (the live default
--      '1234' disappears for every store provisioned before this migration).
--   3) cashier (non-owner) rows are stripped of email/password_hash so only
--      the owner holds dashboard credentials.
--   4) CHECK constraints encode both invariants so no future code path can
--      re-create a mixed account: an owner has no PIN, a cashier has no
--      credentials.
--
-- The dashboard `/api/admin/login` continues to authenticate the owner with
-- email + password (RPC `authenticate_admin`), and `/api/login` now matches
-- cashier rows only. Nothing else in the schema changes.

SET search_path = public, extensions;

-- (1) Provisioning: the owner account is email/password only.
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

  INSERT INTO stores (name, owner_name, email, phone, subscription_status)
  VALUES (p_name, p_owner_name, lower(trim(p_email)), p_phone, 'active')
  RETURNING id INTO v_store_id;

  -- Owner account: dashboard credentials only — NO pin_salt / pin_hash.
  INSERT INTO cashiers (name, role, store_id, email, password_hash)
  VALUES ('مدير النظام', 'admin', v_store_id, lower(trim(p_email)), crypt(p_password, gen_salt('bf', 12)));

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

-- (2) Owners stop carrying any PIN material (incl. the legacy default '1234').
UPDATE cashiers
SET pin = NULL, pin_salt = NULL, pin_hash = NULL
WHERE role IN ('admin', 'مدير');

-- (3) Cashiers stop carrying dashboard credentials.
UPDATE cashiers
SET email = NULL, password_hash = NULL
WHERE role NOT IN ('admin', 'مدير');

-- (4) Enforce the split so a mixed account can never be created again.
ALTER TABLE cashiers
  DROP CONSTRAINT IF EXISTS chk_owner_has_no_pin,
  ADD CONSTRAINT chk_owner_has_no_pin
    CHECK (role NOT IN ('admin', 'مدير') OR (pin IS NULL AND pin_salt IS NULL AND pin_hash IS NULL));

ALTER TABLE cashiers
  DROP CONSTRAINT IF EXISTS chk_cashier_has_no_credentials,
  ADD CONSTRAINT chk_cashier_has_no_credentials
    CHECK (role IN ('admin', 'مدير') OR (email IS NULL AND password_hash IS NULL));

-- SECURITY DEFINER functions are callable by PUBLIC by default, but be
-- explicit: the anon (RPC) role must be able to invoke provisioning.
GRANT EXECUTE ON FUNCTION provision_new_store(text, text, text, text, text, text) TO anon, authenticated;
