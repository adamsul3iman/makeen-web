# TECH_DEBT_BLUEPRINT.md

**Repo:** `MAKEEN POS` (`C:\Projects\pos`)
**Audit date:** 2026-08-24
**Mode:** Read-only overnight audit. No application code was modified. This document is the only file created.
**Scope:** `app/`, `components/`, `hooks/`, `lib/`, `store/`, `services/`, `types/`, `electron/`, `scripts/`, `_legacy_api/`, build config, repo hygiene. ~50,300 first-party LOC measured across app/components/hooks/lib/store/services/types.

---

## 1. Architecture snapshot (context for every finding below)

| Layer | Choice |
|---|---|
| Framework | Next.js **16.3.0**, React 19.2, `output: "export"` (fully static) |
| Targets | Electron desktop, Capacitor Android, PWA |
| Data | Supabase accessed **directly from the client** via `lib/*Client.ts` modules; offline-first queue in IndexedDB (`lib/idb.ts`) replayed by `lib/syncMirror.ts` ("faithful port of the removed /api/sync route" per its own header) |
| State | Zustand + persist (`store/usePosStore.ts`, `store/useReceivingStore.ts`) |
| Routing guard | `proxy.ts.disabled` — the Next 16 `proxy` convention (successor of deprecated `middleware`) exists but is **disabled** |

Because the app is a static export, there is no server at runtime: no API routes can execute and `proxy.ts` can never run. Everything below must be read against that reality.

---

## 2. Executive summary

The codebase is in better shape than its file sizes suggest (strict TS, near-zero `any`, real test suite, disciplined client-layer pattern) — but it carries five structural debts that compound daily:

1. TypeScript build checking is **switched off at build time** while broken code is committed.
2. A single **3,900-line God Store** owns auth, cart, shifts, fiscal compliance and sync.
3. The **tax-authority QR encoder exists twice**, line-for-line.
4. The entire **dead Serverless API surface (59 route files)** is still tracked, still typechecked, and imports a module that no longer exists.
5. Money-rounding logic (`round2`) is **copy-pasted 13 times** in a point-of-sale system.

---

## 3. MUST FIX (P0) — correctness, safety, or actively rotting

### P0-1. `typescript.ignoreBuildErrors: true` — type safety disabled where it matters most
- **Evidence:** `next.config.ts:8`
- **Impact:** `next build` silently succeeds on any type error. This is why dead/broken files (see P0-4) survive unnoticed. Every future refactor gets a false green light. In a POS that computes VAT, totals and ledgers, the compiler is the cheapest auditor you have.
- **Fix:** Remove the flag. Run `npx tsc --noEmit`, fix what surfaces (most of it will be `_legacy_api/`, which disappears with P0-4). Add a CI gate so it never comes back.

### P0-2. God Store: `store/usePosStore.ts` (~3,880 lines)
- **Evidence:** One single `create<PosStore>()` call containing ~198 state fields and ~234 actions/state mutators spanning, by grep evidence:
  - cart & checkout (`CompletedInvoice`, discounts, payment buckets)
  - **authentication for three personas** (POS login, staff login, admin login — lines ~2700–3100, incl. debug logs `"🔥 RAW LOGIN STORE ERROR"`)
  - shift lifecycle (open/close/resolve), cash movements, debt settlement, expenses
  - ISTD/JoFotara fiscal submission & retry (`retryPendingIstd`)
  - catalog & customer cache bootstrapping, shortage flags, sync-queue plumbing
- **Impact:** Any change risks breaking any domain; persist-rehydration surface is huge; merge conflicts guaranteed; untestable in isolation; new devs cannot form a mental model.
- **Fix (blueprint):**
  1. Split with the Zustand **slices pattern** — keep one store identity, compose reducers:
     `authSlice`, `catalogSlice`, `cartSlice`, `shiftSlice`, `moneySlice` (cash/debt/expense), `syncSlice`.
     Auth does not belong in a POS cart store under any naming scheme.
  2. Move pure computations out of actions into `lib/saleMath.ts`-style pure modules (already started — finish it).
  3. Apply `persist` with explicit `partialize` per slice instead of persisting a monolith.
  4. Target: no slice > 400 lines; store file becomes composition only.

### P0-3. Duplicated fiscal-QR encoder — tax-compliance code forked
- **Evidence:** `lib/qr.ts` vs `lib/qrGenerator.ts`. Both contain identical doc comments, identical `tlvField()`, identical Base64 TLV builders (`buildFiscalQrBase64` ≡ `buildJordanQrBase64`) and byte-identical SVG renderers (`renderFiscalQrSvg` ≡ `renderJordanQrSvg`). Consumers are split: `store/usePosStore.ts` → `qr.ts`; `ThermalReceipt.tsx` + `istdIntegration.ts` → `qrGenerator.ts`.
- **Impact:** This prints the legally required ISTD QR on every receipt. If one copy gets a fix (rounding, encoding, tag order) and the other doesn't, you ship non-compliant invoices from half the code paths. Classic drift bug waiting for an audit.
- **Fix:** Keep one canonical module (suggest `lib/fiscalQr.ts`), re-export old names temporarily if needed, delete the twin. Add a unit test pinning the TLV output for a known invoice.

### P0-4. Dead Serverless API left behind by the migration — and it's rotting
- **Evidence:** `_legacy_api/**` — **59 `route.ts` files across 26 resource folders**, git-tracked. Zero references anywhere in live code (grep across all first-party dirs). It contains at least one import of a deleted module: `@/lib/mock` (missing). Because `tsconfig.json` includes `**/*.ts`, these files are still fed to `tsc`/IDE tooling today.
- **Impact:** Broken, unreachable code that still costs compile time, pollutes global search, confuses navigation ("which API is real?"), and fails typecheck once P0-1 is fixed.
- **Fix:** `git rm -r _legacy_api/`. If historical reference matters, it lives in git history — that's what history is for. Do not keep "just in case" copies as tracked source.

### P0-5. Route protection disabled; guard strategy undocumented
- **Evidence:** `proxy.ts.disabled` — a complete, documented role-based routing guard (unauthenticated → `/login`, role→area enforcement) using the current Next 16 `proxy` convention (verified against bundled docs: `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md` — `middleware` is formally deprecated).
- **Impact:** With `output: "export"` this file could never run anyway; enforcement currently rests entirely on client-side gating (`AuthGate.tsx`, `permissions.ts`). For an app moving money, having a written-down threat model for "static export = no server-side guard" is mandatory. Right now the decision is implicit in a renamed file.
- **Fix:** Make an explicit decision and record it:
  - Either delete `proxy.ts.disabled` and document the client-guard model + Supabase RLS as the actual security boundary (RLS becomes P0-critical then — audit it),
  - Or drop static export for a hosted deployment where the proxy runs.
  A `.disabled` file is not an architecture decision; it's an unanswered question.

### P0-6. Production domain types/constants imported from a mock file
- **Evidence:** `app/admin/debts/page.tsx:26–29`, `app/admin/suppliers/page.tsx:18`, `app/admin/expenses/page.tsx:11–15`, `components/pos/ExpenseModal.tsx:6` all import from `@/lib/mock-admin-data` — including runtime constants (`EXPENSE_CATEGORIES`, `EXPENSE_CATEGORY_LABELS`) and types (`CustomerLedger`, `SupplierLedger`, `ExpenseEntry`) used by **live pages backed by real clients** (`customersClient`, `expensesClient`).
- **Impact:** The name screams "safe to delete", so one cleanup sprint will break three admin pages. Real domain vocabulary lives in the wrong layer.
- **Fix:** Move shared domain types to `types/` and category constants to a `lib/expensesConstants.ts`-style module. Then either reduce `mock-admin-data.ts` to genuine fixtures for tests/storybook or delete it.

---

## 4. SHOULD FIX (P1) — structural quality, consistency, cost of change

### P1-1. God Components / oversized files (>800 lines)

| File | Lines | Composition (evidence) | Suggested split |
|---|---|---|---|
| `app/admin/inventory/page.tsx` | ~1,140 | pagination, filtering, CSV export, skeletons, table, modals | extract `useInventoryTable()` hook + `InventoryTable`, `InventoryFilters`, export util |
| `app/admin/categories/page.tsx` | ~1,110 | 5 components in one file: `CategoryModal`, `BrandModal`, `CategoryColumnItem`, `SortableCategoryColumnItem`, page | one file per component; page becomes layout + data wiring |
| `components/mobile/MobileReceiving.tsx` | ~930 | scanning, negotiation shield, multi-payment math, supplier creation, logout, local money helpers | split `LineCard` tree (already started internally), payments panel, supplier modal; logic to `useReceivingPayments()` |
| `components/pos/PosLayout.tsx` | ~820 | POS shell + drawers + panels orchestration | extract drawer components; keep layout dumb |
| `app/admin/shifts/page.tsx` | ~780 | shift list + detail + resolution flows | detail view component + `useShiftResolution()` hook |
| `components/admin/ProductModal.tsx` | ~760 | create/edit + variants + barcodes + validation | variant editor subcomponent; form schema to lib |
| `lib/reportsClient.ts` / `lib/idb.ts` | ~1,080 / ~1,020 | client-layer monoliths mirroring page domains | split per report domain / per object store |

Rule of thumb going forward: **a page file is routing + composition; anything past ~300 lines is extracted UI or a hook.**

### P1-2. Business logic living in UI components
- **Direct DB access bypassing the client layer:** `app/admin/purchases/page.tsx` calls `getSupabaseBrowser().from("purchase_order_items")` (line ~61–66) and `.from("products")` (line ~149–153) inside the component, while the rest of the app goes through `purchasesClient.ts`. Two data-access styles in one app = two places to fix every bug. Move these queries into `purchasesClient.ts`.
- **Money math copy-paste:** `const round2 = ...` defined **13×** across `pages`, `CheckoutModal.tsx`, `loyalty.ts`, `paymentBuckets.ts`, `priceMemory.ts`, `receiving.ts`, `syncMirror.ts`, both QR files, etc. `formatMoney` is re-implemented in `MobileReceiving.tsx:63` despite `lib/format.ts`. `parsePrice` is local to components. In a POS, rounding rules are business policy — centralize into `lib/money.ts` (`round2`, `formatMoney`, `parsePrice`, `toFixedMoney`) and import everywhere. One definition, unit-tested once.
- **Aggregation in render paths:** brand aggregation/grouping inside `QuickKeysGrid.tsx:~284` and `CategoryDrawer.tsx` — move to memoized selectors/hooks (`useGroupedQuickKeys`).

### P1-3. Dead UI code
- `components/ui/DataTable.tsx` (~171 lines): **zero imports** (alias or relative).
- `components/ui/Input.tsx`: **zero imports**.
- Fix: delete both. `AdminDataTable` covers the need (4 consumers).

### P1-4. Unused dependencies
| Package | Verdict | Evidence |
|---|---|---|
| `papaparse` + `@types/papaparse` | **unused** | 0 imports across app/components/lib/store/services/electron/scripts/tests |
| `dotenv` | **unused** | 0 imports; scripts use native `node --env-file=.env` (package.json:29) |

`npm rm papaparse @types/papaparse dotenv`.

### P1-5. Repository hygiene (tracked noise)
Git-tracked files that are clearly transient:
- Logs: `start.log`, `start2.log`…`start5.log`, `store-test-{err,error,out,output}.txt`
- Scratch/diff dumps: `before_after.txt`, `before_after2.txt`, `dryrun048.mjs`
- One-off data dump: `Makeen_Import_Ready.json`

Untracked clutter accumulating at root (add ignore rules / relocate):
- **12 × `dist-final-*` timestamped Electron builds**, `dist-electron*`, `.artifacts/`, `.codex-artifacts/`, `test-results/`, stray xlsx files, `.venv/`
- `scripts/_*.mjs` — nine underscore-prefixed throwaway probes (`_excel.mjs`…`_prices2.mjs`, `_investigate.mjs`) plus `legacy_sales_audit.py` (Python in a TS repo). Archive or delete; they also drag `xlsx` usage that makes dependency auditing harder.
Fix: purge from index (`git rm --cached`), extend `.gitignore`, adopt a `scripts/archive/` convention with deletion discipline.

### P1-6. Debug leftovers in production logging
- `usePosStore.ts:2766` `"🔥 RAW LOGIN STORE ERROR"` and friends (16 `console.error` in the store alone). Introduce a tiny logger wrapper (levels, no emojis, strip in prod builds) — especially before shipping auth-error text to kiosk consoles.

---

## 5. NICE TO HAVE (P2)

1. **`xlsx@0.18.5`** — the frozen npm channel of SheetJS (known CVE history fixed only in later CDN releases); used by inventory export + several scripts. Plan an upgrade path or isolate behind a wrapper module.
2. **`services/` directory is vestigial** — one 128-line file + `.gitkeep` while the real client layer lives in `lib/*Client.ts`. Fold `syncService.ts` into `lib/` and remove the directory.
3. **Naming clarity post-dedupe:** after merging the QR twins (P0-3), rename survivors to intent-based names (`fiscalQr.ts`) — neither `qr.ts` nor `qrGenerator.ts` says "ISTD tax QR".
4. **76 sequential SQL migrations** — consider squashing into a baseline snapshot for fresh installs; keep the chain only for existing deployments.
5. **Type-source discipline:** `types/database.types.ts` (generated?) vs hand-written `types/pos.types.ts` — document which is generated and how to regenerate, so hand-edits don't fight `supabase gen types`.
6. **ESLint depth:** config is stock Next defaults. Once P0-1 lands, add `no-restricted-imports` guards (e.g., forbid importing `mock-*` outside tests, forbid `@supabase/supabase-js` outside `lib/` clients) to make the architecture self-enforcing.

---

## 6. Strengths worth preserving (so the refactor doesn't destroy them)

- `strict: true` TypeScript with effectively zero `any` in the core store.
- Clean client-layer pattern (`*Client.ts`) everywhere except purchases page — the exception proves the rule.
- Genuine offline-first design: idempotent sync queue, poison-record counting, deep payload validation in `syncMirror.ts`.
- Lazy-loading the ~90KB `qrcode` library out of the eager bundle (documented in-code).
- Extensive verification scripts (`npm run verify:*`) and a real migration toolchain in `db/`.
- `.env*` correctly gitignored; secrets not in VCS.

---

## 7. Suggested execution order (each step independently shippable)

1. `git rm -r _legacy_api` + purge tracked junk (P0-4, P1-5) — zero-risk, immediate.
2. Remove `ignoreBuildErrors`, fix remaining type errors (P0-1).
3. Deduplicate fiscal QR + add golden-output test (P0-3).
4. Extract money utils, replace 13 `round2`s (P1-2) — mechanical, high value.
5. Move mock-file constants/types to their real homes (P0-6).
6. Delete dead `DataTable`/`Input`, unused deps (P1-3, P1-4).
7. Slice the God Store (P0-2) — biggest effort; do last, behind the now-restored type checker.
8. Decide and document the guard strategy (P0-5) — needs a product/security decision, not code.

---

*End of blueprint. Generated autonomously; all findings verified against working-tree evidence (file reads, greps, line counts, git index queries) rather than assumption.*
