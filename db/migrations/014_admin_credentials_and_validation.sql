-- 014_admin_credentials_and_validation.sql
-- Close the store→admin→staff loop gaps found in the QA review:
--
--   1) UNIQUE email across ALL stores. The legacy uq_cashiers_store_email was
--      per-(store_id, email), so a duplicate owner email silently created a
--      SECOND store and authenticate_admin() picked one arbitrarily (LIMIT 1).
--      The new global unique index makes the register/stores 409 path real.
--
--   2) provision_new_store() now validates the owner email (format + not
--      already taken) INSIDE the function, so direct RPC callers get the same
--      friendly errors the routes return, not raw SQL constraint text.
--
--   3) update_admin_credentials() — the first ever way to change an admin
--      email/password. Verifies the CURRENT password, then updates the cashier
--      row and keeps stores.email in sync (single source of truth).
--
--   4) delete_store() — atomic tenant deletion (ordered children-first inside
--      one transaction), backing the new super-admin DELETE endpoint.

-- 1) One dashboard account per email across the whole platform.
CREATE UNIQUE INDEX IF NOT EXISTS uq_cashiers_email
  ON cashiers (email) WHERE email IS NOT NULL;

-- 2) Provisioning with email validation + friendly duplicate detection.
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
  VALUES ('مدير النظام', '1234', 'admin', v_store_id, lower(trim(p_email)), crypt(p_password, gen_salt('bf')));

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

-- 3) Change the admin's own email and/or password after verifying the current
--    password. Returns NULL when the current credentials are wrong, raises a
--    friendly errcode on invalid/duplicate new values.
CREATE OR REPLACE FUNCTION update_admin_credentials(
  p_current_email    text,
  p_current_password text,
  p_new_email        text,
  p_new_password     text
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
    v_new_hash := crypt(p_new_password, gen_salt('bf'));
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

-- 4) Atomic tenant deletion: children-first so the FK chain never blocks.
CREATE OR REPLACE FUNCTION delete_store(p_store_id uuid) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
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

GRANT EXECUTE ON FUNCTION update_admin_credentials(text, text, text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION delete_store(uuid) TO anon, authenticated;
