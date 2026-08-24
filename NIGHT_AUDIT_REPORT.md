# MAKEEN POS — Overnight Deep Audit Report

| | |
|---|---|
| **Date** | Night audit — generated autonomously (read-only mode) |
| **Scope** | 221 TS/TSX files (~50,300 LOC), 76 SQL migrations, Electron shell (`main.js`, `preload.cjs`), print-agent service |
| **Working tree note** | 10 pre-existing modified paths from the current fix cycle (sync mirror, silent-print, sales-ledger hardening). Audit ran against that exact tree; nothing was changed by this audit. |
| **Method** | 4 parallel deep-analysis passes (memory/lifecycle, offline-sync integrity, render performance, security+SQL) + targeted manual verification of every Critical claim against source. All file:line references verified in the working tree. |
| **Remediation update** | 2026-08-24 — *Remediation Session 1* closed REG-R1 (§1) and F-01/F-04/F-05 (§2.2) via migrations `076`–`079` + the `jofotara` Edge Function (committed through `8cc5fcc`). Closed findings carry inline **Resolved** notes. |

---

## 0. Executive Summary

| Severity | Count | Theme |
|---|---:|---|
| **CRITICAL** | 8 | Database trust model, money-duplication edge case, unbounded disk growth, one deployment regression |
| **WARNING** | 22 | Sync ordering/report integrity, Electron hardening, listener hygiene, hot-path rendering |
| **SUGGESTION** | 18 | Robustness polish, diagnostics, bundle weight |

### The single most important paragraph in this report

The app's stated security model ("all data protection is delegated to Supabase RLS", `lib/supabaseBrowser.ts:11`) is **not true for any business table**. RLS exists on only ~4 of ~35 tables the browser touches, while migrations 071/072/074 hand the **anon key** (the only credential shipped inside `out/_next/static`) full DML on invoices, cash books, staff credentials, customer PII, and tax secrets. Everything above the database — admin gate, tenant scope, PIN lockout — is enforced in client JS an attacker controls. Section 2 quantifies this; Section 9 gives a reversible SQL-only stop-the-bleeding plan.

### Top 10 actions, ranked (full detail in sections below)

1. **[REGRESSION]** Migration `075` grants Sales-Ledger RPCs to `authenticated` only — but **no Supabase Auth sign-in exists anywhere in the codebase** (verified by grep). Every client is permanently `anon` → the admin Sales Ledger will get permission-denied at runtime. One-line fix before applying 075. *(§1)*
2. **[SEC]** Revoke anon DML on `cashiers` — one `UPDATE` = full tenant takeover via self-minted admin bcrypt hash. *(§2.2 F-01 — ✅ RESOLVED 2026-08-24 via 076+078)*
3. **[SEC]** Lock `tenant_tax_settings` (`USING(true)` policies expose every tenant's `istd_client_secret`). *(§2.2 F-04 — ✅ RESOLVED 2026-08-24 via 079+jofotara Edge Function)*
4. **[SEC]** Drop legacy plaintext `pin` column + stop syncing PIN verifiers to browsers. *(§2.2 F-05 — ✅ RESOLVED 2026-08-24 via 076+078)*
5. **[SYNC]** Fix post-enqueue failure path in `completeCheckout` — a quota error after the sale is durably queued shows "save failed" with cart intact → cashier re-rings → **duplicate revenue**. *(§3.2 SYNC-F1)*
6. **[SYNC]** Call `navigator.storage.persist()` — the IndexedDB queue is the only copy of offline sales and Chromium may legally evict it under disk pressure. *(§3.2 SYNC-F2)*
7. **[MEM]** Prune `SYNCED` rows from `sync_queue` (never deleted today; grows per sale forever) and index/prune `istd_state` (full-table scan into memory every 15 s). *(§4.1 MEM-1/MEM-2)*
8. **[PERF]** Wire up or port the dead virtualized grid — `QuickKeysGrid` (`@tanstack/react-virtual`) ships to zero screens while `CategoryDrawer` renders entire categories unvirtualized on checkout hardware. *(§6.2 PERF-1)*
9. **[ELECTRON]** Remove `webSecurity:false`, add `will-navigate`/`openExternal` allowlists, sanitize `print_jobs.rendered_html`. *(§2.4)*
10. **[SQL]** Wrap migrations in transactions; resolve the 062→070→072 schema churn; rename duplicate `071_*` files. *(§7)*

---

## 1. CRITICAL REGRESSION DISCOVERED DURING AUDIT

> **[CRITICAL] REG-R1 — Migration 075 grants are dead-on-arrival: the app has no authenticated role**
>
> - **Evidence A:** Repo-wide grep for `signInWithPassword | auth.getSession | auth.getUser | auth.setSession | signUp(` across `lib/, store/, app/, components/, services/` → **zero hits**. Admin login is custom bcrypt (`authenticate_admin_client`, migration 069) into a Zustand/localStorage session. The Supabase browser client uses the anon key only (`lib/supabaseBrowser.ts`).
> - **Evidence B:** `db/migrations/075_sales_ledger_rpc_browser_grants.sql` grants `EXECUTE` on `list_sales_ledger`, `sales_ledger_summary`, `sales_ledger_quality` to `authenticated` **only**.
> - **Impact:** PostgREST executes RPCs as the caller's role. Clients are always `anon` → all three calls return permission-denied → `fetchSalesReport` throws → Sales Ledger page renders its error banner (no crash — the defensive guards hold). Feature-dead until fixed.
> - **Why it happened:** 075 correctly diagnosed migration 041's revocation but assumed an authenticated session existed. It does not.
> - **Fix (immediate, edit the not-yet-applied 075 file):**
>   ```sql
>   GRANT EXECUTE ON FUNCTION list_sales_ledger(...) TO anon, authenticated;
>   GRANT EXECUTE ON FUNCTION sales_ledger_summary(...) TO anon, authenticated;
>   GRANT EXECUTE ON FUNCTION sales_ledger_quality(...) TO anon, authenticated;
>   ```
>   This restores the pre-041 posture exactly (functions take client-supplied `p_store_id`; see §2.3 for why that trust model itself needs replacing).
> - **Fix (strategic):** adopt real Supabase Auth sessions (even anonymous-per-device identities) so `authenticated` means something, then add membership assertions inside the functions (§2.2 F-06).
>
> **✅ RESOLVED (2026-08-24, Remediation Session 1):** applied migrations are immutable, so corrective migration **`077_fix_sales_ledger_anon_grants.sql`** re-granted EXECUTE on all three RPCs to `anon, authenticated`. The Sales Ledger is functional again for every client. The strategic fix above remains open (§9 P2).

---

## 2. Security & Database Trust Model

### 2.1 RLS-vs-Grants matrix (effective state after 033→071→072→074→075)

Legend: RLS ✅ enabled / ⚠️ on-but-open (`USING(true)`) / ❌ off.

| Table | RLS | anon grants | Verdict |
|---|---|---|---|
| `stores` | ❌ | SELECT + **UPDATE** (072) | Cross-tenant PII read; anyone can flip `subscription_status` |
| `cashiers` | ❌ | **SELECT+I/U/D** (071:21-22, 072:1313) | 🔴 Takeover chain — see F-01 |
| `staff_roles` | ❌ | SELECT | Capability model readable (client-enforced anyway) |
| `branches`/`terminals` | ❌ | SELECT+I/U/D | Any anon caller can restructure any tenant's registry |
| `products`/`product_variants` | ❌ | SELECT+I/U/D | Cross-tenant catalog tampering incl. cost prices |
| `categories`/`product_brands`/`suppliers` | ❌ | SELECT+I/U/D | Catalog/supplier tampering |
| `sales_invoices` | ❌ | SELECT (071) + I/U (074) | Read every tenant's sales; forge/amend invoices |
| `sales_invoice_items` | ❌ | SELECT + INSERT | Line-level PII/profit exposure |
| `sales_payments` | ❌ | SELECT, INSERT (074:20) | Payment ledger writable cross-tenant |
| `customer_transactions` | ❌ | SELECT+I/U/D (072:1347) | Debt ledger forgeable/erasable directly |
| `customers` | ❌ | SELECT+I/U/D | PII bulk-export; balances editable |
| `loyalty_events` | ❌ | SELECT, INSERT | Points forgery |
| `expenses` | ❌ | SELECT+I/U/D | Cash-book manipulation |
| `cash_movements` | ⚠️ 065 | SELECT,I,U (074); policy `USING(true)` (074:46-50) | Rubber-stamp policy |
| `sync_events` | ❌ | SELECT+I,U (071,074) | Full event history incl. names/phones readable |
| `shift_reports` | ❌ | S/I/U (072,074) | Immutability trigger covers financial cols only; DELETE allowed |
| `risk_events` | ❌ | SELECT, INSERT | Evidence tampering |
| `admin_audit_logs` | ❌ | INSERT+SELECT (074:37) | Trail readable/forged by anon |
| `print_jobs` | ❌ | SELECT, INSERT (074:40) | Attacker-supplied HTML printed silently (F-08) |
| `print_templates` | ⚠️ 042 | full DML; policies `USING(true)` (072:1275-1287) | Receipt logo/footer hijack = phishing channel |
| `tenant_tax_settings` | ⚠️ 050 | S/I/U; policies `USING(true)` (072:1293-1302) | 🔴 `istd_client_secret` exposed — F-04 |
| `istd_submissions` | ✅ 051 | none | 🟢 The only table done right |
| `inventory_movements/postings` | ❌ | SELECT (+INSERT postings) | Stock history readable |
| `suppliers_invoices/items/payments` | ❌ | SELECT+I/U/D | AP books forgeable |
| `purchase_orders(+items)` | ❌ | SELECT+I/U/D | Purchasing forgeable |
| `shortage_flags` | ❌ | SELECT+I/U/D | Operational sabotage |
| `print_server_configs` | ❌ | S,I,U — contains `token` col (072:434-440) | Kiosk token disclosure |
| `platform_secrets` | — | REVOKE ALL (015:31) | 🟢 Locked |

### 2.2 Findings

**F-01 [CRITICAL] Anonymous privilege escalation to tenant owner**
`db/migrations/071_grant_anon_browser_access.sql:21-22` (+072:1313) grant full DML on `cashiers`; no guard trigger exists on the table. `authenticate_admin_client` (069:36-45) trusts `role='admin'` + bcrypt match.
*Attack:* holder of the public anon key runs `UPDATE cashiers SET role='admin', password_hash=<self-made bcrypt> WHERE id=...` → logs into the dashboard as the owner.
*Fix:* revoke anon/authenticated DML on `cashiers`; move staff management behind SECURITY DEFINER RPCs that verify admin credential internally; BEFORE trigger blocking `role`/hash changes outside definer context.

**✅ Resolved (2026-08-24, Remediation Session 1):** `078_staff_security_rpc.sql` — all role grants revoked on `cashiers`; RLS enabled with zero policies (deny-all for client roles). Staff management moved to SECURITY DEFINER RPCs (`admin_create/update/delete_cashier`, `admin_update_owner_email`) requiring per-call admin email+password proof, throttled server-side via `staff_pin_throttle` (5 fails → 15 min lock). The BEFORE-trigger idea became unnecessary: no client role can touch the table at all.

**F-02 [CRITICAL] No RLS on ~30 business tables; broad anon DML**
Umbrella finding — matrix above. Root cause: the serverless migration rebuilt transport but never rebuilt the trust model (033's blanket lockdown fully undone by 071×2/072/074).
*Fix:* enable RLS everywhere with `store_id = auth_store_id()` claim-based policies backed by real sessions (§9 Phase B).

**F-03 [CRITICAL-functional] Super-admin ops-token design incompatible with static export**
`lib/superAdminClient.ts:124-132,181-188` call `provision_new_store`/`delete_store` with `p_token:""` → always `permission_denied`. The console is dead code — and creates pressure to "fix" it later by dropping server-side token checks (as already happened for shift RPCs in 072), which would make the anon key a platform-wide delete key.
*Fix:* platform-operator identity via Supabase Auth claim checked inside the functions; never ship gates to the client.

**F-04 [CRITICAL] Tenant tax secrets readable/writable anonymously**
`tenant_tax_settings` policies `USING(true)` (072:1293-1302); columns include `istd_client_secret` (072:309-316).
*Attack:* dump/redirect every tenant's JoFotara credentials.
*Fix:* per-tenant scoped policies; serve secrets masked through definer RPC only.

**✅ Resolved (2026-08-24, Remediation Session 1):** `079_lock_tenant_tax_settings.sql` dropped the three `USING(true)` policies and revoked all grants from `anon`/`authenticated` (RLS deny-all re-asserted; **verified post-state:** anon SELECT = `false`, policy count = `0`). Secrets moved into the deployed `jofotara` Edge Function: `config_get` returns masked status only, `config_save` requires admin email+password proof, `invoice_submit` reads credentials server-side — the secret never leaves the function.

**F-05 [CRITICAL] Staff PIN material synced to browsers; plaintext column still alive**
`lib/clientCatalog.ts:142` selects `pin` alongside hashes; fallback `sha256(c.pin + pinSalt)` at :98; salt deterministic from public store id (`pinSaltFor` :92-94, predates 016's intent); combined with anon SELECT on `cashiers`.
*Attack:* download roster → instant crack of 10k PIN space → register unlock/drawer/debt impersonation.
*Fix:* `ALTER TABLE cashiers DROP COLUMN pin` after verifying `pin_hash` coverage; random salts; longer-term verify PINs via definer RPC instead of shipping verifiers.

**✅ Resolved (2026-08-24, Remediation Session 1):** `076_stop_the_bleeding_lockdown.sql` backfilled `pin_hash` for every legacy row (byte-exact with the 016 formula, logins unaffected) and dropped the plaintext `pin` column. `078` then stopped verifier syncing: `verify_staff_pin` returns only safe columns, plus the matched cashier's own verifier on a successful check (active-shift offline re-unlock); the full roster/hash set is no longer readable by any client role (`lib/clientCatalog.ts` rewired accordingly). Residual (P2): sha256 verifiers remain brute-forceable offline — migrate to bcrypt/PBKDF2 when the offline-unlock strategy allows.

**F-06 [WARNING] SECURITY DEFINER RPCs accept arbitrary `p_store_id`**
`list_sales_ledger` family (025:85), `apply_customer_ledger_event` (073), `record_inventory_movement` (024), `claim_print_job` (068/072), `approve_shift_variance`/`review_risk_event`/`resolve_stale_shift` (re-granted anon in 072:1380-85 despite 046's revocation), `merge_into_variant_parent` (072:1390). None assert caller membership; client-side re-auth (`shiftsClient.ts:534-550`) binds to nothing server-side.
*Impact:* cross-tenant read/write/approval-forgery for whoever holds a valid role grant.
*Fix:* fold membership assertion into each function; fold password verification into privileged RPCs (also fixes F-12).

**F-07 [SUGGESTION] Admin brute-force throttling documented client-side only (069:16-18)** — add failed-attempt table keyed `(email, ip-hash)` inside the RPC.

**F-14 [SUGGESTION] `admin_audit_logs` anon-readable/insertable** — restrict SELECT; inserts via verified definer RPC.

**F-15 [SUGGESTION] Anon key baked into distributed builds has no rotation story** — proxy via edge function or make endpoint/key remotely configurable.

### 2.3 Secrets surface

- `.env` contains live-looking `SUPABASE_SERVICE_ROLE_KEY`, `PLATFORM_OPS_SECRET`, `ADMIN_SESSION_SECRET`, `DATABASE_URL`. Gitignored (verified `.gitignore:43`) but plaintext across dev disks — **rotate**, treat historical exposure as burned.
- `out/` bundle grep: clean of service_role/ops secrets; only the anon key ships — which per §2.1 is currently *sufficient* for full access. That is the headline risk.

### 2.4 Electron hardening

| # | Sev | Location | Finding & fix |
|---|---|---|---|
| E-1 | WARNING | main.js:88,177 | `webSecurity:false` on both windows disables SOP → renderer XSS can fetch LAN/localhost:9100/Supabase freely; no CSP anywhere. Remove flag; register `app://` as standard+secure privileged scheme; add CSP meta to export. |
| E-2 | WARNING | main.js:197-200 | No `will-navigate` lock; `setWindowOpenHandler` forwards **every** URL to `shell.openExternal` unvalidated (`file://`, `smb://` handlers = known exec vector class). Allowlist https domains for both. |
| E-3 | WARNING | main.js:92-94,77 | Hidden window loads renderer-supplied HTML via data: URL; handler doesn't check `event.senderFrame`. Mitigations confirmed good: sandbox+contextIsolation, **no preload attached → injected JS cannot reach IPC**. Residual: network exfil/spool-wedging loops. Sanitize `rendered_html` at write time or switch to structured payloads rendered by trusted templates. |
| E-4 | 🟢 | preload.cjs:7-19 | Bridge surface minimal (2 methods) — correct. |

### 2.5 Renderer injection & CSV

- React-rendered receipt paths are safe-by-construction (React-escaped; `renderToString` in `lib/printRenderer.tsx:91-93`). `dangerouslySetInnerHTML` sites audited: ThermalReceipt fiscal QR SVG (generated matrix, no interpolation) + static CSS constants → safe.
- **F-10 [WARNING] CSV formula injection**: exports quote cells but never neutralize leading `=,+,-,@` — `app/admin/supplier-accounts/page.tsx:163-176`, `app/admin/reports/page.tsx:120-141`, `app/admin/shifts/page.tsx:302`, `app/admin/reports/profitability/page.tsx:157`, `app/admin/reports/sales/page.tsx:226`. Names are cross-tenant-settable per §2.1 → Excel formula execution on owner machines. Fix: prefix `'` when cell matches `^[=+\-@\t\r]`.

### 2.6 Client-side AuthZ reality

Static export ⇒ no middleware. Gate = `AdminGuard` reading persisted Zustand state (`components/admin/AdminGuard.tsx:34-64`; `lib/clientAdminSession.ts:13-15` documents validity as local check). Bypass = DevTools edit of `pos-store`. Acceptable only because the DB should be the boundary — which it currently isn't (§2.1). Session + PIN-lockout counters persist in localStorage (`usePosStore.ts:752-775`) and are attacker-editable (**F-11 [WARNING]**; also covers unencrypted IDB caching of PIN verifiers/customer PII/invoice payloads — `idb.ts:745-788,1086`).

---

## 3. Offline Sync Integrity (IndexedDB queue lifecycle)

### 3.1 Verified-safe mechanisms (done right — do not regress)

- Durable inbox first: every event upserted to `sync_events` (`onConflict sync_id, ignoreDuplicates`) before ledger work — `lib/syncMirror.ts:1959-1963`; ack only after full mirror success — `services/syncService.ts:108-111`. Crash between mirror and ack replays safely.
- Per-domain idempotency: invoice unique `sync_id` + 23505 race backfill (`ensureInvoiceChildren` :415-492); stock marker + `invoice:<sync_id>:<line>` keys (:1779-1853); settlement via atomic `apply_customer_ledger_event` with row locks (073).
- Outages never age records toward poison (attempts count only server-responded failures — `syncService.ts:88-95`, `idb.ts:618-638`); quarantine preserves payload, never deletes (`idb.ts:570-586`); `clearSyncQueue` has zero production callers.
- Tenant scoping end-to-end: enqueue stamps storeId (`idb.ts:465-469`), drain filters (`syncService.ts:78-83`), unbound rows never sync, logout preserves queue.
- Checkout durability ordering: sale awaited into IDB before cart clear; failure keeps cart + surfaces error (`usePosStore.ts:1757-1876`).
- Z-report recomputed server-side with completeness deferral + SHIFT_CLOSED second pass; SUPPLIER_CREATE prepass covers intra-batch dependency.

### 3.2 Findings

**SYNC-F1 [CRITICAL] Post-enqueue code path can duplicate a sale**
`store/usePosStore.ts:1760-1876`: after `await enqueueSync(record)` succeeds (:1760), the same try block recounts pending (:1761) and runs `upsertPriceMemoryFromPayload` (:1769) — real readwrite IDB I/O that can throw (quota/closed DB). Catch shows "فشل حفظ الفاتورة محلياً" (:1872) **while the sale IS durably queued**, cart intact.
*Scenario:* quota throw → cashier re-rings → second INVOICE_CREATED with fresh sync_id → both mirror → duplicated revenue + double stock deduction. Server cannot dedupe (different sync_ids by design).
*Fix:* once the enqueue put resolves, outcome must be success-only — move everything after :1760 out of the try or wrap in swallow-errors guard.

**SYNC-F2 [CRITICAL] Queue evictable — no `navigator.storage.persist()` anywhere**
Zero call sites repo-wide. Queue-as-archive design (see MEM-1) means Chromium eviction under disk pressure destroys unsynced PENDING sales — true money loss on long-running kiosks.
*Fix:* request `persist()` at bootstrap; watch `storage.estimate()`; alert >90%.

**SYNC-F3 [WARNING] Drain order is UUID-random, not FIFO**
`getSyncsByStatus` returns PK (UUID) order within status (`idb.ts:511-516`); no sort before slicing (`syncService.ts:80-85`); the mirror engine documents it (`syncMirror.ts:1892-1894`). Returns can precede originals across batches; aggregates degrade (feeds F4/F5).
*Fix:* sort scoped batch by `payload.completed_at ?? created_at`; add created_at index.

**SYNC-F4 [WARNING] Z-report can freeze permanently wrong totals**
`assessShiftLedgerCompleteness` checks the **server inbox** (`syncMirror.ts:1448-1460`). PENDING events that UUID-sort after the close land in a later batch → not yet inboxed → `rows.length===0` → `complete:true` → finalize runs on partial ledger. `shift_reports` upsert `onConflict store_id,shift_id, ignoreDuplicates` (:1620) → first wrong close wins forever; close marked SYNCED, never retried. Probability ≈ 1/(k+1) per shift with k pending; guaranteed when backlog >50; clock skew aggravates via the `lte closeTime` filter.
*Fix:* attach the shift's queued-event ids to the SHIFT_CLOSED payload and require all inboxed; or defer finalization until queue drained for the store.

**SYNC-F5 [WARNING] Deferred closes age into poison during backlogs**
`shift_ledger_incomplete` counts toward `MAX_SERVER_ATTEMPTS=8` (`syncService.ts:117-128`); 20 rounds/run × 15 s ticks quarantines a close sitting behind a >~400-event backlog within one run. Combined with F4 there is no self-heal.
*Fix:* treat the deferral reason as non-attempt (retry without aging).

**SYNC-F6 [WARNING] `openShift` flips state before enqueueing, fails silently**
`usePosStore.ts:1921-1944`: set OPEN precedes enqueue; catch only console.errors. Quota failure → ghost shiftId on invoices; Z float derived from fallback.
*Fix:* enqueue-first like closeShift; surface notice.

**SYNC-F7 [WARNING] Poison quarantine has no fix/requeue UI**
Badge surfaces counts (`PosLayout.tsx:547-575,692-708`) but no component offers view/requeue; docs promise it (`idb.ts:26-27,566-568`). Quarantined sale = invisible revenue until manual surgery.
*Fix:* admin modal: list poison rows, show payload, patch & re-put into queue.

**SYNC-F8 [SUGGESTION] Patch-vs-ack race** — `patchSyncRecordPayload` get→put can interleave with drain ack writes-back (`idb.ts:605-616` vs `533-548`). Benign today (ISTD push is a stub); merge inside markSyncCompleted for correctness.

**SYNC-F9 [SUGGESTION] Dead unit-multiplier code** — `multiplier = data ? 1 : 1` (`syncMirror.ts:1804`); unit conversions unimplemented in stock/cost basis.

**SYNC-F10 [SUGGESTION] N+1 ack loops** — per-id get→put in `markSyncCompleted`/`markSyncAttemptFailed`; batch in one readwrite tx.

---

## 4. Memory Leaks & Resource Lifecycle

### 4.1 Storage-layer growth (worst offenders)

**MEM-1 [CRITICAL] `sync_queue` SYNCED rows are never deleted**
`services/syncService.ts:108-111` → `markSyncCompleted` (`idb.ts:533-548`) flips `PENDING→SYNCED` and keeps the full payload (entire invoice incl. items) on disk forever. `deleteSyncs` deliberately unused; `clearSyncQueue` test-only. Compounding: `isInvoiceReturned()` (`idb.ts:658`) and `listInvoices()` (:684) run `db.getAll(STORE)` — deserializing **the whole sales history** on every return attempt and every open of PreviousInvoicesModal (`PreviousInvoicesModal.tsx:64`). Latency/heap grow linearly with business history.
*Fix:* retention sweep after mirror-ack (keep N-day recent window for returns lookup); compact `invoices_index` store (sync_id/date/totals) for `getAll` replacements.

**MEM-2 [CRITICAL] `istd_state` grows per invoice; scanned into memory every 15 s**
`setIstdState` writes one row/invoice; SUBMITTED rows never deleted; `countIstdPending/Failed` → `getIstdStates` → `db.getAll(ISTD_STORE)` (`idb.ts:1065-1067`) executed by `refreshIstdCounts()` on the 15 s background tick (`hooks/useBackgroundSync.ts`). ~50k rows/year × alloc+filter ×2 per tick per tab.
*Fix:* prune terminal-status rows past fiscal retention, or add `(storeId,status)` index + `count()`.

**MEM-3 [WARNING] No `versionchange`/`blocked` handling — future upgrade deadlock**
`idb.ts:428-462` caches the connection forever; `idb` only wires blocking callbacks when supplied. Next `DB_VERSION` bump (now 8) hangs every other open tab's `getDb()` silently (multi-tab is supported).
*Fix:* pass `blocking(){dbPromise=null}`, `blocked()` surfacing a reload notice.

**MEM-4 [WARNING] Per-tenant localStorage boot mirrors never evicted** (`idb.ts:735-752,791-798`) — multi-MB blobs accumulate per tenant ever used on shared registers. Evict non-active tenants on logout/store switch.

### 4.2 Electron lifecycle

**MEM-5 [WARNING] Uncapped hidden print windows under burst** — each `print:silent` invoke spins a full hidden renderer for ≥300ms+print+750ms grace (≤~21s); rapid reprints stack dozens. Serialize via promise-chain semaphore or reject `PRINT_BUSY`. (Lifecycle itself verified correct: finally-destroy + 20 s timeout.)

**MEM-6 [SUGGESTION] autoUpdater re-prompts every 4 h after "لاحقاً"** (`main.js:226-242`) — add promptedForVersion guard. Initial 10 s setTimeout untracked but harmless.

🟢 Verified clean: ipcMain handlers registered once; updater listeners app-lifetime singletons; `updateCheckTimer` cleared on will-quit; mainWindow listeners GC with window; preload stateless; `print:getPrinters` uses `event.sender`.

### 4.3 React listeners/timers (47 add vs 36 remove — delta accounted)

**MEM-7 [WARNING] Abandoned shift-print sessions leak `{once:true}` afterprint listeners with stale closures** — `app/admin/shifts/page.tsx:129-140`: teardown removes neither listener; a stale `cleanup` firing on a LATER `window.print()` cancels/mutes the new session and sticks the guard. Fix: named refs removed in effect return, or gate cleanup on a session token.

**MEM-8 [WARNING] Camera stream torn down/restarted on every parent render** — `MobileReceiving.tsx:435-438,579-583` recreates `handleScanDetected` per keystroke/store update; `BarcodeScanner.tsx:115` deps include it → repeated `getUserMedia` stop/open cycles while visible (device flicker, handle churn). Fix: useCallback, or ref the callback and drop from deps.

**MEM-9 [SUGGESTION] AbortController decorative** — `AsyncProductCombobox.tsx:76-90`: signal never passed to `searchProducts`; abort only discards result post-await.

**MEM-10 [SUGGESTION] Short UI timers uncleaned** — settings page save banners (:227,:286,:334), shifts :105, super-admin :125 (≤4 s, fire-after-unmount no-ops).

**MEM-11 [SUGGESTION] ServiceWorker updatefound/statechange listeners never removed** (`ServiceWorkerRegister.tsx:35-43`) — root component, bounded; symmetry only.

**MEM-12 [SUGGESTION] Module-scope unload flushers intentional** (`persistStorage.ts:93-103`) — document or add dispose for tests.

**MEM-13 [INFORMATIONAL] Web Serial drawer port held open for app lifetime** (`cashDrawer.ts:34,115-151`) — intentional; nit: failed pulse drops ref without `port.close()`.

🟢 Verified clean (pairing cross-checked): useBackgroundSync interval+3 listeners; useDebouncedValue; useBarcodeScanner (capture flags match, buffers capped); usePosHotkeys; useCrossTabSync; useDeviceHardware; useDefaultPrintTemplate (cancelled-flagged); useModalEscape; useMediaQuery; ModalShell; DropdownMenu; ConfirmDialog; EntityCombobox; PinnedCategories; QuickKeysGrid pointerdown; CategoryDrawer; SecondaryAuthModal; InvoicePanel confirm timer; AuditLogTimeline; PosLayout (lease/audio/afterprint/notice timers all cleaned); MobileReceiving own-listener-free; print-server page; posSound oscillator disconnects; adminToast DOM self-cleanup; Zustand: no external `.subscribe()`, hydration-job Map deleted in finally, shiftTransactions reset on close/logout, heldInvoices filtered, receiving shield pruned; print-agent Realtime channel removed in stop() wired to SIGINT/SIGTERM.

**MEM-14 [SUGGESTION] print-agent startup drain not cancellable** — `listener.ts:213-215` 3 s setTimeout survives `stop()`; capture+clear.

**MEM-15 [SUGGESTION] Legacy rate-limit buckets never evict expired unseen IPs** (`rateLimit.ts:15`) — lazy sweep or TTL map (legacy API paths only).

---

## 5. Promises, Error Boundaries & Silent Failures (manual pass)

### 5.1 Error-boundary coverage (static export)

Boundaries present: `app/error.tsx`, `app/admin/error.tsx`, `app/pos/error.tsx`. Every admin subpage inherits `admin/error.tsx` ✓; POS covered ✓.

**ERR-1 [WARNING] `app/global-error.tsx` missing** — a crash inside the root layout (theme/persistence providers) bypasses `app/error.tsx` entirely → white screen in Electron with zero diagnostics. Add global-error.tsx with minimal inline markup.

### 5.2 Floating / unhandled rejections

**ERR-2 [WARNING] `AdminGuard` probe rejection leaves gate unresolved** — `components/admin/AdminGuard.tsx:57` `void probe.then(...)` without `.catch`; if `probeAdminSession/probeStaffCapability` ever rejects, `setProbeComplete` never fires. Currently non-blocking by design (comment :53), so impact = silent stall of revocation checks. Add `.catch(() => setProbeComplete(true))`.

Verified-clean patterns (checked individually): `SupplierInvoiceDetailModal.tsx:18-20` (.catch sets error ✓), `AddProductForm.tsx:74-95` (.catch with documented optional-dropdown rationale ✓), `AuditLogTimeline` (.then chains paired with catch in loader ✓), PosLayout audio-prime/print flows, ThermalReceipt dynamic imports.

### 5.3 Double-submit / concurrency guards

🟢 **Checkout is properly guarded — verified**: `usePosStore.ts:1664` early-returns on `get().isCompleting`; cross-tab lock mirrors the flag through localStorage (`POS_COMPLETING_KEY`, :689-701) propagated by `useCrossTabSync`; button disabled binding `CheckoutModal.tsx:180`. This is exemplary. (The remaining duplication vector is SYNC-F1's post-enqueue path, not double-submit.)

### 5.4 Silent swallowing sweep

Only 5 empty catches repo-wide, all benign storage guards: `AdminShell.tsx:24,32`, `NavGroup.tsx:27,35`, `PinnedCategories.tsx:29` → SUGGESTION: comment intent or narrow. Dangerous swallows are instead concentrated in SYNC-F6 (silent openShift) and §2/§3 items already logged.

---

## 6. Rendering Performance

### 6.1 Verified-fast architecture (worth knowing)

- **Selector discipline flawless**: ~130 `usePosStore((s)=>…)` sites; zero object/array-returning selectors; `useShallow` needed nowhere. PosLayout's ~35 subscriptions include nothing that moves during scan→cart editing.
- Totals computed once per mutation in the store (`computeSaleTotals`); immutable cart updates preserve line identity → memo'd CartRow deep-renders exactly one row per scan.
- Persistence write-coalesced (250 ms debounce + pagehide flush, `persistStorage.ts:26-59,93-103`) — the classic scan-burst freeze is engineered out.
- ThermalReceipt null-gated idle; jsbarcode/qrcode dynamically imported once per completed sale; kept mounted intentionally as print-capture source.
- All modals null-gate when closed; session keys force clean remounts.
- Scanner/hotkey hooks hold zero store subscriptions (pure getState()); wedge-burst detection + coalescing.
- Catalog hydration job-deduped per store, version-gated; heavy libs confined to admin routes by static splitting; no framer-motion/lottie.

### 6.2 Findings

**PERF-1 [CRITICAL] The only virtualized grid is dead code; the live category browser isn't virtualized**
`components/pos/QuickKeysGrid.tsx` (669 lines: `@tanstack/react-virtual` rowVirtualizer, memo tiles, useDeferredValue) is exported (:163) but imported nowhere. Meanwhile `CategoryDrawer.tsx:550-561` renders `productsInView.map(<ProductCard/>)` for **every product in the focused category** (grid-cols-1 cards), reached from SpeedDock's prominent browse button (`SpeedDock.tsx:118`). Thousands of SKUs = synchronous multi-hundred-ms commit on lane hardware.
*Fix:* mount QuickKeysGrid (it was built for exactly this) or port its virtualizer into CategoryDrawer; cap/paginate beyond ~100.

**PERF-2 [WARNING] Omnibar input state lives inside InvoicePanel** — `InvoicePanel.tsx:178,313-325`: per-keystroke re-diff of tabs + whole `<table>` + footer (CartRow deep-renders suppressed by memo, element creation still O(N)). Extract `<BarcodeOmnibar/>` holding its own state.

**PERF-3 [WARNING] Arabic normalization re-run over full catalogs per query**
`SmartSearchModal.tsx:96-125` normalizes name+every barcode (~20k strings @6.6k products) per debounced query; `mobile/QuickAddModal.tsx:49-62` + `QuickAddWizard.tsx:70-84` do full-map normalize+sort **undebounced per keystroke**; `EntityCombobox.tsx:69-74` same per option. Precompute normalized fields once when building entries/options.

**PERF-4 [WARNING] SpeedDock unbounded quick-keys column** (`SpeedDock.tsx:72-108`) — every `is_quick_key` product becomes a persistent DOM node all shift. Cap top-N or virtualize.

**PERF-5 [WARNING] Background tick re-renders POS shell** — PosLayout subscribes pending/poison/istd counters (:97-99,547-551); every 15 s refresh re-renders the outermost shell and un-memo'd InvoicePanel. Wrap InvoicePanel/SpeedDock in `memo` (props empty/stable).

**PERF-6 [WARNING] Admin category-tree search undebounced full-node normalize rebuild** — `app/admin/categories/page.tsx:482-483→544-563,572-580` per keystroke amid dnd-kit drag UI. useDeferredValue/debounce + cache node text.

**PERF-7 [SUGGESTION]** CheckoutModal/ShiftDetailsModal subscribe while closed (null-gated; microseconds) — split inner component mounted when open. · Drawer search skips Arabic normalization (`CategoryDrawer.tsx:227-278`) — consistency gap, not perf. · shortages page two unmemoized stat filters (:181-186). · `formatMoney` builds Intl options per call (`lib/format.ts:5-12`) — hoist module-level formatter; same for inline `toLocaleString("ar-JO")` in row loops (SupplierInvoiceDetailModal :33 etc.). · `next/dynamic` absent — lazily import AuditLogTimeline/AdminHubModal/PreviousInvoicesModal out of POS first paint.

---

## 7. SQL Migration Hygiene

| ID | Sev | Finding |
|---|---|---|
| MIG-1 | WARNING | 74/76 files have no BEGIN/COMMIT (only 072 wraps). Multi-step destructive files partially apply on mid-file failure (e.g., 062:214-222 drop sequence). Wrap everything; CI-apply-to-fresh-DB. |
| MIG-2 | WARNING | Contradictory churn: 062 drops `parent_id/variant_label/is_variant_root` + `product_barcodes`; 070 re-adds them; 072:55-57 adds again. Three shapes across three releases; replicas diverge by applied subset. |
| MIG-3 | CRITICAL-root | Grant churn: 033 blanket-revoke → 071×2 reads → 072 full anon DML → 074 more → 075 RPC re-grant. Net: lockdown undone except `supplier_*` secure RPCs + `istd_submissions`. (This IS §2's root cause.) |
| MIG-4 | SUGGESTION | Duplicate sequence numbers: `071_grant_anon_browser_access.sql` + `071_grant_anon_reports_read.sql` — checksum-runner hazard; rename. |
| MIG-5 | WARNING | Broken shipped function: 068 `claim_print_job` referenced param outside signature (documented 072:32-33,939-946) — proves migrations ran unvalidated. |
| MIG-6 | SUGGESTION | `CREATE INDEX` w/o IF NOT EXISTS in 001/002 → non-replayable. |
| MIG-7 | 🟢 | 072 idempotent throughout (IF NOT EXISTS / DROP CONSTRAINT IF EXISTS) — adopt as house pattern. |

---

## 8. Coverage Statement (what was verified clean, explicitly)

Electron IPC registration/updater/window lifecycle; preload bridge minimality; print-window destruction guarantees; all 47 addEventListener sites reconciled (delta = intentional module-scope flushers/SW/once-listeners flagged above); every production setInterval cleared; the repo's single Realtime subscription properly torn down; Zustand selector discipline (~130 sites) and persistence adapter; checkout double/triple-submit protection incl. cross-tab lock; enqueue durability ordering for sales and shift-close; queue tenant scoping and poison preservation; per-domain idempotency keys end-to-end; admin inventory/reports genuine server-side pagination with debounced normalized search; modal null-gating and session-key remounts; React-rendered print HTML escaping; `dangerouslySetInnerHTML` audit (safe sites); `out/` bundle secret grep (clean apart from anon key); `istd_submissions` + `platform_secrets` lockdown.

---

## 9. Remediation Roadmap

### P0 — this week (money & takeover)
| # | Action | Effort |
|---|---|---|
| 1 | ✅ DONE (2026-08-24) — 075 was already applied, so corrective `077` granted the RPCs to `anon, authenticated` (REG-R1) | done |
| 2 | SYNC-F1 guard: success-only after `enqueueSync` resolves | 30 min |
| 3 | `navigator.storage.persist()` + usage watchdog (SYNC-F2) | 1 h |
| 4 | ✅ DONE (2026-08-24) — SQL stop-the-bleeding shipped as `076`+`078`+`079`: anon DML on `cashiers` revoked + RLS deny-all, `tenant_tax_settings` locked behind the `jofotara` Edge Function; staged claim-based RLS rollout remains P0/P1 for the rest of the schema | done |
| 5 | ◐ HALF-DONE (2026-08-24) — `cashiers.pin` column dropped via `076`; `.env` secret rotation still pending | 0.25 day left |
| 6 | MEM-1/MEM-2 retention sweeps (queue + istd_state) | 0.5 day |

### P1 — next sprint
Z-report integrity cluster (SYNC-F3/F4/F5) · poison requeue UI (F7) · Electron allowlists+CSP+rendered_html sanitization (E-1..3, F-08) · CSV formula guards (F-10) · global-error.tsx + AdminGuard catch (ERR-1/2) · print serialization (MEM-5) · shifts afterprint fix (MEM-7) · camera churn fix (MEM-8) · idb blocking/blocked (MEM-3) · QuickKeysGrid wiring / CategoryDrawer virtualization (PERF-1) · omnibar extraction (PERF-2) · normalized search indexes (PERF-3).

### P2 — hardening
Real Supabase Auth + claim-based RLS everywhere (fixes F-02/F-03/F-06/F-07/F-12/F-14 as a package) · migration transaction wrapper + CI replay · duplicate 071 rename · Intl formatter hoists · dynamic imports for admin-only POS imports · updater prompt-once guard.

---

*Report compiled autonomously in read-only mode. Zero application files were created, modified, or deleted during this audit (verified via git status at completion). The sole artifact is this report.*
