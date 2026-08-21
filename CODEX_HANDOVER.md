# CODEX_HANDOVER — MAKEEN Overhaul (feature/pos-architecture-revamp)

> Read me first. This file logs every change made by Open Code during the
> "MAKEEN" overhaul so you (Codex) can pick up exactly where things left off.

## Branch

- Active branch: `feature/pos-architecture-revamp` (forked from the original
  `feature/makeen-overhaul`, which was created from `main` at `d2d49bd`).
- Phases 1–4 below happened on `feature/makeen-overhaul` and were fast-forward
  merged into live `main` (`d2d49bd..cdfb376`), plus two pushed hotfixes
  (`f9cda84`, `0e2df65`). The 3-zone redesign + performance work (Phase 5)
  lives on `feature/pos-architecture-revamp` and is NOT yet merged to `main`.

## Prime directive honoured

- Nothing that was passing live QA has been broken on purpose.
- No sale is ever blocked for 0/negative stock; stock now decrements into
  negative integers on the server.
- Verify after merge with: `npm run verify` (builds, boots server, runs
  api/security/hardware/store suites) and `npm run verify:e2e`.

---

## Phase 1 — Smart Inventory & Non-Blocking Checkout

### 1a. Server-side stock posting now allows negative balances

- File: `app/api/sync/route.ts`
- Function changed: `applyInvoiceStock()`
- Change: the `record_inventory_movement` RPC call now passes
  `p_allow_negative: true`. Previously a sale that would drive `total_stock`
  below 0 raised `insufficient_stock`, the sync event was NOT acked, and the
  POS kept retrying (blocking the sale's mirror). Now sales decrement freely
  into negative integers (e.g. -5).
- The POS client (`store/usePosStore.ts` → `completeCheckout`) never blocked
  on stock; this was purely a server-side gate.
- DB note: `db/migrations/024_inventory_movement_ledger.sql` already exposes
  `p_allow_negative BOOLEAN DEFAULT FALSE` — no schema migration required.

### 1b. Negative Stock widget ("نواقص المخزون") in the Admin dashboard

- File: `types/reports.types.ts`
  - Added `ReportsNegativeStock` interface:
    `{ productId, name, stock }`.
  - Added `negativeStock: ReportsNegativeStock[]` to `ReportsOverview`.
- File: `app/api/reports/overview/route.ts`
  - Both builders (`buildOverview` and `buildOverviewFromLedger`) now return a
    `negativeStock` array (products with `total_stock < 0`, ascending by
    stock) alongside the existing `dataQuality` count. Also added to
    `mockOverview()` so dev/mock mode renders the widget.
- File: `app/admin/page.tsx`
  - Added a new dashboard card **"نواقص المخزون"** listing products with
    negative stock. Each row shows the product name, current (negative) stock,
    and an inline physical-count input.
  - The physical count submits `POST /api/inventory/movements` with
    `mode: "COUNT"`, `quantity`, `productId`, and a reason. COUNT uses
    `p_target_balance` server-side, which OVERWRITES the negative balance with
    the new non-negative count (this is the exact behaviour required: physical
    count replaces the negative integer).
  - Empty state shown when there are no negative-stock products.
- Reused existing endpoint: `app/api/inventory/movements/route.ts` (no change
  needed — COUNT mode already overwrites balance via `p_target_balance`).

## Phase 2 — POS Hardware UI Optimization (15" & 9.7" touchscreens)

- File: `components/pos/PosLayout.tsx`
  - Confirmed/kept the fluid shell: `h-screen w-screen flex-col overflow-hidden`
    — no global scrolling; only internal panels scroll.
  - Primary action bar, header, product grid and cart already use internal
    `overflow-y-auto`; added touch-friendly sizing where too small.
- File: `components/pos/InvoicePanel.tsx`
  - Cart rows now `min-h-[3rem]` (48px) touch target.
  - Qty / discount / delete icon buttons bumped to 48px (`h-12 w-12`).
  - Barcode input row and footer buttons raised to ≥48px (`min-h-12`).
- File: `components/pos/QuickKeysGrid.tsx`
  - Quick-key buttons are 96px tall (`h-24 min-h-24`) — kept.
- File: `components/pos/ActionBar.tsx`
  - Primary action buttons already `h-16` (64px) — kept.

## Phase 3 — "MAKEEN" Rebranding & Logo Integration

- Palette:
  - `app/globals.css`: `--pos-primary` changed to emerald `#10b981`
    (emerald-500), `--pos-primary-hover` → `#059669` (emerald-600).
    Structure stays slate-900. All `bg-primary`/`text-primary` components
    inherit the new emerald accent automatically.
- New component: `components/shared/Logo.tsx`
  - Renders `<img src="/logo.png" alt="MAKEEN" />` with responsive sizing.
  - **DO NOT generate SVG** (per spec) — the file uses a plain `<img>`.
  - NOTE: the original logo image could not be read by the model
    (`C:\Users\adam\Downloads\IMG_3458.PNG`). Copy it to `public/logo.png`
    before deploy, otherwise the logo renders as a broken image.
- Brand text replacement:
  - `app/layout.tsx` — root metadata title/description now MAKEEN-branded.
  - `app/pos/layout.tsx` — route metadata MAKEEN-branded.
  - `components/pos/PinLogin.tsx` — "نظام نقاط البيع" → "MAKEEN"; icon tiles
    replaced with `<Logo />` in all three modes (no-store / owner / cashier).
  - `components/pos/OpenShiftModal.tsx` — "نظام نقاط البيع" → "MAKEEN";
    icon tile → `<Logo />`.
  - `app/login/page.tsx` — unified sign-in heading → "MAKEEN"; icon tile →
    `<Logo />` (replaces the deleted legacy `components/admin/AdminLogin.tsx`).
  - `components/admin/AdminShell.tsx` — sidebar brand tile → `<Logo />` +
    "MAKEEN" lockup; header brand likewise.
  - `app/super-admin/page.tsx` — "منصة نقاط البيع" → "MAKEEN".
- Functional uses of "كاشير/الكاشير" (cashier/register role & terminal) were
  deliberately NOT renamed — they are domain terms, not the product name.

## Phase 4 — Small-Screen Responsive Fixes (POS layout on narrow windows)

Triggered by: POS UI broke at smaller window widths — overlapping cart
controls, overflowing product names, crushed bottom action buttons, and the
green "Pay" label wrapping onto multiple lines.

- File: `components/pos/QuickKeysGrid.tsx`
  - Grid is now strictly responsive: `grid-cols-2 md:grid-cols-3 lg:grid-cols-4`
    (was fixed `grid-cols-3 md:grid-cols-4 xl:grid-cols-5`).
  - Product names clamp to 2 lines: `line-clamp-2 text-sm` (long names like
    heavy detergents no longer overflow the box).
  - Variant and unit/price lines use `max-w-full truncate`.
  - Buttons use `min-h-24` (not fixed `h-24`) so they grow to fit clamped text.
- File: `components/pos/InvoicePanel.tsx`
  - Cart rows: qty controls container now `shrink-0`; unit-price column now
    `w-24 shrink-0`. The name block stays `min-w-0 flex-1` + `truncate`, so
    long names truncate instead of overlapping quantity/price/delete buttons.
- File: `components/pos/ActionBar.tsx`
  - Footer is now a horizontally scrollable no-wrap container:
    `flex-nowrap overflow-x-auto scrollbar-hidden` — buttons keep their
    dimensions and the bar scrolls instead of crushing.
  - Every button + the status box is `shrink-0`; all button text is
    `whitespace-nowrap` (the "Pay/الدفع" label can no longer wrap). Icons are
    `shrink-0` too.
  - Pay button keeps `flex-1` with `min-w-0` + `px-4` so it still fills
    available space on wide screens and never collapses on narrow ones.

## Verification run before commit

- [x] `npm run lint` — clean.
- [x] `npm run build` (Next 16.3.0 / Turbopack) — 53 routes, OK.
- [x] `npm run verify -- --skip-build` — ALL GREEN
  (api 258 + security 16 + hardware 14 + store 359 = 647 checks, 0 failed).
- [ ] `npm run verify:e2e` — NOT run: requires a live Supabase server and
  provisions+deletes a real store in production. Run it after deploy.

## Follow-ups for Codex

1. Copy the official logo to `public/logo.png`.
2. Re-run `npm run verify` and `npm run verify:e2e` after the logo copy.
3. Consider a DB migration note documenting that negative stock is now
  intentional (sales can drive `total_stock` below 0). No schema change is
  required — `p_allow_negative` already existed.

---

## Phase 5 — POS 3-Zone Architecture & Performance Hardening
### (branch `feature/pos-architecture-revamp`)

Triggered by: live users on narrow windows reported cart controls crowding,
prices/buttons misaligning between rows, and layout shifting while scanning.
A user-provided spec required a "world-class 3-zone desktop-first POS" with
zero changes to business logic, cart math, stock/negative-stock validation,
F-key handlers, or barcode scanning.

### 5.1 Three-zone layout (Money Zone / Smart Catalog / Action Bar)

- File: `components/pos/PosLayout.tsx`
  - Desktop POS is split into exactly three zones:
    1. **Money Zone** — `InvoicePanel` (cart) rendered first in the RTL DOM,
       i.e. visually on the right.
    2. **Smart Catalog** — `QuickKeysGrid` (product quick keys), the primary
       interactive surface.
    3. **Action Bar** — slim secondary `ActionBar` above the grid (status pill,
       مصروف, سداد ذمة F7, مرتجع F6, إغلاق الوردية F10).
  - Shell is `h-screen overflow-hidden`; only inner panels scroll. A safety
    `overflow-x-auto scrollbar-hidden` on the main row keeps everything
    visible below the min widths instead of wrapping or clipping.
  - Headers compacted (`py-1.5`), controls `min-h-10`/`h-10`, main area
    `p-3 gap-3`.

### 5.2 Dynamic + widened cart/invoice panel sizing

- File: `components/pos/InvoicePanel.tsx`
  - The panel grew through iterative tuning:
    - `w-1/3 min-w-[320px] max-w-[420px]` (first stable pass)
    - `w-[30%] min-w-[350px] max-w-[450px]`
    - `w-[35%] min-w-[400px] max-w-[500px]`
    - `w-[40%] min-w-[420px] max-w-[550px]`
    - **final: `w-[42%] min-w-[450px] max-w-[600px] shrink-0`** — multi-item
      rows and qty steppers never wrap or squeeze awkwardly.
  - The grid column (`QuickKeysGrid` + `ActionBar`) takes the remaining
    `flex-1 min-w-0`, so it yields breathing room to the cart.
- File: `components/pos/QuickKeysGrid.tsx`
  - Product cards slimmed for density: `min-h-14`, `gap-0.5`, `px-1`,
    `text-[10px]` meta lines, `line-clamp-2` names, `text-xs md:text-sm`
    labels — compact cards cede horizontal space to the cart panel.

### 5.3 Strict CSS-grid row alignment + tabular numbers (zero layout shift)

- File: `components/pos/InvoicePanel.tsx`
  - `CartRow` is **not** an HTML table. Each row is a strict CSS grid:
    - Row container: `grid grid-cols-[minmax(0,1fr)_auto] items-center
      gap-1.5` — Column 1 = product name + meta (truncates via `min-w-0`),
      Column 2 = controls.
    - Controls are a **fixed-width sub-grid**:
      `grid grid-cols-[36px_24px_36px_36px_36px_64px] items-center gap-1`
      mapping to `− qty + | discount | delete | line total`. Every column is
      a fixed pixel width, so prices and buttons sit on identical vertical
      tracks across all rows regardless of digits/variable text.
  - All money/quantity text uses `tabular-nums` (qty, unit price, line total,
    footer subtotal/tax/discount/total, Pay button) so digits share identical
    advance widths — no width jitter between "3.50" and "10.00".

### 5.4 Performance hardening (heavy-usage rendering stability)

- File: `store/usePosStore.ts`
  - **Memoization-defeating clones removed**: `scanBarcode`, `addQuickKeyItem`
    and `addSearchItem` used `get().items.map((it) => ({ ...it }))`, which
    created a brand-new object reference for EVERY line on every scan/quick
    press — defeating `React.memo` on `CartRow` and re-rendering the whole
    cart on the hottest path. Now `let items = [...get().items]` (shallow
    array copy). Only the touched line is replaced via `applyQtyToLine()`
    (which returns a fresh object); untouched lines keep their reference and
    `memo` bails out. `updateQty` already followed this pattern.
- File: `components/pos/InvoicePanel.tsx`
  - `CartRow` is `memo(function CartRow(...))`, keyed by
    `item.barcode || \`p:\${item.productId}\``. Props are stable (memoized
    item reference, numeric index, stable `setDiscountTarget` setter), so a
    qty/totals change re-renders only the affected row.
  - Footer height is constant: discount rows that appear conditionally stay
    mounted with `invisible` instead of unmounting (`totals.discount > 0 ? ""
    : "invisible"`), so the list never reflows when discounts toggle.
  - `BarcodeScannerInput` extracted as its own memoized component: the
    scanner's `input` state, refs, focus effect, submit handlers and
    `useDeviceHardware` subscription moved out of `InvoicePanel`, so every
    keystroke/scan character no longer re-renders header + footer + the full
    memoized row list.
- File: `hooks/useDeviceHardware.ts`
  - `refresh()` now compares the freshly loaded settings with the current
    state (`JSON.stringify` equality — the struct is tiny) and only calls
    `setSettings` when something actually changed. Previously every storage /
    device event and every mount forced a new object reference, re-rendering
    subscribers even with unchanged settings.

### 5.5 Verification before commit

- [x] `npm run lint` — clean.
- [x] `npm run build` (Next 16.3.0 / Turbopack) — 53 routes, OK.
- [x] `npm run verify -- --skip-build` — ALL GREEN
  (api 258 + security 16 + hardware 14 + store 359 = 647 checks, 0 failed).
- [ ] `npm run verify:e2e` — NOT run: requires a live Supabase server.

### 5.6 Commit trail on `feature/pos-architecture-revamp`

- `c50a118` feat(ui): complete POS structural redesign with protected business logic
- `3a88b5b` fix(ui): stabilize POS layout and fix cart panel rendering jumps/glitches
- `8ea80f3` refactor(ui): widen cart/invoice panel for better product name readability
- `c3de485` refactor(ui): compact cart item rows into clean 2-line layout and widen cart panel
- `7d70f5f` refactor(ui): implement high-density compact POS layout to eliminate cart scrolling and bloat
- `9aa156e` refactor(ui): expand cart panel width bounds and slim product cards for seamless responsiveness
- `7a1f8aa` refactor(ui): enforce strict vertical alignment on cart item rows using CSS grid without borders
- `a5f58b7` refactor(perf): audit and stabilize cart rendering loop and dependency hooks
- `32b3235` fix(security): resolve modal hotkey bypasses (C1/H1), fix ActionBar touch targets (H2), fix currency label (M1)
- `c1d1e16` fix(sync): enforce tenant isolation on the offline sync queue (see §5.8)
- `10d2115` feat(pos): add category quick-bar tabs for instant POS product filtering (see §5.10)
- `ebc1257` refactor(ui): elevate POS quick-keys grid to world-class micro-card design with glass category pills (see §5.10)
- `e8e8c60` refactor(store): preserve invoice discount on returns from discounted invoices (see §5.11)
- `bef64e3` feat(settings): add advanced layout and design customization toggles for thermal receipts (see §5.12)
- `7047ea2` fix(db): resolve schema cache error and redesign receipt into a professional table layout (see §5.12, §5.13)
- `a388545` feat(pos): engineer a world-class, luxury typography thermal receipt design (see §5.14)

### 5.7 Follow-ups for the 3-zone branch

1. Merge `feature/pos-architecture-revamp` into `main` after user sign-off and
   re-run `npm run verify` + `npm run verify:e2e` on the merged tree.
2. Copy the official logo to `public/logo.png` before that merge (the
   `<img src="/logo.png">` in `components/shared/Logo.tsx` needs the exact
   lowercase path; `public/logo.PNG` is the current placeholder).
3. Business invariants touched by Phase 5: none. Cart math
   (`computeSaleTotals`/`computeFiscalBreakdown`), discount approval gates,
   stock posting (`p_allow_negative`), F-key wiring, and barcode scanning are
   byte-for-byte unchanged.

### 5.8 CTO audit — offline sync subsystem (tenant isolation)

Independent audit of the offline sync queue (IndexedDB `sync_queue` →
`processSyncQueue` → `/api/sync`). One critical flaw found and fixed; the
rest of the subsystem held up.

**Critical flaw — cross-tenant queue leak.** `SyncQueueRecord` carried no
tenant; `enqueueSync` stored events unattributed; `logoutAdmin` cleared the
session but never the queue; and `processSyncQueue` drained **all** PENDING
records under whatever `x-pos-store-id` header was active. On a device that
logged into Store A, went offline mid-sale, then logged into Store B, the
next 15s sync posted Store A's invoices/settlements/shifts/expenses to Store
B — silently mutating B's stock, sales ledger, debt balances, loyalty points
and expenses. `listInvoices` (previous-invoices screen) also exposed every
tenant's invoices, and voiding a foreign invoice queued a reversal tagged to
the active store.

**Fix (client-side, no schema migration):**
- `enqueueSync` stamps each record with the active tenant (`storeId`) at
  enqueue time.
- `isQueueRecordForTenant(record, currentStoreId)` is the single scoping rule
  (exact match; unbound records are never synced — they cannot be safely
  attributed).
- `processSyncQueue` drains only the current tenant's records; foreign
  records stay PENDING until that store logs back in (data is never dropped).
- `useBackgroundSync` counts the pending badge per tenant.
- `listInvoices(storeId)` returns only the active tenant's invoices.

**Defense — the rest of the pipeline is sound:**
- Server is fully idempotent per `sync_id` (`sync_events` upsert on
  `sync_id`, sales invoice guarded by `eq sync_id`, stock movements keyed by
  `invoice:<sync_id>:<line>` + `inventory_postings` upsert, debt ledger
  guarded by the `sync:<sync_id>` description marker, expenses by
  deterministic id, loyalty by reference). Cross-tab double-drains (the
  `isSyncing` lock is per-tab, not cross-tab) are therefore harmless — the
  server dedupes and both tabs mark the same ids SYNCED.
- ACK semantics are correct: only events whose mirrors all succeeded are
  returned in `synced_ids`; failed mirrors leave the event PENDING for retry,
  which the idempotency guards make safe.
- Rejected (shape/payload-invalid) events are dropped client-side so corrupt
  rows stop retrying.

**Known limitation (documented, not fixed — needs a live DB to verify):**
`recordDebtLedger` performs a read-modify-write on `customers.balance`. Under
concurrent drains of *different* events for the *same* customer (two tabs of
one terminal syncing overlapping batches), the last writer can clobber an
earlier delta (lost update). Single-tab sequential processing is safe. Fix
path: optimistic lock (`UPDATE ... WHERE balance = <read balance>` + retry,
or a Postgres RPC). Queue it with the Phase 6 debt-ledger work.

### 5.9 Verification before commit (sync audit)

- [x] `npm run lint` — clean.
- [x] `npm run build` (Next 16.3.0 / Turbopack) — 53 routes, OK.
- [x] `npm run verify -- --skip-build` — ALL GREEN
  (api 258 + security 16 + hardware 14 + store 365 = 653 checks, 0 failed;
  store suite gained 6 sync-tenant-scoping checks).

### 5.10 Category quick-bar — instant POS product filtering

New feature on the POS screen: a horizontal category tab bar above the
quick-keys grid.

- `store/usePosStore.ts`: new `activeCategoryId: string | null` state
  (default `null` = "الأكثر طلباً" / all) + `setActiveCategoryId` action.
  State is deliberately **not** persisted (`partialize` omits it) — catalog
  switches/rehydration must never strand the POS on a stale tab.
- `components/pos/QuickKeysGrid.tsx`: tab row between the section header and
  the grid. Tabs = "الأكثر طلباً" (all) + every category that actually owns
  quick keys, sorted by category `sortOrder`, each with a live count badge and
  its category color dot. Empty categories are never rendered as dead-end
  tabs. Selecting a tab filters `quickKeys` by `categoryId` instantly.
  Stale-id safety: if the selected category disappears from the catalog, the
  grid falls back to all instead of a dead-end. Per-category empty state
  ("لا توجد أصناف في هذه الفئة") when a valid tab has no keys. Active tab
  styling is high-contrast (`bg-primary` + inverted badge), RTL-aware
  horizontal scroll (`scrollbar-hidden`).
- No new admin surface needed: the `showInPos` toggle in
  `components/admin/ProductModal.tsx` already gates which products become
  quick keys (server-side in `/api/catalog`), and category `isQuickKey`
  flags flow through the same snapshot.
- `app/admin/inventory/page.tsx`: products now carry a POS-visibility badge —
  "يظهر في نقطة البيع" (green) vs "مخفي عن نقطة البيع" (muted) in the
  desktop table, and a compact "POS"/"مخفي" chip on the mobile card — so
  merchants can see at a glance what the register will display.
- `tests/store.workflows.ts`: new `category quick filter` group (6 checks) —
  default all, tab set, category-scoped key filtering, empty-category edge,
  unknown-id fallback, reset.

Business invariants untouched: cart math, discount gates, stock posting,
F-key wiring, and barcode scanning are byte-for-byte unchanged.

**UI elevation pass (glass + micro-cards):** `QuickKeysGrid.tsx` redesigned to
a world-class register surface — glassmorphic section (`bg-white/70` +
`backdrop-blur`), a floating glass segmented pill bar with glowing active
pills and count badges, a dedicated "المفضلة • الأكثر طلباً" pinned-favorites
shelf (horizontal snap strip, shown when >3 items), and high-density
micro-cards on `grid-cols-4 lg:grid-cols-5 xl:grid-cols-6` with gradient
depth, bold 2-line names, tabular pricing, and a springy staggered entrance
(`pos-pop-in` keyframe in `app/globals.css`). Category switching remounts the
grid (`key={effectiveCategory}`) so every switch animates instantly. No state
or logic changes. `PosLayout.tsx`: added `min-h-0` to the middle zone so the
grid scrolls internally instead of pushing the action bar off-screen.

### 5.11 Stress, concurrency & money-precision audit (final gate)

Principal QA-led audit completed. New `tests/stress.stress.ts` suite runs via
`tsx` (no live services): `fake-indexeddb`, deterministic `mulberry32` PRNG, a
`setTenantStoreId`-stamped `store-main` tenant, and a mocked `globalThis.fetch`
for drain tests (restored in `finally`). Wired as Stage 6 in `tests/run.mjs`
under `verify:stress`.

Groups: multi-role shift (cashier/manager/accountant), rapid cart stress
(2000 ops), concurrent checkout race, sync drain stress, network resilience,
money precision audit, category + modal-guard perf.

**Real defect found & fixed — discounted returns over-refunded.**
`beginReturnByInvoice` (`store/usePosStore.ts:1250`) rebuilt return lines from
the original items' **gross** `lineTotal` while nulling the invoice discount —
so a return of a discounted invoice refunded the pre-discount gross (test
scenario 59.16 invoice → −78.88 return = 19.72 loss). Fix: `beginReturnByInvoice`
re-derives the invoice-level discount (`payload.discount` minus the sum of
per-line discounts, clamped ≥0) and re-runs
`computeFiscalBreakdown(originalItems, invoiceDiscount, tax)` so each negated
`lineTotal` carries its already-allocated share of the original discount
(`-Math.abs(adjustedBasis)`). Returns now refund exactly the discounted net;
per-line `discount`/`discountPct` still cleared on the return lines.

**Test-scenario corrections (expectation bugs, not store bugs):** drawer
invariant now includes expenses (−) and debt collections (+) alongside the Σ
cash portions; the `-0` wire check only asserts that `roundMoney` serializes
genuine ledger outputs (`-0.004`) as `0` while real negatives (`-0.5`) survive
— `roundMoney(-0.0001) === -0` is mathematically correct and no longer
asserted; VAT-inclusive constants reconciled with actual engine semantics
(`computeFiscalBreakdown`: 10 gross incl 16% → net 8.62 + tax 1.38); parity
checks recompute every queued invoice's payload from the queued items with
`derivedInvoiceDiscount`.

**Performance numbers (dev, Turbopack):** 2000 rapid cart ops ≈ 65–98 ms;
300 category switches ≈ 4–6 ms.

**Regression coverage:** `tests/store.workflows.ts` gained the
`discounted return refunds net` group (5 checks) — 25% invoice discount on a
40.00 gross → 34.80 net, full return reverses drawer to starting cash, refund
equals exactly the discounted net, negated lines carry the allocated discount
(±15.00 each).

**Final verification gate — ALL GREEN:** `npm run lint` ✓, `npx tsc --noEmit`
✓, `npm run build` (53 routes) ✓, `npm run verify -- --skip-build` ✓ — API
health 258 + security 16 + hardware 14 + stress 68 + store 376 = **732 checks,
0 failures**. (Store suite grew 365 → 371 → 376 across this phase.)

### 5.12 Receipt layout customization (Store Settings -> Receipt Customization)

Merchants can now fully control the thermal receipt's design elements, saved
per store and honored by the actual print job.

- New `stores` columns (migration `035_receipt_layout_customization.sql`, also
  re-defines `provision_new_store` + `authenticate_admin` so new tenants carry
  the flags in their snapshot): `receipt_show_tax_number` (default true),
  `receipt_show_cashier_time` (default true), `receipt_show_barcode_qr`
  (default true), `receipt_compact_spacing` (default false).
- Wired end-to-end: `types/pos.types.ts` (`Store`), `app/api/settings`
  GET/PATCH, `app/api/login`, `app/api/admin/login`, `app/api/admin/stores`
  (GET/POST).
- `app/admin/settings/page.tsx`: new "عناصر التصميم على الإيصال" toggle grid
  (tax number / cashier + timestamp / footer barcode + QR / compact spacing)
  feeding a live `ReceiptTemplatePreview` that reacts instantly (adds a
  cashier + timestamp row, gates the tax line and the barcode strip, tightens
  spacing when compact).
- `components/pos/ThermalReceipt.tsx`: the real 80mm print respects all four —
  cashier name, exact timestamp and settlement receiver line gate on
  `receiptShowCashierTime`; the tax number line gates on `receiptShowTaxNumber`;
  the footer barcode + invoice id + fiscal QR block gates on
  `receiptShowBarcodeQr`; `receiptCompactSpacing` tightens every divider/item/
  stack margin. Business logic untouched — print-only presentation.
- Tests: `tests/api.health.mjs` +4 checks (toggle presence, PATCH round-trip,
  absent-field defaults).

**Verification — ALL GREEN:** lint ✓, `tsc --noEmit` ✓, `build` (53 routes) ✓,
`verify -- --skip-build` = api 262 + security 16 + hardware 14 + stress 68 +
store 376 = **736 checks, 0 failures**.

**OPERATIONAL — apply migration 035 to the live DB.** Until the new columns
exist in the real `stores` table, saving receipt settings fails server-side
with `Could not find the 'receipt_compact_spacing' column of 'stores' in the
schema cache`. The migration is idempotent (`ADD COLUMN IF NOT EXISTS`); apply
it against the remote database, then force PostgREST to re-read the schema:

1. Apply the pending migrations with the pooler connection string:
   `npm run migrate` (uses `DATABASE_URL` from `.env`), or
   `npx supabase db push`.
2. Reload the PostgREST schema cache — run once in the Supabase SQL editor:
   ```sql
   NOTIFY pgrst, 'reload schema';
   ```
   (Equivalent on self-hosted: restart the PostgREST container, or run
   `curl -X POST http://<host>:3000/rest/v1/rpc/reload_schema` with the service
   role — the NOTIFY form is the standard managed-Supabase path.)
3. Sanity-check the columns exist: `select column_name from information_schema.columns where table_name='stores' and column_name like 'receipt_%';`

### 5.13 Thermal receipt professional table design

`ThermalReceipt.tsx` item list rebuilt as a true 3-column table (RTL grid
`grid-cols-[minmax(0,1fr)_auto_auto]`): **الصنف** (right, flexes) /
**الكمية × السعر** (center, nowrap) / **الإجمالي** (left, nowrap). A dashed
rule separates the bold column header from the item rows; each row carries a
subtle dotted bottom border, and discount/tax hints render as a small second
line under the product name. All numbers use `tabular-nums`. The logo is
centered and capped at `max-h-10` / `max-w-[60%]` so it never blows out the
80mm print width.

The live settings preview lives in `components/print/ReceiptTemplatePreview.tsx`
(shared by the admin settings grid and the print studio) and
mirrors the exact same table grid, sample row, dashed header rule, totals and
payment line — the merchant sees pixel-identical structure to the print. All
four customization toggles still gate the preview + print identically.

> Superseded in layout by §5.14 (the luxury redesign replaces the 3-column
> grid with the flex items table) but kept above as the historical trail entry.

### 5.14 Luxury typography thermal receipt design

`ThermalReceipt.tsx` redesigned into an "Apple Store" hierarchy for 80mm paper,
and `ReceiptTemplatePreview.tsx` mirrors it exactly. Two shared typography
tokens drive every figure and caption:

- `MONEY = "tabular-nums tracking-tight"` — applied to every number
  (prices, qty, totals, date, shift #, tax #).
- `META = "text-[9px] leading-tight text-gray-500"` — faint meta captions
  (contact, date/cashier/shift, discount + tax hints under item names).

Layout highlights:

- Masthead: imposing store name `text-[15px] font-black tracking-tight`,
  logo capped `max-h-10`/`max-w-[60%]`, faint contact / branch / terminal /
  date / shift / cashier block.
- Document title letterspaced `tracking-[0.3em]` (RTL `pr-[0.3em]` optical
  fix on returns/settlements) in muted gray instead of loud black.
- Luxury items table: thick `border-y-2 border-black` frame around the
  **الصنف / الإجمالي** header (9px `font-black tracking-[0.15em]` labels),
  item rows as flex `items-start justify-between` (name right, line total
  left, `shrink-0 whitespace-nowrap`), dotted `border-gray-300` hairlines
  between rows, and qty × price + `خصم`/`ضريبة` hints nested under the name.
- Mini-ledger (`الصافي قبل الضريبة` / `ضريبة المنتجات` / `الخصم`) on a
  dotted top rule — quiet labels, figures speak.
- Grand Total Spectacle: massive `text-2xl font-black leading-none` figure
  inside a heavy `border-y-2` frame with a small gray tracked caption and an
  optional discounted side block (`-خصم`).
- Print engineering preserved: `print:w-[76mm] print:overflow-hidden
  print:grayscale`, `printColorAdjust: "exact"`,
  `WebkitPrintColorAdjust: "exact"`, `textRendering: "optimizeLegibility"`.
- Footer codes unchanged: centered CODE128 barcode (JsBarcode on
  `invoice.syncId`), 8-char sync id, fiscal QR gated exactly as before.
- All four merchant toggles (`receiptShowTaxNumber`, `receiptShowCashierTime`,
  `receiptShowBarcodeQr`, `receiptCompactSpacing`) still gate print and the
  mirrored preview identically; `compact` tunes vertical rhythm via the
  `divider`/`stackGap`/`totalPad`/`itemPad` tokens.





