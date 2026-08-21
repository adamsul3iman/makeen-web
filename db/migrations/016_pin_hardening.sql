-- 016_pin_hardening.sql
-- Harden the cashier PIN scheme (F3).
--
-- The old scheme derived the salt deterministically from the store id
-- (`sha256("pos:pin-salt:"+storeId)[:16]`) and shipped `sha256(pin + salt)`
-- for every cashier in the catalog snapshot. Because the salt was a public
-- constant, an attacker who knew a store id could precompute the entire
-- 10,000-PIN space offline, and because every cashier shared the same salt a
-- single brute-force table covered the whole roster.
--
-- This migration makes the salt random per cashier (16 random bytes) and
-- stores the precomputed hash `sha256(pin + salt)` so the plaintext PIN never
-- needs to leave the cashier-management form:
--
--   1) new `pin_salt` (random) + `pin_hash` (sha256) columns;
--   2) existing rows are backfilled with a fresh random salt and hash;
--   3) `pin` becomes nullable so new writes can stop storing plaintext;
--   4) `provision_new_store` seeds the admin with a random salt + hash only.
--
-- The device-side lockout (escalating cooldown after consecutive failures) is
-- enforced in the store, since the offline register must still unlock without
-- a network round-trip.

SET search_path = public, extensions;

ALTER TABLE cashiers ADD COLUMN IF NOT EXISTS pin_salt TEXT;
ALTER TABLE cashiers ADD COLUMN IF NOT EXISTS pin_hash  TEXT;

-- Backfill: give every legacy row a fresh random salt, then hash whatever
-- plaintext PIN it still carries. Rows without a PIN stay hash-less.
UPDATE cashiers SET pin_salt = encode(gen_random_bytes(16), 'hex')
  WHERE pin_salt IS NULL OR pin_salt = '';

UPDATE cashiers SET pin_hash = encode(digest(pin || pin_salt, 'sha256'), 'hex')
  WHERE pin_hash IS NULL AND pin IS NOT NULL;

-- New rows omit the plaintext `pin` entirely; NULL is now allowed.
ALTER TABLE cashiers ALTER COLUMN pin DROP NOT NULL;

-- Re-seed provisioning so a fresh store's admin cashier only ever holds a
-- random salt + hash. Signature + token gate unchanged (matches 015).
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
  v_pin_salt  text;
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

  v_pin_salt := encode(gen_random_bytes(16), 'hex');

  INSERT INTO cashiers (name, role, store_id, email, password_hash, pin_salt, pin_hash)
  VALUES (
    'مدير النظام',
    'admin',
    v_store_id,
    lower(trim(p_email)),
    crypt(p_password, gen_salt('bf', 12)),
    v_pin_salt,
    encode(digest('1234' || v_pin_salt, 'sha256'), 'hex')
  );

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
