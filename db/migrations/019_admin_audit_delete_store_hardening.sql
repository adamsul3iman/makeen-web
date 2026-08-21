-- 019_admin_audit_delete_store_hardening.sql
-- Keep admin_audit_logs append-only for normal app paths, while allowing the
-- token-gated platform delete_store RPC to atomically remove a tenant and its
-- audit rows. Also aligns the DB CHECK constraint with the app's audit types.

ALTER TABLE admin_audit_logs
  DROP CONSTRAINT IF EXISTS admin_audit_logs_action_type_check;

ALTER TABLE admin_audit_logs
  ADD CONSTRAINT admin_audit_logs_action_type_check
  CHECK (
    action_type IN (
      'OVERRIDE_PRICE',
      'CANCEL_INVOICE',
      'OPEN_DRAWER',
      'SAVE_CASHIER',
      'DELETE_CASHIER',
      'ENTER_RETURN_MODE'
    )
  );

CREATE OR REPLACE FUNCTION prevent_admin_audit_mutation()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('app.allow_audit_log_delete', true) = 'on' THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'admin_audit_logs is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION delete_store(p_store_id uuid, p_token text) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_deleted integer := 0;
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

  PERFORM set_config('app.allow_audit_log_delete', 'on', true);
  DELETE FROM admin_audit_logs       WHERE store_id = p_store_id;
  PERFORM set_config('app.allow_audit_log_delete', 'off', true);

  DELETE FROM customers              WHERE store_id = p_store_id;
  DELETE FROM purchase_orders        WHERE store_id = p_store_id;
  DELETE FROM products               WHERE store_id = p_store_id;
  DELETE FROM categories             WHERE store_id = p_store_id;
  DELETE FROM suppliers              WHERE store_id = p_store_id;
  DELETE FROM cashiers               WHERE store_id = p_store_id;
  DELETE FROM branches               WHERE store_id = p_store_id;
  DELETE FROM stores                 WHERE id = p_store_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  RETURN v_deleted > 0;
END;
$$;

GRANT EXECUTE ON FUNCTION delete_store(uuid, text) TO anon, authenticated;
