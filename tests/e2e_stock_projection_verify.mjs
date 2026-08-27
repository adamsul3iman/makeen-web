/**
 * E2E Verification: POS Checkout → Local Stock Projection → Product Quantities Modal
 *
 * Scenario: Add 1 Carton (×12) of "Cola" variant to cart, complete checkout,
 * verify stock deduction targets the correct variant and that breakdownStock
 * renders "1 كرتون".
 */

import { breakdownStock, maxUnitsAvailable } from "../lib/stockDisplay.ts";
import { resolveStockVariantId, projectSaleStock } from "../lib/localStockProjection.ts";

let passed = 0;
let failed = 0;

function check(label, condition, detail = "") {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// ─── Fixtures ────────────────────────────────────────────────────────────
const COLA_PRODUCT_ID = "product-cola";
const COLA_VARIANT_ID = "variant-cola";
const DIET_VARIANT_ID = "variant-diet";
const CARTON_UNIT_ID = "unit-carton";
const PIECE_UNIT_ID = "unit-piece";

// Parent product: totalStock = 48 (24 Cola + 24 Diet)
const products = {
  [COLA_PRODUCT_ID]: {
    id: COLA_PRODUCT_ID,
    name: "Joy Cola",
    baseUnit: "حبة",
    isWeighed: false,
    totalStock: 48,
    price: 1.50,
    costPrice: 0.80,
  },
};

// BarcodeMap (variant barcodes have totalStock; unit barcodes do not)
const barcodes = {
  "V-COLA": {
    productId: COLA_PRODUCT_ID,
    variantId: COLA_VARIANT_ID,
    variantLabel: "Cola",
    unitName: "حبة",
    qtyMultiplier: 1,
    price: 1.50,
    totalStock: 24,
  },
  "V-DIET": {
    productId: COLA_PRODUCT_ID,
    variantId: DIET_VARIANT_ID,
    variantLabel: "Diet",
    unitName: "حبة",
    qtyMultiplier: 1,
    price: 1.50,
    totalStock: 24,
  },
  "CTN-COLA": {
    productId: COLA_PRODUCT_ID,
    variantId: COLA_VARIANT_ID,
    unitId: CARTON_UNIT_ID,
    unitName: "كرتونة",
    qtyMultiplier: 12,
    price: 18.00,
    // unit barcodes do NOT carry totalStock
  },
};

// BarcodeIndex (mirrors barcodeIndex in the POS store)
const barcodeIndex = {
  "V-COLA": {
    product_id: COLA_PRODUCT_ID,
    variantId: COLA_VARIANT_ID,
    variantLabel: "Cola",
    name: "Joy Cola",
    price: 1.50,
    totalStock: 24,
  },
  "V-DIET": {
    product_id: COLA_PRODUCT_ID,
    variantId: DIET_VARIANT_ID,
    variantLabel: "Diet",
    name: "Joy Cola",
    price: 1.50,
    totalStock: 24,
  },
  "CTN-COLA": {
    product_id: COLA_PRODUCT_ID,
    variantId: COLA_VARIANT_ID,
    unitId: CARTON_UNIT_ID,
    name: "Joy Cola",
    price: 18.00,
    // unit index entries do NOT carry totalStock
  },
};

// Product units for breakdown
const productUnits = {
  [COLA_PRODUCT_ID]: [
    { id: PIECE_UNIT_ID, unitName: "حبة", qtyMultiplier: 1, barcode: "", sellingPrice: 1.50, isActive: true },
    { id: CARTON_UNIT_ID, unitName: "كرتونة", qtyMultiplier: 12, barcode: "CTN-COLA", sellingPrice: 18.00, isActive: true },
  ],
};

// ─── Step 1: Simulate cart line for 1 Carton of Cola ────────────────────
console.log("\n═══ STEP 1: Cart Line (1 Carton of Cola) ═══");
const cartItem = {
  productId: COLA_PRODUCT_ID,
  name: "Joy Cola",
  barcode: "CTN-COLA",
  variantLabel: "Cola",
  variantId: COLA_VARIANT_ID,
  qty: 12,                  // base pieces (1 carton × 12)
  unitName: "كرتونة",
  unitMultiplier: 12,
  unitId: CARTON_UNIT_ID,
  unitPrice: 18.00,         // per carton (new semantics)
  taxPercent: 16,
  taxIncluded: false,
  discount: 0,
};

// Verify cart math
const displayQty = cartItem.qty / cartItem.unitMultiplier;
const lineTotal = displayQty * cartItem.unitPrice;
check("Cart qty is 12 base pieces", cartItem.qty === 12);
check("Cart unitMultiplier is 12", cartItem.unitMultiplier === 12);
check("Cart unitPrice is 18.00 per carton", cartItem.unitPrice === 18.00);
check("Cart displayQty is 1", displayQty === 1);
check("Cart lineTotal is 18.00 (1 carton × 18.00)", lineTotal === 18.00);

// ─── Step 2: Verify resolveStockVariantId ────────────────────────────────
console.log("\n═══ STEP 2: resolveStockVariantId ═══");
const resolvedVariantId = resolveStockVariantId(barcodes, COLA_PRODUCT_ID, cartItem);
check("Variant resolves to Cola variant ID", resolvedVariantId === COLA_VARIANT_ID, `got: ${resolvedVariantId}`);

// ─── Step 3: Execute projectSaleStock ────────────────────────────────────
console.log("\n═══ STEP 3: projectSaleStock (checkout mirror) ═══");
const projected = projectSaleStock(products, barcodes, barcodeIndex, [cartItem]);

// 3a: Parent product stock
const parentStock = projected.products[COLA_PRODUCT_ID]?.totalStock;
check("Parent product stock: 48 → 36 (decremented by 12)", parentStock === 36, `got: ${parentStock}`);

// 3b: Cola variant stock
const colaVariantStock = projected.barcodes["V-COLA"]?.totalStock;
check("Cola variant stock: 24 → 12 (decremented by 12)", colaVariantStock === 12, `got: ${colaVariantStock}`);

// 3c: Diet variant stock — untouched
const dietVariantStock = projected.barcodes["V-DIET"]?.totalStock;
check("Diet variant stock: 24 (untouched)", dietVariantStock === 24, `got: ${dietVariantStock}`);

// 3d: BarcodeIndex mirrors variant stock
const colaIndexStock = projected.barcodeIndex["V-COLA"]?.totalStock;
check("barcodeIndex Cola stock mirrors: 12", colaIndexStock === 12, `got: ${colaIndexStock}`);

// ─── Step 4: breakdownStock (Product Quantities Modal display) ───────────
console.log("\n═══ STEP 4: breakdownStock (Modal display) ═══");

// 4a: Parent product header breakdown
const parentBreakdown = breakdownStock(
  projected.products[COLA_PRODUCT_ID].totalStock,
  productUnits[COLA_PRODUCT_ID],
  false,
  "حبة",
);
check('Parent breakdown label: "3 كرتونة"', parentBreakdown.label === "3 كرتونة", `got: "${parentBreakdown.label}"`);
check("Parent majorQty is 3", parentBreakdown.majorQty === 3);
check("Parent minorQty is 0", parentBreakdown.minorQty === 0);

// 4b: Cola variant row breakdown
const colaBreakdown = breakdownStock(
  projected.barcodes["V-COLA"].totalStock,
  productUnits[COLA_PRODUCT_ID],
  false,
  "حبة",
);
check('Cola variant breakdown label: "1 كرتونة"', colaBreakdown.label === "1 كرتونة", `got: "${colaBreakdown.label}"`);
check("Cola variant majorQty is 1", colaBreakdown.majorQty === 1);
check("Cola variant minorQty is 0", colaBreakdown.minorQty === 0);

// 4c: Diet variant row breakdown
const dietBreakdown = breakdownStock(
  projected.barcodes["V-DIET"].totalStock,
  productUnits[COLA_PRODUCT_ID],
  false,
  "حبة",
);
check('Diet variant breakdown label: "2 كرتونة"', dietBreakdown.label === "2 كرتونة", `got: "${dietBreakdown.label}"`);

// 4d: maxUnitsAvailable for Cola variant carton tier
const colaCartonAvail = maxUnitsAvailable(projected.barcodes["V-COLA"].totalStock, 12);
check("Cola carton maxUnitsAvailable: 1", colaCartonAvail === 1, `got: ${colaCartonAvail}`);

// 4e: maxUnitsAvailable for Diet variant carton tier
const dietCartonAvail = maxUnitsAvailable(projected.barcodes["V-DIET"].totalStock, 12);
check("Diet carton maxUnitsAvailable: 2", dietCartonAvail === 2, `got: ${dietCartonAvail}`);

// ─── Step 5: Edge case — 1 Piece (not carton) of Cola ───────────────────
console.log("\n═══ STEP 5: Edge Case — 1 Piece of Cola ═══");
const pieceItem = {
  ...cartItem,
  barcode: "V-COLA",
  unitId: PIECE_UNIT_ID,
  unitName: "حبة",
  unitMultiplier: 1,
  unitPrice: 1.50,
  qty: 1,
};
const pieceProjected = projectSaleStock(products, barcodes, barcodeIndex, [pieceItem]);
const pieceColaStock = pieceProjected.barcodes["V-COLA"]?.totalStock;
check("Cola variant after 1-piece sale: 24 → 23", pieceColaStock === 23, `got: ${pieceColaStock}`);

const pieceBreakdown = breakdownStock(pieceColaStock, productUnits[COLA_PRODUCT_ID], false, "حبة");
check('1 piece leftover → "1 كرتونة و 11 حبة" (23 = 1×12 + 11)', pieceBreakdown.label === "1 كرتونة و 11 حبة", `got: "${pieceBreakdown.label}"`);

// ─── Step 6: Edge case — 14 pieces (1 carton + 2 pieces) ────────────────
console.log("\n═══ STEP 6: Edge Case — 14 pieces (1 carton + 2 pieces) ═══");
const mixedItem = {
  ...cartItem,
  barcode: "V-COLA",
  unitId: PIECE_UNIT_ID,
  unitName: "حبة",
  unitMultiplier: 1,
  unitPrice: 1.50,
  qty: 14,
};
const mixedProjected = projectSaleStock(products, barcodes, barcodeIndex, [mixedItem]);
const mixedColaStock = mixedProjected.barcodes["V-COLA"]?.totalStock;
check("Cola variant after 14-piece sale: 24 → 10", mixedColaStock === 10, `got: ${mixedColaStock}`);

const mixedBreakdown = breakdownStock(mixedColaStock, productUnits[COLA_PRODUCT_ID], false, "حبة");
check('10 pieces leftover → "كرتونة و 10 حبة" or similar', mixedBreakdown.majorQty === 0 && mixedBreakdown.minorQty === 10, `label: "${mixedBreakdown.label}", majorQty: ${mixedBreakdown.majorQty}, minorQty: ${mixedBreakdown.minorQty}`);

// ─── Summary ─────────────────────────────────────────────────────────────
console.log(`\n══════════════════════════════════════════`);
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log(`══════════════════════════════════════════\n`);

process.exit(failed > 0 ? 1 : 0);
