-- 098_allow_save_print_template_rpc.sql
-- The Print Studio save path (lib/printClient.savePrintTemplate) must be able to
-- call the atomic save_print_template RPC (043) so that making a template the
-- default for its kind atomically clears the previous default inside one
-- transaction. Without this, the browser client writes to print_templates
-- directly and collides with the partial unique index
-- uq_print_templates_default_kind -> a 409 whenever a second default is saved
-- for the same (store_id, kind).
--
-- 043 granted EXECUTE only to service_role; the browser client authenticates as
-- 'authenticated' (anon for pre-auth preview), so grant it here too.

SET search_path = public, extensions;

GRANT EXECUTE ON FUNCTION save_print_template(uuid, uuid, text, text, boolean, jsonb)
  TO anon, authenticated;

-- Allow the atomic RPC to also be reflected in the audit trail the same way the
-- legacy API route did (the browser path previously skipped auditing entirely).
GRANT SELECT, INSERT ON TABLE admin_audit_logs TO authenticated;
