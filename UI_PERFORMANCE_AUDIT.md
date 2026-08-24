# UI Performance & UX Audit — MAKEEN POS

**Scope:** read-only review of the cashier-facing frontend (`components/pos/*`, `components/shared/*`, `components/ui/*`, `store/*`, `hooks/*`, `lib/*`, `app/pos/*`).
**Lenses:** (1) unnecessary re-renders, (2) main-thread blocking on the cashier critical path (scan → cart → checkout → print), (3) full keyboard / barcode-scanner operability.
**Stack:** Next.js 16 · React 19 · Zustand 5 (persist middleware) · IndexedDB offline queue · Electron desktop target · Arabic RTL UI.

---

## 1. Executive summary

The architecture is fundamentally sound. State flows through one Zustand store consumed exclusively via **atomic selectors** (40 in `PosLayout` alone), there are **zero React context providers** in the codebase, list rows are memoized, the product grid is **virtualized**, persistence is debounced, and printing never blocks the lane behind `window.print()`.

The real risks are concentrated, not systemic:

| # | Severity | Finding | Location |
|---|----------|---------|----------|
| P1-1 | High | Full-catalog Arabic normalization re-run on every search query | `components/pos/SmartSearchModal.tsx:31-66` |
| P1-2 | High | Cart clear delayed behind 2–3 awaits + full-table count at checkout | `store/usePosStore.ts:1760-1769` |
| P2-1 | Medium | Closed modals stay subscribed to hot cart state (null re-renders per scan) | `components/pos/CheckoutModal.tsx:40`, `PosLayout.tsx:810-823` |
| P2-2 | Medium | Whole-catalog `JSON.stringify` + sync `localStorage.setItem` after each catalog refresh | `lib/idb.ts:735-752, 791-798` |
| P2-3 | Medium | CategoryDrawer renders unbounded, non-virtualized result lists; no Arabic normalization | `components/pos/CategoryDrawer.tsx:214-278, 434-562` |
| P2-4 | Medium | 7 hand-rolled overlays have no focus trap / dialog semantics | see §3-P2-4 |
| P3-x | Low | readOnly qty input, missing `prefers-reduced-motion`, radiogroup semantics | see §3-P3 |

---

## 2. Architecture snapshot (verified)

```
Input pipeline
  USB wedge ──► keydown heuristics (hooks/useBarcodeScanner.ts)
                SCAN_MAX_GAP_MS=60 · SCAN_MAX_DURATION_MS=600 · SCAN_MIN_LENGTH=3
                SCAN_AVG_KEYS_MS=30 · SCAN_MAX_BUFFER=128 · isEditableTarget guard
            ──► double-read coalescing 120ms (lib/scanCoalesce.ts)
            ──► omnibar form submit (Enter or configurable Tab,
                components/pos/InvoicePanel.tsx:228-240, lib/deviceHardware.ts)
  F-keys/Ctrl+K ──► hooks/usePosHotkeys.ts (modal-aware via anyPosModalOpen)

State
  store/usePosStore.ts (single store, ~3.9k lines, atomic selectors only)
  persist middleware ──► lib/persistStorage.ts (coalesced 250ms writes,
                         microtask flush on critical sections, usePosStore.ts:744-750)

Offline layer
  lib/idb.ts (IndexedDB v8, source of truth)
    + localStorage boot MIRROR written on every cache save (sync-read at login)
  services/syncService (queue processor), hooks/useBackgroundSync.ts (15s tick)
  hooks/useCrossTabSync.ts (SHARED_FIELDS patching via storage events)

Render tree (app/pos/page.tsx → PosLayout)
  header · ActionBar · main[ InvoicePanel | SpeedDock ] · CategoryDrawer
  13 always-mounted modals (self-nulling) · ThermalReceipt (hidden, print-only)
```

---

## 3. Findings

### P1-1 · SmartSearchModal normalizes the entire catalog on every query

- **Where:** `components/pos/SmartSearchModal.tsx:31-66` (`searchEntries`), entries memo at `:98-120`, debounce at `:96`, forced live rescan on early Enter at `:133-136`.
- **Evidence:** for every debounced query (300ms) the scorer calls `normalizeArabicText(entry.name)` for **every product** (~6,600 per the in-code comment) and — when the name doesn't match — `normalizeArabicText` again for **every barcode and variant label**. That's O(N × string-length) character work per keystroke burst, repeated a second time if the cashier hits Enter inside the debounce window.
- **Impact:** visible input-to-results latency on low-end registers exactly when the cashier is typing fast; grows linearly with catalog size.
- **Fix (architectural):** precompute normalized search keys **once** in the `entries` memo — store `nameKey`, and per-barcode `codeKey`/`variantKey`. `searchEntries` then does raw string comparisons against precomputed keys. Optionally build a first-character bucket index to skip most of the array. The early-Enter path (`:133-136`) automatically benefits since it shares the same function.

### P1-2 · Checkout clears the cart only after extra awaits

- **Where:** `store/usePosStore.ts:1663-1877`; the ordering problem is `:1757-1769` vs the UI reset at `:1842-1857`.
- **Evidence:** current sequence after validation:
  1. `await enqueueSync(record)` — necessary, fine.
  2. `await getSyncsByStatus("PENDING")` then `.length` — **reads every pending record from IndexedDB just to count them** (helper at `lib/idb.ts:511`).
  3. `await upsertPriceMemoryFromPayload(...)` — price-memory learning write.
  4. Only then `set({ items: [], ... })` clears the cart.
- **Impact:** the cashier watches a fully-paid cart for 2–3 IDB round trips on the single hottest interaction of the day. None of it blocks the main thread, but perceived completion latency stacks directly onto receipt printing.
- **Fix (architectural):**
  - Clear the cart immediately after `enqueueSync` resolves; move shift-total updates into the same `set()` and defer everything else.
  - Replace the read-all-then-count with an IDB `count()` on the status index (also fixes the identical pattern in `refreshPendingCount`, which runs every 15s in `hooks/useBackgroundSync.ts`).
  - Do not `await` price-memory learning before the UI reset — fire-and-forget with `.catch()` (its failure must never gate the sale UI; comment at `:1763-1765` already states the intent).

### P2-1 · Closed modals remain subscribed to hot state

- **Where:** `components/pos/PosLayout.tsx:810-823` mounts all modals unconditionally; e.g. `CheckoutModal.tsx:40` selects `totals`, so **every scan re-renders the closed checkout modal** (it returns `null` at `:106` *after* running its hooks). Similar exposure: `HeldInvoicesModal` (`heldInvoices`), `EndShiftModal` (`cashMovements`, `pendingSyncCount`, `isOnline`), `PreviousInvoicesModal` (`pendingSyncCount`).
- **Impact:** small today (~1–3 wasted component executions per scan) but scales with every new modal; each wasted render also re-runs `quickCashOptions`-style module logic only when open, so the cost is hook bookkeeping — cheap, yet avoidable.
- **Fix (architectural):** pick one consistent strategy:
  - Conditional mount in `PosLayout`: `{isCheckoutModalOpen && <CheckoutModal key={`checkout-${checkoutSession}`} />}` — preserves the existing session-reset `key` semantics; **or**
  - Gate the selector: `const totals = usePosStore((s) => (s.isCheckoutModalOpen ? s.totals : EMPTY_TOTALS))` with a stable module-level constant.
  - Note the codebase already demonstrates the correct pattern locally: `InvoicePanel.tsx:473-485` conditionally mounts `DiscountModal` / `QuickItemModal` / `AdminLineEditModal`.

### P2-2 · Boot mirror serializes the whole catalog synchronously

- **Where:** `lib/idb.ts:735-742` (`writeBootCacheSync`) invoked from `saveCatalogCache` (`:745-752`) and `saveCustomersCache` (`:791-798`); read back synchronously at login/store-init (`store/usePosStore.ts:1057-1058`, `:3869-3874`).
- **Evidence:** every remote catalog/customer refresh performs `JSON.stringify(entireSnapshot)` + `localStorage.setItem` on the main thread. For a multi-thousand-product catalog this is multiple MB of serialization — a long-frame jank spike right when hydration lands.
- **Mitigating factors:** frequency is low (per refresh, not per sale); quota failures are silently swallowed with IDB remaining authoritative (`:738-741`).
- **Fix (architectural):** keep the synchronous *read* path (it's what makes login instant) but make the *write* idle-scheduled: wrap `writeBootCacheSync` in `requestIdleCallback`/`setTimeout(0)`, and skip the write entirely when the payload hasn't changed (`updatedAt` compare already available at call sites).

### P2-3 · CategoryDrawer: unbounded, non-normalized search rendering

- **Where:** `components/pos/CategoryDrawer.tsx`
  - `searchResults` memo `:246-278` has **no `LIMIT`**, unlike `SmartSearchModal`'s `LIMIT = 12`.
  - `productsInView` `:214-224` likewise unbounded.
  - Rendered as plain `.map` at `:437-476` and `:549-561` — no virtualizer, in contrast to `QuickKeysGrid.tsx:310-315` (`useVirtualizer`, `estimateSize`, `overscan: 4`).
  - Matching at `:253-261` uses raw `toLowerCase().includes()` — **no `normalizeArabicText`**, so alef/hamza/diacritic variants that match in Ctrl+K search fail here.
- **Impact:** a broad query (e.g., a brand name) can mount hundreds–thousands of `ProductCard`s → long task, layout thrash, scroll jank; inconsistent Arabic search behavior between the two search surfaces confuses cashiers.
- **Fix (architectural):** cap results (`slice(0, 30)` + “عرض المزيد”) or reuse the QuickKeysGrid row virtualizer; extract one shared normalized-search utility (keys precomputed once per catalog change) used by both `CategoryDrawer` and `SmartSearchModal`.

### P2-4 · Two generations of modal infrastructure

- **Verified split:**
  - `ModalShell` consumers (focus trap, `role="dialog"`, `aria-modal`, `aria-labelledby`, body scroll-lock — `components/ui/ModalShell.tsx:104-141`): `AdminHubModal`, `AdminLineEditModal`, `CheckoutModal`, `DebtSettlementModal`, `DiscountModal`, `ExpenseModal`, `OpenShiftModal`, `QuickItemModal`.
  - Hand-rolled `fixed inset-0 z-50` overlays **without** focus trap or dialog semantics: `EndShiftModal.tsx:500-509`, `HeldInvoicesModal.tsx:24-31`, `SmartSearchModal`, `ShiftDetailsModal`, `CashMovementModal`, `PreviousInvoicesModal`, `ShiftClosedSuccess`, plus the `CategoryDrawer` slide-over (`:346-358`).
- **Impact:** on hand-rolled overlays, Tab walks out of the dialog into background POS chrome (barcode input, action bar); screen readers get no `dialog` announcement. Escape *is* handled everywhere via `useModalEscape`, so the gap is specifically tab containment + semantics.
- **Fix (architectural):** migrate the seven stragglers onto `ModalShell` (or extract its focus-trap into a hook for the drawer). Highest-value first: `EndShiftModal` (long multi-field form), `SmartSearchModal`, `HeldInvoicesModal`.

### P3 · Low-severity polish

| # | Finding | Where | Recommendation |
|---|---------|-------|----------------|
| P3-1 | Cart quantity `<input>` is `readOnly`; corrections need N presses on the +/− buttons (they are h-11 and Tab-reachable) | `InvoicePanel.tsx:65-71` | Make it editable: commit-on-Enter, clamp 1–999, select-on-focus. Alternatively support `*N` quantity prefixes in the omnibar like SmartSearchModal already does. |
| P3-2 | No `prefers-reduced-motion` guard; animations include `animate-spin`, `animate-pos-toast`, `animate-pos-float`, many `active:scale-*` transitions | `app/globals.css` (only `@media print` at `:264`; focus-ring token documented `:179`) | Add one media query zeroing animation/transition durations. |
| P3-3 | Payment-method picker and discount-type toggle are button groups without `radiogroup`/roving tabindex (arrow keys don't move selection) | `CheckoutModal.tsx:255-278`, `DiscountModal.tsx:83-108` | Roving-tabindex group with ArrowLeft/Right (RTL-aware). Tab works today, so this is enhancement-grade. |
| P3-4 | Destructive confirms (“إلغاء” cart, lock) cancel on `onMouseLeave` only; keyboard flow relies on the 2s timeout | `InvoicePanel.tsx:456-469`, `PosLayout.tsx:763-772` | Acceptable; consider also cancelling on blur for parity. |
| P3-5 | `useDeviceHardware` instantiated independently in `PosLayout`, `InvoicePanel`, and elsewhere — duplicate localStorage reads/subscriptions per mount | `PosLayout.tsx:120`, `InvoicePanel.tsx:175` | Harmless at current scale; hoist to context or a module-level store if it spreads further. |

---

## 4. Verified strengths (do-not-regress list)

These were audited and are **correct** — preserve their invariants during refactors:

1. **Atomic-selector discipline.** Zero `createContext` in the repo; every component subscribes per-field (`grep createContext|useContext` → no matches). This is why per-scan render cost stays local to `InvoicePanel`.
2. **CartRow memo actually works.** `addLine` maps only the merged row and keeps sibling references (`store/usePosStore.ts:881-901`), and the row receives a stable `useState` setter (`InvoicePanel.tsx:370-377`) — untouched rows bail out of re-render.
3. **Scan path is O(1).** `barcodeIndex[barcode]` hash lookup + pure `computeSaleTotals` + a single `set()` (`store/usePosStore.ts:1375-1412`). Persistence is coalesced at 250ms with a microtask flush for critical sections (`lib/persistStorage.ts`, `flushCriticalPersistWrites` at `usePosStore.ts:744-750`).
4. **Printing never blocks the lane.** Silent tiers via print-agent (`lib/printAgent.ts:157-162, 287`), `window.print()` only as a `requestAnimationFrame` fallback outside Electron (`PosLayout.tsx:283-313`); QR TLV is sync-cheap, matrix render async (`lib/qrGenerator.ts`).
5. **Wedge-scanner hardening.** Gap/duration/min-length detection, editable-target guard, 120ms double-read coalescing, configurable submit key (Enter/Tab), and money fields that reject 13-digit barcode bursts (`isValidMoneyInput` at `CheckoutModal.tsx:296-301`, `DiscountModal.tsx:121-126`).
6. **Modal-aware global input.** All hotkeys and scans funnel through `anyPosModalOpen` (`store/usePosStore.ts:666-681`), so nothing fires “behind” a dialog.
7. **Local-first hydration done right.** `hydrateCatalog` dedupes per-store jobs, paints from the boot mirror instantly, then refreshes from network (`store/usePosStore.ts:3084-3203`).
8. **Multi-register integrity.** Storage-based register lease with grace window (`PosLayout.tsx:181-210`) and cross-tab `isCompleting` submit lock (`usePosStore.ts:694-707`).
9. **Non-blocking audio cues.** Shared WebAudio context, compressor, success/error/scan patterns emitted only after verified outcomes (`lib/posSound.ts:161-179`, primed on first gesture at `PosLayout.tsx:231-249`).
10. **Virtualized catalog grid.** Row virtualizer with deferred values and memoized tiles (`QuickKeysGrid.tsx:163-315`) — the model the drawer (P2-3) should follow.

---

## 5. Keyboard-only operation map (as audited)

| Key | Action | Guard |
|-----|--------|-------|
| Barcode wedge | Adds line (merge-by-identity, no duplicate rows) | Blocked while any modal open |
| Omnibar Enter/Tab | Submit scanned/search text (submit key configurable per scanner) | `scannerAcceptsSubmitKey` |
| F2 | Open checkout | No modal open, shift OPEN |
| F4 | Hold invoice + open held list | — |
| F6 | Toggle return mode / exit return mode | — |
| F7 / F8 | Invoice discount / line actions | Capability-gated |
| F9 | Quick item | — |
| F10 | Category drawer | — |
| Ctrl+K | Global product search (arrows navigate, `/` qty mode, Enter adds, Esc backs out) | — |
| Ctrl+Shift+A | Admin hub | `backoffice.access` |
| Esc | Close top-most modal (all modals wired via `useModalEscape`) | — |
| Focus management | Barcode omnibar autofocuses on mount, regains focus when last modal closes (`PosLayout.tsx:277-281`) and after printing (`:353-361`); clicking empty pad refocuses without breaking text selection (`:366-371`) | Skipped while any modal open |

Gaps are itemized under P2-4 (tab containment) and P3-1/P3-3 (qty entry, radiogroups).

---

## 6. Suggested order of work

1. **P1-2** — reorder `completeCheckout` (smallest diff, most-felt win) + switch pending counts to `count()`.
2. **P1-1** — precomputed normalized search keys shared by both search surfaces.
3. **P2-3** — cap/virtualize drawer results (reuses #2’s utility).
4. **P2-1** — unify modal mounting strategy in `PosLayout`.
5. **P2-2** — idle-schedule boot-mirror writes.
6. **P2-4 + P3** — consolidate overlays onto `ModalShell`; fold in qty editing, reduced-motion, radiogroup semantics.

---

*Audit performed statically (no runtime profiling). Line numbers reference the working tree at time of review; re-validate before large refactors.*
