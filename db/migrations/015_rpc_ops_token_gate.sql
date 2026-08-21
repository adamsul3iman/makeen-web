-- 015_rpc_ops_token_gate.sql
-- Close the "privileged RPC callable by anon" hole (F1).
--
-- The app's server-side supabase client uses the PUBLIC anon key, and every
-- function below was granted EXECUTE to anon/authenticated (functions also
-- default to PUBLIC EXECUTE). That made them callable directly through the
-- public PostgREST endpoint — anyone could `delete_store(uuid)` (wipe a
-- tenant), `provision_new_store(...)` (spam stores), brute-force
-- `authenticate_admin(email,password)` (no rate limit), or hammer
-- `update_admin_credentials` — completely bypassing the Next.js gates
-- (super-admin PIN, admin password, rate limiting).
--
-- Fix: every privileged function now requires a server-only token in its
-- signature. The Next.js routes hold the token in PLATFORM_OPS_SECRET (never
-- shipped to the browser) and pass it as the final parameter; direct PostgREST
-- callers cannot, so they get SQLSTATE 42501 (insufficient_privilege).
-- The token itself lives in `platform_secrets`, which is locked down below.
--
-- NOTE: the {{PLATFORM_OPS_SECRET}} placeholder is substituted by
-- db/migrate.mjs from the PLATFORM_OPS_SECRET env var at apply time, so the
-- real secret is never written into this file.

-- The server-only secret store. No RLS is configured anywhere in this schema,
-- but a brand-new table grants nothing to PUBLIC by default; we still revoke
-- explicitly so the token can never leak through /rest/v1/platform_secrets.
CREATE TABLE IF NOT EXISTS platform_secrets (
  name  TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

REVOKE ALL ON TABLE platform_secrets FROM PUBLIC, anon, authenticated;

INSERT INTO platform_secrets (name, value)
VALUES ('ops_token', '{{PLATFORM_OPS_SECRET}}')
ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value;

-- Drop every pre-token signature so no overload without the token survives.
DROP FUNCTION IF EXISTS provision_new_store(text, text, text, text);
DROP FUNCTION IF EXISTS provision_new_store(text, text, text, text, text);
DROP FUNCTION IF EXISTS authenticate_admin(text, text);
DROP FUNCTION IF EXISTS update_admin_credentials(text, text, text, text);
DROP FUNCTION IF EXISTS delete_store(uuid);

-- 1) Provisioning, now token-gated (body identical to 014).
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

  INSERT INTO cashiers (name, pin, role, store_id, email, password_hash)
  VALUES ('مدير النظام', '1234', 'admin', v_store_id, lower(trim(p_email)), crypt(p_password, gen_salt('bf', 12)));

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

-- 2) Dashboard authentication, token-gated (body identical to 012).
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

-- 3) Credential changes, token-gated (body identical to 014, plus bcrypt cost 12).
CREATE OR REPLACE FUNCTION update_admin_credentials(
  p_current_email    text,
  p_current_password text,
  p_new_email        text,
  p_new_password     text,
  p_token            text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_cashier_id uuid;
  v_store_id   uuid;
  v_new_email  text;
  v_new_hash   text;
  v_email_out  text;
BEGIN
  IF p_token IS NULL OR p_token <> (SELECT value FROM platform_secrets WHERE name = 'ops_token') THEN
    RAISE EXCEPTION 'permission_denied' USING ERRCODE = '42501';
  END IF;

  SELECT c.id, c.store_id INTO v_cashier_id, v_store_id
  FROM cashiers c
  WHERE lower(c.email) = lower(trim(p_current_email))
    AND c.role = 'admin'
    AND c.email IS NOT NULL
    AND c.password_hash IS NOT NULL
    AND c.password_hash = crypt(p_current_password, c.password_hash)
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF p_new_email IS NOT NULL AND length(trim(p_new_email)) > 0 THEN
    v_new_email := lower(trim(p_new_email));
    IF v_new_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' THEN
      RAISE EXCEPTION 'invalid_email_format' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM cashiers WHERE email = v_new_email AND email IS NOT NULL AND id <> v_cashier_id) THEN
      RAISE EXCEPTION 'email_already_registered' USING ERRCODE = '23505';
    END IF;
  ELSE
    v_new_email := NULL;
  END IF;

  IF p_new_password IS NOT NULL AND length(p_new_password) > 0 THEN
    IF length(p_new_password) < 8 THEN
      RAISE EXCEPTION 'password_too_short' USING ERRCODE = '22023';
    END IF;
    v_new_hash := crypt(p_new_password, gen_salt('bf', 12));
  ELSE
    v_new_hash := NULL;
  END IF;

  UPDATE cashiers c SET
    email         = coalesce(v_new_email, c.email),
    password_hash = coalesce(v_new_hash, c.password_hash)
  WHERE c.id = v_cashier_id;

  IF v_new_email IS NOT NULL THEN
    UPDATE stores SET email = v_new_email WHERE id = v_store_id;
  END IF;

  SELECT email INTO v_email_out FROM cashiers WHERE id = v_cashier_id;

  RETURN jsonb_build_object('email', v_email_out);
END;
$$;

-- 4) Atomic tenant deletion, token-gated (body identical to 014).
CREATE OR REPLACE FUNCTION delete_store(p_store_id uuid, p_token text) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  IF p_token IS NULL OR p_token <> (SELECT value FROM platform_secrets WHERE name = 'ops_token') THEN
    RAISE EXCEPTION 'permission_denied' USING ERRCODE = '42501';
  END IF;

  DELETE FROM customer_transactions WHERE store_id = p_store_id;
  DELETE FROM purchase_order_items   WHERE store_id = p_store_id;
  DELETE FROM product_barcodes       WHERE store_id = p_store_id;
  DELETE FROM loyalty_events         WHERE store_id = p_store_id;
  DELETE FROM expenses               WHERE store_id = p_store_id;
  DELETE FROM sync_events            WHERE store_id = p_store_id;
  DELETE FROM terminals              WHERE branch_id IN (SELECT id FROM branches WHERE store_id = p_store_id);
  DELETE FROM admin_audit_logs       WHERE store_id = p_store_id;
  DELETE FROM customers              WHERE store_id = p_store_id;
  DELETE FROM purchase_orders        WHERE store_id = p_store_id;
  DELETE FROM products               WHERE store_id = p_store_id;
  DELETE FROM categories             WHERE store_id = p_store_id;
  DELETE FROM suppliers              WHERE store_id = p_store_id;
  DELETE FROM cashiers               WHERE store_id = p_store_id;
  DELETE FROM branches               WHERE store_id = p_store_id;
  DELETE FROM stores                 WHERE id = p_store_id;
  RETURN FOUND;
END;
$$;

-- The token param is only ever supplied by the server routes, which hold the
-- token in env. anon/authenticated keep EXECUTE so the existing server client
-- (anon key) keeps working — the token is the actual gate.
GRANT EXECUTE ON FUNCTION provision_new_store(text, text, text, text, text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION authenticate_admin(text, text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION update_admin_credentials(text, text, text, text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION delete_store(uuid, text) TO anon, authenticated;
