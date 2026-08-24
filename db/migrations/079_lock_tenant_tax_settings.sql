-- 079_lock_tenant_tax_settings.sql
-- P0 remediation step 3 (SECURITY_AND_FRAUD_AUDIT F-04, roadmap step 3 of
-- REMEDIATION SESSION 1): the JoFotara device secret never reaches the client.
--
-- Problem: migration 072:1293-1299 re-opened what 050 had locked. It created
-- `USING (true)` SELECT/INSERT/UPDATE policies and granted
-- SELECT,INSERT,UPDATE to anon,authenticated on tenant_tax_settings. Since the
-- anon key ships inside the static bundle, anyone on the internet could read
-- EVERY tenant's istd_client_id + istd_client_secret (full JoFotara device
-- takeover: submit/fetch invoices under any tenant's fiscal identity).
--
-- Fix strategy (option (a), approved 2026-08-24): a Supabase Edge Function
-- (`jofotara`) holds the credentials server-side:
--   * config_get    -> masked status only (tax_number + client_id + flag);
--                      the secret NEVER leaves the function.
--   * config_save   -> requires the store admin's email+password proof via the
--                      existing authenticate_admin_client RPC; upserts with
--                      service_role.
--   * invoice_submit-> reads the tenant's credentials inside the function,
--                      exchanges them for a JoFotara JWT, submits the mapped
--                      invoice and records the outcome on istd_submissions /
--                      sales_invoices. Single-writer semantics preserved by
--                      moving the claim bookkeeping into the function.
-- The browser talks to the function with the anon key only. Direct table
-- access dies below.
--
-- Compatibility: pure PostgREST/Edge pattern — identical behaviour for the
-- Electron static export today and Capacitor (iOS/Android) later.
--
-- Requirements:
--   * 072 applied (the policies/grants being dropped exist).
--   * Edge Function deployed before this ships to clients that use JoFotara
--     (see supabase/functions/jofotara/index.ts deployment notes). Until the
--     new client build rolls out, the old settings screen loses ISTD read/
--     write — acceptable: it currently leaks every tenant's secret instead.
-- Idempotent: DROP POLICY IF EXISTS / re-grants are replay-safe.

BEGIN;

SET search_path = public, extensions;

-- ─────────────────────────────────── 1. kill the anon data-plane path ──────
DROP POLICY IF EXISTS p_tenant_tax_select ON tenant_tax_settings;
DROP POLICY IF EXISTS p_tenant_tax_insert ON tenant_tax_settings;
DROP POLICY IF EXISTS p_tenant_tax_update ON tenant_tax_settings;

REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE tenant_tax_settings
  FROM anon, authenticated;

-- Re-assert the deny-all posture from 050 (RLS enabled, zero policies for
-- anon/authenticated; service_role bypasses RLS as before).
ALTER TABLE tenant_tax_settings ENABLE ROW LEVEL SECURITY;

GRANT ALL ON TABLE tenant_tax_settings TO service_role;

COMMIT;
