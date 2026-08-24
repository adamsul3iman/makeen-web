# Security & Fraud Audit — POS (static-export browser client + Supabase)

**Date:** 2026-08-24
**Scope:** Financial math precision, checkout/idempotency double-billing safety, Supabase RLS/grant posture (`db/migrations/0*.sql`), client state-tampering surface (`store/`, `lib/idb.ts`, `services/syncService.ts`).
**Method:** Static source review only (read-only; no runtime or penetration testing). Line numbers refer to the current working tree, which contains uncommitted modifications (see `git status`).

**Remediation update (2026-08-24):** C1/C5 and NIGHT-AUDIT F-01/F-04/F-05/REG-R1 were fixed in *Remediation Session 1* (migrations `076`–`079` + the `jofotara` Edge Function; work committed through `8cc5fcc`). Closed findings carry an inline **Resolution** note, and the full closure log sits in "Remediation Session 1 — closure log" above the Appendix.

---

## Architecture context (drives every finding below)

The app is built with `output: "export"` (`next.config.*`), so **all API routes are gone** (`_legacy_api/**` is dead code; `app/api` does not exist; `proxy.ts` does not exist). The shipped artifact is pure HTML/JS that talks **directly from the browser to PostgREST using the public anon key** (`lib/supabaseBrowser.ts`). The comment in `lib/supabaseBrowser.ts` claims *"All data protection is delegated to Supabase RLS policies"* — **this is not true today**, and the gap is the root of the Critical findings.

Migration history matters:
- Migration `033` revoked all privileges from `anon`/`authenticated` (server-route era).
- Migrations **069, 071, 072, 074** re-opened broad access because the logic moved into the browser. Nothing equivalent replaced row-level isolation.

RLS is enabled on only five tables: `print_templates` (042:23), `tenant_tax_settings` (050:26, 072:317), `istd_submissions` (051:39), `cash_movements` (065:89). Every other financial table — `sales_invoices`, `sales_invoice_items`, `cashiers`, `customers`, `customer_ledger`, `sync_events`, `shift_reports`, `stores`, `products`, … — has **no RLS at all**; access is bounded only by column-level GRANTs.

The anon key is public by definition (it ships in the static bundle), so **"who can call this" is effectively everyone on the internet**. Any security property must therefore be enforced *inside the database*, not in React/Zustand code.

---

## CRITICAL

### C1. Anonymous full DML on `cashiers` — account takeover & rogue staff creation
`db/migrations/071_grant_anon_browser_access.sql:21`

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE cashiers TO anon, authenticated;
```

`cashiers` has **no RLS enabled** (grep across migrations confirms). Anyone holding the public anon key can:
- `UPDATE cashiers SET pin_hash = ..., role = 'admin' WHERE ...` — silently take over any staff/owner account in any store;
- `INSERT` a new `role='admin'` cashier for any `store_id`;
- `DELETE` staff rows;
- `SELECT` the full roster including `email`, `pin_hash`, `pin_salt`, `password_hash`.

This is a complete authentication-plane compromise, cross-tenant, with zero credentials.

**Fix:** Revoke all anon DML on `cashiers`. PIN/password verification must happen inside SECURITY DEFINER RPCs that return only safe columns (`name`, `role_id`, capabilities). Enable RLS with policies bound to an authenticated store membership.

**Resolution (Remediation Session 1, 2026-08-24): CLOSED.** Migration `078_staff_security_rpc.sql` revoked all privileges on `cashiers` from `anon`/`authenticated` and enabled RLS with **zero policies** (deny-all for client roles; service_role/definer unaffected). Staff CRUD and owner-email changes moved into SECURITY DEFINER RPCs (`admin_create/update/delete_cashier`, `admin_update_owner_email`) that re-prove the acting admin's email+password per call and throttle failures server-side (5 fails → 15 min lock via `staff_pin_throttle`). The takeover chain — self-minted `role='admin'` via direct DML — is dead: no client role can read or write the table.

### C2. No tenant isolation on the entire financial ledger — cross-store read/write for anyone
`db/migrations/074_client_sync_mirror_grants.sql:14–31`, `071_grant_anon_browser_access.sql:19–31`, `074:47–50`

Blanket grants exist on `sales_invoices`, `sales_invoice_items`, `sync_events`, `cash_movements`, `shift_reports`, `risk_events` (INSERT), `admin_audit_logs` (SELECT), `print_jobs`, plus reads on `stores`, `branches`, `terminals`, `staff_roles`, `products`, `product_variants`, `customers`-adjacent tables. With no RLS, tenancy is enforced only by **client-supplied `store_id` query parameters** (the old `x-pos-store-id` trust model from `lib/tenant.ts:11–23`, now applied by an untrusted client).

Consequences (all with just the public anon key):
- Read any store's complete transaction history, customer debt list, drawer movements.
- Insert forged invoices / cash movements / Z-reports into any store.
- Update/delete historical invoices and items (`sales_invoice_items` got INSERT **and UPDATE** at 074:16–17).

Even the one table that *does* have RLS was deliberately opened wide:

```sql
-- 074_client_sync_mirror_grants.sql:46-50
CREATE POLICY cash_movements_browser_access ON cash_movements
  FOR ALL TO anon, authenticated
  USING (true) WITH CHECK (true);
```
That is RLS theater — it filters nothing.

**Fix:** This is an architectural fork. Either (a) introduce real auth (Supabase Auth JWT per cashier/store) and rewrite every policy as `store_id = auth.jwt()->>'store_id'`, or (b) keep offline-first anon writes but funnel them through SECURITY DEFINER RPCs that validate device/session tokens issued per register and assert tenancy server-side. Row-level `USING(true)` policies must be removed either way.

### C3. SECURITY DEFINER RPCs callable by `anon` with caller-supplied tenant arguments
`db/migrations/073_customer_ledger_atomic.sql` (granted in 072 §6 / 073 tail), `072_hotfix_v010_prod_patch.sql` §6

Well-built functions are exposed to the wrong callers:
- `apply_customer_ledger_event()` (073) — correctly uses `FOR UPDATE` row locking, delta arithmetic, and the `uq_customer_tx_idempotency` unique index `(store_id, idempotency_key)`. But it takes `p_store_id`, `p_customer_id`, amounts, and an arbitrary `idempotency_key` straight from the request; nothing inside asserts the caller may act on that store. Anyone can post debt settlements/charges to **any customer of any store** and mint colliding-but-legitimate-looking idempotency keys.
- Same exposure for the supplier/inventory RPC family granted in 072 §6 (`create_supplier_invoice`, `record_supplier_payment`, `record_inventory_movement`) and the reporting RPCs later tightened by `075_sales_ledger_rpc_browser_grants.sql` (that one at least restricts to `authenticated` — which is still a self-service role when signup is open).

**Fix:** Every RPC must begin with a caller-to-store authorization check against a server-issued credential (JWT claim or register token table), e.g. `IF NOT caller_owns_store(p_store_id) THEN RAISE '42501'`. Idempotency keys should also be namespaced by the authenticated principal so they cannot be pre-computed by attackers.

### C4. Double-return / duplicate-refund is guarded only by local device state
`lib/idb.ts:654–664`, `db/migrations/021_sales_accounting_ledger.sql:46–48`

```sql
-- 021:46-48 — NOT unique:
CREATE INDEX IF NOT EXISTS idx_sales_invoices_original
  ON sales_invoices (store_id, original_invoice_sync_id)
  WHERE original_invoice_sync_id IS NOT NULL;
```

The only guard preventing two refunds against the same original invoice is `isInvoiceReturned()`, which scans **the local device's own IndexedDB queue** (`lib/idb.ts:654–664`). The DB index above is a plain index, not `CREATE UNIQUE INDEX`, so the mirror happily persists a second reversal invoice referencing the same `original_invoice_sync_id`.

Attack/failure scenarios: two registers return the same invoice before sync; a cleared browser profile re-returns a settled invoice; the owner's "fix & requeue" poison flow (`getPoisonSyncRecords`) resubmits an already-mirrored return. Each path yields duplicated cash payouts and falsified Z-variance.

**Fix:** `CREATE UNIQUE INDEX ... ON sales_invoices (store_id, original_invoice_sync_id) WHERE original_invoice_sync_id IS NOT NULL AND is_cancellation/is_return` (or a dedicated `invoice_returns` table with a unique FK), and have `syncMirror.ts` treat the resulting `23505` exactly like its existing duplicate-invoice path (backfill/skip, never error).

### C5. PIN hashing is brute-forceable, and hashes are world-readable; default admin PIN `1234`
`db/migrations/016_pin_hardening.sql:34`, `071_grant_anon_browser_access.sql:21`, `016_pin_hardening.sql:87`

- `pin_hash = sha256(pin ‖ pin_salt)` — a **single unsalted-strength iteration over a 10,000-combination space**. Per-cashier salt defeats precomputed rainbow tables but not targeted brute force: at SHA-256 speeds the whole space is exhausted in milliseconds per cashier.
- Combined with C1's anonymous `SELECT` on `cashiers`, an attacker downloads `email/pin_salt/pin_hash` for every register and recovers every staff PIN offline, then transacts as them via the login RPCs.
- `provision_new_store()` seeds the store-admin cashier with hardcoded `'1234'` (`016:87`). If anything in the product surfaces PIN login for admins, every new store ships with a known credential.
- Legacy plaintext: `pin` was made nullable in 016:38 and nulled for owners in `017_owner_cashier_separation.sql:97`, but legacy staff rows may still carry the old plaintext `pin` column value, equally readable by anonymous SELECT until verified otherwise.

**Fix:** Move PIN verification into a SECURITY DEFINER RPC using `crypt(p_pin, pin_hash)`/bcrypt or PBKDF2 ≥ 100k iterations; revoke anon SELECT on `cashiers`; force PIN rotation on first login; drop the legacy `pin` column after auditing for residual plaintext.

**Resolution (Remediation Session 1, 2026-08-24): CLOSED** (with one P2 residual). Migration `076_stop_the_bleeding_lockdown.sql` backfilled `pin_hash` for every legacy row (byte-exact with the 016 formula, so logins kept working) and **dropped the plaintext `pin` column**. `078` then eliminated anonymous roster/hash access: `verify_staff_pin` returns only safe columns plus the matched cashier's own verifier (issued post-success over TLS, so the active shift can re-unlock offline) — hash material is no longer downloadable in bulk. Residual (roadmap P2): the verifier is still `sha256(pin‖salt)`; migrate to bcrypt/PBKDF2 when the offline-unlock strategy allows, and force rotation of weak PINs.

---

## HIGH

### H1. Admin login brute-force protection is client-side only
`db/migrations/069_auth_client_rpc.sql` (header comment lines ~16–18, function ~1188+ in 072 copy)

`authenticate_admin_client(p_email, p_password)` is a tokenless SECURITY DEFINER RPC whose own migration states *"Rate limiting moves to the client side."* The in-memory lockout lives in browser JS (`useAuthStore` lockout counters) — an attacker scripting PostgREST calls bypasses it entirely and gets unlimited online bcrypt guesses against owner passwords. Passwords use bcrypt cost 12 (`016:85`), which helps, but online guessing at scale remains feasible for weak passwords.

**Fix:** Enforce failed-attempt tracking inside the RPC itself (table keyed by email + IP via `inet_client_addr()`, exponential backoff, optional CAPTCHA proxy), or front it with a real identity provider.

### H2. Session HMAC secret falls back to `DATABASE_URL`, then to ephemeral randomness
`lib/sessionCrypto.ts:21–30`

```ts
process.env.ADMIN_SESSION_SECRET ||
process.env.SESSION_SECRET ||
process.env.PLATFORM_OPS_SECRET ||
process.env.DATABASE_URL   // ← connection string as signing key
```
`DATABASE_URL` routinely leaks (error logs, support tickets, dumps). Whoever reads it can mint valid admin-session cookies for every namespace. The final fallback (random per-process) silently invalidates sessions across restarts/processes — a correctness smell that invites someone to "fix" it with something static and weaker.

**Fix:** Fail hard when `ADMIN_SESSION_SECRET` is absent in production; never chain secrets.

### H3. Loyalty points: TOCTOU races + non-atomic balance writes (client-executed)
`lib/loyalty.ts:78–109` (award), `158–210` (clawback)

Both paths do check-then-insert ("existing?" query) followed by read-modify-write of `customers.loyalty_points`:
- Award idempotency is a substring search `ilike(description, '%sync:<ref>%')` — not a constraint. Two concurrent mirrors (two tabs, two devices draining the same backlog) both pass the check → **double award**.
- Balance update `current + points` has no `FOR UPDATE`, no atomic `points = points + Δ`, no transaction → lost updates under concurrency.
- Clawback clamps at zero (`Math.max(0, …)`), so races there under-credit rather than over-credit — inconsistent with the award path.

Contrast with `apply_customer_ledger_event` (073), which does all of this correctly. Loyalty simply wasn't migrated to the RPC pattern.

**Fix:** One `award_and_settle_loyalty(store_id, customer_id, amount, reference)` SECURITY DEFINER RPC mirroring 073: unique index on `(store_id, type, reference)`, `FOR UPDATE` on the customer row, delta update.

### H4. Authorization for privileged POS actions exists only in the UI
`store/usePosStore.ts:2199, 2205, 2223` (`hasCapability(...)` gates), `lib/syncMirror.ts` handlers, `074_client_sync_mirror_grants.sql`

Debt settlement, expense recording, cash movements, shift close, cancellations — each checks `hasCapability(currentCashier, "pos.…")` in Zustand code. The server mirror and the grants accept these events from **any** origin: `risk_events` INSERT even to `anon` (074:34). A tampered client (or curl) records fake expenses/draw payouts/settlements for any store. Capability metadata itself (`staff_roles`) is anonymously readable and, via C1, writable.

**Fix:** Server-side capability assertion inside the mirror RPCs (join cashier→role→capability for the authenticated principal), reject otherwise.

### H5. Sales-invoice dedupe rests solely on the client-generated `sync_id` primary key
`lib/idb.ts:465–469` (`enqueueSync` mints/uses `sync_id`), `lib/syncMirror.ts` 23505 backfill path

Retries with the same `sync_id` are handled well (PK conflict → treat as mirrored, backfill children). But nothing constrains a **fresh** `sync_id` carrying the same business sale — e.g., a crash between enqueue and UI state persist, a manual requeue from the poison UI, or a restored-from-backup device — inserts a second identical sale. There is no unique business fingerprint (receipt sequence + terminal + timestamp bucket, or the ISTD UUID if mandatory) on `sales_invoices`.

**Fix:** Add a nullable `dedupe_key` (hash of store+terminal+seq+total+items) with a partial unique index; mirror maps 23505 → skip-with-audit like the existing path.

### H6. Anonymous access to operational telemetry
`074_client_sync_mirror_grants.sql:34–40` (+ `admin_audit_logs` SELECT at :37)

`anon` can read `admin_audit_logs` (leaks what owners investigate and when) and write unbounded `risk_events` and `print_jobs` rows (log flooding, print-server spam to kiosks). Cheap for an attacker, noisy for forensics: once writes are anonymous, audit trails can't distinguish attacker from register.

**Fix:** Restrict these to `authenticated` + RPC-mediated writes; add rate limits/quotas at the gateway.

---

## MEDIUM / WARNINGS

| # | Finding | Where |
|---|---------|-------|
| W1 | Cross-tab submit lock is broadcast-only: tabs opened *during* a submit initialize `isCompleting=false`; nothing reads `pos.is-completing` on mount | `hooks/useCrossTabSync.ts:31–59` (listener only), `store/usePosStore.ts:694–702, 1757–1758, 2032–2033` |
| W2 | `typescript.ignoreBuildErrors: true` — type errors ship in an app that computes money | `next.config.*` |
| W3 | Delivery fee is added after tax (`total = fiscal.total + fee`), so it's untaxed while appearing in the fiscal QR total — confirm this matches tax-authority treatment | `lib/saleMath.ts:190–198`, `lib/qr.ts:59–70` |
| W4 | `SYNCED` queue rows are kept forever (needed for return lookups) with no retention/compaction policy → unbounded IndexedDB growth degrades long-lived registers | `lib/idb.ts:533–548`, `listInvoices` consumer |
| W5 | `detectColumnExists` **fails open** (returns `true` on unexpected errors) — schema drift silently changes code paths | `lib/supabase.ts:44–64` |
| W6 | `deleteSyncs` exists but is intentionally unused; good (poison quarantine preserves revenue evidence) — ensure no future caller reintroduces silent drops | `lib/idb.ts:550–562` |
| W7 | `_legacy_api/**` retains service-role routes in-tree; dead today, but a future re-wiring could resurrect service-role endpoints without re-review | `_legacy_api/**`, `lib/supabase.ts:15–20` |
| W8 | `075` grants ledger-reporting RPCs to `authenticated` only — correct direction, but `authenticated` is self-service unless signup is disabled in Supabase Auth | `db/migrations/075_sales_ledger_rpc_browser_grants.sql` |

---

## What is done right (keep these patterns)

- **Money math is excellent.** Single shared rounding engine: epsilon-compensated half-up fils rounding (`roundHalfUp`), invoice discounts allocated pro-rata with largest-remainder, VAT computed **per rate-group then split across lines so Σ line.tax === group tax exactly** — no drift, no float leakage into totals (`lib/saleMath.ts` end-to-end; `computeSaleTotals:180–199`).
- **`apply_customer_ledger_event` (073)** is the gold standard in this codebase: `FOR UPDATE` locking, delta-based balances, true unique-index idempotency. Extend this pattern; don't build more check-then-write flows like loyalty.
- **Poison quarantine over deletion**: failing sync records are parked with full payload + reason (`lib/idb.ts:570–586`); network failures never age out the queue, only server-acked failures count (`lib/idb.ts:618–638`, `services/syncService.ts` thresholds).
- **Queue tenancy tagging**: every enqueue stamps `storeId` and records without it are never synced (`lib/idb.ts:465–469, 518–530`).
- **Checkout double-submit defense-in-depth**: modal disables + guards on `isCompleting` (`components/pos/CheckoutModal.tsx:153–166, 180`), store broadcasts the lock cross-tab (`store/usePosStore.ts:1757`, `hooks/useCrossTabSync.ts`).
- **Credential hygiene**: `.env*` gitignored (verified `git check-ignore`); service-role key referenced only in dead `_legacy_api`/scripts, never in the shipped bundle; passwords bcrypt(12); session verification uses `timingSafeEqual`; cookies HttpOnly/SameSite/Secure-in-prod (`lib/sessionCrypto.ts:56–105`).
- **Supplier invoice idempotency** uses a real natural key `(store_id, supplier_id, invoice_number)` unique index with 23505-aware handling (`lib/syncMirror.ts:1017–1058`).

---

## Prioritized remediation roadmap

**P0 — stop the bleeding (database-only changes, no app rewrite)**
1. ✅ **DONE (078):** `REVOKE ALL ON cashiers FROM anon` (C1) + enable RLS on `cashiers` — RLS enabled with zero policies (deny-all).
2. Make the return-guard index UNIQUE (C4) and map its 23505 in `syncMirror.ts`.
3. ✅ **DONE (076+078):** Move PIN + password verification into guarded SECURITY DEFINER RPCs; strip hash/salt columns from grants (C5, part of C1).
4. Add caller→store authorization assertions to every anon-callable RPC; namespace idempotency keys by caller (C3).
5. Replace `USING(true)` on `cash_movements` with a real policy or fold movements into an RPC (C2 minimal containment).

**P1 — structural**
6. Introduce per-register credentials (Supabase Auth JWT or device-token table) and derive all RLS policies from them; re-enable row-level security across the financial schema (C2/H4/H6).
7. Wrap loyalty award/clawback in a 073-style atomic RPC (H3).
8. Server-side login rate limiting inside `authenticate_admin_client` (H1).
9. Remove the `DATABASE_URL` secret fallback (H2).

**P2 — hygiene**
10. Business-fingerprint dedupe key on `sales_invoices` (H5).
11. Turn `ignoreBuildErrors` off; make column probes fail closed (W2, W5).
12. Retention policy for `SYNCED` queue rows (W4); confirm delivery-fee VAT treatment (W3); initialize `isCompleting` from localStorage on mount (W1); audit and null legacy plaintext `pin` values, then drop the column (C5 residue) — ✅ plaintext-`pin` portion DONE via 076 (backfilled, then column dropped).

---

## Remediation Session 1 — closure log (2026-08-24)

All four migrations were applied to production and the post-states below were confirmed by verification queries. Work is committed through `8cc5fcc`.

| Finding | Resolution | Post-state |
|---|---|---|
| REG-R1 (NIGHT_AUDIT §1) — sales-ledger RPCs dead-on-arrival after 075 | `077_fix_sales_ledger_anon_grants.sql`: EXECUTE on `list_sales_ledger` / `sales_ledger_summary` / `sales_ledger_quality` restored to `anon, authenticated` (applied migrations stay immutable; 075 left untouched in history) | Sales Ledger renders for all clients again; strategic fix (real auth sessions + membership assertions) remains a P2 item |
| C1 / F-01 — anonymous `cashiers` takeover chain | `078_staff_security_rpc.sql`: all grants revoked from `anon`/`authenticated`; RLS enabled with zero policies (deny-all); staff CRUD + owner-email change behind per-call admin-proof SECURITY DEFINER RPCs with server-side throttling (`staff_pin_throttle`, 5 fails → 15 min); PIN login via `verify_staff_pin` returning safe columns only | No client role can read or write `cashiers`; roster/hash material no longer downloadable |
| F-04 — tenant tax secrets exposed via `USING(true)` policies | `079_lock_tenant_tax_settings.sql`: the three open policies dropped, all grants revoked from `anon`/`authenticated`, RLS deny-all re-asserted. Secrets moved into the deployed `jofotara` Edge Function (`config_get` masked status only / `config_save` requires admin proof / `invoice_submit` reads credentials server-side) | **Verified:** `anon` SELECT privilege on `tenant_tax_settings` = `false`; policy count = `0`. The secret never leaves the function |
| F-05 / C5 residue — plaintext `pin` + synced hash material | `076_stop_the_bleeding_lockdown.sql`: legacy plaintext backfilled into `pin_hash` (byte-exact 016 formula), then plaintext column dropped; `078` removed bulk hash exposure | `cashiers.pin` no longer exists; only the matched cashier's own verifier is ever returned |

Client rewiring shipped with the same commit family: staff CRUD → RPCs (`lib/staffClient.ts`), settings/ISTD → edge function (`lib/settingsClient.ts`, `lib/istdIntegration.ts`, `lib/clientIstd.ts`), active-cashier offline cache (`lib/cashierSessionCache.ts`).

Still open from this report: C2/C3/C4 architectural items, H1–H6, W1–W8 — see the roadmap above.

---

## Appendix — evidence index

| Topic | Files |
|---|---|
| Grants / RLS | `db/migrations/071_grant_anon_browser_access.sql`, `071_grant_anon_reports_read.sql`, `072_hotfix_v010_prod_patch.sql`, `074_client_sync_mirror_grants.sql`, `075_sales_ledger_rpc_browser_grants.sql`, `042:23`, `050:26`, `051:39`, `065:89` |
| Ledger RPCs | `073_customer_ledger_atomic.sql`, `069_auth_client_rpc.sql` |
| AuthN material | `016_pin_hardening.sql`, `017_owner_cashier_separation.sql:97`, `012_admin_email_auth.sql` |
| Client data plane | `lib/supabaseBrowser.ts`, `lib/idb.ts`, `lib/syncMirror.ts`, `services/syncService.ts`, `lib/tenantClient.ts` |
| Money math | `lib/saleMath.ts`, `lib/paymentBuckets.ts`, `lib/qr.ts`, `components/pos/CheckoutModal.tsx` |
| State & authz | `store/usePosStore.ts`, `hooks/useCrossTabSync.ts`, `lib/loyalty.ts`, `lib/sessionCrypto.ts`, `lib/supabase.ts` |
