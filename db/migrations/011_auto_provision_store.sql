-- 011_auto_provision_store.sql
-- Per-store cashier PINs + atomic store provisioning.
--
-- 1) The cashiers table carries a GLOBAL UNIQUE on pin (legacy single-store
--    design from migration 003). In a multi-tenant system that forbids two
--    stores from both using the default admin PIN (1234). Replace it with a
--    per-store unique (store_id, pin) so every tenant can own PIN 1234.
--
-- 2) provision_new_store() inserts a store and its default admin cashier,
--    main branch and first terminal inside ONE transaction, so a store
--    provisioned from the super-admin portal is immediately login-able.

ALTER TABLE cashiers DROP CONSTRAINT IF EXISTS cashiers_pin_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_cashiers_store_pin ON cashiers (store_id, pin);

CREATE OR REPLACE FUNCTION provision_new_store(
  p_name       text,
  p_owner_name text,
  p_email      text,
  p_phone      text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_store_id  uuid;
  v_branch_id uuid;
BEGIN
  INSERT INTO stores (name, owner_name, email, phone, subscription_status)
  VALUES (p_name, p_owner_name, p_email, p_phone, 'active')
  RETURNING id INTO v_store_id;

  INSERT INTO cashiers (name, pin, role, store_id)
  VALUES ('مدير النظام', '1234', 'admin', v_store_id);

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

GRANT EXECUTE ON FUNCTION provision_new_store(text, text, text, text) TO anon, authenticated;
