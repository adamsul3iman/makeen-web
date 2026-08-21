# QA / Security Audit — POS App (mock mode)

**Date:** 2026-08-07 (F-1 → F-5 remediated same session) · **Updated:** 2026-08-08 (F-6 remediated, PIN hardening verified, register-lockout E2E)
**Scope:** `C:\Projects\pos` — Next.js POS, audited in **mock mode** (no Supabase).
**Method:** Static deep-dive of the full app surface + verified Playwright E2E flows against a live `next start` server.
**Result:** QA suite 4/4 green; modal-close regression spec 11/11 green. All six findings (F-1 security, F-2 modal stacking, F-3 cross-tab sync, F-4 Esc, F-5 cash pre-fill, F-6 duplicate modal keys) were **fixed and regression-tested**.

---

## 1. Environment under test

- Mock mode forced via `.env.production` (blank `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY`), so `lib/supabase.ts` returns `null` and every API route uses its mock fallback.
- Live server: `next start -p 3199` at `http://127.0.0.1:3199`.
- Playwright `@playwright/test` (installed `--no-save`) with system Chrome.
  - Required launch flag: `--disable-features=Serial`, otherwise `openCashDrawer()` opens the native Web Serial port chooser and the secondary-auth modal hangs in "جارٍ التحقق…".
- Test harness: `tests/qa.audit.config.mjs` + `tests/qa.audit.e2e.mjs` (1 worker, 120s timeout).

### Mock fixtures
| Entity | Value |
|---|---|
| Admin login | `admin@demo.test` / `12345678` |
| Store / branch / terminal | `store-main` / `branch-main` / `terminal-main` |
| Cashier (مدير) | Ahmad, PIN `1234` |
| Cashier (كاشير) | Mahmoud, PIN `9999` |
| Product | كاسات بلاستيك 7 أونص — barcode `12345` — 0.15 |
| Product | ماء معدني 500 مل — barcode `6250000987654` — 0.25 |
| Tax (mock) | 16% (`TAX_RATE` / `effectiveTaxPercent`) |
| Money format | `toLocaleString("en-US", {2 decimals}) + " د.أ"` |
| Persisted store key | `pos-store` (zustand persist, version 1) |

---

## 2. E2E flow results

| Flow | Coverage | Status |
|---|---|---|
| **FLOW 1** | Store provisioned via `/super-admin` (PIN 7777) → self-registration closed (`/register` 403, informational page) → owner admin login (email + password) → owner opens the register directly from the welcome screen (no PIN) → creates the first cashier → cashier unlocks the register with its PIN → open shift | ✅ Pass |
| **FLOW 2** | Admin mode bar → Admin Hub (Ctrl+Shift+A, Esc closes) → drawer secondary auth (wrong password, Esc, correct password) → invoice scan/checkout → void via Previous Invoices + secondary auth | ✅ Pass |
| **FLOW 3** | Admin Hub → "إدارة الكاشير" → create cashier (secondary auth via pointer click — F-2 fixed) → PIN-only cashier login → admin revoked after lock (F-1 fixed) → `/admin` denied → lock-screen `logoutAdmin` (F-1 fixed) | ✅ Pass |
| **FLOW 4** | F3 inertness → 50× scan merge (total `8.70 د.أ` = 7.50 + 16%) → quick-cash `10.00` → live 3-tab cart sync (F-3 fixed) | ✅ Pass |
| **X-close (F-6)** | Opens each of 11 modals (AdminHub, SmartSearch, Checkout, HeldInvoices, CloseShift, DebtSettlement, Expense, Discount, CashierManage, PreviousInvoices, AuditLog), clicks its scoped إغلاق/إلغاء button, asserts the modal unmounts | ✅ Pass |

---

## 3. Findings

### F-1 — Lock screen does NOT revoke the admin session (Security / Medium) — ✅ FIXED
- Original: `lockScreen: () => set({ currentCashier: null })` cleared **only** the cashier; `adminSession` survived (persisted via `partialize` at `usePosStore.ts:1711`), so after a lock the next PIN holder kept the admin top bar, the Admin Hub hotkey (gated only by `adminSession`, `usePosHotkeys.ts:58`) and `/admin` access (`AdminGuard.tsx:24-29`). `logoutAdmin()` existed (`usePosStore.ts:1385`) but was not wired to any UI.
- **Fix:** `lockScreen` now also clears `adminSession` (`store/usePosStore.ts`), and the lock screen (`components/pos/PinLogin.tsx`) exposes a "تسجيل خروج المدير" button that calls `logoutAdmin()` when an admin session is present.
- **Regression test (FLOW 3):** after lock → unlock with PIN 9999, "وضع المدير" is hidden, Ctrl+Shift+A does not open the hub, `/admin` redirects to `/login`, and the lock-screen sign-out button revokes the session.

### F-2 — Modal stacking: SecondaryAuthModal overlays the staff/auth modals (UI / Medium) — ✅ FIXED
- Original: `PosLayout.tsx` rendered `<SecondaryAuthModal/>` before the management modals, all `fixed … z-50`, so the underlying dialog intercepted pointer events on the auth "تأكيد" button (verified by an `elementFromPoint` probe; only Enter worked).
- **Fix:** `SecondaryAuthModal` is now rendered **last** in `PosLayout` and its backdrop uses `z-[60]`, above every other z-50 modal.
- **Regression test (FLOW 3):** the `elementFromPoint` probe now resolves to the button itself ("تأكيد"), and `confirmSecondaryAuth` submits via a real pointer click (Enter workaround removed).

### F-3 — No live cross-tab cart sync (Architecture / Low) — ✅ FIXED
- Original: zustand **v5.0.14** `persist` registers no `storage` event listener, so a cart mutation in one tab never live-updated another open tab (only a reload rehydrated).
- **Fix:** new `hooks/useCrossTabSync.ts` (mounted in `PosLayout`) listens for the `storage` event and patches the shared business fields (`items`, `totals`, `invoiceDiscount`, `isReturnMode`, `heldInvoices`, `shiftState`, `shiftTotals`, `shiftTransactions`) into the store in every other open tab.
- **Regression test (FLOW 4):** scans in tab2/tab3 now appear live in tabs 1/2; persisted state stays shared.

### F-4 — Esc does not dismiss SecondaryAuthModal (UX / Low) — ✅ FIXED
- Original: only the "إلغاء" button or a backdrop click closed it; Esc was inert (verified in FLOW 2).
- **Fix:** `components/auth/SecondaryAuthModal.tsx` now registers an Escape keydown handler (while open) that calls `cancelSecondaryAuth` and clears the form.
- **Regression test (FLOW 2):** Esc now closes the auth modal.

### F-5 — Cash amount is not pre-filled with the invoice total (UX / Observation) — ✅ FIXED
- Original: `CheckoutModal.tsx` initialized `amount = ""`; the CASH confirm button stayed disabled until the cashier typed or clicked a quick-cash amount.
- **Fix:** `CheckoutModal.tsx` now initializes `amount` from `totals.total` (lazy `useState`, guarded for negative return totals). The modal remounts on every open via `key={checkoutSession}`, so the pre-fill always reflects the current invoice.
- **Regression test (FLOW 2):** the amount field asserts `0.46` and the confirm button is clickable with no manual input.

### F-6 — X (إغلاق) buttons do not close their modal (Regression / High) — ✅ FIXED
- Reported: clicking the X close button on open modals (Smart Search, Admin Hub, Held Invoices, …) left the dialog on screen even though the store flag flipped to `false`.
- Root cause: `PosLayout.tsx` rendered **every** modal sibling with the same `key={modalSession}` (SmartSearchModal, AdminHubModal, HeldInvoicesModal, CloseShiftModal, DebtSettlementModal, ExpenseModal, DiscountApprovalModal). React requires **unique keys among siblings**; with duplicate keys, reconciliation is undefined and only the **last** sibling receives state updates/remounts — every modal earlier in the DOM never unmounted when its store flag became `false`. Diagnostic instrumentation (store/modal `console.log` probes, `data-instance` markers, minimal repro) confirmed `closeSmartSearch()` ran, state flipped, and the DOM backdrop stayed. Swapping SmartSearch/AdminHub render order inverted the failure, proving the duplicate-key root cause.
- **Fix:** unique per-modal keys — `key={`checkout-${checkoutSession}`}`, `key={`held-${modalSession}`}`, `key={`close-${modalSession}`}`, `key={`debt-${modalSession}`}`, `key={`expense-${modalSession}`}`, `key={`discount-${modalSession}`}`, `key={`search-${modalSession}`}`, `key={`hub-${modalSession}`}` (`components/pos/PosLayout.tsx`).
- **Regression test:** new `tests/modal-close.e2e.mjs` opens all 11 modals, clicks each modal's scoped إغلاق/إلغاء button, and asserts the modal unmounts — **11/11 green**.

---

## 4. Security observations (good posture)

- **Secondary auth never stores the password** — every guarded action re-verifies via `/api/admin/reverify` or server-side on the cashier upsert (`components/auth/SecondaryAuthModal.tsx:13-20`).
- **Generic auth errors** — wrong secondary-auth password shows "تعذر التحقق — تحقق من كلمة المرور أو الاتصال" (no user/password enumeration). Verified in FLOW 2.
- **API surface** (`/api/catalog`, `/api/admin/cashiers`, `/api/admin/reverify`, `/api/admin/audit`, `/api/sync`, `/api/auth/register`) all carry mock-fallback + authz checks in mock mode.
- **`AdminGuard`** uses `useSyncExternalStore` for a hydration-safe mount flag — no SSR/localStorage-at-build-time pitfalls, and the client-only redirect path is sound.
- **Hotkey surface is minimal** — `usePosHotkeys.ts:110` only binds Ctrl+Shift+A (adminSession-gated) and Esc; **F3 is not bound** (verified inert in FLOW 4: no dialog, cart unchanged).

---

## 5. Remediation applied

| Fix | File(s) | Change |
|---|---|---|
| F-1 | `store/usePosStore.ts` | `lockScreen` also clears `adminSession` |
| F-1 | `components/pos/PinLogin.tsx` | lock screen "تسجيل خروج المدير" button → `logoutAdmin()` |
| F-2 | `components/pos/PosLayout.tsx` | `SecondaryAuthModal` rendered last |
| F-2 | `components/auth/SecondaryAuthModal.tsx` | backdrop `z-[60]` (above all z-50 modals) |
| F-3 | `hooks/useCrossTabSync.ts` (new) + `PosLayout.tsx` | `storage` listener patches shared cart/shift state into other open tabs |
| F-4 | `components/auth/SecondaryAuthModal.tsx` | Escape keydown handler closes the modal |
| F-5 | `components/pos/CheckoutModal.tsx` | `amount` lazily initialized from `totals.total` (remount per open via `checkoutSession` key) |
| F-6 | `components/pos/PosLayout.tsx` | unique per-modal sibling keys (`checkout-`, `held-`, `close-`, `debt-`, `expense-`, `discount-`, `search-`, `hub-` prefixes) |
| F-6 | `tests/modal-close.e2e.mjs` + `tests/modal-close.config.mjs` (new) | regression spec: X closes all 11 modals |

Verification: `npx tsc --noEmit` clean, `npx eslint` clean, QA suite **4/4 green**, modal-close spec **11/11 green**.

---

## 6. PIN hardening (per-cashier salt + device lockout) — verified

Plaintext PINs are no longer stored anywhere. `db/migrations/016_pin_hardening.sql` (applied to the live DB) adds `pin_salt` (16 random bytes, hex) and `pin_hash` (`sha256(pin || pin_salt)`), makes `pin` nullable, backfills legacy rows, and re-seeds `provision_new_store` so new stores get salt+hash from the start.

- **Online verify** (`app/api/login/route.ts`): finds the cashier by `sha256Hex(pin + salt) === pin_hash` (legacy `pin` fallback); no `WHERE pin = …`.
- **Admin add/update** (`app/api/admin/cashiers/route.ts`): mints a fresh random salt, stores salt+hash, never persists plaintext.
- **Catalog snapshot** (`app/api/catalog/route.ts`): ships per-cashier `pinSalt`/`pinHash` so the offline register verifies identically.
- **Register unlock wiring** (`components/pos/PinLogin.tsx`): the lock screen now unlocks **offline** via `loginCashier` (sha256 vs hydrated snapshot) whenever cashiers are loaded, falling back to the online `/api/login` route only during catalog bootstrap. Previously the lock screen called the online route directly, so the device lockout was never enforced on the actual register.
- **Bootstrap path** (`store/usePosStore.ts`): `loginStore` now honours the same lockout — rejected before any fetch while locked, and a 401 counts toward the 5-failure escalation (success resets the counters, mirroring `loginCashier`).
- **Device lockout**: 5 consecutive failures set `pinLockedUntil` with escalating cooldown (30s base → 30min cap); success resets. Persisted via zustand `partialize`, so lockout survives reloads.
- **Lock-screen feedback** (`components/pos/PosLayout.tsx`): the notice toast used to be rendered *after* the `if (!currentCashier) return <PinLogin/>` early return, so the lockout message was invisible while the register was locked. The toast is now rendered above the lock screen too (and remains z-above all modals via `z-[70]`).
- **Live proof**: `scripts/e2e_lifecycle_audit.mjs` asserts the seeded admin cashier has `pin IS NULL`, a 32-hex `pin_salt`, and `pin_hash === sha256('1234' + salt)` — **40/40 ALL GREEN** against the real Supabase DB (store auto-deleted in `finally`).
- **Unit proof**: `tests/store.workflows.ts` **358/358** (incl. locked PIN rejected while locked, and `loginStore` rejected without fetch while locked).
- **E2E proof**: `tests/pin-lockout.e2e.mjs` **1/1** — drives the real lock screen: 4 wrong PINs rejected, 5th trips the 30s lockout toast, `pinLockedUntil`/`pinLockoutLevel` persisted, the correct PIN is still rejected while locked, and the lockout survives a full reload.

## 7. Repro commands

```powershell
# build + server (mock mode)
npx next build
node node_modules/next/dist/bin/next start -p 3199

# QA suite (F-1 → F-5 flows)
node node_modules/@playwright/test/cli.js test --config=tests/qa.audit.config.mjs

# F-6 modal-close regression spec
node node_modules/@playwright/test/cli.js test --config=tests/modal-close.config.mjs

# PIN hardening: unit suite (offline lockout + hash verify)
npm run verify:store

# PIN hardening: register lockout E2E (5 wrong -> locked toast -> correct PIN rejected -> survives reload)
node node_modules/@playwright/test/cli.js test --config=tests/pin-lockout.config.mjs

# PIN hardening: live lifecycle audit (real Supabase, server on 3101)
#   server: node scripts/start-live.mjs start 3101   (restart if 429 trips)
BASE_URL=http://127.0.0.1:3101 npm run verify:e2e
```

Note: the suite is full-order dependent (single worker, shared `pos-store` localStorage across flows); run as-is, not filtered.
