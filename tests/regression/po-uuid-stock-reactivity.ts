import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { projectSaleStock, resolveStockVariantId } from "../../lib/localStockProjection";
import { normalizePoUuidReference } from "../../lib/uuid";
import { clearSyncQueue, getSyncsByStatus } from "../../lib/idb";
import { setTenantStoreId } from "../../lib/tenantClient";
import { usePosStore } from "../../store/usePosStore";
import type { BarcodeIndex, BarcodeMap, ProductMap, SaleItem } from "../../types/pos.types";

const productId = "11111111-1111-4111-8111-111111111111";
const colaId = "22222222-2222-4222-8222-222222222222";
const dietId = "33333333-3333-4333-8333-333333333333";
const cartonId = "44444444-4444-4444-8444-444444444444";

assert.equal(normalizePoUuidReference(`${colaId}:base`, "variant"), colaId);
assert.equal(normalizePoUuidReference(`${colaId}:${cartonId}`, "variant"), colaId);
assert.equal(normalizePoUuidReference(`${colaId}:${cartonId}`, "unit"), cartonId);
assert.equal(normalizePoUuidReference(`${productId}:base`, "unit"), null);
assert.equal(normalizePoUuidReference(`${cartonId}:unit`, "unit"), cartonId);
assert.equal(normalizePoUuidReference(`${cartonId}:unit`, "variant"), null);
assert.throws(() => normalizePoUuidReference(`${colaId}:not-a-unit`, "variant"));

const products: ProductMap = {
  [productId]: {
    id: productId,
    categoryId: "soft-drinks",
    name: "Cola",
    baseUnit: "piece",
    isWeighed: false,
    price: 1,
    costPrice: 0.5,
    totalStock: 50,
  },
};

const barcodes: BarcodeMap = {
  cola: {
    barcode: "cola",
    productId,
    variantId: colaId,
    variantLabel: "Cola",
    unitName: "piece",
    qtyMultiplier: 1,
    price: 1,
    costPrice: 0.5,
    totalStock: 30,
  },
  diet: {
    barcode: "diet",
    productId,
    variantId: dietId,
    variantLabel: "Diet",
    unitName: "piece",
    qtyMultiplier: 1,
    price: 1,
    costPrice: 0.5,
    totalStock: 20,
  },
  carton: {
    barcode: "carton",
    productId,
    variantId: `${cartonId}:unit`,
    variantLabel: "",
    unitName: "carton",
    qtyMultiplier: 12,
    price: 10,
    costPrice: 6,
    unitId: cartonId,
  },
};

const barcodeIndex: BarcodeIndex = {
  cola: { product_id: productId, variantId: colaId, name: "Cola", price: 1, variantLabel: "Cola", totalStock: 30 },
  diet: { product_id: productId, variantId: dietId, name: "Cola", price: 1, variantLabel: "Diet", totalStock: 20 },
  carton: { product_id: productId, variantId: `${cartonId}:unit`, name: "Cola", price: 10, variantLabel: "", unitId: cartonId, qtyMultiplier: 12 },
};

const cartonSale: SaleItem = {
  productId,
  name: "Cola",
  barcode: `UOM:${cartonId}:Cola`,
  variantId: colaId,
  variantLabel: "Cola",
  qty: 12,
  unitName: "carton",
  unitMultiplier: 12,
  unitId: cartonId,
  unitPrice: 1,
  lineTotal: 12,
};

assert.equal(resolveStockVariantId(barcodes, productId, cartonSale), colaId);

const sold = projectSaleStock(products, barcodes, barcodeIndex, [cartonSale]);
assert.equal(sold.products[productId].totalStock, 38);
assert.equal(sold.barcodes.cola.totalStock, 18);
assert.equal(sold.barcodes.diet.totalStock, 20);
assert.equal(sold.barcodeIndex.cola.totalStock, 18);

const returned = projectSaleStock(sold.products, sold.barcodes, sold.barcodeIndex, [
  { ...cartonSale, qty: -6, unitName: "piece", unitMultiplier: 1, unitId: undefined },
]);
assert.equal(returned.products[productId].totalStock, 44);
assert.equal(returned.barcodes.cola.totalStock, 24);
assert.equal(returned.barcodes.diet.totalStock, 20);

await clearSyncQueue();
setTenantStoreId(productId);
const initialState = usePosStore.getState();
usePosStore.setState({
  currentStore: { id: productId, name: "QA", taxPercent: 0 } as never,
  products,
  barcodes,
  barcodeIndex,
  items: [cartonSale],
  totals: { subtotal: 12, tax: 0, discount: 0, deliveryFee: 0, total: 12, itemCount: 12 },
  shiftState: {
    status: "OPEN",
    shiftId: dietId,
    startTime: new Date().toISOString(),
    startingCash: 0,
    branchId: null,
    terminalId: null,
  },
  shiftTotals: initialState.shiftTotals,
  shiftTransactions: [],
  isCompleting: false,
  isOnline: false,
});

await usePosStore.getState().completeCheckout("CASH", 12);
assert.equal(usePosStore.getState().products[productId].totalStock, 38);
assert.equal(usePosStore.getState().barcodes.cola.totalStock, 18);

const queued = (await getSyncsByStatus("PENDING")).find(
  (record) => record.action_type === "INVOICE_CREATED",
);
assert.ok(queued && queued.action_type === "INVOICE_CREATED");
assert.equal(queued.payload.items[0]?.variantId, colaId);

await clearSyncQueue();
setTenantStoreId(null);

console.log("PASS po-uuid-stock-reactivity");
