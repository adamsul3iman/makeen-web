-- 076_stop_the_bleeding_lockdown.sql
-- P0 stop-the-bleeding from NIGHT_AUDIT_REPORT §2/§9 (items 4+5), restricted
-- to changes that CANNOT break a running register. Everything here is
-- idempotent and safe to replay.
--
-- What is deliberately NOT in this file (would brick live features because
-- every browser call executes as `anon` — the app has no Supabase Auth):
--   * REVOKE anon DML on cashiers (F-01): staff management CRUD
--     (lib/staffClient.ts, store/usePosStore.saveCashier/deleteCashier)
--     writes cashiers directly as anon. Locking it requires the Phase B
--   * tenant_tax_settings lockdown (F-04): both the settings UI
--     (lib/settingsClient.ts) and the ISTD clearance push
--     (lib/istdIntegration.ts) read istd_client_secret client-side.
--   These ship with the P2 package: real Supabase Auth + SECURITY DEFINER
--   staff/tax RPCs + claim-based RLS (report §9 P2).
--
-- What IS here:
--   1. F-05: backfill pin_hash for any legacy row still carrying plaintext,
--      then DROP the plaintext `pin` column. Backfill formula is byte-exact
--      with 016 (`encode(digest(pin || pin_salt,'sha256'),'hex')`) and with
--      the browser verifier sha256(pin + salt), so logins keep working.
--   2. stores: strip cross-tenant UPDATE surface down to the profile columns
--      the app actually writes (settingsClient tax_number, printClient
--      logo_url). Blocks anonymous subscription_status flips (§2.1).
--   3. shift_reports / customer_transactions: revoke DELETE — no live browser
--      code deletes rows there (verified by repo grep); this closes audit-
--      trail erasure and debt-ledger erasure vectors.
--
-- Requires pgcrypto (digest/gen_random_bytes), as used since 016.

SET search_path = public, extensions;

BEGIN;

-- ---------------------------------------------------------------- 1. PIN ---
-- Give every hash-less legacy row a salt (if missing) then hash exactly like
-- the client fallback did. Rows with neither pin nor pin_hash are untouched
-- (they simply cannot authenticate — same as before).
UPDATE cashiers
SET pin_salt = encode(gen_random_bytes(16), 'hex')
WHERE (pin_salt IS NULL OR pin_salt = '')
  AND pin_hash IS NULL
  AND pin IS NOT NULL;

UPDATE cashiers
SET pin_hash = encode(digest(pin || pin_salt, 'sha256'), 'hex')
WHERE pin_hash IS NULL AND pin IS NOT NULL;

ALTER TABLE cashiers DROP COLUMN IF EXISTS pin;

-- ------------------------------------------------------------- 2. stores ---
REVOKE UPDATE ON TABLE stores FROM anon;
GRANT UPDATE (
  name, owner_name, email, phone, logo_url, address,
  receipt_header, receipt_footer, tax_number
) ON stores TO anon;

-- ------------------------------------------- 3. ledger / audit immutability --
REVOKE DELETE ON TABLE shift_reports FROM anon;
REVOKE DELETE ON TABLE customer_transactions FROM anon;

COMMIT;
