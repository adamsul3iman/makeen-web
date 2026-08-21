-- 012_admin_email_auth.sql
-- SaaS dashboard vs POS authentication split.
--
-- The legacy /login flow showed a store picker + shared PIN pad to everyone,
-- leaking the whole tenant list. This migration gives store owners a standard
-- email/password dashboard login while cashiers keep a per-store PIN that is
-- scoped to the store an admin session launched:
--
--   1) cashiers gain nullable email + password_hash (bcrypt via pgcrypto).
--   2) provision_new_store() now receives the owner email + a default
--      password and seeds the default admin with both a PIN and credentials.
--   3) authenticate_admin() verifies email/password in one call and returns
--      the full dashboard payload (store + admin + branches/terminals).
--   4) existing stores are backfilled with a dashboard admin (owner email
--      when present, else a derived address) and the documented default
--      password '12345678'.

ALTER TABLE cashiers ADD COLUMN IF NOT EXISTS email VARCHAR(255);
ALTER TABLE cashiers ADD COLUMN IF NOT EXISTS password_hash TEXT;

-- One dashboard account per store. NULL email rows (plain PIN cashiers) stay
-- unrestricted, which is why the unique index is partial.
CREATE UNIQUE INDEX IF NOT EXISTS uq_cashiers_store_email
  ON cashiers (store_id, email) WHERE email IS NOT NULL;

-- Recreate provisioning with the new signature (email + default password).
DROP FUNCTION IF EXISTS provision_new_store(text, text, text, text);

CREATE OR REPLACE FUNCTION provision_new_store(
  p_name       text,
  p_owner_name text,
  p_email      text,
  p_phone      text,
  p_password   text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_store_id  uuid;
  v_branch_id uuid;
BEGIN
  INSERT INTO stores (name, owner_name, email, phone, subscription_status)
  VALUES (p_name, p_owner_name, p_email, p_phone, 'active')
  RETURNING id INTO v_store_id;

  INSERT INTO cashiers (name, pin, role, store_id, email, password_hash)
  VALUES ('مدير النظام', '1234', 'admin', v_store_id, p_email, crypt(p_password, gen_salt('bf')));

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

-- Dashboard authentication. Returns the complete login payload for the
-- matching admin, or NULL when the credentials are invalid. The store is
-- resolved from the admin's own row — a caller can never choose a tenant.
CREATE OR REPLACE FUNCTION authenticate_admin(
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

-- Backfill: hand every existing store a dashboard admin (owner email when
-- set, else a derived address) with the documented default password, so the
-- back-office is reachable immediately after this migration ships.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT s.id AS store_id, s.email AS owner_email
    FROM stores s
    WHERE NOT EXISTS (
      SELECT 1 FROM cashiers c WHERE c.store_id = s.id AND c.email IS NOT NULL
    )
  LOOP
    UPDATE cashiers c SET
      email = CASE
        WHEN r.owner_email IS NOT NULL AND r.owner_email <> '' THEN r.owner_email
        ELSE 'admin@' || replace(r.store_id::text, '-', '') || '.pos'
      END,
      password_hash = crypt('12345678', gen_salt('bf'))
    WHERE c.store_id = r.store_id
      AND c.role = 'admin'
      AND c.email IS NULL
      AND c.id = (
        SELECT c2.id FROM cashiers c2
        WHERE c2.store_id = r.store_id AND c2.role = 'admin'
        ORDER BY c2.id LIMIT 1
      );
  END LOOP;
END $$;

GRANT EXECUTE ON FUNCTION provision_new_store(text, text, text, text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION authenticate_admin(text, text) TO anon, authenticated;
