# ═══════════════════════════════════════════════════════════════════════════
# MASTER QA TEST SUITE — 300 SCENARIOS
# ERP POS System: Catalog, UoM, Variants, PO, Receiving, Stock Inspector
# ═══════════════════════════════════════════════════════════════════════════
# Format: Consumable by AI agents (Codex / Browser-use) as step-by-step tasks.
# Each test: ID | Module | Title | Steps | Expected Result
# ═══════════════════════════════════════════════════════════════════════════

---

## MODULE 1: CATALOG & VARIANT STOCK SYNC (Tests 1–60)

### TC-001: Create single-variant product with no UoM tiers
- **Steps:**
  1. Navigate to admin catalog page.
  2. Click "إضافة منتج جديد".
  3. Enter name: "صابون لويز-popup", category: "منزلية", base unit: "حبة".
  4. Set cost_price: 10, selling_price: 15.
  5. Leave variant matrix with default single variant (label: "أساسي").
  6. Set opening stock: 87 pieces.
  7. Submit form.
- **Expected:** Product created. `products.total_stock = 87`. `product_variants.total_stock = 87`. Trigger `trg_pv_stock_sync` fires and parent matches variant sum.

### TC-002: Create multi-variant product (3 colors)
- **Steps:**
  1. Create product "جل شاور", category: "كوزماتيكس", base unit: "عبوة".
  2. In variant matrix, add 3 rows: "احمر", "اخضر", "ابيض".
  3. Set barcode for each: "V1001", "V1002", "V1003".
  4. Set cost: 20, selling: 35 for all.
  5. Set opening stock: 30 for "احمر", 50 for "اخضر", 0 for "ابيض".
  6. Submit.
- **Expected:** `products.total_stock = 80`. Each `product_variants.total_stock` matches its opening stock. Parent = sum of all active variants.

### TC-003: Variant barcode uniqueness enforcement
- **Steps:**
  1. Create product A with variant barcode "DUP123".
  2. Try to create product B with variant barcode "DUP123".
- **Expected:** `assertNoBarcodeConflict` throws error. Second product creation fails with duplicate barcode message.

### TC-004: UoM tier creation with multiplier
- **Steps:**
  1. Edit product "صابون لويز-popup".
  2. Add UoM tier: unitName: "كرتونة", qtyMultiplier: 12, barcode: "CTN-LOU-001".
  3. Save.
- **Expected:** `product_units` row created with `qty_multiplier = 12`. Barcode "CTN-LOU-001" indexed in `barcodeMap` as unit barcode.

### TC-005: UoM tier barcode resolution in `record_inventory_movement`
- **Steps:**
  1. Sell 1 كرتونة of "صابون لويز-popup" by scanning barcode "CTN-LOU-001".
  2. Check `inventory_movements` row.
- **Expected:** `multiplier = 12`, `unit_name = "كرتونة"`, `unit_quantity = 1`, `quantity_delta = -12`. `products.total_stock` decremented by 12 base pieces.

### TC-006: Variant barcode resolves to base unit
- **Steps:**
  1. Sell 1 حبة of "صابون لويز-popup" by scanning variant barcode "V1001" (for "احمر").
  2. Check `inventory_movements` row.
- **Expected:** `variant_label = "احمر"`, `multiplier = 1`, `unit_name = "حبة"`, `quantity_delta = -1`. `product_variants.total_stock` for "احمر" decremented by 1.

### TC-007: Stock display breakdown — cartons and pieces
- **Steps:**
  1. Product "صابون لويز-popup" has `total_stock = 87`, UoM tier "كرتونة" × 12.
  2. View stock breakdown in catalog page.
- **Expected:** `breakdownStock(87, units, false, "حبة")` renders "7 كرتون و 3 حبات". Raw display: "87 حبة".

### TC-008: Stock display — weighed product
- **Steps:**
  1. Create product "زيت زيتون", base_unit: "كغ", is_weighed: true.
  2. Set stock: 25.500.
  3. View breakdown.
- **Expected:** `breakdownStock` returns raw value "25.5 كغ" without unit tier breakdown.

### TC-009: `maxUnitsAvailable` calculation
- **Steps:**
  1. Product stock = 87, UoM multiplier = 12.
  2. Call `maxUnitsAvailable(87, 12)`.
- **Expected:** Returns 7 (floor of 87/12).

### TC-010: `maxUnitsAvailable` with zero stock
- **Steps:**
  1. Product stock = 0, UoM multiplier = 12.
  2. Call `maxUnitsAvailable(0, 12)`.
- **Expected:** Returns 0.

### TC-011: Parent stock matches variant sum after sale
- **Steps:**
  1. Product "جل شاور" has variants: احمر(30), اخضر(50), ابيض(0). Parent=80.
  2. Sell 5 of "احمر" via barcode "V1001".
- **Expected:** `product_variants.total_stock` for "احمر" = 25. Trigger fires: `products.total_stock = 25 + 50 + 0 = 75`.

### TC-012: Parent stock matches variant sum after purchase receipt
- **Steps:**
  1. Receive PO with 20 units of "احمر" (barcode V1001) via `receivePurchaseOrderWithReconciliation`.
  2. Check parent and variant stock.
- **Expected:** "احمر" variant stock = 45 (25+20). Parent = 45 + 50 + 0 = 95. Both RPC (`record_inventory_movement`) and trigger update correctly.

### TC-013: Opening stock on new product — single variant
- **Steps:**
  1. Create product via `createInventoryProduct` with 1 variant and `stock: 50`.
  2. Check both tables.
- **Expected:** `products.total_stock = 50`. `product_variants.total_stock = 50`. INSERT sets variant stock directly; OPENING movement also recorded.

### TC-014: Opening stock on new product — multi-variant with per-row stock
- **Steps:**
  1. Create product via `createInventoryProduct` with 3 variants.
  2. Set `initialStock`: variant1=10, variant2=20, variant3=0.
  3. Set `stock: 0` (product-level).
- **Expected:** `products.total_stock = 30`. Each variant has its `initialStock`. Movement recorded with `quantity_delta = 30`.

### TC-015: Product creation with tax_included = true
- **Steps:**
  1. Create product with `tax_included: true`, `tax_percent: 14`, `selling_price: 100`.
- **Expected:** Product created. When displayed in POS, `price` shown is 100 (tax included). Internal calculations use pre-tax base.

### TC-016: Category hierarchy — Category > Brand > Product > Variant
- **Steps:**
  1. Create category "نظافة".
  2. Create brand "Document".
  3. Create product under category "نظافة", brand "Document".
  4. Product has variant "احمر".
- **Expected:** Product `category_id` links to "نظافة". Product `brand_id` links to "Document". Variant `product_id` links to product. 4-tier hierarchy intact.

### TC-017: Product `is_active` flag hides from POS
- **Steps:**
  1. Create product "منتج مخفي", set `is_active: false`.
  2. Open POS register.
- **Expected:** Product does not appear in POS catalog grid. Exists in admin catalog.

### TC-018: Product `show_in_pos` flag
- **Steps:**
  1. Create product with `show_in_pos: false`, `is_active: true`.
  2. Open POS register.
- **Expected:** Product hidden from POS grid but visible in admin catalog and inventory reports.

### TC-019: Reorder level alert
- **Steps:**
  1. Create product with `reorder_level: 10`, stock = 5.
  2. Navigate to inventory low-stock report.
- **Expected:** Product appears in low-stock alerts with severity "critical" (stock ≤ 0 or ≤7 days of stock).

### TC-020: Negative stock prevention (non-sale)
- **Steps:**
  1. Product stock = 5.
  2. Attempt manual adjustment OUT of 10 units via `movementsClient.ts` with `p_allow_negative: false`.
- **Expected:** RPC raises `insufficient_stock` (23514). Stock remains 5.

### TC-021: Negative stock allowed for sales
- **Steps:**
  1. Product stock = 3.
  2. Sale of 5 units syncs via `syncMirror.ts` with `p_allow_negative: true`.
- **Expected:** Movement recorded. `products.total_stock = -2`. Sale completes without stock block.

### TC-022: Idempotency key prevents duplicate movements
- **Steps:**
  1. Sale sync calls `record_inventory_movement` with idempotency_key `invoice:ABC:1`.
  2. Same call repeated (network retry).
- **Expected:** Second call returns the existing movement row. Stock not decremented twice.

### TC-023: Product update preserves existing stock
- **Steps:**
  1. Product has stock = 87.
  2. Edit product name to "صابون لويز-جديد" via `updateInventoryProduct`.
  3. Check stock.
- **Expected:** `products.total_stock = 87` unchanged. Only name and price fields updated.

### TC-024: Cost price sync from PO to product
- **Steps:**
  1. Product cost_price = 10.
  2. Receive PO with unit_cost = 12 for this product.
- **Expected:** `products.cost_price` updated to 12 after PO receipt price control loop.

### TC-025: Selling price override from PO
- **Steps:**
  1. Product selling_price = 15.
  2. PO line has `new_selling_price: 20`.
  3. Receive PO.
- **Expected:** `products.selling_price` updated to 20.

### TC-026: `notifyLocalCatalogWrite` triggers catalog refresh
- **Steps:**
  1. Create a product.
  2. Check Zustand store `products` map.
- **Expected:** After `notifyLocalCatalogWrite`, the local catalog version increments. Next hydration fetches the new product.

### TC-027: `mergeEntityMap` merges partial catalog snapshots
- **Steps:**
  1. Local store has products A, B, C.
  2. Snapshot arrives with B (updated), D (new).
  3. Apply via `mergeEntityMap`.
- **Expected:** Store has A, B(updated), C, D. No data loss.

### TC-028: `isDefaultSale` and `isDefaultPurchase` flags on variants
- **Steps:**
  1. Create product with 3 variants.
  2. Set variant "احمر" as `isDefaultSale: true`.
  3. Set variant "اخضر" as `isDefaultPurchase: true`.
- **Expected:** In `barcodeMap`, "احمر" has `isDefaultSale: true`. "اخضر" has `isDefaultPurchase: true`.

### TC-029: Wholesale price stored on variant
- **Steps:**
  1. Create variant with `wholesalePrice: 25`.
  2. Check `LocalBarcode.wholesalePrice`.
- **Expected:** `wholesalePrice = 25` on the barcode map entry.

### TC-030: Product deletion cascades to variants
- **Steps:**
  1. Product has 3 variants in `product_variants`.
  2. Delete product from admin.
- **Expected:** All 3 variant rows deleted. All `product_units` rows deleted. Parent product deleted.

### TC-031: Barcode index O(1) lookup performance
- **Steps:**
  1. Catalog has 500 products (2000 variants).
  2. Scan barcode "V1001".
  3. Measure time to resolve product from `barcodeIndex`.
- **Expected:** Resolution completes in < 1ms (O(1) hash map lookup).

### TC-032: Product variant label required
- **Steps:**
  1. Try to create variant with empty `variant_label`.
- **Expected:** Validation rejects. Variant row not inserted.

### TC-033: `record_inventory_movement` with no barcode — parent only update
- **Steps:**
  1. Call RPC with `p_barcode: NULL` for a product with 3 variants.
  2. Check `product_variants.total_stock`.
- **Expected:** `products.total_stock` updated. No `product_variants` row updated (variant_id not resolved). Variant stocks unchanged.

### TC-034: `record_inventory_movement` with `p_variant_id` direct
- **Steps:**
  1. Call RPC with `p_variant_id: <uuid of "احمر">`, `p_quantity_delta: 10`.
  2. Check variant and parent stock.
- **Expected:** "احمر" variant stock += 10. Parent stock += 10.

### TC-035: Migration 089 backfill — Phase 1 (movement history)
- **Steps:**
  1. Product has 1 variant "احمر".
  2. Movement history has: +50 SALE RETURN, -20 SALE. variant_label = "احمر".
  3. Run Phase 1 backfill.
- **Expected:** "احمر" `total_stock = GREATEST(0, 50-20) = 30`.

### TC-036: Migration 089 backfill — Phase 2 (single variant fallback)
- **Steps:**
  1. Product has 1 variant with `total_stock = 0`.
  2. `products.total_stock = 87`.
  3. Movement history has no variant_label matching.
  4. Run Phase 2.
- **Expected:** Variant `total_stock = 87`. Parent unchanged at 87.

### TC-037: Migration 089 backfill — Phase 3 (multi-variant deficit)
- **Steps:**
  1. Product has 3 variants: A(0), B(0), C(0). Parent = 87.
  2. Run Phase 3.
- **Expected:** First variant (lowest id) gets `total_stock = 87`. Others stay 0. Parent unchanged.

### TC-038: Migration 089 backfill — Phase 4 (parent reconciliation)
- **Steps:**
  1. After Phase 3: variants sum = 87. Parent = 87.
  2. Run Phase 4.
- **Expected:** `products.total_stock = 87` (unchanged, already correct).

### TC-039: Migration 089 backfill — negative clamp
- **Steps:**
  1. Movement history: -50 SALE, +20 RETURN. Sum = -30.
  2. Run Phase 1.
- **Expected:** Variant `total_stock = GREATEST(0, -30) = 0`. No constraint violation.

### TC-040: Trigger drop during migration 089
- **Steps:**
  1. `trg_pv_stock_sync` exists before migration.
  2. Start migration 089.
- **Expected:** Trigger dropped before backfill. Backfill phases run without trigger interference. Trigger recreated after Phase 4.

### TC-041: Trigger recreation after migration 089
- **Steps:**
  1. Migration 089 completes.
  2. UPDATE a variant's `total_stock` manually.
- **Expected:** `trg_pv_stock_sync` fires. `products.total_stock` updated to sum of variants.

### TC-042: Hotfix 090 idempotency
- **Steps:**
  1. Run hotfix 090 once. Parent = 87, variants sum = 87.
  2. Run hotfix 090 again.
- **Expected:** No changes. All phases are idempotent. Parent stays 87.

### TC-043: `log_cost_history` RPC creates audit row
- **Steps:**
  1. Receive PO that changes cost_price from 10 to 15.
  2. Check `product_cost_history` table.
- **Expected:** Row with `old_cost: 10`, `new_cost: 15`, `source: 'PO_RECEIPT'`, `ref_type: 'PURCHASE_ORDER'`.

### TC-044: `log_cost_history` — old prices captured before update
- **Steps:**
  1. `log_cost_history` called before `products.update(cost_price)`.
  2. Check `product_cost_history.old_cost`.
- **Expected:** `old_cost` reflects the price BEFORE the update (10, not 15). RPC is Security Definer so it reads pre-update state.

### TC-045: Product search by name in catalog
- **Steps:**
  1. Catalog has "صابون لويز", "جل شاور", "معقم يدين".
  2. Search for "صابون".
- **Expected:** "صابون لويز" returned. Others filtered out.

### TC-046: Product search by barcode in catalog
- **Steps:**
  1. Search for barcode "V1001".
- **Expected:** Product "جل شاور", variant "احمر" resolved via `barcodeIndex["V1001"]`.

### TC-047: Category filter in catalog
- **Steps:**
  1. Filter by category "كوزماتيكس".
- **Expected:** Only products in "كوزماتيكس" shown.

### TC-048: Brand filter in catalog
- **Steps:**
  1. Filter by brand "Document".
- **Expected:** Only products with `brand_id` = Document shown.

### TC-049: is_sellable flag prevents POS sale
- **Steps:**
  1. Product has `is_sellable: false`.
  2. Try to scan in POS.
- **Expected:** Product not addable to cart. Barcode lookup fails or product filtered.

### TC-050: is_purchasable flag prevents PO addition
- **Steps:**
  1. Product has `is_purchasable: false`.
  2. Open PO Builder.
  3. Search for this product.
- **Expected:** Product excluded from PO search results.

### TC-051: Cost history — CostHistoryPopover displays last 10 changes
- **Steps:**
  1. Product has 12 cost history entries.
  2. Click clock icon on inventory page.
- **Expected:** `fetchCostHistory(productId, limit)` returns last 10 rows. Popover shows 10 entries with old→new deltas and trend arrows.

### TC-052: Cost history — trend arrow UP for cost increase
- **Steps:**
  1. Cost changed from 10 → 15.
- **Expected:** Popover shows ↑ arrow in amber/red color. Delta: "+5.00".

### TC-053: Cost history — trend arrow DOWN for cost decrease
- **Steps:**
  1. Cost changed from 15 → 10.
- **Expected:** Popover shows ↓ arrow in green. Delta: "-5.00".

### TC-054: Variant stock — all variants sum equals parent after multiple sales
- **Steps:**
  1. Product has 3 variants. Parent = 87.
  2. Sell 5 of variant A, 3 of variant B, 2 of variant C.
- **Expected:** Variants: A -= 5, B -= 3, C -= 2. Parent = 87 - 10 = 77. Sum of variants = 77.

### TC-055: Variant stock — PO receipt distributes to specific variant
- **Steps:**
  1. PO line has `variant_id` = variant A's UUID.
  2. Receive 20 units.
- **Expected:** RPC with `p_variant_id` updates variant A stock += 20. Parent += 20.

### TC-056: Catalog hydration — `buildProductUnits` fallback chain
- **Steps:**
  1. Variant has `selling_price: NULL`, `wholesale_price: 30`, `price: 25`.
  2. `buildProductUnits` processes this variant.
- **Expected:** Unit price = 30 (wholesale fallback, since selling_price is null). Not 25 (price).

### TC-057: Catalog hydration — selling_price present
- **Steps:**
  1. Variant has `selling_price: 40`.
  2. `buildProductUnits` processes this variant.
- **Expected:** Unit price = 40 (selling_price takes priority).

### TC-058: Catalog hydration — price × multiplier fallback
- **Steps:**
  1. Variant has `selling_price: NULL`, `wholesale_price: NULL`, `price: 10`.
  2. UoM tier with `qty_multiplier: 12`.
- **Expected:** Unit display price = 10 × 12 = 120 for the كرتونة tier.

### TC-059: Catalog hydration — all prices zero
- **Steps:**
  1. Variant has `selling_price: 0`, `wholesale_price: 0`, `price: 0`.
- **Expected:** Unit price = 0. No crash. `formatMoney(0)` displays "0.00".

### TC-060: Migration 088 — barcode lookup cascade
- **Steps:**
  1. Product has UoM barcode "CTN-001" and variant barcode "V001".
  2. Call `record_inventory_movement` with `p_barcode: "CTN-001"`.
- **Expected:** Matched in `product_units`. `v_unit_name = "كرتونة"`, `v_multiplier = 12`. No variant_label set.

---

## MODULE 2: POS OPERATIONS & CART LOGIC (Tests 61–130)

### TC-061: Add product to cart by barcode scan
- **Steps:**
  1. Open POS register.
  2. Scan barcode "V1001" (جل شاور — احمر).
  3. Check cart.
- **Expected:** Cart has 1 line: product "جل شاور", variant "احمر", qty: 1 (base pieces), unitPrice: 35 (selling price per piece).

### TC-062: Add product by tapping quick-key
- **Steps:**
  1. Product "صابون لويز" has `is_quick_key: true`.
  2. Tap its card in POS grid.
- **Expected:** Product added to cart with qty: 1.

### TC-063: Cart qty stored in base pieces (not multiplied)
- **Steps:**
  1. Scan UoM barcode "CTN-LOU-001" (كرتونة ×12).
  2. Check cart item `qty`.
- **Expected:** `cartItem.qty = 12` (base pieces). `cartItem.unitName = "كرتونة"`. `cartItem.unitMultiplier = 12`.

### TC-064: Cart unitPrice is per base piece
- **Steps:**
  1. Scan UoM barcode "CTN-LOU-001". Selling price per piece = 15.
  2. Check `cartItem.unitPrice`.
- **Expected:** `unitPrice = 15` (per piece, not per carton). Carton price = 15 × 12 = 180.

### TC-065: Cart total calculation — full float precision
- **Steps:**
  1. Add 3 items with prices: 10.00, 15.50, 22.33.
  2. Check cart total.
- **Expected:** Total = 47.83 (exact arithmetic, no rounding until display). `formatMoney()` renders "47.83".

### TC-066: Cart total — floating-point edge case
- **Steps:**
  1. Add item with price 0.1.
  2. Add 3 more of the same.
  3. Check total.
- **Expected:** Total = 0.4 (not 0.39999999999999997). Internal math uses safe arithmetic; `formatMoney()` rounds at render.

### TC-067: Dedicated Unit column in cart
- **Steps:**
  1. Scan UoM barcode "CTN-LOU-001".
  2. Check cart columns.
- **Expected:** "الوحدة" column shows "كرتونة". "الكمية" shows 12. "سعر الوحدة" shows 15.00.

### TC-068: Unit switch in cart — auto-scaling
- **Steps:**
  1. Cart has "صابون لويز" × 12 pieces (from كرتونة scan).
  2. Click unit switch to "حبة".
- **Expected:** Cart qty stays 12 base pieces. Display shows 12 حبة. unitName changes to "حبة", multiplier to 1.

### TC-069: Unit switch — badge multiplier display
- **Steps:**
  1. Cart has "صابون لويز" × 12 pieces.
  2. Click unit switch to "كرتونة".
- **Expected:** Badge shows "×12". Display: "1 كرتونة". Underlying qty = 12 base pieces.

### TC-070: Cart qty increment by +1
- **Steps:**
  1. Cart has 1 item ( qty = 1).
  2. Click "+" button.
- **Expected:** Qty = 2. Total updates proportionally.

### TC-071: Cart qty decrement to zero removes line
- **Steps:**
  1. Cart has 1 item (qty = 1).
  2. Click "-" button.
- **Expected:** Line removed from cart. Cart is empty.

### TC-072: Clear entire cart
- **Steps:**
  1. Cart has 5 items.
  2. Click "مسح السلة".
- **Expected:** All items removed. Cart total = 0.

### TC-073: Price override (allow_price_change)
- **Steps:**
  1. Product has `allow_price_change: true`.
  2. Add to cart.
  3. Click on unitPrice field, change to 20.
- **Expected:** `cartItem.unitPrice = 20`. Line total recalculated.

### TC-074: Price override blocked
- **Steps:**
  1. Product has `allow_price_change: false`.
  2. Add to cart.
  3. Try to edit unitPrice.
- **Expected:** Price field not editable. Displayed price from catalog.

### TC-075: Add duplicate product — merge qty
- **Steps:**
  1. Scan "V1001" → cart has qty 1.
  2. Scan "V1001" again.
- **Expected:** Cart qty for "V1001" = 2. Not two separate lines.

### TC-076: Add different variants of same product — separate lines
- **Steps:**
  1. Scan "V1001" (احمر).
  2. Scan "V1002" (اخضر).
- **Expected:** Two cart lines: one for احمر, one for اخضر. Different `variantId`.

### TC-077: Offline mode — sale saved to IDB
- **Steps:**
  1. Disconnect network.
  2. Complete a sale (add items, click checkout).
- **Expected:** Sale saved to IndexedDB via `idb.ts`. Toast: "تم حفظ الفاتورة محلياً".

### TC-078: IDB queue — pending invoices display
- **Steps:**
  1. Go offline, complete 3 sales.
  2. Navigate to pending invoices panel.
- **Expected:** 3 invoices listed with status "PENDING". `countIstdPending()` returns 3.

### TC-079: Online sync — IDB invoices push to server
- **Steps:**
  1. Reconnect network.
  2. `bypassAllStuckIstd()` runs on login.
- **Expected:** All PENDING invoices marked `ISTD_BYPASSED` (since `BYPASS_ISTD = true`). POS sync unblocked.

### TC-080: JoFotara bypass — `pushInvoiceToIstd` short-circuits
- **Steps:**
  1. `BYPASS_ISTD = true`.
  2. Sale completes, `pushInvoiceToIstd` called.
- **Expected:** Function immediately marks invoice as `ISTD_BYPASSED` in IDB. Returns without making network call. No JoFotara error.

### TC-081: JoFotara bypass — `countIstdPending` excludes bypassed
- **Steps:**
  1. 5 invoices: 3 PENDING, 2 ISTD_BYPASSED.
  2. Call `countIstdPending()`.
- **Expected:** Returns 3 (only PENDING, not bypassed).

### TC-082: JoFotara bypass — `getIstdStates` includes bypassed
- **Steps:**
  1. Call `getIstdStates()`.
- **Expected:** Returns both PENDING and ISTD_BYPASSED invoices in the result.

### TC-083: Boot-time bypass clears stuck queue
- **Steps:**
  1. Have 5 PENDING invoices in IDB.
  2. Login (triggers `applyLoginPayloadToStore`).
- **Expected:** `bypassAllStuckIstd()` called automatically. All 5 → ISTD_BYPASSED. POS ready immediately.

### TC-084: POS cart — Arabic product names display correctly
- **Steps:**
  1. Product name: "معقم يدين بكحول 70%".
  2. Add to cart.
- **Expected:** Name renders correctly in RTL. No truncation on desktop. Truncation with ellipsis on mobile if too long.

### TC-085: POS cart — simultaneous line items
- **Steps:**
  1. Add 10 different products to cart.
- **Expected:** All 10 lines visible. Scrolling works. No performance lag.

### TC-086: Cart persistence — refresh preserves cart
- **Steps:**
  1. Add 3 items to cart.
  2. Refresh browser page.
  3. Check cart.
- **Expected:** Cart preserved via Zustand persist + IDB. 3 items still present with correct quantities and prices.

### TC-087: Sale completion — stock decremented
- **Steps:**
  1. Product stock = 87.
  2. Sell 5 pieces.
- **Expected:** After sync, `products.total_stock = 82`. Movement recorded with `quantity_delta = -5`.

### TC-088: Sale return — stock incremented
- **Steps:**
  1. Previous sale of 5 pieces. Stock = 82.
  2. Process return of 2 pieces.
- **Expected:** `products.total_stock = 84`. Movement with `movement_type = "RETURN"`, `quantity_delta = +2`.

### TC-089: Tax calculation in cart
- **Steps:**
  1. Product has `tax_percent: 14`, `tax_included: true`, price: 100.
  2. Add to cart.
- **Expected:** Displayed price = 100 (tax included). Tax amount = 100 × 14/114 ≈ 12.28. Net = 87.72.

### TC-090: POS quick-actions drawer opens
- **Steps:**
  1. In POS, click hamburger menu / quick actions button.
- **Expected:** `QuickActionsDrawer` opens. Shows "كميات المنتجات والاستعلام السريع" button.

### TC-091: Quick-actions drawer — open ProductQuantitiesModal
- **Steps:**
  1. Open quick-actions drawer.
  2. Click "كميات المنتجات والاستعلام السريع".
- **Expected:** `ProductQuantitiesModal` opens. Input auto-focused.

### TC-092: Cart — `formatMoney` rounding at render
- **Steps:**
  1. Item price = 10.333 (from cost calculation).
  2. Quantity = 3.
  3. Line total internal = 30.999.
- **Expected:** Displayed total = "31.00" (rounded at render, not in storage).

### TC-093: Cart — variant label shown on line item
- **Steps:**
  1. Add "جل شاور — احمر" to cart.
- **Expected:** Line shows "احمر" as variant label under product name.

### TC-094: POS — product not found error
- **Steps:**
  1. Scan barcode "FAKE999".
- **Expected:** Error toast or inline message: "الباركود غير مسجل". No item added to cart.

### TC-095: Cart — rapid add/remove
- **Steps:**
  1. Add item to cart.
  2. Click "+" 20 times rapidly.
- **Expected:** Qty = 21. No duplicate lines. No UI freeze. Cart total updates correctly.

### TC-096: Cart — negative qty prevention
- **Steps:**
  1. Cart has 1 item (qty = 1).
  2. Try to manually type -5 in qty field.
- **Expected:** Input rejected or clamped to 0. Line removed.

### TC-097: Cart — barcode with leading/trailing spaces
- **Steps:**
  1. Scan "  V1001  " (with spaces).
- **Expected:** Trimmed to "V1001". Product resolved correctly.

### TC-098: Cart — duplicate barcode in barcodeMap (unit vs variant)
- **Steps:**
  1. Scan "CTN-LOU-001" (unit barcode for كرتونة).
  2. System resolves as unit, not variant.
- **Expected:** Unit tier identified. Multiplier = 12. `unitName = "كرتونة"`.

### TC-099: Cart — `useModalEscape` closes on Esc
- **Steps:**
  1. Open `ProductQuantitiesModal`.
  2. Press Escape.
- **Expected:** Modal closes. Input loses focus.

### TC-100: POS register — daily total calculation
- **Steps:**
  1. Complete 5 sales in one session.
  2. Check daily total.
- **Expected:** Total = sum of all 5 invoice totals. Correct to 2 decimal places.

### TC-101: Cart — stock check warning (low stock)
- **Steps:**
  1. Product has stock = 2.
  2. Add 5 to cart.
- **Expected:** Visual warning on cart line (red badge or tooltip) indicating insufficient stock.

### TC-102: Cart — apply discount
- **Steps:**
  1. Add item with price 100.
  2. Apply 10% discount.
- **Expected:** Discounted price = 90. Line total = 90. Discount amount shown.

### TC-103: Cart — customer selection
- **Steps:**
  1. Select customer "أحمد محمد" from customer dropdown.
  2. Complete sale.
- **Expected:** Invoice linked to customer. Customer name on receipt.

### TC-104: Cart — split payment
- **Steps:**
  1. Total = 200.
  2. Pay 100 cash + 100 card.
- **Expected:** Payment recorded as split. Invoice total = 200. Two payment entries.

### TC-105: POS — receipt printing
- **Steps:**
  1. Complete sale.
  2. Click print.
- **Expected:** Thermal receipt generated with: store name, items, totals, tax, payment method.

### TC-106: Cart — auto-focus on input after modal close
- **Steps:**
  1. Close `ProductQuantitiesModal`.
  2. Return to POS.
- **Expected:** POS barcode input re-focused.

### TC-107: Cart — concurrent qty edits (rapid +/- clicks)
- **Steps:**
  1. Hold down "+" button for 2 seconds.
- **Expected:** Qty increments smoothly. No race condition. Final qty correct.

### TC-108: POS — cash drawer open on sale
- **Steps:**
  1. Complete cash sale.
- **Expected:** Cash drawer trigger fired (if hardware connected). Transaction recorded.

### TC-109: POS — shift management
- **Steps:**
  1. Start shift.
  2. Complete 3 sales.
  3. End shift.
- **Expected:** Shift report shows 3 sales, total revenue, cash in drawer.

### TC-110: Cart — variant matrix items via `addVariantMatrixItems`
- **Steps:**
  1. In POS, select product "جل شاور" with 3 variants.
  2. Add all 3 variants to cart.
- **Expected:** 3 cart lines with synthetic barcodes `UOM:${unitId}:${variantLabel}`. Each with correct variant_id and label.

### TC-111: Cart — product not sellable (`is_sellable: false`)
- **Steps:**
  1. Product has `is_sellable: false`.
  2. Try to scan in POS.
- **Expected:** Barcode resolves but cart rejects addition. Error: "المنتج غير قابل للبيع".

### TC-112: POS — login payload applies to store
- **Steps:**
  1. Login with credentials.
  2. Check Zustand store.
- **Expected:** `applyLoginPayloadToStore` sets products, barcodes, barcodeIndex, productUnits, categories, brands. All O(1) maps populated.

### TC-113: POS — logout clears store
- **Steps:**
  1. Logout.
  2. Check store.
- **Expected:** Products, barcodes, cart all cleared. IDB state preserved.

### TC-114: Cart — line discount per item
- **Steps:**
  1. Add 2 items.
  2. Apply 5% discount to item 1 only.
- **Expected:** Item 1 discounted, item 2 at full price. Total = discounted_item1 + full_item2.

### TC-115: POS — keyboard shortcut for checkout
- **Steps:**
  1. Cart has items.
  2. Press Enter or F2 (checkout shortcut).
- **Expected:** Checkout modal opens.

### TC-116: Cart — quantity keyboard input
- **Steps:**
  1. Click on qty field in cart.
  2. Type "25".
  3. Press Enter.
- **Expected:** Qty = 25. Total recalculated.

### TC-117: POS — product image display
- **Steps:**
  1. Product has `image_url`.
  2. View in POS grid.
- **Expected:** Product image shown in grid card. Fallback to icon if no image.

### TC-118: Cart — multiple payments
- **Steps:**
  1. Total = 300.
  2. Pay 100 cash + 100 card + 100 credit.
- **Expected:** 3 payment methods recorded. Invoice balanced.

### TC-119: Cart — B2B account sale
- **Steps:**
  1. Select B2B customer account.
  2. Complete sale on credit.
- **Expected:** `b2b_accounts.balance` debited. Transaction recorded in B2B ledger.

### TC-120: POS — multi-terminal scenario
- **Steps:**
  1. Terminal A sells 5 of product X (stock = 87 → 82).
  2. Terminal B sells 3 of product X.
- **Expected:** After sync, `products.total_stock = 79`. Idempotency keys prevent double-counting.

### TC-121: Cart — modify price then change qty
- **Steps:**
  1. Add item at price 15.
  2. Override price to 20.
  3. Change qty to 3.
- **Expected:** Total = 60 (20 × 3). Price override preserved across qty changes.

### TC-122: POS — hold/park transaction
- **Steps:**
  1. Add items to cart.
  2. Click "تعليق" (hold).
  3. Start new transaction.
- **Expected:** Cart cleared. Held transaction stored. Can be recalled later.

### TC-123: POS — recall held transaction
- **Steps:**
  1. Hold transaction with 3 items.
  2. Click "استدعاء" (recall).
- **Expected:** Cart restored with all 3 items, quantities, and prices.

### TC-124: Cart — weigh scale integration
- **Steps:**
  1. Product "زيت زيتون" is weighed (`is_weighed: true`).
  2. Scan barcode, enter weight 2.5.
- **Expected:** Qty = 2.5. Total = 2.5 × unit_price.

### TC-125: POS — customer change calculation
- **Steps:**
  1. Total = 85.
  2. Customer pays 100.
- **Expected:** Change = 15. Displayed on screen.

### TC-126: Cart — apply coupon
- **Steps:**
  1. Total = 200.
  2. Apply coupon "SAVE20" for 20% off.
- **Expected:** Discount = 40. Final total = 160.

### TC-127: POS — concurrent cart edits (optimistic locking)
- **Steps:**
  1. Two users on same terminal try to modify cart simultaneously.
- **Expected:** Last write wins. No data corruption. Cart state consistent.

### TC-128: Cart — overflow protection (very large qty)
- **Steps:**
  1. Add item.
  2. Set qty = 999999.
- **Expected:** Total calculated correctly. No integer overflow. `formatMoney` renders correctly.

### TC-129: POS — offline indicator badge
- **Steps:**
  1. Disconnect network.
- **Expected:** "غير متصل" badge visible in POS header. Red/orange indicator.

### TC-130: Cart — return flow with original invoice
- **Steps:**
  1. Look up original invoice #1234.
  2. Select items to return.
  3. Process return.
- **Expected:** New invoice with negative quantities. Stock incremented. Original invoice flagged.

---

## MODULE 3: ADVANCED PURCHASING & PO BUILDER (Tests 131–180)

### TC-131: PO Builder modal opens
- **Steps:**
  1. Navigate to admin purchases page.
  2. Click "أمر شراء جديد".
- **Expected:** `POBuilderModal` opens. Supplier dropdown, product search, line items table visible.

### TC-132: PO Builder — add product by search
- **Steps:**
  1. In PO Builder, search "صابون".
- **Expected:** `searchProductsForPO()` returns matching products. Results list shows "صابون لويز".

### TC-133: PO Builder — add product by barcode scan
- **Steps:**
  1. Scan "V1001" in PO Builder.
- **Expected:** Product "جل شاور" variant "احمر" added as PO line.

### TC-134: PO Builder — multi-variant selection
- **Steps:**
  1. Search "جل شاور".
  2. Select all 3 variants (احمر, اخضر, ابيض).
  3. Add to PO.
- **Expected:** 3 PO lines, each with correct `variant_id`. Quantities default to 0.

### TC-135: PO Builder — set quantity per line
- **Steps:**
  1. Add "جل شاور — احمر" to PO.
  2. Set quantity = 100.
- **Expected:** Line quantity = 100. Line total = 100 × unit_cost.

### TC-136: PO Builder — set unit cost per line
- **Steps:**
  1. Add line.
  2. Set unit_cost = 12.50.
- **Expected:** `unit_cost = 12.50`. Line total = qty × 12.50.

### TC-137: PO Builder — cost pre-fills from product
- **Steps:**
  1. Product "صابون لويز" has `cost_price: 10`.
  2. Add to PO.
- **Expected:** `unit_cost` pre-filled with 10 (from product's current cost_price).

### TC-138: PO Builder — new selling price column
- **Steps:**
  1. Add line.
  2. Set `new_selling_price: 20`.
- **Expected:** Value stored on PO line. Will be applied to product on receipt.

### TC-139: PO Builder — remove line
- **Steps:**
  1. Add 3 lines.
  2. Remove line 2.
- **Expected:** 2 lines remaining. PO total recalculated.

### TC-140: PO Builder — line total auto-calculation
- **Steps:**
  1. Add line: qty=100, unit_cost=12.50.
- **Expected:** Line total = 1250.00. PO total = 1250.00.

### TC-141: PO Builder — submit creates PO record
- **Steps:**
  1. Fill PO with 2 lines.
  2. Select supplier.
  3. Click submit.
- **Expected:** `purchase_orders` row created with status "PENDING". `purchase_order_items` rows created (2 lines).

### TC-142: PO Builder — `enrichedPurchaseOrderItem` stores variant_id
- **Steps:**
  1. Add variant to PO.
  2. Check `purchase_order_items` row.
- **Expected:** `variant_id` column populated with the variant's UUID. `unit_id` and `qty_in_unit` also stored.

### TC-143: PO Builder — unit_id stored for UoM purchase
- **Steps:**
  1. Add product via UoM barcode "CTN-LOU-001" (كرتونة ×12).
  2. Check PO line.
- **Expected:** `unit_id` = the product_units row id. `qty_in_unit` = 12.

### TC-144: PO Builder — UI feedback on add
- **Steps:**
  1. Add product to PO.
- **Expected:** Line appears with animation. Product name, variant, barcode displayed. Quantity input focused.

### TC-145: PO Builder — duplicate product handling
- **Steps:**
  1. Add "جل شاور — احمر" twice.
- **Expected:** Two separate lines (PO allows multiple orders of same item). Or merged with qty increment (depending on design).

### TC-146: PO Builder — empty PO submission blocked
- **Steps:**
  1. Open PO Builder.
  2. Click submit without adding lines.
- **Expected:** Validation error: "أضف صنفاً واحداً على الأقل".

### TC-147: PO Builder — supplier required
- **Steps:**
  1. Add lines but don't select supplier.
  2. Click submit.
- **Expected:** Validation error: "اختر المورد".

### TC-148: PO list page — displays all POs
- **Steps:**
  1. Create 5 POs.
  2. Navigate to purchases page.
- **Expected:** 5 POs listed with order numbers, suppliers, statuses, dates.

### TC-149: PO status — PENDING
- **Steps:**
  1. Create new PO.
- **Expected:** Status = "PENDING". "استلام" button visible.

### TC-150: PO status — RECEIVED
- **Steps:**
  1. Receive PO completely.
- **Expected:** Status = "RECEIVED". "استلام" button disabled or hidden.

### TC-151: PO Builder — search products excluding non-purchasable
- **Steps:**
  1. Product has `is_purchasable: false`.
  2. Search in PO Builder.
- **Expected:** Product not in results.

### TC-152: PO Builder — keyboard navigation
- **Steps:**
  1. Use Tab to navigate between fields in PO Builder.
- **Expected:** Focus moves logically: search → quantity → cost → next line.

### TC-153: PO Builder — large order (50+ lines)
- **Steps:**
  1. Add 50 products to PO.
- **Expected:** All 50 lines render. Scrolling works. No performance degradation. Total sums correctly.

### TC-154: PO Builder — decimal quantities
- **Steps:**
  1. Add weighed product "زيت زيتون".
  2. Set quantity = 2.5.
- **Expected:** `quantity = 2.5`. Line total = 2.5 × unit_cost.

### TC-155: PO Builder — zero cost allowed (free goods)
- **Steps:**
  1. Set unit_cost = 0.
- **Expected:** Line accepted. Total = 0 for this line.

### TC-156: PO Builder — very large quantities
- **Steps:**
  1. Set quantity = 999999.
- **Expected:** No overflow. Total calculated correctly.

### TC-157: PO Builder — category/brand filter in product search
- **Steps:**
  1. Filter PO search by category "نظافة".
- **Expected:** Only products in "نظافة" shown in results.

### TC-158: PO Builder — cancel/close without saving
- **Steps:**
  1. Add 3 lines to PO Builder.
  2. Click close (X).
- **Expected:** Warning: "هل تريد الإغلاق بدون حفظ؟". Confirm → modal closes, no PO created.

### TC-159: PO Builder — edit existing PO
- **Steps:**
  1. PO is PENDING.
  2. Click edit.
- **Expected:** PO Builder opens with existing lines. Quantities and costs editable.

### TC-160: PO Builder — print PO
- **Steps:**
  1. PO created.
  2. Click print.
- **Expected:** PDF/printable PO document generated with supplier, items, totals.

### TC-161: PO — cost pre-fill from last PO
- **Steps:**
  1. Product was purchased at cost 10 in previous PO.
  2. Create new PO, add same product.
- **Expected:** `unit_cost` pre-filled with 10 (from last purchase history).

### TC-162: PO Builder — multi-supplier POs
- **Steps:**
  1. PO Builder allows single supplier per PO.
  2. Try to add products from different suppliers.
- **Expected:** All products under same supplier. Warning if product's default_supplier differs.

### TC-163: PO Builder — stock projection
- **Steps:**
  1. Product stock = 20.
  2. Add 100 to PO.
- **Expected:** UI shows "المخزون الحالي: 20 ← بعد الاستلام: 120".

### TC-164: PO Builder — default supplier pre-fill
- **Steps:**
  1. Product has `default_supplier_id`.
  2. Add to PO.
- **Expected:** Supplier dropdown pre-selects the product's default supplier.

### TC-165: PO Builder — line notes
- **Steps:**
  1. Add line.
  2. Enter note: "يجب أن يكون التعبئة أصلي".
- **Expected:** Note stored on PO line metadata.

### TC-166: PO Builder — subtotal + tax calculation
- **Steps:**
  1. Add 3 lines with different costs.
  2. PO total = sum of all line totals.
- **Expected:** Total correct to 2 decimal places. No floating-point artifacts.

### TC-167: PO Builder — delete entire PO
- **Steps:**
  1. PO is PENDING.
  2. Click delete.
- **Expected:** Confirmation dialog. On confirm, PO and all lines deleted. Status removed from list.

### TC-168: PO Builder — responsive layout on mobile
- **Steps:**
  1. Open PO Builder on mobile viewport.
- **Expected:** Full-width layout. Table scrolls horizontally. Buttons stack vertically.

### TC-169: PO Builder — UoM tier selection for purchase
- **Steps:**
  1. Add "صابون لويز" to PO.
  2. Select UoM tier "كرتونة" (×12).
- **Expected:** PO line shows "كرتونة". Quantity in cartons. Cost per carton.

### TC-170: PO Builder — variant matrix display
- **Steps:**
  1. Product "جل شاور" has 3 variants.
  2. Expand variant matrix in PO Builder.
- **Expected:** Grid showing all variants with checkboxes. Select specific variants.

### TC-171: PO Builder — keyboard shortcut submit
- **Steps:**
  1. Fill PO completely.
  2. Press Ctrl+Enter.
- **Expected:** PO submitted (shortcut for submit button).

### TC-172: PO Builder — line count badge
- **Steps:**
  1. Add 5 lines.
- **Expected:** Badge shows "5 أصناف". Total shows sum of 5 line totals.

### TC-173: PO Builder — quick-add from recent POs
- **Steps:**
  1. View previous PO.
  2. Click "تكرار أمر شراء".
- **Expected:** New PO Builder opens with same supplier and items pre-filled.

### TC-174: PO Builder — supplier search/filter
- **Steps:**
  1. 50 suppliers in system.
  2. Type "أحمد" in supplier search.
- **Expected:** Filtered list shows suppliers matching "أحمد".

### TC-175: PO Builder — estimated delivery date
- **Steps:**
  1. Set delivery date to "2025-02-15".
- **Expected:** Date stored on PO. Displayed in PO list.

### TC-176: PO Builder — notes field
- **Steps:**
  1. Enter notes: "توصيلMorning only".
- **Expected:** Notes stored. Visible on PO detail.

### TC-177: PO Builder — total in multiple currencies
- **Steps:**
  1. System configured for SAR.
  2. PO total = 1250.
- **Expected:** Displayed as "1,250.00 ر.س" or "1,250.00 SAR".

### TC-178: PO Builder — attachment upload
- **Steps:**
  1. Attach a PDF quote to PO.
- **Expected:** File uploaded. Link stored on PO. Downloadable from PO detail.

### TC-179: PO Builder — status history
- **Steps:**
  1. Create PO → PENDING → RECEIVED.
- **Expected:** Status transitions logged with timestamps.

### TC-180: PO Builder — export to CSV
- **Steps:**
  1. View PO list.
  2. Click export.
- **Expected:** CSV file downloaded with all PO data.

---

## MODULE 4: RECEIVING RECONCILIATION & COST HISTORY (Tests 181–230)

### TC-181: ReconciliationModal opens from PO list
- **Steps:**
  1. PO is PENDING.
  2. Click "استلام" button.
- **Expected:** `ReconciliationModal` opens. All PO lines displayed with editable fields.

### TC-182: ReconciliationModal — ordered qty displayed
- **Steps:**
  1. PO line: ordered 100 units.
- **Expected:** "الكمية المطلوبة: 100" displayed. "الكمية المستلمة" input default = 100.

### TC-183: ReconciliationModal — edit received qty
- **Steps:**
  1. Ordered 100.
  2. Change received qty to 85.
- **Expected:** `receivedQty = 85`. Amber highlight on discrepancy (15 units short).

### TC-184: ReconciliationModal — edit cost
- **Steps:**
  1. PO unit_cost = 10.
  2. Change cost to 12.50.
- **Expected:** `unitCost = 12.50`. Line total recalculated. Amber highlight on cost change.

### TC-185: ReconciliationModal — edit selling price
- **Steps:**
  1. Change `newSellingPrice` from 15 to 20.
- **Expected:** `newSellingPrice = 20`. Will be applied to product on receipt.

### TC-186: ReconciliationModal — discrepancy highlighting
- **Steps:**
  1. Ordered 100, received 85.
- **Expected:** Row highlighted in amber. Delta "-15" shown. Visual indicator of shortage.

### TC-187: ReconciliationModal — summary bar
- **Steps:**
  1. 3 lines with different discrepancies.
- **Expected:** Summary bar shows: total ordered, total received, total cost, total selling.

### TC-188: ReconciliationModal — zero received qty
- **Steps:**
  1. Set received qty = 0.
- **Expected:** Line highlighted as full shortage. No stock movement for this line.

### TC-189: ReconciliationModal — over-receive
- **Steps:**
  1. Ordered 100, set received = 120.
- **Expected:** Over-receive allowed (if `allow_over_receive` is true). Amber highlight shows "+20".

### TC-190: `receivePurchaseOrderWithReconciliation` — fires `log_cost_history`
- **Steps:**
  1. Receive PO where cost changes from 10 → 12.50.
- **Expected:** `log_cost_history` RPC called BEFORE price update. `product_cost_history` row: old_cost=10, new_cost=12.50, source=PO_RECEIPT.

### TC-191: `receivePurchaseOrderWithReconciliation` — fires `record_inventory_movement`
- **Steps:**
  1. Receive 85 units.
- **Expected:** RPC called with `p_quantity_delta: 85`, `p_movement_type: "PURCHASE_RECEIPT"`. `product_variants.total_stock` += 85. `products.total_stock` += 85.

### TC-192: `receivePurchaseOrderWithReconciliation` — passes `p_variant_id`
- **Steps:**
  1. PO line has `variant_id`.
  2. Receive.
- **Expected:** RPC receives `p_variant_id`. Variant stock updated directly.

### TC-193: `receivePurchaseOrderWithReconciliation` — updates product prices
- **Steps:**
  1. Receive with cost=12.50, selling=20.
- **Expected:** `products.cost_price = 12.50`, `products.selling_price = 20`.

### TC-194: `receivePurchaseOrderWithReconciliation` — PO status → RECEIVED
- **Steps:**
  1. Receive all lines.
- **Expected:** `purchase_orders.status` = "RECEIVED".

### TC-195: ReconciliationModal — idempotency key per line
- **Steps:**
  1. Receive PO. Network error on line 2.
  2. Retry.
- **Expected:** Line 1: movement already recorded (idempotent). Line 2: new movement recorded. No double-counting.

### TC-196: `fetchCostHistory` — returns last N rows
- **Steps:**
  1. Product has 15 cost changes.
  2. Call `fetchCostHistory(productId, 10)`.
- **Expected:** Returns 10 rows, most recent first.

### TC-197: `fetchCostHistory` — empty history
- **Steps:**
  1. New product with no cost changes.
  2. Call `fetchCostHistory`.
- **Expected:** Returns empty array. No error.

### TC-198: CostHistoryPopover — displays source labels
- **Steps:**
  1. Cost changed via PO_RECEIPT and MANUAL_ADJUSTMENT.
- **Expected:** PO_RECEIPT shows "استلام شراء". MANUAL_ADJUSTMENT shows "تعديل يدوي".

### TC-199: CostHistoryPopover — old→new delta display
- **Steps:**
  1. Cost changed from 10 → 15.
- **Expected:** Display: "10.00 → 15.00 (+5.00 ↑)".

### TC-200: ReconciliationModal — partial receive
- **Steps:**
  1. 3 lines: A(100), B(50), C(200).
  2. Receive: A(80), B(50), C(200).
- **Expected:** Only line A has discrepancy. Lines B, C fully received. Stock: A+=80, B+=50, C+=200.

### TC-201: ReconciliationModal — receive with cost=0
- **Steps:**
  1. Set unitCost = 0.
- **Expected:** Cost update skipped (cost_price not updated if 0). Movement still recorded.

### TC-202: ReconciliationModal — concurrent receives blocked
- **Steps:**
  1. PO is PENDING.
  2. Two users try to receive simultaneously.
- **Expected:** First receive succeeds. Second receives "أمر الشراء مستلم بالفعل" error.

### TC-203: ReconciliationModal — supplier invoice creation
- **Steps:**
  1. Receive PO with supplier linked.
- **Expected:** `supplier_invoices` row created. `purchase_order_id` linked. Amount = PO total.

### TC-204: ReconciliationModal — cost history audit trail
- **Steps:**
  1. Receive PO. Check `product_cost_history`.
- **Expected:** Row has: `p_ref_type: 'PURCHASE_ORDER'`, `p_ref_id: orderId`, `p_source: 'PO_RECEIPT'`.

### TC-205: ReconciliationModal — metadata on movement
- **Steps:**
  1. Receive PO line.
- **Expected:** Movement metadata contains: `purchaseOrderItemId`, `unitCost`, `reconciled: true`.

### TC-206: ReconciliationModal — receive already-received PO
- **Steps:**
  1. PO status = "RECEIVED".
  2. Try to receive again.
- **Expected:** Error: "أمر الشراء مستلم بالفعل". `RECEIVED_STATUSES.has(status)` check blocks.

### TC-207: ReconciliationModal — rounding in received qty
- **Steps:**
  1. Enter received qty = 2.333.
- **Expected:** Stored as `round(2.333, 3) = 2.333`. Movement delta = 2.333.

### TC-208: ReconciliationModal — cost rounding
- **Steps:**
  1. Enter unitCost = 12.3456.
- **Expected:** Stored as `round2(12.3456) = 12.35`.

### TC-209: CostHistoryPopover — single entry
- **Steps:**
  1. Product has 1 cost change.
- **Expected:** Popover shows 1 row. No scroll needed.

### TC-210: CostHistoryPopover — 10+ entries with scroll
- **Steps:**
  1. Product has 20 cost changes.
- **Expected:** Popover shows 10 most recent. Scrollable if more.

### TC-211: ReconciliationModal — multi-variant receive
- **Steps:**
  1. PO has 3 variants of "جل شاور".
  2. Receive all 3 with different quantities.
- **Expected:** Each variant's stock updated independently. Parent stock = sum.

### TC-212: `receivePurchaseOrderWithReconciliation` — batch price logging
- **Steps:**
  1. 3 lines all have cost changes.
- **Expected:** 3 `log_cost_history` calls, one per product. All before price updates.

### TC-213: ReconciliationModal — selling price not changed if null
- **Steps:**
  1. `newSellingPrice` left as null.
  2. Receive.
- **Expected:** `products.selling_price` unchanged. Only `cost_price` updated.

### TC-214: ReconciliationModal — zero cost and zero selling
- **Steps:**
  1. Both cost and selling = 0.
  2. Receive.
- **Expected:** No price updates. Movement recorded with qty only.

### TC-215: ReconciliationModal — cost history for multiple products
- **Steps:**
  1. PO has lines for products A and B.
  2. Both have cost changes.
- **Expected:** `product_cost_history` has entries for both A and B.

### TC-216: ReconciliationModal — previous PO cost comparison
- **Steps:**
  1. Product cost was 10 in last PO.
  2. New PO cost is 15.
- **Expected:** CostHistoryPopover shows old=10, new=15. Trend arrow UP.

### TC-217: ReconciliationModal — POD cost decrease
- **Steps:**
  1. Last cost was 20. New PO cost is 15.
- **Expected:** CostHistoryPopover shows ↓ arrow. Delta "-5.00".

### TC-218: ReconciliationModal — zero lines received
- **Steps:**
  1. All lines received qty = 0.
- **Expected:** No stock movements. PO status still changes to RECEIVED (or stays PENDING depending on design).

### TC-219: ReconciliationModal — submit button disabled during processing
- **Steps:**
  1. Click "تأكيد الاستلام".
- **Expected:** Button shows spinner/disabled during RPC calls. Prevents double-submit.

### TC-220: ReconciliationModal — escape key closes
- **Steps:**
  1. Modal open.
  2. Press Escape.
- **Expected:** `useModalEscape` handler fires. Modal closes.

### TC-221: ReconciliationModal — numeric input validation
- **Steps:**
  1. Enter "abc" in received qty field.
- **Expected:** Input rejected or parsed as NaN → reverted to previous value.

### TC-222: ReconciliationModal — negative qty prevention
- **Steps:**
  1. Enter -5 in received qty.
- **Expected:** Input clamped to 0 or rejected.

### TC-223: `receivePurchaseOrderWithReconciliation` — partial receive + PO status
- **Steps:**
  1. 3 lines. Receive only 2.
- **Expected:** 2 movements recorded. PO status may change to "PARTIAL" or stay PENDING.

### TC-224: CostHistoryPopover — hover vs click trigger
- **Steps:**
  1. On inventory page, hover over clock icon.
- **Expected:** Popover appears (or on click, depending on implementation).

### TC-225: CostHistoryPopover — outside click closes
- **Steps:**
  1. Popover open.
  2. Click outside.
- **Expected:** Popover closes.

### TC-226: ReconciliationModal — column alignment on mobile
- **Steps:**
  1. Open on mobile viewport.
- **Expected:** Table scrolls horizontally. All columns accessible.

### TC-227: CostHistoryPopover — loading state
- **Steps:**
  1. Click clock icon.
  2. `fetchCostHistory` is in progress.
- **Expected:** Skeleton/spinner shown. No flash of empty state.

### TC-228: CostHistoryPopover — error state
- **Steps:**
  1. Network error during `fetchCostHistory`.
- **Expected:** Error message shown. No crash.

### TC-229: ReconciliationModal — preserve edits on modal reopen
- **Steps:**
  1. Edit received qty to 85.
  2. Close modal.
  3. Reopen.
- **Expected:** Edits lost (reopened fresh from PO data). Or preserved if using local state.

### TC-230: ReconciliationModal — real-time total update
- **Steps:**
  1. Edit qty on line 1.
- **Expected:** Summary bar total updates immediately without submit.

---

## MODULE 5: LIVE STOCK PROBE & BARCODE INSPECTOR (Tests 231–270)

### TC-231: ProductQuantitiesModal opens from inventory page
- **Steps:**
  1. Navigate to inventory page.
  2. Click "كميات المنتجات" button (Barcode icon).
- **Expected:** `ProductQuantitiesModal` opens. Input auto-focused. Empty state shown.

### TC-232: ProductQuantitiesModal — scan barcode resolves product
- **Steps:**
  1. Enter barcode "V1001" in search input.
  2. Press Enter or click search.
- **Expected:** Product "جل شاور" resolved. Header shows name, base unit, weighed flag.

### TC-233: ProductQuantitiesModal — parent stock breakdown displayed
- **Steps:**
  1. Product "صابون لويز" has stock=87, UoM كرتونة×12.
  2. Scan barcode.
- **Expected:** Header shows: "7 كرتون و 3 حبات". Raw: "87 حبة". Prices: cost + selling.

### TC-234: ProductQuantitiesModal — unit tiers grid
- **Steps:**
  1. Product has 2 UoM tiers: حبة(×1), كرتونة(×12).
  2. Scan.
- **Expected:** Grid shows 2 cards: حبة (72 متاح), كرتونة (7 متاح). Each with barcode if set.

### TC-235: ProductQuantitiesModal — variants table shows ALL variants
- **Steps:**
  1. Product "جل شاور" has 3 variants: احمر, اخضر, ابيض.
  2. Scan barcode.
- **Expected:** Table shows 3 rows. Each variant: label, barcode, totalStock, breakdown label, cost, selling.

### TC-236: ProductQuantitiesModal — variant stock from `bc.totalStock`
- **Steps:**
  1. Variant "احمر" has `product_variants.total_stock = 30`.
  2. Scan.
- **Expected:** Variant row shows "الرصيد: 30". Breakdown: "2 كرتون و 6 حبات".

### TC-237: ProductQuantitiesModal — variant with zero stock
- **Steps:**
  1. Variant "ابيض" has `total_stock = 0`.
  2. Scan.
- **Expected:** Variant row shows "الرصيد: 0 (لا رصيد)". Gray text.

### TC-238: ProductQuantitiesModal — name search fallback
- **Steps:**
  1. Enter "صابون" (not a barcode).
  2. Press Enter.
- **Expected:** `Object.values(products).find(p => p.name.includes("صابون"))` matches. Product resolved.

### TC-239: ProductQuantitiesModal — not found
- **Steps:**
  1. Enter "FAKEPRODUCT999".
  2. Press Enter.
- **Expected:** Error message: "هذا الباركود أو الاسم غير مسجل في الكتالوج".

### TC-240: ProductQuantitiesModal — continuous scan mode
- **Steps:**
  1. Scan "V1001". Product resolved.
  2. Immediately scan "V1002".
- **Expected:** After first resolve, input clears and refocuses. Second scan resolves "اخضر". No modal close between scans.

### TC-241: ProductQuantitiesModal — scan history
- **Steps:**
  1. Scan 3 different barcodes.
  2. Then scan a non-existent one.
- **Expected:** History shows 3 entries. After non-existent scan, history still shows 3 (last 20).

### TC-242: ProductQuantitiesModal — click history item re-queries
- **Steps:**
  1. Scan "V1001". Add to history.
  2. Scan "FAKE". Not found.
  3. Click "V1001" in history list.
- **Expected:** Product "جل شاور — احمر" re-resolved. Displayed again.

### TC-243: ProductQuantitiesModal — clear history
- **Steps:**
  1. 5 items in history.
  2. Click "مسح السجل".
- **Expected:** History cleared. Empty state shown.

### TC-244: ProductQuantitiesModal — Esc closes modal
- **Steps:**
  1. Modal open with product displayed.
  2. Press Escape.
- **Expected:** `useModalEscape` fires. Modal closes.

### TC-245: ProductQuantitiesModal — O(1) barcode lookup
- **Steps:**
  1. Catalog has 2000 variants.
  2. Scan barcode.
- **Expected:** Resolution from `barcodeIndex[barcode]` in < 1ms. No iteration over all products.

### TC-246: ProductQuantitiesModal — variant stock breakdown accuracy
- **Steps:**
  1. Variant "احمر" stock = 37. UoM كرتونة×12.
  2. Scan.
- **Expected:** Variant breakdown: "3 كرتون و 1 حبة" (3×12=36, 37-36=1). Correct.

### TC-247: ProductQuantitiesModal — cost/selling price display
- **Steps:**
  1. Product cost=10, selling=15.
  2. Scan.
- **Expected:** Price summary: "تكلفة الوحدة: 10.00", "سعر البيع: 15.00".

### TC-248: ProductQuantitiesModal — variant cost/selling per row
- **Steps:**
  1. Variant "احمر" cost=20, selling=35.
  2. Scan.
- **Expected:** Variant row: "التكلفة: 20.00", "البيع: 35.00".

### TC-249: ProductQuantitiesModal — parent product header
- **Steps:**
  1. Scan.
- **Expected:** Product name (large, bold), base unit, weighed/count label.

### TC-250: ProductQuantitiesModal — multiple scans accumulate history
- **Steps:**
  1. Scan 10 barcodes over time.
- **Expected:** History shows last 10 entries (max 20). Most recent first.

### TC-251: ProductQuantitiesModal — auto-focus on open
- **Steps:**
  1. Open modal.
- **Expected:** Input focused after 80ms delay (animation complete).

### TC-252: ProductQuantitiesModal — auto-focus after resolve
- **Steps:**
  1. Scan barcode. Product resolved.
- **Expected:** Input cleared and refocused for next scan.

### TC-253: ProductQuantitiesModal — empty input submit ignored
- **Steps:**
  1. Leave input empty.
  2. Click search.
- **Expected:** `resolve("")` returns early. No state change.

### TC-254: ProductQuantitiesModal — barcode with leading spaces
- **Steps:**
  1. Enter "  V1001  ".
  2. Submit.
- **Expected:** Trimmed to "V1001". Product resolved.

### TC-255: ProductQuantitiesModal — variant added to list if not in barcodeMap
- **Steps:**
  1. Scan a variant barcode that's not in `barcodes` map (stale cache).
  2. But `barcodeIndex` has it.
- **Expected:** Variant added to list via `variantList.unshift()` fallback (line 101-109).

### TC-256: ProductQuantitiesModal — product with no variants
- **Steps:**
  1. Product has only 1 default variant (no explicit variants).
  2. Scan.
- **Expected:** Variants table shows 1 row: label "أساسي", barcode, stock.

### TC-257: ProductQuantitiesModal — product with no UoM tiers
- **Steps:**
  1. Product has `productUnits[pid] = []`.
  2. Scan.
- **Expected:** Unit tiers section hidden. Only variants table shown.

### TC-258: ProductQuantitiesModal — weighed product display
- **Steps:**
  1. Product `is_weighed: true`.
  2. Scan.
- **Expected:** Header shows "وزني" badge. Stock displayed as decimal (25.500 كغ).

### TC-259: ProductQuantitiesModal — inventory page button styling
- **Steps:**
  1. View inventory page header.
- **Expected:** "كميات المنتجات" button with Barcode icon, primary-tinted border.

### TC-260: ProductQuantitiesModal — POS QuickActions button
- **Steps:**
  1. Open QuickActionsDrawer in POS.
- **Expected:** "كميات المنتجات والاستعلام السريع" button with Package icon, prominent primary border.

### TC-261: ProductQuantitiesModal — large product name truncation
- **Steps:**
  1. Product name = "معقم يدين بكحول 70% بدون رائحة 500 مل".
  2. Scan.
- **Expected:** Name displayed (may truncate with ellipsis on small screens).

### TC-262: ProductQuantitiesModal — concurrent state updates
- **Steps:**
  1. Scan rapidly 5 times.
- **Expected:** Only the last scan result displayed. No React state batching issues.

### TC-263: ProductQuantitiesModal — modal size "xl"
- **Steps:**
  1. Open modal.
- **Expected:** Modal uses `size="xl"` from ModalShell. Full-width on mobile, max-width on desktop.

### TC-264: ProductQuantitiesModal — scan history timestamp
- **Steps:**
  1. Scan item.
- **Expected:** History entry has `timestamp: Date.now()`. Can be used for recency display.

### TC-265: ProductQuantitiesModal — RTL layout
- **Steps:**
  1. All text is Arabic.
  2. Open modal.
- **Expected:** RTL layout. Search input has `dir="ltr"` (barcodes are LTR). All labels RTL.

### TC-266: ProductQuantitiesModal — variant table header
- **Steps:**
  1. Product with variants.
  2. Scroll to variants table.
- **Expected:** Headers: المتغير, الباركود, الرصيد, التفصيل, التكلفة, البيع.

### TC-267: ProductQuantitiesModal — breakdownStock accuracy for all-zero stock
- **Steps:**
  1. Variant stock = 0.
- **Expected:** `breakdownStock(0, ...)` returns "لا رصيد".

### TC-268: ProductQuantitiesModal — `maxUnitsAvailable` in unit tier card
- **Steps:**
  1. Product stock = 50, UoM multiplier = 12.
- **Expected:** Unit tier card shows "4 متاح" (floor(50/12)=4).

### TC-269: ProductQuantitiesModal — parent stock used for unit tiers (not variant)
- **Steps:**
  1. Product stock = 87 (parent). Variants sum = 87.
  2. Scan.
- **Expected:** Unit tiers use `resolved.totalStock` (87). Shows "7 متاح" for كرتونة.

### TC-270: ProductQuantitiesModal — empty catalog edge case
- **Steps:**
  1. Fresh store with 0 products.
  2. Open modal, scan anything.
- **Expected:** "هذا الباركود أو الاسم غير مسجل" error. No crash.

---

## MODULE 6: EDGE CASES & STRESS TESTS (Tests 271–300)

### TC-271: Negative stock prevention on manual adjustment
- **Steps:**
  1. Product stock = 3.
  2. Manual adjustment OUT of 10 via admin.
- **Expected:** RPC error: `insufficient_stock`. Stock remains 3. UI shows error toast.

### TC-272: Rapid sequential barcode scanning
- **Steps:**
  1. Scan 20 barcodes in 5 seconds.
- **Expected:** All 20 resolved. No race conditions. Cart/stock consistent.

### TC-273: Multi-terminal sync — same product sold simultaneously
- **Steps:**
  1. Terminal A and B both sell from product X (stock=100).
  2. A sells 50, B sells 30 within same second.
- **Expected:** After both sync: stock = 20. Idempotency keys unique per terminal+line.

### TC-274: UI responsiveness — catalog with 1000 products
- **Steps:**
  1. Store has 1000 products (4000 variants).
  2. Open POS.
- **Expected:** POS loads in < 3 seconds. Scrolling smooth. Barcode scan < 50ms.

### TC-275: UI responsiveness — PO with 100 lines
- **Steps:**
  1. Create PO with 100 lines.
  2. Open ReconciliationModal.
- **Expected:** Modal renders all 100 lines. Scrolling smooth. Submit processes in < 10 seconds.

### TC-276: Floating-point: 0.1 + 0.2 = 0.3
- **Steps:**
  1. Add item at price 0.1, qty 2.
  2. Check total.
- **Expected:** Total = 0.20 (not 0.199999...). `formatMoney` renders "0.20".

### TC-277: Floating-point: large qty × small price
- **Steps:**
  1. Price = 0.01, qty = 99999.
- **Expected:** Total = 999.99. No overflow. Correct to 2 decimals.

### TC-278: Empty store — fresh account
- **Steps:**
  1. Login to brand new store.
  2. Open POS.
- **Expected:** Empty grid. No products. No crashes. All features degrade gracefully.

### TC-279: Single product store
- **Steps:**
  1. Store has 1 product with 1 variant.
  2. Complete sale.
- **Expected:** Works correctly. Stock decremented. Invoice created.

### TC-280: Product with 50 variants
- **Steps:**
  1. Create product with 50 variants (50 barcodes).
  2. Scan each.
- **Expected:** Each barcode resolves to correct variant. Variant table shows 50 rows. Scrollable.

### TC-281: Stock = 0 — sell attempt
- **Steps:**
  1. Product stock = 0.
  2. Try to sell.
- **Expected:** With `p_allow_negative: true` (POS sales): sale goes through, stock = -1. With manual adjustment: blocked.

### TC-282: Stock = 0 — PO receipt
- **Steps:**
  1. Product stock = 0.
  2. Receive PO of 100.
- **Expected:** Stock = 100. Movement recorded.

### TC-283: Maximum quantity boundary
- **Steps:**
  1. Set qty = 999999.999.
- **Expected:** Stored as DECIMAL(14,3). No overflow. Calculations correct.

### TC-284: Unicode product names
- **Steps:**
  1. Product name: "ℌ𝔬𝔯𝔧 𝔄𝔩𝔶𝔞ℜ𝔞𝔞" (decorative unicode).
  2. Add to cart.
- **Expected:** Name renders correctly. No encoding issues.

### TC-285: Emoji in product name
- **Steps:**
  1. Product name: "صابون 🧼".
  2. Display in POS.
- **Expected:** Emoji renders. No crash.

### TC-286: SQL injection via product name
- **Steps:**
  1. Product name: "'; DROP TABLE products; --".
  2. Search for this product.
- **Expected:** Name stored and searched as literal string. No SQL injection. Supabase parameterized queries protect.

### TC-287: XSS via product name
- **Steps:**
  1. Product name: "<script>alert('xss')</script>".
  2. Display in POS and catalog.
- **Expected:** React escapes HTML. Script tag displayed as text, not executed.

### TC-288: Very long product name
- **Steps:**
  1. Product name: 500 characters.
  2. Display in POS grid card.
- **Expected:** Truncated with ellipsis. No layout breakage.

### TC-289: Concurrent PO receives
- **Steps:**
  1. Two users receive same PO simultaneously.
- **Expected:** First succeeds. Second gets error. No double stock increment.

### TC-290: Network timeout during sale sync
- **Steps:**
  1. Complete sale.
  2. Network drops mid-sync.
- **Expected:** Sale saved to IDB. Toast: "تم الحفظ محلياً". Will sync on reconnect.

### TC-291: Browser tab close during sale
- **Steps:**
  1. Add items to cart.
  2. Close browser tab.
- **Expected:** Cart preserved in IDB. Next session restores cart.

### TC-292: LocalStorage quota exceeded
- **Steps:**
  1. Fill LocalStorage to near capacity.
- **Expected:** IDB fallback works. No data loss for critical operations.

### TC-293: Cart with 100 different items
- **Steps:**
  1. Add 100 unique products to cart.
- **Expected:** All 100 lines render. Scrolling works. Total correct.

### TC-294: Rapid unit switching in cart
- **Steps:**
  1. Cart has item with UoM tiers.
  2. Switch unit 20 times rapidly.
- **Expected:** No state corruption. Final unit display correct.

### TC-295: Modal stack — multiple modals
- **Steps:**
  1. Open ProductQuantitiesModal.
  2. From inside, try to open ReconciliationModal.
- **Expected:** Either modal closes first, or second modal stacks on top. No z-index conflicts.

### TC-296: Price = 0 product
- **Steps:**
  1. Product with selling_price = 0.
  2. Add to cart.
- **Expected:** Line total = 0. No crash. `formatMoney(0)` = "0.00".

### TC-297: Cost = 0 product
- **Steps:**
  1. Product with cost_price = 0.
  2. View in reports.
- **Expected:** Profit = selling_price × qty. No division by zero.

### TC-298: Database connection loss mid-RPC
- **Steps:**
  1. Call `record_inventory_movement`.
  2. Database disconnects mid-transaction.
- **Expected:** Transaction rolls back. RPC returns error. Client retries or logs.

### TC-299: Stress test — 1000 inventory movements
- **Steps:**
  1. Process 1000 sales sequentially.
- **Expected:** All 1000 movements recorded. Stock accurate. No performance degradation.

### TC-300: Full end-to-end user journey
- **Steps:**
  1. Login → create category "نظافة" → create brand "Document".
  2. Create product "صابون لويز" with 3 variants (احمر/اخضر/ابيض), UoM كرتونة×12.
  3. Set opening stock: 50 each variant (150 total).
  4. Create PO with supplier, add all 3 variants × 100 each.
  5. Receive PO with reconciliation: احمر=90, اخضر=100, ابيض=100. Cost adjusted to 12.
  6. Open POS → scan variant barcodes → verify stock breakdown.
  7. Sell 5 of احمر → verify parent stock updated.
  8. Open ProductQuantitiesModal → verify variant breakdown (85/100/100).
  9. Check cost history popover → shows PO receipt with old→new.
  10. Go offline → complete sale → verify IDB save → reconnect → verify sync.
- **Expected:** All steps complete without errors. Stock consistent across all views. Cost audit trail intact. Offline/online transition seamless.
