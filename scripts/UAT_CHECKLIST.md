# UAT CHECKLIST — Post-Simulation Verification

## PREPARATION

1. Open POS register → verify shift is OPEN
2. Paste `scripts/simulate_shift.js` into DevTools console → Enter
3. **Hard-refresh** (Ctrl+Shift+R) to hydrate store with injected data
4. Verify the register shows updated shift totals in the header/sidebar

---

## PHASE 1: POS REGISTER (The Cashier View)

### 1A. Shift Totals Verification
**Where:** POS register header / shift summary section

| Metric | Expected Value |
|--------|---------------|
| Cash Sales | 1,422.00 د.أ |
| Card (VISA) Sales | 1,299.30 د.أ |
| CliQ Sales | 595.00 د.أ |
| Debt Sales | 657.50 د.أ |
| Total Sales | 3,973.80 د.أ |
| Discounts | 37.00 د.أ |
| Delivery Fees | 5.00 د.أ |
| Cash In | 150.00 د.أ |
| Cash Out | 30.00 د.أ |
| Expected Cash in Drawer | 2,122.00 د.أ |
| Expected Card | 1,299.30 د.أ |
| Expected CliQ | 595.00 د.أ |
| Drawer Opens | 5 |
| Pending Sync | 25 (20 invoices + 3 movements + 2 settlements) |

- [ ] All totals match exactly
- [ ] "المتوقع بالصندوق" (Expected Cash) = starting cash + cash sales + cash in − cash out + debt collections
- [ ] Drawer open count shows 5

### 1B. Previous Invoices
**Where:** POS → Previous Invoices / العرض الجانبي

- [ ] 20 invoices visible with correct payment methods (CASH/VISA/CLIQ/SPLIT/DEBT)
- [ ] 2 settlement records visible
- [ ] Invoice #1 shows 300.00 د.أ CASH
- [ ] Invoice #9 shows 209.60 د.أ DEBT (أحمد العلي)
- [ ] Invoice #11 shows 220.00 د.أ (has item discount of 20.00)
- [ ] Invoice #18 shows 173.00 د.أ (includes 5.00 delivery fee)

---

## PHASE 2: CLOSE SHIFT (The Tri-Reconciliation)

### 2A. Open End Shift Modal
- [ ] Click "إغلاق الوردية" (Close Shift)
- [ ] Modal shows "فتح الوردية" (shift start time) correctly
- [ ] Modal shows total amounts for Cash/Card/CliQ

### 2B. Enter Closing Counts (ZERO-VARIANCE TEST)
Enter EXACTLY these values to test a perfect-count scenario:

| Field | Enter Value |
|-------|------------|
| العدد الفعلي للنقود (Actual Cash) | **2,122.00** |
| إجمالي الصرافة (Card Terminal) | **1,299.30** |
| CliQ الفعلي | **595.00** |

- [ ] "المتوقع بالصندوق" = 2,122.00
- [ ] فرق الصندوق (Cash Variance) = **0.00** ✅
- [ ] فرق البطاقة (Card Variance) = **0.00** ✅
- [ ] فرق CliQ (CliQ Variance) = **0.00** ✅
- [ ] "السبب مطلوب" (Reason Required) does NOT appear — zero variance = no reason needed
- [ ] "إتمام الإغلاق" button is ENABLED

### 2C. Close the Shift
- [ ] Click "إتمام الإغلاق" (Complete Close)
- [ ] Post-close success screen shows
- [ ] Success screen displays: Cash 1,422.00 / Card 1,299.30 / CliQ 595.00
- [ ] Drawer open count: 5
- [ ] Click "تم" to dismiss

### 2D. Test DISCREPANCY Enforcement (Re-open and test with wrong amounts)
- [ ] Open a NEW shift with any starting cash
- [ ] Add 1 item to cart, complete as CASH (e.g. 10.00 د.أ)
- [ ] Close the shift with Actual Cash = 20.00 (10.00 variance)
- [ ] Verify: "السبب مطلوب" (Reason Required) BLOCKS the close button
- [ ] Select a reason (e.g. "نقص") + write a note
- [ ] Verify: close button becomes ENABLED only after both reason + note filled

---

## PHASE 3: ADMIN — SHIFTS LIST

### 3A. Navigate to `/admin/shifts`

- [ ] Page loads without errors
- [ ] Shift list shows the CLOSED shift (with timestamp)
- [ ] Each shift card shows: opening time, closing time, cashier name
- [ ] Summary cards at top show: Card/CliQ Variance, Cash In/Out totals

### 3B. Click a Shift Card → Deep-Dive Modal
- [ ] Modal opens with full breakdown
- [ ] **Tri-reconciliation section** shows:
  - Expected Cash: 2,122.00 | Actual: 2,122.00 | Variance: 0.00
  - Expected Card: 1,299.30 | Actual: 1,299.30 | Variance: 0.00
  - Expected CliQ: 595.00 | Actual: 95.00 | Variance: 0.00
- [ ] **Cash Movements timeline** shows:
  - Cash In: 100.00 + 50.00 = 150.00
  - Cash Out: 30.00
- [ ] **Drawer Opens** shows count = 5
- [ ] **Transaction list** shows 22 entries (20 invoices + 2 settlements)
- [ ] Transaction payment methods are correct (CASH/VISA/CLIQ/DEBT/SPLIT)
- [ ] **Print button** works → generates clean print layout

### 3C. Pagination Test
- [ ] If more than 10 shifts exist, pagination shows
- [ ] Click "التالي" (Next) → navigates correctly
- [ ] Click "السابق" (Prev) → navigates correctly
- [ ] Page numbers are clamped (no out-of-bounds values)
- [ ] Changing filters resets to page 1

---

## PHASE 4: ADMIN — DEBTS (H-1/H-2/H-3 Verification)

### 4A. Navigate to `/admin/debts`

- [ ] Page loads with spinner → data appears
- [ ] 3 customers visible: أحمد العلي, محمد حسن, سارة الدليمي
- [ ] **Loading state** shows spinner before data loads (H-3 fix)
- [ ] Error message appears if fetch fails (M-6 fix)

### 4B. Customer Balances
- [ ] أحمد العلي: balance should reflect 209.60 (sale) − 50.00 (settlement) = **159.60**
- [ ] محمد حسن: balance should reflect 194.10 (sale) − 30.00 (settlement) = **164.10**
- [ ] سارة الدليمي: balance should be **253.80** (no settlement)

### 4C. Record a New Debt Payment
- [ ] Click on أحمد العلي → "تسجيل دفعة"
- [ ] Enter amount: 50.00 → Confirm
- [ ] Balance updates to 109.60
- [ ] Success message appears

---

## PHASE 5: ADMIN — SUPPLIERS (M-1 Fix)

### 5A. Navigate to `/admin/suppliers`

- [ ] Page loads (showing spinner → data)
- [ ] Error message shown if fetch fails (M-6 fix)
- [ ] All suppliers show numeric balance (e.g., "0.00 د.أ") — NOT "—"
- [ ] Zero-balance suppliers show `0.00 د.أ` not a dash

---

## PHASE 6: ADMIN — RISK (H-11 Fix)

### 6A. Navigate to `/admin/risk`

- [ ] Page loads without errors
- [ ] If total events ≥ 20,000: amber banner "تنبيه: النتائج مقتطعة" appears
- [ ] Banner shows total count and advises narrowing filters
- [ ] Pagination controls work within risk events

---

## PHASE 7: ADMIN — EXPENSES (M-22/M-24 Fix)

### 7A. Navigate to `/admin/expenses`

- [ ] Category filter dropdown shows all categories
- [ ] Create expense form has its own category selector (independent of filter)
- [ ] Select " Pikopiko " in filter → list filters correctly
- [ ] Select "ãåá" in create form → does NOT affect filter selection
- [ ] After creating expense, form category resets to "عام" (general)
- [ ] Filter category stays on whatever was selected

---

## PHASE 8: ADMIN — PROFITABILITY (M-19 Fix)

### 8A. Navigate to `/admin/reports/profitability`

- [ ] Page loads without errors
- [ ] NO Chinese characters (`记录`) visible anywhere on the page
- [ ] Warning about missing costs shows Arabic-only text

---

## PHASE 9: ADMIN — SETTINGS (M-25 Fix)

### 9A. Navigate to `/admin/settings`

- [ ] Change tax percent → Save → green "تم الحفظ" appears
- [ ] Wait 4 seconds → success message AUTO-DISAPPEARS
- [ ] Change credentials → Save → green "تم الحفظ" appears
- [ ] Wait 4 seconds → success message AUTO-DISAPPEARS
- [ ] Change ISTC settings → Save → success AUTO-DISAPPEARS
- [ ] Both password inputs are type="password" (dots visible, not plaintext)

---

## PHASE 10: SIDEBAR (H-17 Fix)

### 10A. Collapse the Sidebar
- [ ] Click collapse toggle → sidebar collapses to icons
- [ ] **Logout button (🚪) is STILL VISIBLE** when collapsed
- [ ] Click logout button → confirmation dialog opens
- [ ] Confirm → redirects to login

---

## PHASE 11: SHORTAGES MODULE (H-5/H-6/H-7 Verification)

### 11A. Navigate to `/admin/shortages`
- [ ] Shortage radar loads with flagged products
- [ ] Products with `reorder_level > 0` and `stock ≤ reorder_level` appear
- [ ] Manual shortage flags appear (if any were created)

### 11B. WhatsApp Integration (H-5)
- [ ] Group shortages by supplier
- [ ] Click WhatsApp button on a supplier group
- [ ] URL opens `wa.me/<REAL_PHONE>?text=...` — NOT `wa.me/?text=...`
- [ ] Phone number matches the supplier's registered phone

### 11C. Resolve/Delete Flags (H-6)
- [ ] Click "Resolve" on a shortage flag
- [ ] Flag moves to resolved state
- [ ] Click "Delete" → flag is permanently removed
- [ ] Both require `inventory.manage` capability

### 11D. Create Shortage Flag (H-7)
- [ ] Only users with `inventory.manage` capability can create flags
- [ ] Users with only `inventory.view` get 403

---

## PHASE 12: PAGINATION CLAMPING (H-18 Fix)

### 12A. Any Paginated Admin Page
- [ ] Navigate to any list page with > 1 page of results
- [ ] Type page number > max in URL or manually → clamped to valid range
- [ ] Previous button disabled on page 1
- [ ] Next button disabled on last page
- [ ] Page indicator shows correct range (e.g., "1-10 من 25")

---

## PHASE 13: SYNC VERIFICATION

### 13A. Background Sync
- [ ] Open DevTools → Application → IndexedDB → `pos_local_db` → `sync_queue`
- [ ] Count PENDING records → should be ~25 (20 invoices + 3 movements + 2 settlements)
- [ ] Wait for background sync to process
- [ ] Records transition to SYNCED status
- [ ] `pendingSyncCount` in POS header decreases to 0

### 13B. Supabase Verification
- [ ] Navigate to `/admin/shifts` → shift report visible
- [ ] Click into the shift → transaction items visible
- [ ] All 20 invoice records synced to `sync_events` table
- [ ] Cash movements visible in shift timeline

---

## EXPECTED NUMBERS REFERENCE

### Payment Method Breakdown
| Method | Count | Total |
|--------|-------|-------|
| CASH (pure) | 7 | 1,072.00 |
| CASH (from SPLIT) | 3 | 350.00 |
| **Total Cash Sales** | **10** | **1,422.00** |
| VISA (pure) | 4 | 917.30 |
| VISA (from SPLIT) | 3 | 382.00 |
| **Total Card Sales** | **7** | **1,299.30** |
| CLIQ | 3 | 595.00 |
| DEBT | 3 | 657.50 |
| **Total Sales** | **20** | **3,973.80** |

### Cash Movements
| Type | Amount | Running Drawer |
|------|--------|---------------|
| Starting Cash | — | 500.00 |
| + Cash Sales (invoices) | 1,072.00 | 1,572.00 |
| + SPLIT Cash Portions | 350.00 | 1,922.00 |
| + Cash In #1 | 100.00 | 2,022.00 |
| + Cash In #2 | 50.00 | 2,072.00 |
| − Cash Out #1 | 30.00 | 2,042.00 |
| + Settlement (Ahmad) | 50.00 | 2,092.00 |
| + Settlement (Mohammad) | 30.00 | **2,122.00** |

### Discounts
| Invoice | Type | Amount |
|---------|------|--------|
| #11 | Item discount | 20.00 |
| #12 | Invoice fixed 17 | 17.00 |
| **Total** | | **37.00** |

### Debt Customers
| Customer | Sale | Settlement | Balance |
|----------|------|------------|---------|
| أحمد العلي | 209.60 | 50.00 | 159.60 |
| محمد حسن | 194.10 | 30.00 | 164.10 |
| سارة الدليمي | 253.80 | 0.00 | 253.80 |

---

## PASS/FAIL CRITERIA

| Criterion | Status |
|-----------|--------|
| All 20 invoices injected correctly | ☐ PASS / ☐ FAIL |
| Shift totals match expected numbers | ☐ PASS / ☐ FAIL |
| Tri-reconciliation (zero variance) works | ☐ PASS / ☐ FAIL |
| Discrepancy blocks close when variance ≠ 0 | ☐ PASS / ☐ FAIL |
| Debts page shows correct balances | ☐ PASS / ☐ FAIL |
| Suppliers show 0.00 not "—" | ☐ PASS / ☐ FAIL |
| Settings success auto-clears after 4s | ☐ PASS / ☐ FAIL |
| Sidebar logout visible when collapsed | ☐ PASS / ☐ FAIL |
| No Chinese chars on profitability page | ☐ PASS / ☐ FAIL |
| Expenses filter/form categories independent | ☐ PASS / ☐ FAIL |
| Pagination clamps out-of-range values | ☐ PASS / ☐ FAIL |
| Shortage WhatsApp uses real phone | ☐ PASS / ☐ FAIL |
| Risk shows truncated warning if >20k events | ☐ PASS / ☐ FAIL |
| Sync pushes all records to Supabase | ☐ PASS / ☐ FAIL |
