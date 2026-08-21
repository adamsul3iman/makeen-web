-- 052_staff_username.sql
-- Username-based staff login (unified /login).
--
-- The unified sign-in page authenticates every staff member (cashier,
-- inventory clerk, accountant, ...) with a store code + a short username +
-- PIN instead of a raw tenant id + PIN. Owners keep their email + password
-- dashboard login; migration 017's `chk_owner_has_no_pin` invariant is
-- untouched, so an owner never holds PIN material.
--
--   1) Add `cashiers.username`, backfill it from the display name for every
--      existing row (unique per store), then enforce NOT NULL.
--   2) A per-store unique index on lower(username) keeps sign-in lookup cheap
--      and unambiguous (Arabic names are preserved verbatim).
--   3) `provision_new_store` seeds the owner's username from the email local
--      part so a freshly provisioned store can sign in immediately.
--
-- Backfill notes: usernames are case-insensitive within a store. Duplicate
-- display names get a numeric suffix (ahmed, ahmed-2, ...). Non-word
-- characters are stripped; a fully-stripped name falls back to `user`.

SET search_path = public, extensions;

ALTER TABLE cashiers ADD COLUMN IF NOT EXISTS username TEXT;

DO $$
DECLARE
  r RECORD;
  v_base   text;
  v_uname  text;
  v_n      int;
BEGIN
  FOR r IN
    SELECT c.id, c.store_id, c.name
    FROM cashiers c
    WHERE c.username IS NULL OR trim(c.username) = ''
    ORDER BY c.store_id, c.id
  LOOP
    v_base := lower(
      coalesce(
        nullif(trim(regexp_replace(coalesce(r.name, ''), '[^[:alnum:]_\-. ]', '', 'g')), ''),
        'user'
      )
    );
    v_uname := v_base;
    v_n := 1;
    WHILE EXISTS (
      SELECT 1 FROM cashiers c
      WHERE c.store_id = r.store_id
        AND lower(c.username) = lower(v_uname)
        AND c.id <> r.id
    ) LOOP
      v_n := v_n + 1;
      v_uname := v_base || '-' || v_n;
    END LOOP;
    UPDATE cashiers SET username = v_uname WHERE id = r.id;
  END LOOP;
END $$;

ALTER TABLE cashiers ALTER COLUMN username SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_cashiers_username_per_store
  ON cashiers (store_id, lower(username));

-- Future stores: the owner signs in on the dashboard with email + password,
-- but staff may also refer to the owner's username. Derive it from the email
-- local part so it is stable and human-friendly.
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
  v_username   text;
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
  v_username := lower(
    regexp_replace(split_part(lower(trim(p_email)), '@', 1), '[^[:alnum:]_\-. ]', '', 'g')
  );

  INSERT INTO stores (name, owner_name, email, phone, subscription_status, tax_percent, code)
  VALUES (p_name, v_owner_name, lower(trim(p_email)), p_phone, 'active', 16, generate_store_code())
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

GRANT EXECUTE ON FUNCTION provision_new_store(text, text, text, text, text, text) TO anon, authenticated;
