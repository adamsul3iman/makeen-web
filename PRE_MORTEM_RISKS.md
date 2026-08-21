# PRE-MORTEM RISKS — MAKEEN POS

**Audience:** Owner / Ops / Engineering lead.
**Method:** Ruthless pre-mortem. Assume the worst cashier, the worst network, the worst weekend rush. Every scenario below either contradicts a documented invariant, exploits a gap in one, or fails silently in a way an owner will discover only at reconciliation.
**Status:** Analysis only — no code fixes shipped.

Severity legend: **CRITICAL** (lost money / wrong books / data loss) · **HIGH** (wrong books, recoverable with heavy manual work) · **MEDIUM** (friction, minor financial leak) · **LOW** (UX polish).

---

## Domain 1 — Operational & User Errors (The Stressed Cashier)

### 1.1 Scanner keystrokes land in the "Cash Given" / discount fields

- **Risk:** A USB keyboard-wedge scanner physically types the barcode (digit-by-digit) plus a terminator (usually Enter) wherever focus sits. Mid-checkout, focus is on the tendered-amount field (or the discount entry field). The cashier scans the next customer's item while the modal is open → the barcode digits are appended into the amount field, and the scanner's Enter submits the modal with a garbage tendered amount.
- **Current behavior:** The scanning hook (`hooks/useBarcodeScanner.ts`) correctly *defers* to editable targets and requires no-modal-open before ringing a scan, but that guard cannot intercept the OS-level keystrokes: the wedge still types into the focused `<input>`. The Checkout modal's amount field has no "digits + single decimal only" validation that would reject a 13-digit barcode with an error instead of submitting.
- **Fix:** (a) When the Checkout / discount modal opens, programmatically select-all or blur the amount input so a stray scan lands nowhere; (b) strictly validate `amountPaid` / discount inputs (digits + one decimal separator, bounded length) and reject with a clear notice — never submit; (c) suppress the wedge's Enter-as-submit inside these fields unless the field content parses as money; (d) in the scanner hook, keep the editable-target handover but add an explicit "scan-while-modal-open → beep + ignore" branch that also `preventDefault`s the wedge terminator when possible.

### 1.2 Double-click / double-Enter on checkout during lag

- **Risk:** Lag after "Charge" → cashier double-taps or holds Enter → two `completeCheckout` runs → two invoices for one sale, or one invoice + a stray empty re-submit.
- **Current behavior:** `isCompleting` is a single boolean guard set during persistence. It is *per-tab* and synchronous-guarded, so a same-tab rapid double-fire is mostly blocked. But the checkout button is not disabled at the DOM level; two tabs (see 2.3) each have their own `isCompleting`.
- **Fix:** Disable the confirm button + full-screen click-absorb on submit (both tabs), keep `isCompleting` but also key the modal by `checkoutSession` (already done) so a second trigger after completion is a fresh, empty modal; add a short "processing…" overlay so the cashier has visible feedback instead of tapping again.

### 1.3 Register handover mid-transaction

- **Risk:** Cashier A is mid-cart, walks away without locking; or locks and cashier B unlocks the same register → sees A's half-built cart (possibly customer debt or discount state) and completes it against B's shift.
- **Current behavior:** `partializePosState` persists `items`, `totals`, `heldInvoices`, `invoiceDiscount`, `deliveryFee`, `isReturnMode` to localStorage. `lockScreen` drops the cashier session but does **not** clear the cart. A new unlock restores the previous cart. In return mode, this can resurrect a return document on a different shift.
- **Fix:** Decide a policy and enforce it: either (a) `lockScreen` clears the cart (and cancels return mode), or (b) the cart is preserved but tagged with the originating cashier + shift, and any unlock under a different cashier/shift forces a "clear cart?" confirm. At minimum, `isReturnMode` must never survive a lock.

### 1.4 PIN lockout during the rush (Caps Lock / numpad / typo)

- **Risk:** A stressed cashier (or one with Caps Lock on, or an Arabic keyboard layout) fails the 4-digit PIN 5 times → register locks for 30s→60s→120s→…→ up to 30 minutes, exponential, persisted across reload. Mid-weekend-rush, the register is dead and there is **no documented owner-side reset**.
- **Current behavior:** `PIN_MAX_ATTEMPTS = 5`, `PIN_LOCKOUT_BASE_MS = 30_000`, `PIN_LOCKOUT_CAP_MS = 30min`, cooldown `min(cap, base·2^level)` (store/usePosStore.ts:66). Resets only on a successful unlock. Owner dashboard login does **not** clear the device lockout.
- **Fix:** (a) Normalize input: strip Arabic-Indic digits `٠-٩`→`0-9`, reject non-digits before hashing so layout/CapsLock typos are caught client-side without burning attempts; (b) add an owner flow (verified owner password / secondary auth) to reset the lockout level immediately; (c) show a countdown + which key was wrong ("الكيبورد على Caps Lock؟") instead of silent failure.

### 1.5 Barcode typed slowly, or the same item scanned twice

- **Risk:** Long/13-digit barcodes that arrive slower than the 600ms window are misread as "human typing"; conversely a legitimate rapid double-scan of **two identical items** is dropped as a duplicate.
- **Current behavior:** `SCAN_MAX_GAP_MS=60`, `SCAN_MAX_DURATION_MS=600`, `SCAN_MIN_LENGTH=3`, `SCAN_AVG_KEYS_MS=30`; `lib/scanCoalesce.ts` drops an identical code re-committed within `SCAN_COALESCE_MS=120`. The coalesce correctly absorbs hardware double-fire, but a cashier physically double-scanning the same SKU faster than 120ms (very possible with a fast hand-held gun) silently loses a line.
- **Fix:** Make the coalesce window bound to a single hardware burst (e.g., only collapse when the second scan arrives while the *first scan's keystrokes are still in the same wedge burst*, or a few ms after the terminator) instead of a fixed 120ms; add a visible "+1" flash per added line so a dropped scan is immediately obvious; log coalesced events to the audit trail.

### 1.6 Ad-hoc items silently distort gross profit

- **Risk:** Cashiers ring un-cataloged items (`addQuickItem` name+price only) — no cost → profit unknown. Weekend rush multiplies this; the owner's profitability report quietly degrades.
- **Current behavior:** Ad-hoc lines carry no cost; `mapSalesLedgerInvoice` flags `profit_reliable === false`. Handled honestly at the ledger, but nothing at the register tells the cashier (or owner) how much of the day's profit is "unknown cost".
- **Fix:** Show a persistent "× items بدون تكلفة" badge in the cart when any line is cost-less; surface "unknown-cost sales" as its own row on the dashboard; allow a default-cost override prompt for repeated ad-hoc lines.

---

## Domain 2 — System & Sync Edge Cases

### 2.1 Closing a shift while invoices are still unsynced → frozen wrong Z-report  ← **HIGHEST RISK**

- **Risk:** Cashier sells offline (or the queue exceeds `BATCH_SIZE = 50`), then closes the shift. The device's `SHIFT_CLOSED` event is queued behind (or ahead of) still-PENDING `INVOICE_CREATED` events. When the server finalizes the close, it recomputes drawer math from `sales_invoices` — which does **not yet contain the unsynced invoices** → wrong `expected_cash`, wrong `variance`, a false `SHIFT_VARIANCE` risk + audit entry.
- **Current behavior:** `POST /api/sync` upserts the whole batch to `sync_events`, mirrors invoices, then finalizes `SHIFT_CLOSED` in a second pass (`finalizeShiftClose` → `computeShiftLedgerSums`). The recomputed numbers **overwrite** the client's and are **immutable** (`protect_shift_report_financials` trigger raises on any financial-column change). If the invoices arrive in a *later* batch (50-cap split, or flapping network), the Z-report is already finalized wrong and only a manual `resolve_stale_shift`-style correction can repair it.
- **Fix (belt + braces):**
  1. **Finalize from `sync_events`, not only `sales_invoices`:** the authoritative drawer math should read all INVOICE_CREATED / DEBT_SETTLEMENT / EXPENSE_RECORDED events for that `shift_id` from `sync_events` (which the batch already upserts completely), falling back to ledger rows only for events mirrored in earlier sessions. This makes the close correct regardless of mirror timing.
  2. **Device-side guard:** block `closeShift` while any `INVOICE_CREATED` / `DEBT_SETTLEMENT` / `EXPENSE_RECORDED` for the active shift is still `PENDING` in IndexedDB; show "لا يمكن إغلاق الوردية قبل مزامنة X حركة" with a sync-now button.
  3. **Server-side deferral:** if finalization would be computed over an incomplete ledger, mark the close `PENDING` and recompute when the last invoice of that shift lands, rather than freezing a provisional Z-report.
  4. **Reconciliation job:** a nightly job that re-derives every closed shift's sums from `sync_events` and flags mismatches vs `shift_reports` (never silently mutates — but surfaces them).

### 2.2 Network flapping during checkout / shift close

- **Risk:** Wi-Fi drops and reconnects every few seconds. Each cycle fires `useBackgroundSync` (interval 15s + online/visibility triggers). The queue drains partially, ACKs are lost, events are re-sent (safe, idempotent) — but the **fast-path ISTD push** (`pushInvoiceToIstd`) fires exactly when `isOnline` flips true, and a flap mid-ISTD means the invoice is registered locally but the JoFotara submission times out. The user sees "متصل" and assumes it cleared.
- **Current behavior:** ISTD fast-path is fire-and-forget with `FAST_PATH_TIMEOUT_MS = 8000`; the catch-up pass (`runIstdCatchUp`, 5/tick, every 15s tick) will eventually pick it up — so no permanent loss — but there is a **long silent window** where the invoice is saved locally, shows no QR yet, and no one is told.
- **Fix:** (a) De-bounce sync on `online` (only trigger a drain once network has been stable ≥2s); (b) surface ISTD state visibly (see 4.2); (c) make `pushInvoiceToIstd` retry-once-inline instead of strictly fire-and-forget when a submission started but timed out.

### 2.3 Two POS tabs on the same register (cross-tab race)

- **Risk:** Cashier (or a stray tab restore) opens two tabs pointed at `/pos` for the same store/terminal. Each tab has its **own** Zustand instance (synced cross-tab via `useCrossTabSync`) but **its own** `isCompleting`, its own cart, and its own sync timer.
- **Current behavior:** Both tabs share one IndexedDB queue and one server (idempotent by `sync_id`) — so queue drains are dedupe-safe on the server. But: (a) two carts can complete simultaneously → two invoices (double-charge); (b) two `useBackgroundSync` loops can drain concurrently (module-locked in `syncService`, so a second drain waits — OK); (c) both tabs can independently open/close shifts against the same terminal.
- **Fix:** (a) Broadcast a "register in use" claim (BroadcastChannel / localStorage lease) and **bounce any second tab to a read-only "this register is open elsewhere" screen**; (b) make `isCompleting` cross-tab (store the flag in localStorage during the critical section); (c) close the shift modal from one tab should force-close it in the other via the existing cross-tab channel.

### 2.4 Closing a shift while a debt settlement / expense is still queued

- **Risk:** Same shape as 2.1 but for `DEBT_SETTLEMENT` and `EXPENSE_RECORDED`: `computeShiftLedgerSums` reads `customer_transactions` (SETTLEMENT) and `expenses` for the shift. If either is still PENDING in IndexedDB, `debtCollections` / `expenses` are understated in the frozen Z-report.
- **Current behavior:** Covered by the same finalize-from-ledger logic as 2.1 — same vulnerability, same fix. Specifically: the device should not allow `closeShift` while shift-scoped settlements/expenses are queued.
- **Fix:** Fold into the 2.1 solution (device guard + sync_events-based finalize). Also enforce at the modal: if `pendingSyncCount > 0` for shift-scoped rows, show them by type before confirming close.

### 2.5 Browser/device data loss between IndexedDB and the server

- **Risk:** Cashier closes the browser, the OS clears site data, the cache gets cleared, or the tablet is wiped before the queue drains. All unsynced events are gone. There is **no pull-back**: the device never re-fetches "what the server knows for this terminal/shift".
- **Current behavior:** The queue is the only write path; `/api/catalog` and `/api/sync` are push-only. `clearSyncQueue` exists and is used post-reconcile. Nothing on the device reconciles against server truth.
- **Fix:** Add a per-terminal reconciliation: on boot/login, fetch the server's `sync_events` for `storeId+terminalId` since the device's last known `created_at`, diff against local PENDING/SYNCED ids, and (a) surface locally-missing-but-server-known invoices as a "recovered records" list, (b) mark any local PENDING record the server already has as SYNCED. This closes the wipe-hole.

### 2.6 Cross-store device handover

- **Risk:** A tablet is moved from Store A to Store B. Leftover PENDING events from A must never drain into B's ledgers or stock.
- **Current behavior:** Well handled by design: `enqueueSync` stamps `storeId`; `isQueueRecordForTenant` refuses to sync/count records whose `storeId` ≠ active tenant; `applyLoginPayloadToStore` resets transactional runtime on tenant change. This is the **one documented invariant that holds end-to-end** — keep a regression test on it (2.6 is flagged as "do not break" rather than "fix").
- **Fix:** Add an automated test that enqueues under tenant A, switches tenant, asserts zero sync + zero badge, then switches back and asserts drain resumes.

### 2.7 Shared barcode across stores (multi-tenant collision)

- **Risk:** Two different stores sell the same packaged product (e.g., the same brand of cups with the same GTIN). Both try to register the barcode.
- **Current behavior:** Migration 003 declares `product_barcodes.barcode VARCHAR(100) UNIQUE NOT NULL` — **globally unique, not `(store_id, barcode)`**. Migration 006 added `store_id` but never replaced the global UNIQUE. Store B's mobile add-product / import will fail with a unique violation for a barcode Store A already owns.
- **Fix:** Replace the global unique with `UNIQUE (store_id, barcode)` (add the column, drop old constraint, re-add composite). Same audit for any other "globally unique but tenant-scoped" columns (`cashiers.pin` legacy, etc.). This is a real multi-tenant blocker, not a hypothetical.

### 2.8 Poison-event drop silently loses a sale

- **Risk:** An invoice that the server keeps rejecting (mirror bug, bad shape that passed client validation but trips a server CHECK) is retried 8 times and then **dropped** by `MAX_SERVER_ATTEMPTS`. The sale happened; the books never see it; no one is told.
- **Current behavior:** `markSyncAttemptFailed` increments on 2xx-but-not-acked; at 8 the syncService drops the record (poison path). Logged server-side (`console.error`) but **not surfaced to the cashier/owner** and not parked anywhere queryable.
- **Fix:** Never hard-delete — move poison records to a `sync_poison` table / IndexedDB "quarantine" store, render a permanent "⚠ حركة معلّقة (خارج المزامنة)" badge with count, and expose them in the admin audit view so the owner can fix the underlying row and requeue.

---

## Domain 3 — Complex Business Logic

### 3.1 Partial returns are not supported (full-invoice negation only)

- **Risk:** Customer returns 2 of 5 line items, or 1 unit of a 3-unit line. The cashier cannot do a line-level partial return from a settled invoice.
- **Current behavior:** `beginReturnByInvoice` loads the original invoice from IndexedDB and negates **every line** at **full qty**; there is no line/qty selection. The only path to a partial return today is manually re-ringing negative qty lines — which loses the fiscal split linkage and the `originalInvoiceId` guard.
- **Fix:** Add line-level selection (qty per line, capped at original qty) in the return document; build the return payload from a *fresh* `computeFiscalBreakdown` over only the selected lines with the original invoice discount prorated proportionally to the returned lines. Keep the "refund = discounted net, never gross" invariant.

### 3.2 SPLIT-payment returns reverse 100% to cash  ← **CRITICAL for reconciliation**

- **Risk:** Invoice paid €… err, JOD 100 = JOD 60 cash + JOD 40 Visa (SPLIT). Customer returns it in full. The reversal row carries `paymentMethod: "SPLIT"`, `amountPaid: -100`. Server-side `recordSalesInvoiceLedger` computes `cashAmount = total>=0 ? min(amountPaid,total) : total` → for total −100 → `cashAmount = -100`, `visaAmount = 0`. **The refund is booked entirely against cash** even though JOD 40 was originally on Visa.
- **Current behavior:** The SPLIT branch in `/api/sync` treats negative totals as all-cash. `sales_payments` rows and `sales_invoices.cash_amount/visa_amount` therefore misstate the refund; the cash drawer math (`cashSales`) then subtracts the full 100 from expected cash, and the variance is wrong by exactly the Visa portion.
- **Fix:** Store the original payment split on the invoice (already in `payload.payments`/`cash_amount` etc. from the mirror — read it back) and reverse each bucket proportionally: cash = −60, visa = −40. On the reversal payload, carry explicit `cashAmount/visaAmount/cliqAmount/debtAmount` so the mirror never re-derives them from `total`.

### 3.3 SPLIT + invoice-level discount + return: fiscal split correctness

- **Risk:** Invoice had a global (invoice-level) discount of JOD 10 over 5 lines plus a SPLIT payment. A *full* return is currently handled by `beginReturnByInvoice` re-running `computeFiscalBreakdown` (good), but the returned lines carry `discount: 0` and their *allocated* discount is baked into the negative `lineTotal`. Combined with 3.2, the payment-side split and the line-side discount allocation must be kept consistent or the owner sees a refund that doesn't equal what the customer paid.
- **Current behavior:** Line discount allocation is proportional (`allocateInvoiceDiscount`) and 2dp; the return path re-derives it. The payment split is the broken half (3.2). Verify with a fixed test vector: invoice 100, discount 10 (net 90), split 50/40, full return → expect cash −50, visa −40, per-line negative nets summing to −90.
- **Fix:** Add regression tests for this exact vector on both the device (`computeFiscalBreakdown`) and server (`recordSalesInvoiceLedger`) paths.

### 3.4 Loyalty points on a returned invoice are never clawed back

- **Risk:** Customer earned points on invoice A, returns it → the refund goes through but the earned `loyalty_events` row (keyed by sync_id) stays; `recordLoyaltyEarn` skips negative totals and nothing reverses the earlier award. Customer's balance is overstated; the store eats the liability.
- **Current behavior:** `recordLoyaltyEarn` only awards for `total > 0`; returns/cancellations are not submitted to ISTD and not reflected in loyalty.
- **Fix:** On INVOICE_CREATED with `isCancellation` or negative total referencing an `originalInvoiceId`, find the original sync_id's EARN event and post a matching `REDEEM`/`ADJUST` reversal (`points = -earned`), idempotent by the reversal sync_id.

### 3.5 Rounding precision with fractional quantities and multipliers

- **Risk:** Weighed/fractional items (`qty = 0.333`, multiplier 1 or 3) and the proportional discount allocator round per-line to 2dp. Line-level `tax_amount` sums can differ by 1 fils (JOD 0.01) from an invoice-level VAT computation, and the fiscal TLV QR encodes total + VAT at 2dp. ISTD/JoFotara validate the TLV against the submitted totals; a 1-fils mismatch can flag the invoice, and per-line vs per-invoice VAT drift shows up in ZATCA-style inspections.
- **Current behavior:** `roundMoney` (2dp) everywhere; `computeFiscalBreakdown` proportional with 2dp lines; `record_inventory_movement` rounds stock deltas to 3dp; line tax `DECIMAL(5,2)`/`tax_amount DECIMAL(12,2)`. There is no explicit "largest-remainder" or "last-line-adjusts" allocator to guarantee Σlines == invoice total exactly.
- **Fix:** Use a largest-remainder method for the proportional allocator so `Σ line_total == total`, `Σ line_discount + invoice_discount == discount`, and `Σ line_tax == tax` **exactly**; add a round-trip assertion test with the exact vector (subtotal, fractional qty, multiplier, discount, 16% VAT, delivery fee) used by both the receipt and the ISTD submission. Document the rounding rule (half-up) in one shared helper.

### 3.6 Gross-profit semantics on returns

- **Risk:** Returns book `line_profit = net − cost` with negative qty → negative profit. Across a messy shift (many returns of high-margin items), "gross profit" can swing wildly and the dashboard's single number mixes sales profit with return reversal without a label.
- **Current behavior:** `mapSalesLedgerInvoice` computes per-line profit and flags `profit_reliable === false`; `gross_profit = Σ net − cost + deliveryFee`. Returns are included as negative profit. Honest, but presentation isn't split into Sales vs Returns.
- **Fix:** Report Sales Gross Profit and Returns (Refunds) as separate rows, plus net; keep the raw data unchanged. Also surface "returns as % of sales" on the daily dashboard — a spike is a fraud/error signal the risk engine should already catch via INVOICE_RETURN.

### 3.7 Debt settlement overpayment / partial settlement clarity

- **Risk:** A customer pays more than the outstanding balance, or a cashier enters a settlement that crosses two debt invoices. Server caps at balance (good) but a partial settlement of one invoice when the customer has two is ambiguous, and the returned "balance" may surprise the cashier.
- **Current behavior:** `recordDebtLedger` caps settlement at current customer balance and records only the capped amount; the cashier-facing flow (`processDebtSettlement`) takes a single name+amount.
- **Fix:** Show the customer's outstanding balance + invoice breakdown in the settlement modal before confirming; surface "تم تسديد 40 من 60 — الباقي 20" instead of a bare success; consider allocating to oldest invoices first.

---

## Domain 4 — UX, UI & Feedback

### 4.1 Modal stacking: Secondary Auth behind Shift Close / Checkout

- **Risk:** The owner-password gate (`SecondaryAuthModal`) is opened while another full-screen modal (Shift Close, Checkout, Hold) is already up — e.g., a discount-approval fires from inside the checkout flow, or `open_drawer` is triggered while a modal is open. Z-order/backdrop fights, or the second modal renders but the first is still scroll-locked → cashier clicks into the wrong layer.
- **Current behavior:** Modals are individually rendered in `PosLayout` (keyed by `modalSession`); there is no central modal stack/registry with explicit ordering or "top-most wins" elevation. `anyPosModalOpen` gates the scanner but not modal-vs-modal elevation.
- **Fix:** Introduce a tiny modal manager: a `modalStack` in the store; each modal registers, the stack enforces single-top, secondary auth always mounts with `z-index` above everything and blocks the one below; ESC/backdrop close only the top modal. Regression-test the "discount approval during checkout" and "open_drawer while shift modal open" sequences.

### 4.2 ISTD fast-path failure is invisible

- **Risk:** Invoice saved locally, ISTD submission fails/times out → the receipt prints with the **local** TLV QR (valid but not "cleared"), and nothing on screen, on the receipt, or in the header tells the cashier or owner that this invoice still needs JoFotara submission. Owner discovers it days later when the tax office asks.
- **Current behavior:** `pushInvoiceToIstd` is fire-and-forget; success patches the queued payload with `istd_uuid/istd_qr`; catch-up runs in background (5/tick). No UI state, no receipt marker, no dashboard count of "pending ISTD".
- **Fix:** (a) Track per-invoice ISTD state in IndexedDB (`PENDING/SUBMITTING/SUBMITTED/FAILED`); (b) show a countdown badge "X فاتورة بانتظار JoFotara" in the POS header + admin dashboard; (c) mark the receipt with "قيد الإرسال للمصلحة" when not cleared; (d) alert on FAILED with the error code and a retry button.

### 4.3 Touch targets in the mobile inventory flow

- **Risk:** The camera add-product flow is used on phones/tablets by a scanning inventory clerk, often one-handed during a stock-take. Sub-44px tap targets, an Enter-key-only submit, and a tiny qty/price input make the flow error-prone and slow.
- **Current behavior:** `MobileAddProduct` / `AddProductForm` use compact inputs; `parsePrice` handles the Arabic decimal comma; `normalizeBarcode` strips whitespace. No explicit minimum touch-target enforcement or big-number-keypad for price/qty.
- **Fix:** Enforce ≥44×44px targets on all tappable elements in the mobile flow; use a numeric keypad (`inputMode="decimal"`) for price/qty; add large "+/-" steppers for qty; keep the camera open after submit so the clerk can rapid-scan without re-opening.

### 4.4 Notices disappear too fast under pressure

- **Risk:** Error/success toasts auto-dismiss after 2.5s (`PosLayout` notice timer). During a rush the cashier misses an error ("الصنف غير موجود", "تعذر فتح الدرج") and continues, compounding mistakes.
- **Current behavior:** `useEffect` timer `setTimeout(dismissNotice, 2500)` for all tones; error tones additionally play a sound. No persistence of the last N notices.
- **Fix:** Keep success toasts short but make error notices require dismissal (or stay ≥8s), and keep the last 20 notices in a small scrollable "messages" drawer so the cashier/owner can review what happened.

### 4.5 Owner password typed on the shared register keyboard

- **Risk:** Discount approvals, drawer opens, voids, and cashier management all require the **owner's dashboard password** typed into the secondary-auth modal on the same physical register. A keylogger on shared hardware, or a camera/line-of-sight, captures the owner credential; the password is reused for the dashboard.
- **Current behavior:** `confirmSecondaryAction` re-verifies against `/api/admin/reverify` per action. Correct security posture, but the input method (keyboard on a shared POS) is the weak point, and there is no cooldown/max-attempts on `reverify` in the UI.
- **Fix:** (a) Add attempts-cooldown to reverify (mirror the PIN lockout philosophy); (b) offer a "NFC/QR scan a YubiKey-style code" or a phone-based second factor for high-frequency actions; (c) at minimum use a masked field + auto-lock after failure and never log the password. Consider limiting secondary-auth actions to the owner's own device session with a short-lived one-time code displayed in the dashboard.

### 4.6 Return-mode accidental activation

- **Risk:** F6 toggles return mode (banner shows, but a single keypress). A cashier pressing F6 for another reason (or fat-fingering near the top row) enters return mode without a confirm and processes a sale with negative lines → the invoice books as a return and cashier/day variance goes sideways.
- **Current behavior:** `toggleReturnMode` flips the flag; `F6` exits return mode from the banner. The hotkey handler guards on shift/session but there's no confirmation for *entering* return mode (there is secondary auth for *requesting* it via UI).
- **Fix:** Entering return mode via hotkey should require a confirm dialog ("أنت تردّ مالاً للزبون — متابعة؟"); only the UI button path uses secondary auth. Add an "exit return mode" always-reachable button in the banner, not just F6.

### 4.7 Focus management fights the user

- **Risk:** `keepFocusOnScanner` refocuses `#pos-barcode-input` on any pad click that isn't an input/textarea/select — and `useEffect` refocuses it whenever modals close. A cashier trying to click a button, use the scrollbar, or type into a field can be yanked back to the scanner input, causing wrong-field input or the 1.1 problem.
- **Current behavior:** `keepFocusOnScanner` explicitly skips `input/textarea/select` and modals; the modal-close effect refocuses the scanner. The scrollbar is intentionally excluded (`preventDefault` was removed because it broke selection/drags) — meaning clicks on the scrollbar *do* steal focus.
- **Fix:** Never refocus programmatically while the last interaction was a non-input click on an interactive element; add a small guard so focus only returns to the scanner after a *scan* or a *checkout*, not after any modal close; test scrollbar drag behavior explicitly.

---

## Summary — Top 10 to fix before go-live

| # | Risk | Severity | Where |
|---|---|---|---|
| 1 | Shift close finalized over incomplete ledger → frozen wrong Z-report | **CRITICAL** | `/api/sync` finalize + device `closeShift` |
| 2 | SPLIT return reverses 100% to cash | **CRITICAL** | `/api/sync` SPLIT branch |
| 3 | Global-unique barcode blocks shared SKUs across stores | **CRITICAL** | migration 003 / 006 |
| 4 | Partial returns unsupported | **HIGH** | `beginReturnByInvoice` |
| 5 | Poison-event drop silently loses sales | **HIGH** | `syncService` + `markSyncAttemptFailed` |
| 6 | Cross-tab double-cart / double-submit | **HIGH** | `useCrossTabSync` + `isCompleting` |
| 7 | Scanner typing into Cash Given / discount fields | **HIGH** | `useBarcodeScanner` + Checkout modal |
| 8 | Loyalty points not clawed back on return | **HIGH** | `recordLoyaltyEarn` |
| 9 | ISTD failure invisible to cashier/owner | **HIGH** | `clientIstd` + receipts |
| 10 | Rounding drift (fractional qty × multiplier × VAT, 1-fils) | **MEDIUM** | `saleMath` allocator |

### Recommended next step after fixes
After each mitigation, add a regression test against the exact vectors above (SPLIT+discount return, offline shift close with unsynced invoices, 0.333×3 multiplier VAT, shared barcode, cross-tab). The current `tests/run.mjs` mock harness covers happy paths; the pre-mortem scenarios are the failure paths it does not.

---

*Pre-mortem analysis — analysis only, no code changes made. Where behavior is "per the blueprint" it reflects the source as documented; flagged `verify` items are marked inline.*
