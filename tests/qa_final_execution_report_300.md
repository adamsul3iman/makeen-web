# QA Master Test Suite — Final Execution Report

**Execution date:** 2026-08-26  
**Application:** `http://localhost:3000`  
**Primary QA store:** `QAM1_20260826010302 Store`  
**Coverage:** TC-001 through TC-300

## Executive Summary

| Module | Range | Passed | Failed | Blocked | Total |
|---|---:|---:|---:|---:|---:|
| 1 — Catalog & Inventory | TC-001–TC-060 | 20 | 40 | 0 | 60 |
| 2 — POS Operations & Cart | TC-061–TC-130 | 61 | 7 | 2 | 70 |
| 3 — Purchasing & PO Builder | TC-131–TC-180 | 27 | 22 | 1 | 50 |
| 4 — Receiving & Cost History | TC-181–TC-230 | 38 | 12 | 0 | 50 |
| 5 — Stock Probe & Inspector | TC-231–TC-270 | 39 | 1 | 0 | 40 |
| 6 — Edge Cases & Stress | TC-271–TC-300 | 22 | 6 | 2 | 30 |
| **Overall** | **TC-001–TC-300** | **207** | **88** | **5** | **300** |

## Status Matrix

Every test case is accounted for below. Ranges are inclusive.

### Module 1 — TC-001–TC-060

**Passed:** TC-007, TC-009–TC-010, TC-029, TC-031, TC-035–TC-040, TC-042, TC-045–TC-048, TC-056–TC-059.

**Failed:** TC-001–TC-006, TC-008, TC-011–TC-028, TC-030, TC-032–TC-034, TC-041, TC-043–TC-044, TC-049–TC-055, TC-060.

**Blocked:** None.

### Module 2 — TC-061–TC-130

**Passed:** TC-061, TC-063–TC-067, TC-070–TC-072, TC-074–TC-086, TC-089–TC-110, TC-112–TC-116, TC-118–TC-125, TC-127–TC-130.

**Failed:** TC-062, TC-068, TC-069, TC-087, TC-088, TC-111, TC-126.

**Blocked:** TC-073, TC-117.

### Module 3 — TC-131–TC-180

**Passed:** TC-132–TC-133, TC-135–TC-142, TC-144–TC-145, TC-148–TC-150, TC-152, TC-155, TC-159–TC-160, TC-166, TC-168–TC-170, TC-172, TC-174–TC-176.

**Failed:** TC-131, TC-134, TC-143, TC-146–TC-147, TC-151, TC-154, TC-156–TC-158, TC-161–TC-165, TC-167, TC-171, TC-173, TC-177–TC-180.

**Blocked:** TC-153.

### Module 4 — TC-181–TC-230

**Passed:** TC-181–TC-186, TC-188–TC-197, TC-200–TC-201, TC-203–TC-206, TC-208, TC-211–TC-215, TC-218–TC-220, TC-222, TC-224–TC-225, TC-227–TC-230.

**Failed:** TC-187, TC-198–TC-199, TC-202, TC-207, TC-209–TC-210, TC-216–TC-217, TC-221, TC-223, TC-226.

**Blocked:** None.

### Module 5 — TC-231–TC-270

**Passed:** TC-231–TC-244, TC-246–TC-270.

**Failed:** TC-245.

**Blocked:** None.

### Module 6 — TC-271–TC-300

**Passed:** TC-271–TC-273, TC-275–TC-277, TC-279–TC-280, TC-282–TC-288, TC-290–TC-291, TC-293, TC-296–TC-299.

**Failed:** TC-281, TC-289, TC-292, TC-294, TC-295, TC-300.

**Blocked:** TC-274, TC-278.

## Critical Bug Breakdown

### BUG-001 — Inventory movement RPC overload ambiguity

**Severity:** Critical  
**Affected:** TC-001–TC-006, TC-008, TC-011–TC-026, TC-049–TC-055, TC-060, TC-087–TC-088 and cascading Module 1 setup checks.

PostgREST cannot choose between the 18-argument and 19-argument `record_inventory_movement` signatures when callers omit `p_variant_id`. The exact error is:

> Could not choose the best candidate function between public.record_inventory_movement(...p_allow_negative) and public.record_inventory_movement(...p_allow_negative, p_variant_id)

Calls that explicitly send `p_variant_id` work. The old function signature must be dropped, or all clients must call one unambiguous signature.

### BUG-002 — POS negative stock is silently clamped

**Severity:** Critical  
**Affected:** TC-021, TC-281, TC-300.

A sale with `p_allow_negative: true` returns success, but `product_variants.total_stock` is updated with `GREATEST(0, ...)`; the parent-sync trigger then restores `products.total_stock` to the non-negative variant sum. Expected stock `-1` remains `0`.

### BUG-003 — Product opening stock field mismatch

**Severity:** High  
**Affected:** TC-001 and TC-300 journey setup.

The product modal sends variant opening stock as `stock`, while `inventoryClient` reads `initialStock`. The UI shows a success toast, but the product and variant are created with zero stock and no opening movement.

### BUG-004 — Cost history exists but the UI cannot read it

**Severity:** High  
**Affected:** TC-198, TC-199, TC-209, TC-210, TC-216, TC-217.

The service-role test created 15 valid `product_cost_history` rows and `fetchCostHistory(..., 10)` returned the latest 10. In the authenticated inventory UI, opening the same product's clock popover displayed `لا سجل بعد`. The table's RLS policy depends on a JWT `store_id` claim that is not present in the app's current browser session model.

### BUG-005 — PO receiving is not atomically claimed

**Severity:** High  
**Affected:** TC-202, TC-289.

Receiving performs a normal status read, stock and price work, invoice creation, then an unconditional status update. Two callers can both pass the initial `pending` check. Per-line idempotency reduces duplicate stock risk, but the second caller is not guaranteed the required `أمر الشراء مستلم بالفعل` error.

### BUG-006 — Fractional receiving quantities are truncated

**Severity:** High  
**Affected:** TC-207.

`ReconciliationModal` parses received quantity with `parseInt`, so `2.333` becomes `2` even though the database and movement RPC support three decimal places.

### BUG-007 — Cart unit switching corrupts base quantity

**Severity:** High  
**Affected:** TC-068, TC-069, TC-294.

`setLineUnit` derives display quantity from the old multiplier and multiplies by the new multiplier. Switching carton-to-piece changes 12 base pieces to 1; switching back can inflate it to 12 or 144 depending on sequence.

### BUG-008 — Stock inspector is not end-to-end O(1)

**Severity:** Medium  
**Affected:** TC-245.

`barcodeIndex[barcode]` is O(1), measured at roughly `0.0001 ms` per synthetic lookup. Every successful resolve then scans `Object.values(barcodes)` to rebuild the variant list, making the complete operation O(N) with catalog size.

### BUG-009 — Receiving summary and mobile layout are incomplete

**Severity:** Medium  
**Affected:** TC-187, TC-226.

The summary bar omits total cost and total selling value. The line editor uses three fixed columns without mobile stacking or a horizontal-scroll container.

### BUG-010 — Invalid received quantity silently becomes zero

**Severity:** Medium  
**Affected:** TC-221.

The quantity handler uses `parseInt(value) || 0`, so an invalid or temporarily empty edit changes the line to zero instead of rejecting the value or restoring the prior quantity.

### BUG-011 — Partial receipt state is not modeled

**Severity:** Medium  
**Affected:** TC-223.

An omitted override falls back to ordered quantity, and every successful flow ends with status `received`. There is no `partial` status or pending remainder.

### BUG-012 — PO Builder gaps

**Severity:** Medium  
**Affected:** TC-131, TC-134, TC-143, TC-146–TC-147, TC-151, TC-154, TC-156–TC-158, TC-161–TC-165, TC-167, TC-171, TC-173, TC-177–TC-180.

The builder lacks required validation messages, purchasable filtering, decimal and high-quantity support, supplier defaults/warnings, stock projection, line notes, unsaved-change confirmation, keyboard submit, recent-PO reuse, deletion, multi-currency, attachments, status history, and CSV export.

### BUG-013 — Persistence and modal edge gaps

**Severity:** Medium  
**Affected:** TC-292, TC-295.

Zustand persistence has no explicit quota-exceeded fallback into IndexedDB. The specified quantities-to-reconciliation modal stack cannot be opened through the current UI, so its z-index behavior is unsupported.

## Browser Evidence

- Three-line reconciliation displayed ordered `100`, received `85`, delta `-15 نقص`, changed cost `12.5`, selling price `20`, and recalculated total `3,062.50 د.أ`.
- Live receipt completed in about `7.5 s` and refreshed the PO to received.
- A 100-line reconciliation modal rendered all 100 rows (`300` numeric inputs) in about `2.35 s`.
- `V1001` resolved `جل شاور` and displayed all variants: red `30`, green `50`, white `0`.
- A spaced `V1002` scan resolved correctly; a fake code showed the Arabic not-found state without clearing valid history.
- History re-query, clear-history, name fallback, continuous scan, and Escape close all worked.
- Unicode, emoji, SQL-like text, and escaped `<script>` product names rendered as text without executing script.

## Database & Stress Evidence

- Reconciled movement deltas were exactly `80`, `50`, and `200` with per-line idempotency and reconciliation metadata.
- Product price finished at cost `12.50`, selling `20.00`; PO status and supplier invoice link were created.
- Manual `-10` adjustment against stock `3` returned `insufficient_stock` and preserved stock `3`.
- Two simultaneous sale RPCs (`-50`, `-30`) serialized correctly from stock `100` to `20`.
- Maximum quantity `999999.999` persisted exactly.
- The 1,000-movement run experienced one transport failure after 554 commits. Idempotent recovery added the remaining 446 in `184.42 s`; final count was exactly `1000`, final stock `0`, and no keys duplicated.

## Blocked Tests

- **TC-073:** no fixture with `allow_price_change=true`.
- **TC-117:** no product-image fixture in the active catalog query.
- **TC-153:** 50-line creation through the PO Builder itself was not exercised; the later 100-line reconciliation fixture was inserted directly.
- **TC-274:** 1,000-product/4,000-variant live browser load was not provisioned; only the synthetic lookup benchmark ran.
- **TC-278:** the authenticated browser was not switched to a separate empty tenant; empty-catalog component behavior was covered by TC-270.

## Console & Runtime Notes

- No uncaught React crash was observed during Modules 4–6.
- Repeated Supabase warning observed across sessions: `Multiple GoTrueClient instances detected`.
- One DNS failure occurred during a repeated Module 1 probe: `getaddrinfo ENOTFOUND db.avjtopmuexiderzgnmdz.supabase.co`.
- Two transient `TypeError: fetch failed` events occurred under the long sequential RPC load; both paths succeeded on bounded retry.

## UX Recommendations

1. Make receipt ownership atomic and show a clear conflict toast when another user receives first.
2. Preserve decimal quantities through the UI and show inline validation instead of converting invalid input to zero.
3. Add received-vs-ordered and cost/selling totals to a sticky summary on long reconciliation lists.
4. Pre-index variants by parent product so the inspector remains constant-time at scale.
5. Surface a real cost-history error when RLS blocks access; do not display an empty-history state for authorization failures.
6. Add explicit offline/pending indicators and quota-recovery messaging for critical POS writes.

## QA Artifacts

- `tests/qa_module1_runner.mjs`
- `tests/qa_modules_2_3_runner.mjs`
- `tests/qa_modules_4_6_runner.mjs`
- `tests/qa_modules_4_6_recovery.mjs`
