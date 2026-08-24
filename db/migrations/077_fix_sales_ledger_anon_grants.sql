-- 077_fix_sales_ledger_anon_grants.sql
-- Corrective follow-up to 075 (REG-R1, NIGHT_AUDIT_REPORT §1).
--
-- 075 was applied to production on 2026-08-23 granting EXECUTE on the
-- sales-ledger reporting RPCs to `authenticated` ONLY. That is dead-on-arrival:
-- the app performs NO Supabase Auth sign-in anywhere (admin login is a custom
-- bcrypt check into localStorage; lib/supabaseBrowser.ts ships the anon key
-- only), so every PostgREST call executes as `anon`. Result: all three RPCs
-- return permission-denied and the admin Sales Ledger renders its error banner.
--
-- This migration restores the pre-041 posture: EXECUTE for both roles.
-- Applied migrations are immutable; 075 is left untouched in history.
--
-- Trust-model note (deliberate, matches the rest of the browser surface):
-- these SECURITY DEFINER functions still trust the caller-supplied p_store_id.
-- Caller→store membership assertions inside the functions are a P2 item,
-- landing together with real auth sessions + staged RLS (report §9 P2).
--
-- Idempotent: re-granting is a no-op if run twice. Safe on any replica that
-- already has 075 applied.
--
-- Capacitor note: pure role grants — no platform-specific behavior; identical
-- access from Electron static export and future iOS/Android builds.

BEGIN;

GRANT EXECUTE ON FUNCTION list_sales_ledger(
  uuid, timestamptz, timestamptz, uuid, uuid, uuid, text, text, text, integer, integer
) TO anon, authenticated;

GRANT EXECUTE ON FUNCTION sales_ledger_summary(
  uuid, timestamptz, timestamptz, uuid, uuid, uuid, text, text, text
) TO anon, authenticated;

GRANT EXECUTE ON FUNCTION sales_ledger_quality(
  uuid, timestamptz, timestamptz, uuid, uuid, uuid, text, text, text
) TO anon, authenticated;

COMMIT;
