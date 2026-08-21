# MAKEEN POS — System Blueprint

Master reference for the MAKEEN POS codebase (`C:\Projects\pos`). Written from a full source read; paths are exact, constants are exact, behavior reflects the code as of this revision. Use this document as the entry point before changing anything.

---

## 1. Architecture & Stack

### 1.1 Stack

| Layer | Choice |
|---|---|
| Framework | **Next.js 16.3.0** (App Router; root `proxy.ts` instead of `middleware.ts`) |
| UI | React 19.2.8, Tailwind, shadcn-style components (`components/ui`), `lucide-react` icons |
| State | Zustand 5.0.14 with `persist` (localStorage) + cross-tab sync |
| Local DB | `idb` (IndexedDB) — offline sync queue + catalog/customer caches |
| Backend DB | Supabase (`@supabase/supabase-js` ^2.112.0) — Postgres, RPC, RLS-adjacent grants |
| Scanning | `@zxing/browser` (camera, 1D retail formats) + manual keyboard-wedge scanner |
| Printing | `jsbarcode` + `qrcode` + thermal receipt template (window.print) |
| Import | `papaparse` (CSV), `xlsx` (Excel) |
| Charts | `recharts` |
| Virtualized lists | `@tanstack/react-virtual` |
| Dev/test | devDeps: `pg` ^8.22, `fake-indexeddb`, `tsx`; self-test runner `tests/run.mjs` |

> **Breaking-change warning (AGENTS.md):** this is a Next.js version whose conventions differ from training data. Read `node_modules/next/dist/docs/` before writing Next code. `proxy.ts` replaces `middleware.ts` — route interception lives there.

### 1.2 App surfaces

- **`/login`** — unified gateway, two tabs: staff (store code + username + PIN) and owner (email + password). Only signed device session unlocks app pages; a valid `pos_admin` cookie alone never unlocks anything.
- **`/pos`** — the register (layout `components/pos/PosLayout.tsx`). Requires an OPEN shift; see §4.
- **`/admin`** — back office: dashboard, reports, shifts, risk, inventory, catalog, purchases, suppliers, debts, loyalty, branches, devices, staff, settings, print-studio, audit, expenses.
- **`/mobile`** — mobile inventory flow; `/mobile/add-product` for the camera-driven product-add page.
- **`/register`** — closed door (store creation is a Super-Admin action).
- **`/super-admin`** — platform console (PIN-gated), provisions stores.

### 1.3 Event-sourced core

The system is **offline-first and event-sourced**:

- Every write at the register is queued into IndexedDB as a `SyncQueueRecord` (`action_type` ∈ `INVOICE_CREATED | SHIFT_OPENED | SHIFT_CLOSED | DEBT_SETTLEMENT | EXPENSE_RECORDED`).
- `hooks/useBackgroundSync.ts` drains the queue every `15_000 ms` (and on `online`/visibilitychange) into `POST /api/sync`.
- The server upserts events into `sync_events` (idempotent on `sync_id`) and **mirrors** them into relational ledgers (`sales_invoices`, `sales_invoice_items`, `sales_payments`, `customer_transactions`, `expenses`, `inventory_movements`, `shift_reports`, `loyalty_events`, `risk_events`). Mirrors are dedupe-safe so retries never double-count.
- Only events whose mirror succeeded are ACKed back; the POS marks them `SYNCED`. Poison events (server 2xx but never acked) are dropped after 8 attempts.

This is the single source of truth for every report: **the mirror is what accounting reads, `sync_events` is the immutable audit of what the device said.**

---

## 2. Authentication & Authorization

### 2.1 Session architecture

Three session kinds, all HMAC-SHA256 envelopes created by `lib/sessionCrypto.ts`:

- **Device session** — cookie `pos_device` (`DEVICE_SESSION_COOKIE` in `lib/sessionTypes.ts`), namespace `"device"`, 30 days. Payload: `{storeId, actorId, actorName, role, staffRoleCode?}`. Created by staff login; carries the store tenant on every request.
- **Admin (owner) session** — cookie `pos_admin` (`ADMIN_SESSION_COOKIE`), namespace `"admin"`, 12 hours. Payload `{storeId, email, name}`. Created by owner email/password login. **`getAdminSession` returns null when the device session's role is `cashier`** — a later cashier login supersedes the owner cookie.
- **Mock mode** — when Supabase is not configured, `POS_FORCE_MOCK`-style header/session mocks stand in (`mockStoreAccess` etc. in `lib/requestAuth.ts`).

Envelope format: `{version:1, issuedAt, expiresAt, payload}` base64url + signature. Root secret = first defined of `ADMIN_SESSION_SECRET | SESSION_SECRET | PLATFORM_OPS_SECRET | DATABASE_URL`; falls back to ephemeral `randomBytes` when nothing is configured (sessions invalidate on restart). Per-namespace signing key: `pos-session:${namespace}:v1`.

### 2.2 Who is who

- **Owner** = `cashiers` row with `role = 'admin'` (or Arabic `'مدير'`). Logs in with email + password only. **Never holds a PIN.** Has every capability.
- **Staff** = `cashiers` rows with a PIN + `role_id → staff_roles`. Login is store code + username + PIN.
- **Super Admin** = platform operator (`super_admins`, PIN `7777` mock), provisions/removes stores via `/super-admin` → `POST /api/admin/stores`.

### 2.3 Login flows

1. **Staff** (`POST /api/login`, page `app/login/page.tsx` staff tab):
   - Body `{storeCode, username, pin}` (or legacy `{storeId, pin}`).
   - Store-code format enforced `/^[A-Z0-9]{4,12}$/`, PIN exactly 4 chars.
   - Verifies PIN as `sha256Hex(pin + pin_salt)` against the store's active cashier; resolves role capabilities/limits; creates device session; returns `{store, cashier, branches, terminals, defaultBranchId, defaultTerminalId}`.
   - Inactive cashier → 403 «الحساب موقوف».
2. **Owner** (`POST /api/admin/login`): email + password → `authenticate_admin` RPC (bcrypt, token-gated) → admin session + device session (role `admin`) + store snapshot incl. `code`.
3. **Mock logins** (`lib/posLogin.ts`): `ahmed/1234`, `mahmoud/9999` (cashier), `layla/1111` (inventory_clerk), `suspended/0000` (inactive); owner `admin@demo.test` / `12345678`, store `MAIN01`, branch `branch-main`, terminal `terminal-main`.
4. **Logout** (`POST /api/admin/logout`) clears BOTH cookies; `lib/clientLogout.ts` then clears the Zustand session and `window.location.replace("/login")`.

### 2.4 Authorization

- **Root proxy** (`proxy.ts`): `PUBLIC_PATHS = ["/login", "/register", "/super-admin"]`. Only a valid device session unlocks app paths; authenticated users on `/login` are bounced to their role home. Route↔role mapping is `deviceCanAccessPath`/`homePathForDevice` in `lib/permissions.ts` (e.g. `inventory_clerk` → only `/mobile/*`; cashiers → `/pos`; others → `/admin`).
- **Server route guards** (`lib/requestAuth.ts`): `StoreAccess` (any valid device session in its store), `AdminAccess` (admin session), `CapabilityAccess` (admin or staff with a capability). `authorizedStoreId(request)` is the standard tenant resolver.
- **Tenant header**: `x-pos-store-id` (`STORE_HEADER`, `lib/tenant.ts`) + `x-pos-super-admin-pin`. Client `posFetch` (`lib/tenantClient.ts`) stamps headers merge-safely from the module-level `currentStoreId`.
- **Capabilities & limits** (`lib/permissions.ts`): full list in `STAFF_CAPABILITIES`; role codes `cashier | senior_cashier | accountant | inventory_clerk | inventory_manager | store_manager`. `StaffLimits` = `maxDiscountPercent, maxRefundAmount, maxPriceReductionPercent, maxCashVarianceWithoutApproval`. Admin bypasses all limits. Capabilities are cached offline and re-checked server-side on protected routes.
- **Secondary auth** (`components/auth/SecondaryAuthModal.tsx` + `confirmSecondaryAction`): destructive actions (`open_drawer`, `cancel_invoice`, `save_cashier`, `delete_cashier`, `approve_discount`, `toggle_return_mode`) re-verify the owner's dashboard password against `POST /api/admin/reverify` before running (cashier upserts self-verify on the owning endpoint instead). No stored password anywhere.
- **PIN lockout** (F3): 4-digit PIN brute-forceable in ≤10k tries → escalating cooldown. Constants: `PIN_MAX_ATTEMPTS = 5`, `PIN_LOCKOUT_BASE_MS = 30_000`, `PIN_LOCKOUT_CAP_MS = 30min`, exponential backoff `min(cap, base·2^level)`. Persisted so reload can't reset it.
- **Ops token gate** (migration 015): all privileged RPCs (`provision_new_store`, `authenticate_admin`, `update_admin_credentials`, `delete_store`) require `PLATFORM_OPS_SECRET`-derived `ops_token` from `platform_secrets`; direct PostgREST calls get `42501`. Placeholder `{{PLATFORM_OPS_SECRET}}` substituted by `db/migrate.mjs`.

### 2.5 Audit

`admin_audit_logs` is append-only (BEFORE UPDATE OR DELETE trigger raises). Action types: `OVERRIDE_PRICE, CANCEL_INVOICE, OPEN_DRAWER, SAVE_CASHIER, DELETE_CASHIER, ENTER_RETURN_MODE, ADJUST_STOCK, CREATE_SUPPLIER_INVOICE, RECORD_SUPPLIER_PAYMENT, SHIFT_VARIANCE, SHIFT_VARIANCE_APPROVED, SHIFT_STALE_RESOLVED, REVIEW_RISK_EVENT, SAVE_PRINT_TEMPLATE, DELETE_PRINT_TEMPLATE, UPDATE_RECEIPT_LOGO`. Admin identity resolved server-side from `x-pos-admin-email`, never client-supplied. Client pushes via `lib/audit.ts` `pushAudit`.

---

## 3. Zustand State & Offline-First Sync

### 3.1 Store

`store/usePosStore.ts` (2613 lines), persisted as `pos-store` localStorage v1 (`POS_PERSIST_NAME`, `POS_PERSIST_VERSION = 1`), rehydration restores `tenantStoreId`.

Key state groups (see `PosStoreState`, line 125):
- **Catalog**: `categories, products, barcodes, barcodeIndex, quickKeys, customers` + `catalogUpdatedAt/customersUpdatedAt` + `customersLoading`.
- **Cart/runtime**: `items, totals, invoiceDiscount, deliveryFee, isReturnMode, returnReference, isCompleting, lastCompletedInvoice`.
- **Shift**: `shiftState, shiftTotals, shiftTransactions`.
- **Session**: `currentCashier, cashiers, pinSalt, pinFailCount, pinLockedUntil, pinLockoutLevel, currentStore, runtimeStoreId, adminSession, stores, branches, terminals, activeBranchId, activeTerminalId`.
- **UI/modal flags**: `isCheckoutModalOpen, isHoldModalOpen, checkoutSession, isCloseShiftModalOpen, isDebtSettlementModalOpen, isExpenseModalOpen, isSmartSearchOpen, isAdminHubOpen, isSecondaryAuthOpen, pendingSecondaryAction, isPreviousInvoicesModalOpen, isAuditLogOpen, lineEditTarget`.
- **Online state**: `isOnline, pendingSyncCount`.

`partializePosState` persists runtime store id, shift state/totals/transactions, current cashier/store, admin session, items, totals, held invoices, return mode, discounts, delivery fee, PIN lockout — **not** `notice`.

Key actions:
- `applyLoginPayloadToStore` (line 776): sets tenant, maps branches/terminals, boots catalog/customers from cache, resets runtime if the tenant changed (`shouldResetRuntimeForTenant`), sets `currentCashier {…, sessionReady:true}` for staff.
- `hydrateCatalog` (line ~2200): merges server snapshot into memory + IndexedDB, coalesced per store, exposes `isOnline`; falls back to cached/boot catalog with an error notice when offline and uncached.
- `loginCashier(pin)` — offline PIN unlock; rejects `admin`/`مدير` roles (owner has no PIN). `staffLogin` / `adminLogin` / `loginAsOwner` / `lockScreen` (line 2114) / `selectTerminal` (line 2124).
- `requestSecondaryAuth` / `confirmSecondaryAction` (line 2305/2311) — see §2.4.
- `saveCashier`/`deleteCashier` (lines 2522/2562) — self-verifying password, then `/api/admin/cashiers`, then re-hydrate catalog.

### 3.2 Offline queue (IndexedDB)

`lib/idb.ts` — DB `pos_local_db` v3, stores: `sync_queue` (keyPath `sync_id`, index `status`), `catalog_cache`, `customer_cache`.

- `enqueueSync(record)` stamps `storeId = getTenantStoreId()`.
- `getSyncsByStatus("PENDING")`; `markSyncCompleted`; `deleteSyncs`; `markSyncAttemptFailed` (counts only on 2xx-not-acked, never on network failure).
- `isQueueRecordForTenant`: **a record may only sync/count while the active tenant is the one that enqueued it; unbound records never sync.**
- `patchSyncRecordPayload` — used to stamp ISTD results back onto pending invoices.
- Catalog/customer caches are per-tenant (`store:<id>` keys) with synchronous localStorage "boot mirrors" (`pos-catalog-boot:*`, `pos-customer-boot:*`) so a cold reload can hydrate instantly before the async read.

### 3.3 Sync engine

`services/syncService.ts`: `BATCH_SIZE = 50`, endpoint `/api/sync`, `MAX_SERVER_ATTEMPTS = 8`; single-flight module lock; parses `{success, synced_ids, rejected[]}`; poison-drop after the cap. `hooks/useBackgroundSync.ts` drives it every `SYNC_INTERVAL_MS = 15_000` plus online/visibility triggers; updates `pendingSyncCount`.

`POST /api/sync` (`app/api/sync/route.ts`, 1070 lines) — the server write-side:
1. Validates shape + `payloadValidationError` (deep numeric NaN/Infinity guard, UUID/string/money helpers `round2/UUID_RE/text/money/uuidOrNull`). Rejects → `{sync_id, reason}`.
2. Mock mode (`!supabase`): simulated latency `POS_SYNC_MOCK_LATENCY_MS` (default 500, 0 for perf tests), accepts all.
3. Live: batch upserts into `sync_events` (ignore duplicates), then per-event **mirrors in strict order**:
   - `recordSalesInvoiceLedger` — writes `sales_invoices` (FK→`sync_events`) + `sales_invoice_items` + `sales_payments` via `ensureInvoiceChildren` (backfill-only, never duplicates). Payment split: CASH/VISA/CLIQ/DEBT single-bucket, SPLIT = `min(amountPaid, total)` cash + remainder visa; empty → UNKNOWN. Gross profit = Σ(adjusted net − cost) + delivery fee. Row reused on retry (verify + backfill).
   - `stampCarriedIstd` — backfills `istd_uuid/qr/submitted_at` carried on the payload by the fast-path.
   - `recordDebtLedger` — DEBT sales raise `customers.balance`, SETTLEMENTs capped at current balance; idempotency marker `sync:<sync_id>` in the transaction description; upserts customer by id then name.
   - `recordLoyaltyEarn` — `awardLoyaltyPoints` keyed by sync_id.
   - `recordExpenseLedger` — deterministic id upsert (ignore duplicates).
   - `applyInvoiceStock` — per line `record_inventory_movement` RPC with idempotency key `invoice:<sync_id>:<line>`; `p_allow_negative: true` (Phase 1: sales never blocked by stock); deterministic failures (P0002 product missing, 22023 barcode/unit) skip the line and **keep the sale**; marks `inventory_postings`.
   - `recordInvoiceRiskSignals` for INVOICE_CREATED.
4. **SHIFT_CLOSED is finalized in a second pass** (`finalizeShiftClose`): recomputes drawer math from the now-complete ledger (`computeShiftLedgerSums`), overwrites the stored payload (blind count → authoritative), upserts `shift_reports` (`approval_status = PENDING` if variance ≠ 0), records SHIFT_VARIANCE risk + audit entries.
5. If any invoice arrived, `void runIstdCatchUp(storeId, 5)` (detached).

### 3.4 Cross-tab

`hooks/useCrossTabSync.ts` keeps multiple register tabs consistent.

---

## 4. POS Sales Flow (end-to-end)

### 4.1 Layout & gating

`components/pos/PosLayout.tsx`:
- Mounts the four engines: `usePosHotkeys()`, `useCrossTabSync()`, `useBackgroundSync()`, `useBarcodeScanner()`.
- **`RegisterGate`** (components/pos/RegisterGate.tsx): when no `currentCashier`, shows the register lock. Redirect-guard `LOCK_REDIRECT_KEY = "pos.lock.redirect"`, `LOCK_REDIRECT_RECENT_MS = 5000`, module-level `lockRedirectAttempted` guard.
- Staff without `pos.sell` but with `backoffice.access` are routed to their back-office path; `inventory_clerk`-style roles get a "dashboard role" screen with a lock button.
- Header shows cashier name + role badge (مالك when admin), branch/terminal, online status + pending-sync count, shift-close button (when `pos.close_shift`), reprint-last-receipt, drawer-open (admin), Admin Hub, back-office link, lock.
- Return mode banners a destructive red strip (F6 exits).
- Hardware settlement after each completed sale: auto open drawer (CASH/SPLIT only) + auto print, single-flight per invoice (`handledHardwareInvoice` ref), reprint bar when auto-print off.
- Scanner focus management: keeps `#pos-barcode-input` focused on pad clicks, never `preventDefault` (preserves text selection/drag).
- Sound cues via `lib/posSound.ts` (primed on first pointerdown/keydown; ERROR notices play a descending alert).

### 4.2 Scanning

- **Keyboard wedge** (`hooks/useBarcodeScanner.ts`): constants `SCAN_MAX_GAP_MS=60`, `SCAN_MAX_DURATION_MS=600`, `SCAN_MIN_LENGTH=3`, `SCAN_AVG_KEYS_MS=30`, `SCAN_MAX_BUFFER=128`; hands off to editable targets (INPUT/TEXTAREA/SELECT/contentEditable); requires OPEN shift + cashier + no modal. `lib/scanCoalesce.ts` (`SCAN_COALESCE_MS=120`) drops a duplicate scan of the same code within 120ms (double-scan guard).
- **Camera** (`components/mobile/BarcodeScanner.tsx`): `BrowserMultiFormatReader` restricted to 1D retail formats (EAN/UPC/Code128/Code39/ITF/Codabar); stream stopped on delivery + unmount; `prevEnabled` render-phase reset pattern; torch toggle.
- `scanBarcode` (store): matches `barcodeIndex`, adds line with multiplier-aware pricing/tax, emits success sound; unknown barcode → error notice (and on mobile the add-product flow).

### 4.3 Cart

- `addQuickKeyItem` / `addSearchItem` (Ctrl+K smart search) / `updateQty` / `removeItem` / `addQuickItem` (ad-hoc name+price+barcode line).
- Per-line discount (`applyDiscount`): ITEM scope = % or amount over `qty·unitPrice`; invoice scope = % or amount over gross. `DISCOUNT_PERCENT_APPROVAL = 10`, `DISCOUNT_AMOUNT_APPROVAL = 50` — beyond those, without an active owner session, opens secondary auth (`approve_discount`). Negative (return) lines cannot be discounted. `commitDiscount` recomputes `computeTotals` with `effectiveTaxPercent`.
- `setDeliveryFee` — optional surcharge.
- Holds (`holdInvoice`/`restoreInvoice`) + `HeldInvoicesModal` (keyed by `modalSession` to remount fresh).
- Totals via `computeSaleTotals`/`computeFiscalBreakdown` (`lib/saleMath.ts`): `roundMoney`, `normalizeTaxPercent` (fallback 16), `discountAmount`, proportional `allocateInvoiceDiscount`, VAT-inclusive semantics.

### 4.4 Checkout

`CheckoutModal` → `completeCheckout(paymentMethod, amountPaid, customerName?, customerId?, customerPhone?)` (line ~1148):
- Guards: non-empty cart, total ≠ 0, open shift, valid method.
- Methods `CASH | VISA | CLIQ | DEBT | SPLIT`. SPLIT = `min(amountPaid, total)` cash + remainder card; DEBT requires a customer name.
- Updates `shiftTotals` buckets (`cashSales, visaSales, cliqSales, debtSales, debtCollections, totalSales, discounts, returns (total<0), expectedCashInDrawer`), then queues an `INVOICE_CREATED` `SyncQueueRecord` (payload shape in §4.5).
- `isCompleting` guards double-submit; success sets `lastCompletedInvoice`, plays success cue, and — when online — fire-and-forget `pushInvoiceToIstd(syncId)` (see §5).
- Returns produce negative `total`, reversed bucket math, `isCancellation` reversal records for voids.

### 4.5 Invoice payload (`InvoiceCreatedPayload`)

`items[{productId, barcode, name, unitName, unitPrice, qty, multiplier, variantLabel, discount, discountPct, lineTotal, cost?}], subtotal, tax, discount, deliveryFee, total, paymentMethod, amountPaid, change, customerName?, customerId?, customerPhone?, originalInvoiceId?, isCancellation?, cashierId?, cashierName?, shiftId?, branchId?, terminalId?, completed_at, istd_uuid?, istd_qr?`

### 4.6 Returns & voids (admin)

- **Return by invoice** (`beginReturnByInvoice`, line 1806): looks up the settled invoice in IndexedDB, verifies not already returned, negates each line using the **fiscal split** (`computeFiscalBreakdown`) so the refund equals the discounted net (never the pre-discount gross — prevents silent over-refund), sets `isReturnMode` + `returnReference`, clears invoice discount/delivery fee.
- **Void** (`cancelInvoice`, line 2395): builds a full reversal record (`total: -abs(total)`, `amountPaid: -abs(...)`, `change: 0`, `isCancellation: true`, `originalInvoiceId`) and enqueues it; double-void guarded by `isInvoiceReturned`.
- Both are gated behind secondary auth; both append audit entries.

---

## 5. Fiscal / ISTD (JoFotara) Pipeline

### 5.1 QR generation

- `lib/qr.ts`: `buildJordanQrBase64` / `renderJordanQrSvg` — JoFotara TLV tags 1–5 (seller name, TIN, date, total, VAT amount), 2dp, Base64 BER encoding, no `-0`. `effectiveTaxPercent`.
- Local receipt always carries the TLV QR; once ISTD clears, the official QR replaces it.

### 5.2 Server-side ISTD

- `lib/istdIntegration.ts` (server-only, multi-tenant): `TenantTaxSettings {storeId, taxNumber, istdClientId, istdClientSecret}`; `configured()` requires non-empty taxNumber + istdClientId; `IstdError {code, status}`; prod `https://backend.jofotara.gov.jo`, sandbox `https://sandbox.jofotara.gov.jo`; credentials loaded **per call** from `tenant_tax_settings`, never from `.env`.
- `lib/istdSync.ts`: single-writer claim model. Constants `CLAIM_DUE_BACKOFF_MS = 10_000`, `FAST_PATH_TIMEOUT_MS = 8_000`. Statuses `submitted | already | pending | not_configured | failed`. `submitInvoiceToIstdOnce`:
  1. `ensureIstdClaim` (INSERT-only, `last_attempt_at` 60s in the past so it's immediately due; `23505` = another worker owns it).
  2. `takeIstdAttempt` — atomic conditional UPDATE to `SUBMITTING` where status ∈ (PENDING, FAILED, SUBMITTING) AND `last_attempt_at < now − 10s`; exactly one row wins.
  3. On success: `markOutcome` (`SUBMITTED` + uuid/qr) + `persistIstdResult` onto `sales_invoices`.
  4. Non-winner `readIstdResult` (SUBMITTED → `already`).
- `runIstdCatchUp(storeId, limit=5)`: newest-unsubmitted invoices (`istd_uuid IS NULL`, `is_cancellation = false`, `total > 0`) each tick, stops on first hard failure; called detached from `/api/sync`.
- Claim rows keyed by `sync_id` in `istd_submissions` — deliberately **no FK** to `sales_invoices` (claim must exist before the mirror row).

### 5.3 Fast path

`lib/clientIstd.ts` `pushInvoiceToIstd(syncId)` → `POST /api/istd/submit` (validates `UUID_RE` sync_id + payload; `400 invalid_json / invalid_sync_id / invalid_payload`). Fire-and-forget, timeout-bounded. Result patches the queued payload (`patchSyncRecordPayload`) so `/api/sync` later stamps it via `stampCarriedIstd`.

---

## 6. Shift Management

### 6.1 Open

`OpenShiftModal` (full-screen, non-dismissible while shift CLOSED): branch/terminal picker + starting cash → `openShift` → enqueues `SHIFT_OPENED`.

### 6.2 Close

`CloseShiftModal`: **blind count** — the cashier types `actualCash` before any expected/variance is shown (variance only surfaces to the owner later in `/admin/shifts`). `canClose` requires finite ≥ 0 and `!isCompleting`. `closeShift` → enqueues `SHIFT_CLOSED` with `startTime`, `closeTime`, starting cash, bucket sums, `actualCash`; then `void lockScreen()`.

### 6.3 Server finalization

`finalizeShiftClose` (see §3.3 step 4) is authoritative: `expectedCashInDrawer = startingCash + cashSales − expenses + debtCollections`, `variance = actualCash − expected`. Recomputes from the shift-bound ledger (ignores the device-supplied sums), overwrites the stored event, upserts `shift_reports` with `approval_status PENDING` on variance ≠ 0, records `SHIFT_VARIANCE` risk + audit. DB triggers make the financial columns immutable.

### 6.4 Stale shift recovery

`resolve_stale_shift` RPC (migration 047): an owner can close a shift with no close event after 24h; creates a synthetic `SHIFT_CLOSED` + `shift_reports` row (`close_source = 'ADMIN_RECOVERY'`), writes `SHIFT_STALE_RESOLVED` audit + `STALE_SHIFT` risk (auto-REVIEWED). Guarded to service_role. Exposed via `/api/shifts/[id]/resolve`.

### 6.5 Variance approval

`approve_shift_variance` RPC (migration 046): note (3–500 chars) required, sets `APPROVED`, writes `SHIFT_VARIANCE_APPROVED` audit, marks the matching risk event REVIEWED. Exposed via `/api/shifts/[id]/approval`.

### 6.6 Admin views

- `/admin/shifts`: X/Z reports, `VarianceBadge` («زيادة»/«عجز»/«مطابق»).
- `/admin/risk`: risk engine events with review actions (`review_risk_event` RPC → `REVIEWED | DISMISSED | ESCALATED`).

---

## 7. Database Schema & API Map

### 7.1 Tables (by migration)

- `001_initial_schema` (products/categories/… base), `002_sync_events_schema`, `003_production_schema_sync` (idempotent convergence: `total_stock`, `is_quick_key`, `multiplier`, `selling_price`; seeds).
- `004` **`customers`, `customer_transactions`** (ذمم ledger; positive balance = owes store; `SALE_DEBT` debit / `SETTLEMENT` credit).
- `005` **`expenses`** (petty cash out of drawer), **`suppliers`**, **`purchase_orders`**, **`purchase_order_items`** (PO pending→received).
- `006` **`stores`** (tenant registry: `name, owner_name, email, phone, subscription_status active|suspended`), **`super_admins`** (PIN); backfills `store_id` on all core tables → multi-tenant isolation.
- `008` **`loyalty_events`** + `customers.loyalty_points`, `stores.loyalty_enabled / points_per_spend / point_value`.
- `009` `stores.tax_percent` (0 = tax-free), `stores.tax_number`.
- `010` **`branches`**, **`terminals`** (branch→terminal), unique `(store,name)` / `(branch,name)`; backfills main branch/terminal per store; `sync_events.branch_id/terminal_id`.
- `013` **`admin_audit_logs`** append-only (trigger).
- `015` **`platform_secrets`** + ops-token gate on RPCs (§2.4).
- `016` PIN hardening (`pin_salt`, `pin_hash`), `017` owner/cashier separation, `018` owner name, `019` delete_store hardening.
- `021` **`sales_invoices`** (+ children `sales_invoice_items`, `sales_payments`), `delete_store` (token-gated cascade), indexes.
- `022` **`product_brands`** + product master 2.0 (`tax_percent`, `tax_included`, `is_active`, `show_in_pos`, `is_sellable`, `is_purchasable`, `allow_price_change`, `reorder_level`), barcode `wholesale_price`, `is_default_sale/purchase` (unique partial indexes), line tax columns on `sales_invoice_items`.
- `023` catalog references, `024` **`inventory_movements`** + `inventory_postings` + `record_inventory_movement` RPC (atomic balance, idempotency key, `p_target_balance`, `p_allow_negative`, balance-math CHECK), opening-balance backfill.
- `025–030` sales-ledger/reporting backfills, `029` profitability statement, `030` reconciliation.
- `031` **`supplier_invoices`, `supplier_invoice_items`, `supplier_payments`** + RPCs `create_supplier_invoice`, `record_supplier_payment`, `list_supplier_invoices`, `supplier_accounting_summary` (accounts payable; checks `total = subtotal + tax`, `balance_due = total − paid`).
- `032` RPC hardening, `033` server-only data API, `034` global defaults, `035` receipt layout customization.
- `037` CLIQ, `038` delivery fee + customer phone, `040` categories parent hierarchy (`parent_id`, `bg_color`, `is_quick_key`, `sort_order`).
- `041` accounting profit consistency, `042` **`print_templates`** (RECEIPT / BARCODE_LABEL, tenant-scoped, single default per kind, seed trigger), `043` atomic templates + audit.
- `045` **`staff_roles`** (RBAC, per-store, `capabilities TEXT[]`, `limits JSONB`, seed trigger `seed_default_staff_roles`), cashiers `role_id` FK + owner/staff CHECK.
- `046` **`shift_reports`** (immutable financials trigger, `approval_status NOT_REQUIRED|PENDING|APPROVED` with consistency CHECK) + **`risk_events`** (event types, severity, score 0–100, status, unique `(store_id, event_key)`) + `approve_shift_variance`, `review_risk_event` RPCs + X/Z backfill.
- `047` stale-shift recovery (see §6.4), `048` missing-invoice reconciliation, `049` mobile: `stores.code` (6-char random, unique), `provision_new_store` 6-arg + `inventory_clerk` role (`catalog.add` only).
- `050` **`tenant_tax_settings`** (store_id PK, tax_number, istd_client_id, istd_client_secret; service_role only).
- `051` **`istd_submissions`** (sync_id PK, store FK, PENDING/SUBMITTING/SUBMITTED/FAILED, `last_attempt_at`; **no FK to sales_invoices**); `sales_invoices.istd_uuid/istd_qr/istd_submitted_at`.
- `052` cashiers `username` (per-store unique, lower) backfill; `053` cashiers `is_active` default TRUE; `054` store `code` format `^[A-Z0-9]{4,12}$` + 7-arg `provision_new_store(…, p_code, p_token)` with custom-code uniqueness; `055` perf indexes.

### 7.2 API map

**Auth / provisioning**
- `POST /api/login` — staff login (§2.3). `GET /api/admin/login`? no — `POST /api/admin/login` — owner login.
- `POST /api/admin/logout` — clears both cookies. `POST /api/admin/reverify` — owner password re-check.
- `POST /api/auth/register` — closed door → 403 «إنشاء المتاجر يتم عبر لوحة مدير النظام فقط».
- `GET/POST /api/admin/stores`, `GET/POST/DELETE /api/admin/stores/[id]` — Super-Admin store provisioning (calls `provision_new_store`).
- `GET /api/access` — capability/session probe (used by `probeStaffCapability`).

**Catalog & inventory**
- `GET /api/catalog` — full snapshot (`PosSnapshot`) with `ETag`/304; live Supabase or mock (§3).
- `GET /api/catalog/references` — brands/suppliers refs. `POST /api/catalog/products` — create/update product. `GET/PATCH/DELETE /api/catalog/products/[id]`.
- `GET /api/catalog/products/barcode` — barcode lookup. `POST /api/catalog/import` — CSV/Excel import. `GET /api/catalog/labels` — barcode-label print data.
- `GET /api/inventory/movements` — stock card.

**Sales & fiscal**
- `POST /api/sync` — event-sourcing write-side (§3.3). `POST /api/istd/submit` — fast-path ISTD (§5.3).
- `GET /api/reports/sales`, `GET /api/reports/sales/[id]`, `GET /api/reports/sales/export` — Sales Ledger.
- `GET /api/reports/overview`, `GET /api/reports/profitability`.

**Debts, loyalty, expenses**
- `GET/POST /api/customers`, `GET /api/customers/[id]/transactions`, `GET/POST /api/loyalty`, `GET/POST /api/expenses`.

**Shifts & risk**
- `GET /api/shifts`, `POST /api/shifts/open`, `POST /api/shifts/[id]/resolve` (stale), `POST /api/shifts/[id]/approval` (variance), `GET /api/risk`.

**Ops**
- `GET/POST/PATCH/DELETE /api/branches`, `/api/branches/[id]`, `/api/terminals`, `/api/terminals/[id]`; `/api/suppliers`; `/api/purchase-orders`; `/api/supplier-accounts`, `/api/supplier-accounts/[id]`; `/api/admin/cashiers` (POST/DELETE); `/api/admin/roles`; `/api/admin/audit`; `/api/admin/account` (credentials update); `/api/settings`, `/api/settings/tax`, `/api/settings/logo`; `/api/print-templates`, `/api/print-templates/[id]`; `/api/stores`.

### 7.3 RPC inventory

`provision_new_store`, `authenticate_admin`, `update_admin_credentials`, `delete_store` (all ops-token gated), `record_inventory_movement`, `create_supplier_invoice`, `record_supplier_payment`, `list_supplier_invoices`, `supplier_accounting_summary`, `seed_default_staff_roles`, `approve_shift_variance`, `review_risk_event`, `resolve_stale_shift`, `award_loyalty_points`, `generate_store_code`, helpers `safe_jsonb_numeric` / `safe_jsonb_timestamptz`, triggers `prevent_admin_audit_mutation`, `protect_shift_report_financials`, `seed_staff_roles_after_store_insert`, `seed_store_print_templates`.

---

## 8. Verification

- `npm run verify` → runs `tests/run.mjs`: builds (or `--skip-build`), starts `next start` on `VERIFY_PORT` (default 3100) with mock env (`POS_FORCE_MOCK=1`, `POS_SYNC_MOCK_LATENCY_MS=0`), and exercises end-to-end flows. **All green at last run.**
- `--live` flag targets a real Supabase instance.

---

## 9. Critical Evaluation (remaining gaps / judgment calls)

These are deliberate, code-visible decisions worth flagging before further work:

1. **No RLS — grants + service_role only.** The schema relies on `REVOKE/GRANT` to anon/authenticated/service_role and the ops-token gate. RLS is only enabled on `print_templates`. Every tenant-scoped query filters `store_id`; this is consistent but means a single leaked service key compromises all tenants. (Acknowledged in migration 015/033.)
2. **Client-side PIN unlock is brute-force-resistant only via lockout.** `pin_hash = sha256(pin + pin_salt)` ships in the catalog snapshot, so offline unlock is client-side; the escalating lockout is the mitigation. Server never stores the plaintext PIN.
3. **Stock can go negative by design.** Phase 1 explicitly allows a sale to decrement `total_stock` below zero (`p_allow_negative: true`) — accounting never blocks a sale; replenishment is expected to catch up. Inventory managers see negative stock as a signal.
4. **Mirror ordering is a 2-phase commitment, not a transaction.** A partial failure ACKs only what mirrored; each mirror is independently dedupe-safe. The single risk is a mirror that *looks* idempotent but isn't — mitigated by explicit checks (`ensureInvoiceChildren`, description markers, unique partial indexes).
5. **ISTD is best-effort.** Fast-path fire-and-forget + 5-item/tick catch-up; no backpressure on total volume. `istd_submissions` has no FK to the invoice (deliberate), so cleanup/orphan logic is owned by catch-up.
6. **`close_event_id` FK is `ON DELETE RESTRICT`** — a store wipe must delete `shift_reports` before `sync_events` (handled in the latest `delete_store`).
7. **Owner/staff trust boundary** is clean (owner has no PIN; staff never reach password flows), but secondary-auth password re-entry happens per destructive action with no rate-limit cooldown at the UI level beyond the HTTP layer.
8. **Mock catalog** (`lib/mockCatalogData.ts`) still exists for mock-mode; the live path (`/api/catalog` with Supabase) is the production shape. Keep both green.

---

*Generated by opencode from a full source read. Paths/line numbers are accurate to this revision.*
