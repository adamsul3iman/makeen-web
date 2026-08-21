-- 043_atomic_print_templates_audit.sql
-- Make default-template replacement atomic and audit every print-design change.

SET search_path = public, extensions;

ALTER TABLE admin_audit_logs DROP CONSTRAINT IF EXISTS admin_audit_logs_action_type_check;
ALTER TABLE admin_audit_logs ADD CONSTRAINT admin_audit_logs_action_type_check
  CHECK (action_type IN (
    'OVERRIDE_PRICE', 'CANCEL_INVOICE', 'OPEN_DRAWER', 'SAVE_CASHIER',
    'DELETE_CASHIER', 'ENTER_RETURN_MODE', 'ADJUST_STOCK',
    'CREATE_SUPPLIER_INVOICE', 'RECORD_SUPPLIER_PAYMENT',
    'SHIFT_VARIANCE', 'SAVE_PRINT_TEMPLATE', 'DELETE_PRINT_TEMPLATE',
    'UPDATE_RECEIPT_LOGO'
  ));

CREATE OR REPLACE FUNCTION save_print_template(
  p_store_id uuid,
  p_id uuid,
  p_kind text,
  p_name text,
  p_is_default boolean,
  p_config jsonb
) RETURNS print_templates
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_row print_templates;
  v_existing print_templates;
BEGIN
  IF p_kind NOT IN ('RECEIPT', 'BARCODE_LABEL') THEN
    RAISE EXCEPTION 'invalid_template_kind' USING ERRCODE = '22023';
  END IF;
  IF char_length(trim(coalesce(p_name, ''))) NOT BETWEEN 1 AND 80 THEN
    RAISE EXCEPTION 'invalid_template_name' USING ERRCODE = '22023';
  END IF;

  IF p_id IS NOT NULL THEN
    SELECT * INTO v_existing
      FROM print_templates
     WHERE id = p_id AND store_id = p_store_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'template_not_found' USING ERRCODE = 'P0002';
    END IF;
    p_kind := v_existing.kind;
    IF v_existing.is_default AND NOT p_is_default THEN
      RAISE EXCEPTION 'default_template_required' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF p_is_default THEN
    UPDATE print_templates
       SET is_default = FALSE
     WHERE store_id = p_store_id
       AND kind = p_kind
       AND (p_id IS NULL OR id <> p_id);
  END IF;

  IF p_id IS NULL THEN
    INSERT INTO print_templates(store_id, kind, name, is_default, config)
    VALUES (p_store_id, p_kind, trim(p_name), p_is_default, coalesce(p_config, '{}'::jsonb))
    RETURNING * INTO v_row;
  ELSE
    UPDATE print_templates
       SET name = trim(p_name),
           is_default = p_is_default,
           config = coalesce(p_config, '{}'::jsonb)
     WHERE id = p_id AND store_id = p_store_id
    RETURNING * INTO v_row;
  END IF;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION save_print_template(uuid, uuid, text, text, boolean, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION save_print_template(uuid, uuid, text, text, boolean, jsonb) TO service_role;
