/**
 * Smart Goods-In receiving suite (Phase 3) — strict TDD for the two headline
 * behaviours, written BEFORE the implementation:
 *
 *  A) Negotiation Shield — instantly shows the last 3 purchase costs with
 *     their vendor names, compares the entered cost against every known cost,
 *     and when the cost rises proposes the exact retail that keeps the margin.
 *
 *  B) Cash Drawer Integration — money paid to a vendor out of the register is
 *     a linked, shift-bound drawer deduction. Committing cash REQUIRES an OPEN
 *     shift; the Z-report counts the payout in `expenses` so the expected
 *     drawer drops and the cashier never reconciles short.
 *
 *  C) End-to-end store flow: scan → shield → accept suggested retail → commit
 *     → a PENDING SUPPLIER_INVOICE_CREATED sync event with the drawer
 *     deduction applied to the live POS shift totals.
 */

import "fake-indexeddb/auto";

// Dummy credentials so any accidental network path fails fast (dead port).
process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:9/rest/v1";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
delete process.env.POS_FORCE_MOCK;

const storage = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => void storage.set(k, v),
  removeItem: (k: string) => void storage.delete(k),
  clear: () => storage.clear(),
  key: () => null,
  length: 0,
};
(globalThis as Record<string, unknown>).window = globalThis;

// Stores + libs must load AFTER the polyfills above (ESM hoists statics).
const { usePosStore } = await import("../store/usePosStore");
const { useReceivingStore } = await import("../store/useReceivingStore");
const { clearSyncQueue, enqueueLabelPrint, getSyncsByStatus, saveCatalogCache } = await import("../lib/idb");
const {
  applyCashDrawerDeduction,
  buildNegotiationShield,
  buildReceivingSyncRecord,
  buildSupplierCreateSyncRecord,
  computeDueDate,
  computePaymentTotals,
  computeReceivingTotals,
  convertLineUnit,
  deriveVariantLabel,
  evaluateMarginFloor,
  generateAutoInvoiceNumber,
  generateInternalSku,
  lineBaseQuantity,
  lineBaseUnitCost,
  maintainMarginRetailPrice,
  validateReceivingDraft,
} = await import("../lib/receiving");
const { sha256Hex } = await import("../lib/sha256");

import type {
  BarcodeIndex,
  BarcodeMap,
  Cashier,
  CategoryMap,
  PosSnapshot,
  ProductMap,
  QuickKeyItem,
  ShiftTotals,
  Store,
} from "../types/pos.types";
import type { ReceivingDraft, ReceivingPayment } from "../types/receiving.types";
import type { SupplierCreatePayload, SupplierInvoiceCreatedPayload } from "../lib/idb";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, cond: boolean): void {
  if (cond) {
    pass += 1;
  } else {
    fail += 1;
    failures.push(name);
    console.error(`  ✗ ${name}`);
  }
}

const categories: CategoryMap = {
  c1: { id: "c1", name: "مشروبات", parentId: null, bgColor: "#0f766e", isQuickKey: true, sortOrder: 1 },
};

const products: ProductMap = {
  p1: { id: "p1", categoryId: "c1", name: "كولا", baseUnit: "عبوة", isWeighed: false, price: 10, costPrice: 6 },
};

const barcodes: BarcodeMap = {
  "11111": { barcode: "11111", productId: "p1", variantId: "v-11111", variantLabel: "", unitName: "عبوة", qtyMultiplier: 1, price: 10, costPrice: 6 },
};

const barcodeIndex: BarcodeIndex = {
  "11111": { product_id: "p1", variantId: "v-11111", name: "كولا", price: 10, variantLabel: "" },
};

const quickKeys: QuickKeyItem[] = [];

const TEST_PIN_SALT = "pos-test-salt-v1";
const pinHash = (pin: string): string => sha256Hex(pin + TEST_PIN_SALT);

const cashiers: Cashier[] = [
  // An inventory-clerk cashier: the receiving module's target role.
  { id: "cashier-1", name: "أمين مخزون", pinHash: pinHash("1111"), role: "cashier", capabilities: ["catalog.add"] },
];

const snapshot: PosSnapshot = {
  schemaVersion: 1,
  updatedAt: new Date().toISOString(),
  categories,
  products,
  barcodes,
  barcodeIndex,
  quickKeys,
  cashiers,
  pinSalt: TEST_PIN_SALT,
};

const emptyShiftTotals: ShiftTotals = {
  cashSales: 0,
  visaSales: 0,
  cliqSales: 0,
  debtSales: 0,
  debtCollections: 0,
  totalSales: 0,
  discounts: 0,
  returns: 0,
  expenses: 0,
  expectedCashInDrawer: 0,
};

const st = (): ReturnType<typeof usePosStore.getState> => usePosStore.getState();
const rt = (): ReturnType<typeof useReceivingStore.getState> => useReceivingStore.getState();

async function reset(): Promise<void> {
  await clearSyncQueue();
  usePosStore.setState({
    ready: false,
    categories: {},
    products: {},
    barcodes: {},
    barcodeIndex: {},
    quickKeys: [],
    items: [],
    heldInvoices: [],
    pendingSyncCount: 0,
    shiftState: { status: "CLOSED", shiftId: null, startTime: null, startingCash: 0, branchId: null, terminalId: null },
    shiftTotals: { ...emptyShiftTotals },
    shiftTransactions: [],
    currentCashier: null,
    currentStore: null,
    activeBranchId: null,
    activeTerminalId: null,
  });
  useReceivingStore.setState({
    draft: {
      supplierId: null,
      supplierName: "",
      invoiceNumber: "",
      invoiceDate: "",
      dueDate: "",
      notes: "",
      lines: [],
      cashPaid: 0,
      taxPercent: 16,
    },
    suppliers: {},
    suppliersLoaded: false,
    shieldByBarcode: {},
    quickAddTarget: null,
    notice: null,
    isCommitting: false,
  });
  st().loadSnapshot(snapshot);
}

/**
 * Cold-start reset: clears the in-memory catalog so `barcodeIndex` is empty —
 * the exact state the Phase 3.5 client bug hit where `usePosStoreHydrated()`
 * was already true but `hydrateCatalog()` had not applied the snapshot yet.
 * Only the IndexedDB catalog mirror holds the products.
 */
async function resetOffline(): Promise<void> {
  await clearSyncQueue();
  usePosStore.setState({
    ready: false,
    categories: {},
    products: {},
    barcodes: {},
    barcodeIndex: {},
    quickKeys: [],
    items: [],
    heldInvoices: [],
    pendingSyncCount: 0,
    shiftState: { status: "CLOSED", shiftId: null, startTime: null, startingCash: 0, branchId: null, terminalId: null },
    shiftTotals: { ...emptyShiftTotals },
    shiftTransactions: [],
    currentCashier: null,
    currentStore: null,
    activeBranchId: null,
    activeTerminalId: null,
  });
  useReceivingStore.setState({
    draft: {
      supplierId: null,
      supplierName: "",
      invoiceNumber: "",
      invoiceDate: "",
      dueDate: "",
      notes: "",
      lines: [],
      cashPaid: 0,
      taxPercent: 16,
    },
    suppliers: {},
    suppliersLoaded: false,
    shieldByBarcode: {},
    quickAddTarget: null,
    notice: null,
    isCommitting: false,
  });
  // Seed the offline catalog mirror under the store's partition (the scan must
  // hydrate from it without a network call).
  await saveCatalogCache(
    {
      storeId: "store-main",
      categories,
      products,
      barcodes,
      barcodeIndex,
      quickKeys,
      cashiers,
      pinSalt: TEST_PIN_SALT,
      updatedAt: snapshot.updatedAt,
    },
    "store-main",
  );
}

const storeMain = {
  id: "store-main",
  name: "متجر الاختبار",
  ownerName: "مالك",
  email: "owner@test.local",
  phone: "",
  subscriptionStatus: "active",
  taxPercent: 16,
} as Store;

function makeDraft(overrides: Partial<ReceivingDraft> = {}): ReceivingDraft {
  return {
    supplierId: "s1",
    supplierName: "مورد الريف",
    invoiceNumber: "INV-100",
    invoiceDate: "2026-08-01",
    dueDate: "2026-08-08",
    notes: "",
    lines: [
      {
        key: "11111",
        productId: "p1",
        barcode: "11111",
        description: "كولا",
        quantity: 2,
        unitCost: 6,
        taxPercent: 16,
        baseUnit: "عبوة",
        applyCost: true,
        newRetailPrice: null,
        isNewProduct: false,
      },
    ],
    cashPaid: 0,
    taxPercent: 16,
    ...overrides,
  };
}

const openShiftCtx = {
  shift: { shiftId: "shift-1", status: "OPEN" as const },
};

const closedShiftCtx = { shift: null };

// ---------------------------------------------------------------------------
// Part A — Negotiation Shield
// ---------------------------------------------------------------------------

function sampleHistory(): Array<{ cost: number; supplierId: string; supplierName: string; invoiceNumber: string; purchasedAt: string; quantity: number }> {
  return [
    { cost: 5, supplierId: "s1", supplierName: "مورد الريف", invoiceNumber: "INV-1", purchasedAt: "2026-05-01", quantity: 24 },
    { cost: 7, supplierId: "s2", supplierName: "مورد الشرق", invoiceNumber: "INV-2", purchasedAt: "2026-06-01", quantity: 24 },
    { cost: 6.5, supplierId: "s1", supplierName: "مورد الريف", invoiceNumber: "INV-3", purchasedAt: "2026-07-01", quantity: 12 },
    { cost: 4, supplierId: "s3", supplierName: "مورد قديم", invoiceNumber: "INV-0", purchasedAt: "2025-12-01", quantity: 6 },
  ];
}

function shieldWith(enteredCost: number, overrides: Partial<Parameters<typeof buildNegotiationShield>[0]> = {}) {
  return buildNegotiationShield({
    barcode: "11111",
    description: "كولا",
    currentCost: 6,
    currentRetail: 10,
    lastPurchases: sampleHistory(),
    enteredCost,
    ...overrides,
  });
}

function testShield(): void {
  const shield = shieldWith(7.5);
  check("shield: only the newest 3 purchases are shown", shield.lastPurchases.length === 3);
  check("shield: newest purchase is first (6.5, مورد الريف)", shield.lastPurchases[0]?.cost === 6.5 && shield.lastPurchases[0]?.supplierName === "مورد الريف");
  check("shield: second newest is 7.0 from مورد الشرق", shield.lastPurchases[1]?.cost === 7 && shield.lastPurchases[1]?.supplierName === "مورد الشرق");
  check("shield: third newest is 5.0", shield.lastPurchases[2]?.cost === 5);
  check("shield: hasHistory true", shield.hasHistory === true);
  check("shield: highest cost 7", shield.highestCost === 7);
  check("shield: lowest cost 5", shield.lowestCost === 5);
  check("shield: average cost 6.17", shield.averageCost === 6.17);
  check("shield: 7.5 is a cost increase over 7", shield.isCostIncrease === true);
  check("shield: increase prompts retail update", shield.shouldPromptRetailUpdate === true);

  const equal = shieldWith(7);
  check("shield: cost equal to highest is NOT an increase", equal.isCostIncrease === false);
  check("shield: no increase means no retail prompt", equal.shouldPromptRetailUpdate === false);

  const lower = shieldWith(5.5);
  check("shield: below-current cost is not an increase", lower.isCostIncrease === false);

  check("shield: current cost/retail surfaced", shield.currentCost === 6 && shield.currentRetail === 10);

  const fallback = shieldWith(8, { currentRetail: 0 });
  check("shield: no retail → margin null", fallback.marginPercent === null);
  check("shield: no retail → fallback suggested price = 8 × 1.3 = 10.40", fallback.suggestedRetail === 10.4);
  check("shield: no retail → no prompt (nothing to maintain)", fallback.shouldPromptRetailUpdate === false);

  const noHistory = buildNegotiationShield({
    barcode: "11111",
    description: "كولا",
    currentCost: 6,
    currentRetail: 10,
    lastPurchases: [],
    enteredCost: 6.5,
  });
  check("shield: empty history → hasHistory false", noHistory.hasHistory === false);
  check("shield: empty history → compares against current cost (6.5 > 6)", noHistory.isCostIncrease === true);

  const twoPurchases = buildNegotiationShield({
    barcode: "11111",
    description: "كولا",
    currentCost: 6,
    currentRetail: 10,
    lastPurchases: sampleHistory().slice(0, 2),
    enteredCost: 5,
  });
  check("shield: only 2 available → exactly 2 shown", twoPurchases.lastPurchases.length === 2);
}

function testMarginRetail(): void {
  // current margin (10 - 6) / 10 = 0.40 → 8 / 0.60 = 13.33
  check("margin: 8 at 40% margin → 13.33", maintainMarginRetailPrice(8, 6, 10) === 13.33);
  check("margin: cost unchanged keeps retail", maintainMarginRetailPrice(6, 6, 10) === 10);
  check("margin: zero retail → 1.3× fallback", maintainMarginRetailPrice(8, 0, 0) === 10.4);
  check("margin: below-cost retail → 1.3× fallback", maintainMarginRetailPrice(8, 10, 9) === 10.4);
  check("margin: zero entered cost → 0", maintainMarginRetailPrice(0, 6, 10) === 0);
}

function testSku(): void {
  const a = generateInternalSku("أكياس سوداء 25 كغم");
  const b = generateInternalSku("منتج جديد تماماً");
  check("sku: MKN prefix + 10 alphanumerics", /^MKN[A-Z0-9]{10}$/.test(a));
  check("sku: distinct names mint distinct codes", a !== b);
  const same1 = generateInternalSku("عبوة ماء");
  const same2 = generateInternalSku("عبوة ماء");
  check("sku: same name keeps same hash head", same1.slice(0, 9) === same2.slice(0, 9));
}

function testTotals(): void {
  const totals = computeReceivingTotals([
    { quantity: 2, unitCost: 10, taxPercent: 16 },
    { quantity: 1, unitCost: 5, taxPercent: 16 },
  ]);
  check("totals: subtotal 25", totals.subtotal === 25);
  check("totals: tax 4.00", totals.tax === 4);
  check("totals: total 29", totals.total === 29);

  const zero = computeReceivingTotals([{ quantity: 0, unitCost: 10, taxPercent: 16 }]);
  check("totals: zero qty → zero totals", zero.subtotal === 0 && zero.tax === 0 && zero.total === 0);
}

// ---------------------------------------------------------------------------
// Part B — Cash Drawer Integration
// ---------------------------------------------------------------------------

function testDrawerDeduction(): void {
  const base: ShiftTotals = { ...emptyShiftTotals, expectedCashInDrawer: 100 };
  const deducted = applyCashDrawerDeduction(base, 50);
  check("drawer: expenses rise by the vendor payout", deducted.expenses === 50);
  check("drawer: expected cash drops by exactly the payout", deducted.expectedCashInDrawer === 50);
  check("drawer: cash sales untouched", deducted.cashSales === 0);

  const noop = applyCashDrawerDeduction(base, 0);
  check("drawer: zero payout is a no-op", noop.expenses === 0 && noop.expectedCashInDrawer === 100);
  const negative = applyCashDrawerDeduction(base, -5);
  check("drawer: negative payout is a no-op", negative.expenses === 0 && negative.expectedCashInDrawer === 100);
}

function testValidation(): void {
  check("validation: valid draft passes", validateReceivingDraft(makeDraft(), openShiftCtx) === null);
  check("validation: no supplier rejected", validateReceivingDraft(makeDraft({ supplierId: null, supplierName: "" }), openShiftCtx) === "اختر المورد");
  check("validation: no invoice number rejected", validateReceivingDraft(makeDraft({ invoiceNumber: "  " }), openShiftCtx) === "أدخل رقم فاتورة المورد");
  check("validation: due before invoice rejected", validateReceivingDraft(makeDraft({ dueDate: "2026-07-01" }), openShiftCtx) === "تاريخ الاستحقاق يسبق تاريخ الفاتورة");
  check("validation: empty lines rejected", validateReceivingDraft(makeDraft({ lines: [] }), openShiftCtx) === "أضف صنفاً واحداً على الأقل");
  check(
    "validation: zero quantity rejected",
    validateReceivingDraft(makeDraft({ lines: [{ ...makeDraft().lines[0], quantity: 0 }] }), openShiftCtx)?.includes("كمية") === true,
  );

  const cashDraft = makeDraft({ cashPaid: 50 });
  check(
    "validation: cash without open shift rejected",
    validateReceivingDraft(cashDraft, closedShiftCtx) === "افتح الوردية قبل دفع النقد للمورد من الصندوق",
  );
  check("validation: cash with open shift passes", validateReceivingDraft(cashDraft, openShiftCtx) === null);

  // Phase 3.5 — payment center + margin floor guard.
  const badMethod = makeDraft({
    payments: [{ key: "p1", method: "CHEQUE", amount: 5 }] as unknown as ReceivingPayment[],
  });
  check("validation35: unknown payment method rejected", validateReceivingDraft(badMethod, openShiftCtx) === "طريقة دفع غير صالحة");

  const overpay = makeDraft({ payments: [{ key: "p1", method: "CASH", amount: 999 }] });
  check("validation35: payments above the invoice total rejected", validateReceivingDraft(overpay, openShiftCtx) === "الدفع يتجاوز قيمة الفاتورة");

  const thinMargin = makeDraft({ lines: [{ ...makeDraft().lines[0]!, quantity: 1, unitCost: 9, currentRetail: 10 }] });
  check("validation35: below-floor margin blocks commit", validateReceivingDraft(thinMargin, openShiftCtx)?.includes("هامش") === true);

  const overrideOk = makeDraft({ lines: [{ ...makeDraft().lines[0]!, quantity: 1, unitCost: 9, currentRetail: 10, marginOverride: true }] });
  check("validation35: margin override clears the block", validateReceivingDraft(overrideOk, openShiftCtx) === null);
}

function testSyncRecordBuilder(): void {
  const draft = makeDraft({
    cashPaid: 120,
    lines: [
      { ...makeDraft().lines[0], quantity: 2, unitCost: 6, taxPercent: 16, newRetailPrice: 13.33 },
      {
        key: "MKNABC0001",
        productId: null,
        barcode: "MKNABC0001",
        description: "منتج سريع",
        quantity: 1,
        unitCost: 2,
        taxPercent: 16,
        baseUnit: "حبة",
        applyCost: true,
        newRetailPrice: 3,
        isNewProduct: true,
      },
    ],
  });
  const record = buildReceivingSyncRecord(draft, {
    syncId: "sync-900",
    cashierId: "cashier-1",
    cashierName: "أمين مخزون",
    branchId: "branch-1",
    terminalId: "terminal-1",
    shift: { shiftId: "shift-1", status: "OPEN" },
    drawerExpenseId: "expense-1",
  });
  const p = record.payload as SupplierInvoiceCreatedPayload;

  check("builder: action type is SUPPLIER_INVOICE_CREATED", record.action_type === "SUPPLIER_INVOICE_CREATED");
  check("builder: status PENDING", record.status === "PENDING");
  check("builder: payload supplier/date stamped", p.supplierId === "s1" && p.invoiceNumber === "INV-100");
  check("builder: totals equal computeReceivingTotals", p.subtotal === 14 && p.total === 16.24);
  check("builder: cashPaid carried", p.cashPaid === 120);
  check("builder: drawer deduction linked to open shift", p.drawerDeduction?.shiftId === "shift-1");
  check("builder: drawer deduction has the deterministic expense id", p.drawerDeduction?.expenseId === "expense-1");
  check("builder: drawer deduction amount matches cash paid", p.drawerDeduction?.amount === 120);
  check("builder: line carries accepted retail", p.lines[0]?.newRetailPrice === 13.33);
  check("builder: quick-add line mapped to newProducts", p.newProducts?.length === 1);
  check("builder: quick-add product has sku + retail", p.newProducts?.[0]?.sku === "MKNABC0001" && p.newProducts?.[0]?.retailPrice === 3);
  check("builder: plain quick-add carries no variant linkage", p.newProducts?.[0]?.brandId === undefined && p.newProducts?.[0]?.variantLabel === undefined);

  // Phase 4 — variant quick-add: the new product hangs off an existing parent.
  const variantDraft = makeDraft({
    lines: [
      {
        key: "MKNVAR0001",
        productId: null,
        barcode: "MKNVAR0001",
        description: "زبادي فراولة",
        quantity: 1,
        unitCost: 1.5,
        taxPercent: 16,
        baseUnit: "حبة",
        applyCost: true,
        newRetailPrice: 2.5,
        isNewProduct: true,
        brandId: "parent-1",
        variantLabel: "فراولة",
      },
    ],
  });
  const variantRecord = buildReceivingSyncRecord(variantDraft, {
    syncId: "sync-910",
    shift: { shiftId: "shift-1", status: "OPEN" },
  });
  const vp = variantRecord.payload as SupplierInvoiceCreatedPayload;
  check("builder: variant line maps brandId into newProducts", vp.newProducts?.[0]?.brandId === "parent-1");
  check("builder: variant label carried into newProducts", vp.newProducts?.[0]?.variantLabel === "فراولة");

  const creditOnly = buildReceivingSyncRecord(makeDraft({ cashPaid: 0 }), {
    syncId: "sync-901",
    shift: { shiftId: "shift-1", status: "OPEN" },
  });
  const creditPayload = creditOnly.payload as SupplierInvoiceCreatedPayload;
  check("builder: credit-only draft has no drawer deduction", creditPayload.drawerDeduction === undefined);
  check("builder: credit-only cashPaid is 0", creditPayload.cashPaid === 0);

  // Smart on-the-fly variants: a brand-new group name rides as parentName and
  // the sync mirror creates the parent (variant root) before linking children.
  const onTheFlyDraft = makeDraft({
    lines: [
      {
        key: "MKNONF001",
        productId: null,
        barcode: "MKNONF001",
        description: "معطر جو ليمون",
        quantity: 1,
        unitCost: 2.5,
        taxPercent: 16,
        baseUnit: "حبة",
        applyCost: true,
        newRetailPrice: 5,
        isNewProduct: true,
        parentName: "معطر جو 300مل",
      },
    ],
  });
  const onTheFlyRecord = buildReceivingSyncRecord(onTheFlyDraft, {
    syncId: "sync-920",
    shift: { shiftId: "shift-1", status: "OPEN" },
  });
  const ofp = onTheFlyRecord.payload as SupplierInvoiceCreatedPayload;
  check("builder: draft parent name carried into newProducts", ofp.newProducts?.[0]?.parentName === "معطر جو 300مل");
  check("builder: draft parent has no brand id yet", ofp.newProducts?.[0]?.brandId === undefined);
  check("builder: no variantLabel — the mirror derives it", ofp.newProducts?.[0]?.variantLabel === undefined);

  const multiChildDraft = makeDraft({
    lines: [
      {
        key: "MKNONF002",
        productId: null,
        barcode: "MKNONF002",
        description: "معطر جو عود",
        quantity: 1,
        unitCost: 3,
        taxPercent: 16,
        baseUnit: "حبة",
        applyCost: true,
        newRetailPrice: 6,
        isNewProduct: true,
        parentName: "معطر جو 300مل",
      },
      {
        key: "MKNONF003",
        productId: null,
        barcode: "MKNONF003",
        description: "معطر جو فانيليا",
        quantity: 1,
        unitCost: 3,
        taxPercent: 16,
        baseUnit: "حبة",
        applyCost: true,
        newRetailPrice: 6,
        isNewProduct: true,
        parentName: "معطر جو 300مل",
      },
    ],
  });
  const mcPayload = buildReceivingSyncRecord(multiChildDraft, {
    syncId: "sync-921",
    shift: { shiftId: "shift-1", status: "OPEN" },
  }).payload as SupplierInvoiceCreatedPayload;
  check("builder: two children share one draft parent name", mcPayload.newProducts?.length === 2 && mcPayload.newProducts.every((np) => np.parentName === "معطر جو 300مل"));

  // Label derivation is the TS twin of merge_into_variant_parent's SQL.
  check("draft: Arabic child strips the shared prefix", deriveVariantLabel("معطر جو ليمون", "معطر جو 300مل") === "ليمون");
  check("draft: English child strips the shared prefix", deriveVariantLabel("Air Freshener Lemon", "Air Freshener 300ml") === "Lemon");
  check("draft: no shared prefix keeps the whole name", deriveVariantLabel("زبادي فراولة", "معطر جو 300مل") === "زبادي فراولة");
  check("draft: identical child+parent falls back to the full name", deriveVariantLabel("معطر جو 300مل", "معطر جو 300مل") === "معطر جو 300مل");
  check("draft: label truncates at 112 chars", deriveVariantLabel(`معطر جو ${"ل".repeat(200)}`, "معطر جو").length <= 112);
  check("draft: case-insensitive prefix match", deriveVariantLabel("air freshener lemon", "AIR FRESHENER 300ML") === "lemon");

  // Validation guards around draft parents.
  check(
    "draft: parent name over 255 chars rejected",
    validateReceivingDraft(
      makeDraft({ lines: [{ ...makeDraft().lines[0]!, isNewProduct: true, parentName: "ج".repeat(256) }] }),
      openShiftCtx,
    )?.includes("طويل") === true,
  );
  check(
    "draft: valid draft-parent line passes validation",
    validateReceivingDraft(
      makeDraft({ lines: [{ ...makeDraft().lines[0]!, isNewProduct: true, parentName: "معطر جو 300مل" }] }),
      openShiftCtx,
    ) === null,
  );

  // Phase 3.5 — payment center + per-line units.
  check("builder35: legacy cashPaid falls back to one CASH payment", p.payments?.[0]?.method === "CASH" && p.payments?.[0]?.amount === 120);
  check("builder35: totalPaid mirrors the legacy cashPaid", p.totalPaid === 120);
  check("builder35: line unitMultiplier defaults to 1", p.lines[0]?.unitMultiplier === 1);
  check("builder35: line unitName defaults to the base unit", p.lines[0]?.unitName === "عبوة");

  const splitPay = buildReceivingSyncRecord(
    makeDraft({
      cashPaid: 30,
      payments: [
        { key: "c", method: "CASH", amount: 30 },
        { key: "b", method: "BANK", amount: 20 },
      ],
      lines: [{ ...makeDraft().lines[0]!, multiplier: 12, unitName: "كرتونة" }],
    }),
    { syncId: "sync-902", shift: { shiftId: "shift-1", status: "OPEN" } },
  );
  const splitPayload = splitPay.payload as SupplierInvoiceCreatedPayload;
  check("builder35: payments array carried through", splitPayload.payments?.length === 2);
  check("builder35: cashPaid derived as the cash portion", splitPayload.cashPaid === 30);
  check("builder35: totalPaid sums all methods", splitPayload.totalPaid === 50);
  check("builder35: drawer deduction equals the cash portion only", splitPayload.drawerDeduction?.amount === 30);
  check("builder35: line unit multiplier carried into the payload", splitPayload.lines[0]?.unitMultiplier === 12);
}

// ---------------------------------------------------------------------------
// Part C — End-to-end store flow
// ---------------------------------------------------------------------------

async function testStoreFlow(): Promise<void> {
  await reset();
  check("store: inventory clerk can log in", st().loginCashier("1111") === true);
  await st().openShift(100);
  usePosStore.setState({
    currentStore: {
      id: "store-main",
      name: "متجر الاختبار",
      ownerName: "مالك",
      email: "owner@test.local",
      phone: "",
      subscriptionStatus: "active",
      taxPercent: 16,
    } as Store,
  });
  useReceivingStore.setState({
    suppliers: { s1: { id: "s1", name: "مورد الريف" }, s2: { id: "s2", name: "مورد الشرق" } },
    suppliersLoaded: true,
  });
  rt().startNewDraft();
  rt().setSupplier("s1", "مورد الريف");
  rt().setInvoiceMeta({ invoiceNumber: "INV-900", invoiceDate: "2026-08-16", dueDate: "2026-08-23" });

  await rt().scanBarcode("11111");
  check("store: scan adds the catalog line", rt().draft.lines.length === 1 && rt().draft.lines[0]?.barcode === "11111");
  check("store: scan seeds cost from catalog (6)", rt().draft.lines[0]?.unitCost === 6);
  check("store: shield rendered on scan", rt().shieldByBarcode["11111"]?.currentCost === 6);

  rt().updateLineCost("11111", 8);
  const shield = rt().shieldByBarcode["11111"];
  check("store: cost increase detected at 8", shield?.isCostIncrease === true);
  check("store: maintain-margin retail proposed (13.33)", shield?.suggestedRetail === 13.33);

  rt().acceptSuggestedRetail("11111");
  check("store: accepted retail written to the line", rt().draft.lines[0]?.newRetailPrice === 13.33);

  rt().updateLineQuantity("11111", 2);
  check("store: quantity updated", rt().draft.lines[0]?.quantity === 2);

  rt().setCashPaid(50);
  const pendingBefore = (await getSyncsByStatus("PENDING")).length;
  const commitResult = await rt().commitDraft();
  check("store: commit succeeds", commitResult.ok === true);
  check("store: draft cleared after commit", rt().draft.lines.length === 0);

  const pending = await getSyncsByStatus("PENDING");
  const receivingEvent = pending.find((r) => r.action_type === "SUPPLIER_INVOICE_CREATED");
  const eventPayload = receivingEvent?.payload as SupplierInvoiceCreatedPayload | undefined;
  check("store: SUPPLIER_INVOICE_CREATED enqueued", Boolean(receivingEvent));
  check("store: event count grew by exactly one", pending.length === pendingBefore + 1);
  check("store: event references the open shift", eventPayload?.drawerDeduction?.shiftId === st().shiftState.shiftId);
  check("store: event drawer amount matches", eventPayload?.drawerDeduction?.amount === 50);
  check("store: event carries the accepted retail", eventPayload?.lines[0]?.newRetailPrice === 13.33);
  check("store: event carries the cashier identity", eventPayload?.cashierId === "cashier-1");

  const totals = st().shiftTotals;
  check("store: shift expenses include the vendor payout", totals.expenses === 50);
  check("store: expected drawer dropped from 100 to 50", totals.expectedCashInDrawer === 50);
  check("store: success notice reflects the drawer deduction", rt().notice?.message.includes("خصم") === true);
}

async function testCashWithoutShift(): Promise<void> {
  await reset();
  check("store: cashier login", st().loginCashier("1111") === true);
  usePosStore.setState({
    currentStore: { id: "store-main", name: "متجر الاختبار", ownerName: "م", email: "e@t", phone: "", subscriptionStatus: "active" } as Store,
  });
  rt().startNewDraft();
  rt().setSupplier("s1", "مورد الريف");
  rt().setInvoiceMeta({ invoiceNumber: "INV-901", invoiceDate: "2026-08-16", dueDate: "2026-08-23" });
  await rt().scanBarcode("11111");
  rt().setCashPaid(50);

  const pendingBefore = (await getSyncsByStatus("PENDING")).length;
  const result = await rt().commitDraft();
  check("store: cash commit without open shift is rejected", result.ok === false);
  check("store: rejection carries the drawer error", result.error === "افتح الوردية قبل دفع النقد للمورد من الصندوق");
  const pendingAfter = await getSyncsByStatus("PENDING");
  check("store: nothing enqueued for a rejected draft", pendingAfter.length === pendingBefore);
  check("store: shift totals untouched", st().shiftTotals.expenses === 0);
  check("store: draft preserved for correction", rt().draft.lines.length === 1);
}

async function testQuickAdd(): Promise<void> {
  await reset();
  check("store: cashier login", st().loginCashier("1111") === true);
  usePosStore.setState({
    currentStore: { id: "store-main", name: "متجر الاختبار", ownerName: "م", email: "e@t", phone: "", subscriptionStatus: "active" } as Store,
  });
  rt().startNewDraft();
  rt().setSupplier("s2", "مورد الشرق");
  rt().setInvoiceMeta({ invoiceNumber: "INV-902", invoiceDate: "2026-08-16", dueDate: "2026-08-23" });

  await rt().scanBarcode("999999999");
  check("store: unknown barcode opens Quick Add", rt().quickAddTarget === "999999999");

  rt().quickAdd({ name: "منتج جديد", cost: 2.5, retailPrice: 4, taxPercent: 16, baseUnit: "حبة" });
  check("store: quick-add line added", rt().draft.lines.length === 1);
  check("store: quick-add keeps the scanned barcode", rt().draft.lines[0]?.barcode === "999999999");
  check("store: quick-add line flagged isNewProduct", rt().draft.lines[0]?.isNewProduct === true);
  check("store: quick-add seeds retail for the new product", rt().draft.lines[0]?.newRetailPrice === 4);

  rt().startNewDraft();
  rt().quickAdd({ name: "بدون باركود", cost: 1, retailPrice: 2, taxPercent: 16, baseUnit: "حبة" });
  check("store: quick-add without a scan mints an MKN SKU", /^MKN[A-Z0-9]{10}$/.test(rt().draft.lines[0]?.barcode ?? ""));

  // Phase 4 — variant quick-add: parent + label land on the line.
  rt().startNewDraft();
  rt().quickAdd({
    name: "زبادي فراولة",
    cost: 1.5,
    retailPrice: 2.5,
    taxPercent: 16,
    baseUnit: "حبة",
    brandId: "parent-1",
    variantLabel: "فراولة",
  });
  const variantLine = rt().draft.lines[0];
  check("store: variant quick-add keeps the brand id", variantLine?.brandId === "parent-1");
  check("store: variant quick-add keeps the label", variantLine?.variantLabel === "فراولة");
  check("store: variant quick-add stays a new product", variantLine?.isNewProduct === true);

  // Smart on-the-fly — a brand-new group name is accepted with no DB row.
  rt().startNewDraft();
  rt().quickAdd({
    name: "معطر جو ليمون",
    cost: 2.5,
    retailPrice: 5,
    taxPercent: 16,
    baseUnit: "حبة",
    brandName: "معطر جو 300مل",
  });
  const onTheFlyLine = rt().draft.lines[0];
  check("store: draft-parent quick-add keeps the brand name", onTheFlyLine?.brandName === "معطر جو 300مل");
  check("store: draft-parent quick-add has no brand id yet", onTheFlyLine?.brandId == null);

  rt().startNewDraft();
  rt().quickAdd({ name: "زبادي عادي", cost: 1, retailPrice: 2, taxPercent: 16, baseUnit: "حبة" });
  check("store: plain quick-add leaves variant fields empty", rt().draft.lines[0]?.brandId == null && rt().draft.lines[0]?.variantLabel == null && rt().draft.lines[0]?.brandName == null);
}

// ---------------------------------------------------------------------------
// Part D — Phase 3.5: Smart Payment Engine, per-line units, margin floor
// ---------------------------------------------------------------------------

function testAutoInvoiceNumber(): void {
  const a = generateAutoInvoiceNumber(new Date(2026, 7, 16, 9, 5));
  check("auto: AUTO-YYMMDD-HHMM shape", /^AUTO-\d{6}-\d{4}$/.test(a));
  check("auto: deterministic for a fixed time", a === generateAutoInvoiceNumber(new Date(2026, 7, 16, 9, 5)));
  const b = generateAutoInvoiceNumber(new Date(2026, 7, 16, 9, 6));
  check("auto: minutes change the code", a !== b);
  check("auto: encodes date + time", a === "AUTO-260816-0905");
}

function testDueDate(): void {
  check("due: +7 days from Aug 1", computeDueDate("2026-08-01", 7) === "2026-08-08");
  check("due: month rollover", computeDueDate("2026-08-31", 1) === "2026-09-01");
  check("due: zero days keeps the date", computeDueDate("2026-08-15", 0) === "2026-08-15");
  check("due: negative days clamp to the invoice date", computeDueDate("2026-08-15", -3) === "2026-08-15");
  check("due: invalid input echoed untouched", computeDueDate("nope", 7) === "nope");
}

function testPaymentTotals(): void {
  const split = computePaymentTotals(100, [
    { method: "CASH", amount: 30 },
    { method: "BANK", amount: 20 },
  ]);
  check("pay: totalPaid is the sum (50)", split.totalPaid === 50);
  check("pay: cashPortion is 30", split.cashPortion === 30);
  check("pay: nonCash is 20", split.nonCash === 20);
  check("pay: remaining is 50", split.remaining === 50);
  check("pay: not fully paid", split.fullyPaid === false);

  const full = computePaymentTotals(100, [{ method: "CLIQ", amount: 100 }]);
  check("pay: fully paid when paid equals total", full.fullyPaid === true && full.remaining === 0);

  const none = computePaymentTotals(100, []);
  check("pay: no payments → nothing paid", none.totalPaid === 0 && none.cashPortion === 0 && none.remaining === 100);

  const over = computePaymentTotals(50, [{ method: "WALLET", amount: 60 }]);
  check("pay: remaining never goes negative", over.remaining === 0);
}

function testUnitHelpers(): void {
  const base = { quantity: 24, unitCost: 1, multiplier: 1 } as const;
  check("units: base quantity is quantity × 1", lineBaseQuantity(base) === 24);
  check("units: base unit cost is cost / 1", lineBaseUnitCost(base) === 1);

  const pack = { quantity: 2, unitCost: 12, multiplier: 12 } as const;
  check("units: pack quantity converts to base (24)", lineBaseQuantity(pack) === 24);
  check("units: pack unit cost converts to base (1)", lineBaseUnitCost(pack) === 1);

  const converted = convertLineUnit({ quantity: 24, unitCost: 1, multiplier: 1 }, 12);
  check("units: converting to pack re-expresses quantity", Math.abs(converted.quantity - 2) < 0.001);
  check("units: converting to pack re-expresses unit cost", Math.abs(converted.unitCost - 12) < 0.001);
  check("units: base value preserved across conversion", Math.abs(converted.quantity * converted.unitCost - 24) < 0.01);
}

function testMarginFloor(): void {
  const safe = evaluateMarginFloor({ unitCost: 8, currentRetail: 10 });
  check("margin-floor: 20% sits above the 15% floor", safe.belowFloor === false && safe.marginPercent === 0.2);

  const thin = evaluateMarginFloor({ unitCost: 9, currentRetail: 10 });
  check("margin-floor: 10% breaches the floor", thin.belowFloor === true && thin.marginPercent === 0.1);
  check("margin-floor: floor constant surfaced", thin.floor === 0.15);

  const belowCost = evaluateMarginFloor({ unitCost: 12, currentRetail: 10 });
  check("margin-floor: at/below-cost selling always breaches", belowCost.belowFloor === true && belowCost.marginPercent === 0);

  const unknown = evaluateMarginFloor({ unitCost: 6 });
  check("margin-floor: unknown retail never blocks", unknown.belowFloor === false && unknown.retail === null);

  const preferred = evaluateMarginFloor({ unitCost: 6, currentRetail: 10, newRetailPrice: 7 });
  check("margin-floor: accepted retail is authoritative (1/7 ≈ 14.29% < floor)", preferred.belowFloor === true && preferred.retail === 7);

  const shield = buildNegotiationShield({
    barcode: "11111", description: "كولا", currentCost: 6, currentRetail: 10, lastPurchases: [], enteredCost: 9,
  });
  check("margin-floor: shield flags belowFloor", shield.belowFloor === true);
  check("margin-floor: shield exposes the floor", shield.marginFloor === 0.15);
  check("margin-floor: shield proposed margin is 10%", shield.proposedMarginPercent === 0.1);

  const shieldSafe = buildNegotiationShield({
    barcode: "11111", description: "كولا", currentCost: 6, currentRetail: 10, lastPurchases: [], enteredCost: 8,
  });
  check("margin-floor: shield stays clear at 20%", shieldSafe.belowFloor === false);
}

async function testStorePhase35(): Promise<void> {
  await reset();
  check("store35: cashier login", st().loginCashier("1111") === true);
  await st().openShift(100);
  usePosStore.setState({
    currentStore: { id: "store-main", name: "متجر الاختبار", ownerName: "م", email: "e@t", phone: "", subscriptionStatus: "active" } as Store,
  });
  useReceivingStore.setState({
    suppliers: { s1: { id: "s1", name: "مورد الريف", paymentTermsDays: 7, balance: 100 } },
    suppliersLoaded: true,
  });

  rt().startNewDraft();
  check("store35: auto invoice number minted on a new draft", /^AUTO-\d{6}-\d{4}$/.test(rt().draft.invoiceNumber));

  rt().setSupplier("s1", "مورد الريف", 7);
  check("store35: supplier terms compute the due date", rt().draft.dueDate === computeDueDate(rt().draft.invoiceDate, 7));
  rt().setInvoiceMeta({ invoiceNumber: "INV-350", invoiceDate: "2026-08-16", dueDate: "2026-08-23" });

  await rt().scanBarcode("11111");
  rt().updateLineQuantity("11111", 1);
  rt().updateLineCost("11111", 9);
  check("store35: cost 9 keeps retail 10 → floor breached", rt().shieldByBarcode["11111"]?.belowFloor === true);

  const blocked = await rt().commitDraft();
  check("store35: below-floor margin blocks commit", blocked.ok === false);
  check("store35: margin block message mentions هامش", blocked.error?.includes("هامش") === true);
  check("store35: draft preserved for correction", rt().draft.lines.length === 1);

  rt().overrideMarginWarning("11111");
  const afterOverride = await rt().commitDraft();
  check("store35: margin override allows the commit", afterOverride.ok === true);
  const pendingAfterOverride = await getSyncsByStatus("PENDING");
  check("store35: event enqueued after override", pendingAfterOverride.some((r) => r.action_type === "SUPPLIER_INVOICE_CREATED") === true);

  await reset();
  check("store35: cashier login (payments)", st().loginCashier("1111") === true);
  await st().openShift(100);
  usePosStore.setState({
    currentStore: { id: "store-main", name: "متجر الاختبار", ownerName: "م", email: "e@t", phone: "", subscriptionStatus: "active" } as Store,
  });
  rt().startNewDraft();
  rt().setSupplier("s1", "مورد الريف");
  rt().setInvoiceMeta({ invoiceNumber: "INV-351", invoiceDate: "2026-08-16", dueDate: "2026-08-23" });
  await rt().scanBarcode("11111");
  rt().setPayments([
    { key: "c", method: "CASH", amount: 4 },
    { key: "b", method: "BANK", amount: 2 },
  ]);
  check("store35: cashPaid derived from the CASH payment", rt().draft.cashPaid === 4);

  const payCommit = await rt().commitDraft();
  check("store35: payment-center commit succeeds", payCommit.ok === true);
  const events = await getSyncsByStatus("PENDING");
  const ev = events.find((r) => r.action_type === "SUPPLIER_INVOICE_CREATED");
  const payload = ev?.payload as SupplierInvoiceCreatedPayload | undefined;
  check("store35: payments array mirrored into the event", payload?.payments?.length === 2);
  check("store35: cashPaid is the cash portion", payload?.cashPaid === 4);
  check("store35: totalPaid sums both methods", payload?.totalPaid === 6);
  check("store35: drawer deduction is cash-only", payload?.drawerDeduction?.amount === 4);

  const totals = st().shiftTotals;
  check("store35: shift expenses rose by the cash portion", totals.expenses === 4);
  check("store35: expected drawer dropped by the cash portion", totals.expectedCashInDrawer === 96);
}

// ---------------------------------------------------------------------------
// Part E — Phase 3.5 client QA: offline catalog lookup + inline supplier add
// ---------------------------------------------------------------------------

function testSupplierCreateBuilder(): void {
  const record = buildSupplierCreateSyncRecord(
    { id: "11111111-1111-4111-8111-111111111111", name: "مورد جديد", phone: "0790000000" },
    { syncId: "sync-supplier-1", branchId: "b1", terminalId: "t1", cashierId: "cashier-1", cashierName: "أمين" },
  );
  const p = record.payload as SupplierCreatePayload;
  check("supplier-builder: action type is SUPPLIER_CREATE", record.action_type === "SUPPLIER_CREATE");
  check("supplier-builder: status PENDING", record.status === "PENDING");
  check("supplier-builder: payload carries id/name/phone", p.id === "11111111-1111-4111-8111-111111111111" && p.name === "مورد جديد" && p.phone === "0790000000");
  check("supplier-builder: context stamped", p.cashierId === "cashier-1" && p.branchId === "b1" && p.terminalId === "t1");
  check("supplier-builder: created_at set", typeof p.created_at === "string" && p.created_at.length > 0);
  check("supplier-builder: no phone stays undefined", (buildSupplierCreateSyncRecord({ id: "11111111-1111-4111-8111-111111111111", name: "مورد" }, { syncId: "x" }).payload as SupplierCreatePayload).phone === undefined);
}

async function testOfflineCatalogFallback(): Promise<void> {
  await resetOffline();
  check("offline: in-memory barcode index is empty (cold start)", Object.keys(st().barcodeIndex).length === 0);
  usePosStore.setState({ currentStore: storeMain });
  rt().startNewDraft();
  rt().setSupplier("s1", "مورد الريف");
  rt().setInvoiceMeta({ invoiceNumber: "INV-904", invoiceDate: "2026-08-16", dueDate: "2026-08-23" });

  await rt().scanBarcode("11111");
  check("offline: known barcode does NOT open Quick-Add", rt().quickAddTarget === null);
  check("offline: line added from the IndexedDB catalog", rt().draft.lines.length === 1 && rt().draft.lines[0]?.barcode === "11111");
  check("offline: cost seeded from the cache (6)", rt().draft.lines[0]?.unitCost === 6);
  check("offline: retail seeded from the cache (10)", rt().draft.lines[0]?.currentRetail === 10);
  check("offline: catalog hydrated into memory for O(1) scans", st().barcodeIndex["11111"]?.product_id === "p1" && st().products["p1"]?.name === "كولا");

  await rt().scanBarcode("11111");
  check("offline: second scan hits the hydrated index and increments", rt().draft.lines[0]?.quantity === 2);
  check("offline: quick-add never triggered on repeats", rt().quickAddTarget === null);
}

async function testInlineAddSupplier(): Promise<void> {
  await reset();
  check("store: cashier login (inline supplier)", st().loginCashier("1111") === true);
  usePosStore.setState({ currentStore: storeMain });
  rt().startNewDraft();
  rt().setSupplier("s1", "مورد الريف");
  rt().setInvoiceMeta({ invoiceNumber: "INV-905", invoiceDate: "2026-08-16", dueDate: "2026-08-23" });
  await rt().scanBarcode("11111");
  const lineCountBefore = rt().draft.lines.length;

  const result = await rt().addSupplier({ name: "مورد جديد", phone: "0790000000" });
  check("supplier: add ok", result.ok === true && typeof result.supplierId === "string");
  const id = result.supplierId!;
  check("supplier: entry in the picker state", rt().suppliers[id]?.name === "مورد جديد");
  check("supplier: phone captured", rt().suppliers[id]?.phone === "0790000000");
  check("supplier: auto-selected on the draft", rt().draft.supplierId === id && rt().draft.supplierName === "مورد جديد");
  check("supplier: draft lines preserved", rt().draft.lines.length === lineCountBefore);
  check("supplier: success notice shown", rt().notice?.message.includes("مورد جديد") === true);

  const pending = await getSyncsByStatus("PENDING");
  const createEvent = pending.find((r) => r.action_type === "SUPPLIER_CREATE");
  check("supplier: SUPPLIER_CREATE enqueued", Boolean(createEvent));
  const p = createEvent?.payload as SupplierCreatePayload | undefined;
  check("supplier: event carries the client id", p?.id === id);
  check("supplier: event carries name + phone", p?.name === "مورد جديد" && p?.phone === "0790000000");

  const empty = await rt().addSupplier({ name: "   " });
  check("supplier: blank name rejected", empty.ok === false);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function testLabelPrintQueue(): Promise<void> {
  console.log("\n[F] Phase 4 — remote label print queue");
  await clearSyncQueue();

  await enqueueLabelPrint(
    {
      barcode: "6261",
      name: "شامبو",
      variantLabel: "نعناع",
      unitName: "عبوة",
      price: 12.5,
      quantity: 3,
      templateSize: { widthMm: 40, heightMm: 30 },
    },
    "أمين",
  );
  await enqueueLabelPrint(
    {
      barcode: "6262",
      name: "صابون",
      unitName: "قطعة",
      price: 4,
      quantity: 1,
      templateSize: { widthMm: 58, heightMm: 40 },
    },
    "أمين",
  );

  const pending = (await getSyncsByStatus("PENDING")).filter((r) => r.action_type === "BARCODE_LABEL_PRINT");
  check("label-print: two jobs enqueued", pending.length === 2);

  const shampoo = pending.find((r) => (r.payload as { barcode: string }).barcode === "6261");
  check("label-print: record carries action type", shampoo?.action_type === "BARCODE_LABEL_PRINT");
  const sp = shampoo?.payload as {
    barcode: string;
    name: string;
    variantLabel?: string;
    unitName: string;
    price: number;
    quantity: number;
    templateSize: { widthMm: number; heightMm: number };
    created_at: string;
  };
  check("label-print: payload is self-contained", sp.barcode === "6261" && sp.name === "شامبو" && sp.unitName === "عبوة");
  check("label-print: variant label carried", sp.variantLabel === "نعناع");
  check("label-print: quantity + price carried", sp.quantity === 3 && sp.price === 12.5);
  check("label-print: template size carried", sp.templateSize.widthMm === 40 && sp.templateSize.heightMm === 30);
  check("label-print: created_at stamped", typeof sp.created_at === "string" && sp.created_at.length > 0);
  check("label-print: sync_id is a UUID", typeof shampoo?.sync_id === "string" && UUID_RE.test(shampoo.sync_id));

  const soap = pending.find((r) => (r.payload as { barcode: string }).barcode === "6262");
  check("label-print: distinct ids per job", shampoo?.sync_id !== soap?.sync_id);
  check("label-print: plain product keeps variantLabel empty", (soap?.payload as { variantLabel?: string }).variantLabel === undefined);
}

async function main(): Promise<void> {
  console.log("\n[A] Negotiation Shield");
  testShield();
  testMarginRetail();
  testSku();
  testTotals();

  console.log("\n[B] Cash Drawer Integration");
  testDrawerDeduction();
  testValidation();
  testSyncRecordBuilder();

  console.log("\n[C] End-to-end store flow");
  await testStoreFlow();
  await testCashWithoutShift();
  await testQuickAdd();

  console.log("\n[D] Phase 3.5 — Smart Payment Engine + Units + Margin Floor");
  testAutoInvoiceNumber();
  testDueDate();
  testPaymentTotals();
  testUnitHelpers();
  testMarginFloor();
  await testStorePhase35();

  console.log("\n[E] Phase 3.5 QA — Offline Catalog Lookup + Inline Supplier");
  testSupplierCreateBuilder();
  await testOfflineCatalogFallback();
  await testInlineAddSupplier();

  await testLabelPrintQueue();

  console.log(`\nReceiving workflows: ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.error("Failures:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
}

void main();
