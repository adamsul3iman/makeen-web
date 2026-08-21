/**
 * Enterprise stress, concurrency and precision audit suite (runs via tsx).
 *
 * Simulates the whole platform under fire before production:
 *   1. Multi-role interleaved shift (Cashier / Manager / Accountant) with a
 *      fully-asserted Z-report.
 *   2. Rapid-fire cart stress — a 2000-operation deterministic walk with a
 *      recompute-from-scratch invariant checked after EVERY op (no drift).
 *   3. Concurrent checkout racing (the `isCompleting` guard must let exactly
 *      one payment through).
 *   4. Sync-queue drain stress — 120 events through the real
 *      `processSyncQueue` with a mocked endpoint: batch cap, idempotency and
 *      the module-level lock (no overlapping HTTP POSTs).
 *   5. Network drop / reconnect cycles — offline sales persist PENDING and
 *      drain losslessly once connectivity returns.
 *   6. Money precision audit — roundMoney half-up vectors, cent-integrity
 *      sweeps, VAT-inclusive/exclusive fiscal splits and exact cart→payload→
 *      ledger parity (no floating-point drift).
 *   7. Category-switch performance + the `anyPosModalOpen` guard matrix.
 */
import "fake-indexeddb/auto";

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

// The store + idb + services modules must load AFTER the polyfills above.
const { usePosStore, anyPosModalOpen } = await import("../store/usePosStore");
const { clearSyncQueue, enqueueSync, getSyncsByStatus } = await import("../lib/idb");
const { setTenantStoreId } = await import("../lib/tenantClient");
const { processSyncQueue } = await import("../services/syncService");
const { computeSaleTotals, computeFiscalBreakdown, roundMoney } = await import("../lib/saleMath");
const { effectiveTaxPercent } = await import("../lib/qr");
const { sha256Hex } = await import("../lib/sha256");
const { SCAN_COALESCE_MS, shouldCoalesceScan } = await import("../lib/scanCoalesce");

import type { SyncQueueRecord } from "../lib/idb";

import type {
  BarcodeIndex,
  BarcodeMap,
  CategoryMap,
  PosSnapshot,
  ProductMap,
  QuickKeyItem,
  SaleItem,
  ShiftTransaction,
} from "../types/pos.types";

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
  c2: { id: "c2", name: "أغذية", parentId: null, bgColor: "#b45309", isQuickKey: false, sortOrder: 2 },
};

const products: ProductMap = {
  p1: { id: "p1", categoryId: "c1", name: "كولا", baseUnit: "عبوة", isWeighed: false, price: 10, costPrice: 6 },
  p2: { id: "p2", categoryId: "c1", name: "ماء", baseUnit: "عبوة", isWeighed: false, price: 5, costPrice: 3 },
  p3: { id: "p3", categoryId: "c2", name: "شيبس", baseUnit: "كيس", isWeighed: false, price: 20, costPrice: 12 },
  p4: { id: "p4", categoryId: "c2", name: "منتج شامل الضريبة", baseUnit: "حبة", isWeighed: false, price: 10, costPrice: 5, taxPercent: 16, taxIncluded: true },
};

const barcodes: BarcodeMap = {
  "11111": { barcode: "11111", productId: "p1", variantId: "v-11111", variantLabel: "", unitName: "عبوة", qtyMultiplier: 1, price: 10, costPrice: 6 },
  "22222": { barcode: "22222", productId: "p2", variantId: "v-22222", variantLabel: "", unitName: "عبوة", qtyMultiplier: 1, price: 5, costPrice: 3 },
  "33333": { barcode: "33333", productId: "p3", variantId: "v-33333", variantLabel: "", unitName: "كيس", qtyMultiplier: 1, price: 20, costPrice: 12 },
  "44444": { barcode: "44444", productId: "p4", variantId: "v-44444", variantLabel: "", unitName: "كرتونة", qtyMultiplier: 12, price: 10, costPrice: 5, isDefaultSale: true },
};

const barcodeIndex: BarcodeIndex = {
  "11111": { product_id: "p1", variantId: "v-11111", name: "كولا", price: 10, variantLabel: "" },
  "22222": { product_id: "p2", variantId: "v-22222", name: "ماء", price: 5, variantLabel: "" },
  "33333": { product_id: "p3", variantId: "v-33333", name: "شيبس", price: 20, variantLabel: "" },
  "44444": { product_id: "p4", variantId: "v-44444", name: "منتج شامل الضريبة", price: 10, variantLabel: "" },
};

const quickKeys: QuickKeyItem[] = [
  { id: "qk1", categoryId: "c1", label: "كولا", bgColor: "#0f766e", sortOrder: 1, productId: "p1", unitName: "عبوة", price: 10, barcode: "11111" },
];

const TEST_PIN_SALT = "pos-test-salt-v1";
const pinHash = (pin: string): string => sha256Hex(pin + TEST_PIN_SALT);

const snapshot: PosSnapshot = {
  schemaVersion: 1,
  updatedAt: new Date().toISOString(),
  categories,
  products,
  barcodes,
  barcodeIndex,
  quickKeys,
  cashiers: [
    { id: "cashier-1", name: "كاشير", pinHash: pinHash("1111"), role: "cashier" },
    { id: "admin-1", name: "مدير", pinHash: "", role: "admin" },
  ],
  pinSalt: TEST_PIN_SALT,
};

const emptyTotals = { subtotal: 0, tax: 0, discount: 0, deliveryFee: 0, total: 0, itemCount: 0 };
const emptyShiftTotals = {
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

async function resetStore(): Promise<void> {
  await clearSyncQueue();
  usePosStore.setState({
    ready: false,
    categories: {},
    products: {},
    barcodes: {},
    barcodeIndex: {},
    quickKeys: [],
    activeCategoryId: null,
    items: [],
    totals: { ...emptyTotals },
    notice: null,
    heldInvoices: [],
    isCheckoutModalOpen: false,
    isHoldModalOpen: false,
    checkoutSession: 0,
    isOnline: true,
    pendingSyncCount: 0,
    shiftState: { status: "CLOSED", shiftId: null, startTime: null, startingCash: 0, branchId: null, terminalId: null },
    shiftTotals: { ...emptyShiftTotals },
    shiftTransactions: [],
    isCloseShiftModalOpen: false,
    isDebtSettlementModalOpen: false,
    isExpenseModalOpen: false,
    isSmartSearchOpen: false,
    isAdminHubOpen: false,
    isReturnMode: false,
    invoiceDiscount: null,
    returnReference: null,
    isCompleting: false,
    modalSession: 0,
    lastCompletedInvoice: null,
    currentCashier: null,
    currentStore: null,
    adminSession: null,
    pinFailCount: 0,
    pinLockedUntil: 0,
    pinLockoutLevel: 0,
    isSecondaryAuthOpen: false,
    pendingSecondaryAction: null,
    isPreviousInvoicesModalOpen: false,
    lineEditTarget: null,
    isAuditLogOpen: false,
  });
}

const st = (): ReturnType<typeof usePosStore.getState> => usePosStore.getState();

async function group(name: string, fn: () => Promise<void>): Promise<void> {
  console.log(`\n[${name}]`);
  await resetStore();
  st().loadSnapshot(snapshot);
  try {
    await fn();
  } catch (err) {
    fail += 1;
    failures.push(`${name}: threw ${String(err)}`);
    console.error(`  ✗ ${name}: threw ${String(err)}`);
  }
}

/** Deterministic PRNG so the stress walk is reproducible run-to-run. */
function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function totalsEqual(
  a: { subtotal: number; tax: number; discount: number; total: number; itemCount: number },
  b: { subtotal: number; tax: number; discount: number; total: number; itemCount: number },
): boolean {
  return (
    a.subtotal === b.subtotal &&
    a.tax === b.tax &&
    a.discount === b.discount &&
    a.total === b.total &&
    a.itemCount === b.itemCount
  );
}

/** Sum per-barcode net stock movement across all queued INVOICE_CREATED events. */
async function stockLedgerByBarcode(): Promise<Map<string, number>> {
  const ledger = new Map<string, number>();
  const pending = await getSyncsByStatus("PENDING");
  for (const r of pending) {
    if (r.action_type !== "INVOICE_CREATED") continue;
    const items = (r.payload as { items?: Array<{ barcode?: string; qty?: number }> }).items ?? [];
    for (const it of items) {
      const code = it.barcode ?? "";
      if (!code) continue;
      ledger.set(code, (ledger.get(code) ?? 0) + (it.qty ?? 0));
    }
  }
  return ledger;
}

// ---------------------------------------------------------------------------
// 1. Multi-role interleaved shift
// ---------------------------------------------------------------------------
async function multiRoleShift(): Promise<void> {
  const store = usePosStore;
  const ADMIN_SESSION = { storeId: "store-main", email: "admin@demo.test", name: "مدير" };

  store.getState().loginCashier("1111");
  await store.getState().openShift(100);

  // ---- Cashier: rapid ring-up ----
  store.getState().scanBarcode("11111");
  store.getState().scanBarcode("11111");
  store.getState().scanBarcode("11111");
  store.getState().scanBarcode("22222");
  store.getState().scanBarcode("33333");
  let s = st();
  check("role: cashier cart 55 + 8.8 tax = 63.8", s.totals.subtotal === 55 && s.totals.tax === 8.8 && s.totals.total === 63.8 && s.totals.itemCount === 5);

  store.getState().updateQty(0, 4);
  s = st();
  check("role: adjust qty kola 4 -> 65 / 75.4", s.totals.subtotal === 65 && s.totals.total === 75.4);

  store.getState().removeItem(1);
  s = st();
  check("role: remove mada -> 60 / 69.6", s.totals.subtotal === 60 && s.totals.total === 69.6 && s.totals.itemCount === 5);

  // ---- Manager: price override + big-discount bypass ----
  usePosStore.setState({ adminSession: ADMIN_SESSION });
  store.getState().adminSetLinePrice(0, 12);
  s = st();
  check("role: manager price override kola 12 -> 68 / 78.88", s.items[0].unitPrice === 12 && s.totals.subtotal === 68 && s.totals.total === 78.88);

  store.getState().applyDiscount({ scope: "TOTAL", type: "PERCENT", value: 25 });
  s = st();
  check("role: manager 25% inline -> disc 17 / tax 8.16 / 59.16", s.totals.discount === 17 && s.totals.tax === 8.16 && s.totals.total === 59.16);

  await store.getState().completeCheckout("CASH", 70);
  s = st();
  const cashSyncId = s.lastCompletedInvoice?.syncId ?? "";
  check("role: cash sale change 10.84 + drawer 159.16", s.lastCompletedInvoice?.change === 10.84 && s.shiftTotals.expectedCashInDrawer === 159.16 && s.shiftTotals.cashSales === 59.16);

  // ---- Accountant: expense + debt settlement ----
  await store.getState().recordExpense("transport", 12.5);
  s = st();
  check("role: expense 12.5 -> drawer 146.66", s.shiftTotals.expenses === 12.5 && s.shiftTotals.expectedCashInDrawer === 146.66);
  await store.getState().processDebtSettlement("خالد", 40, "customer-khaled");
  s = st();
  check("role: settlement 40 -> drawer 186.66", s.shiftTotals.debtCollections === 40 && s.shiftTotals.expectedCashInDrawer === 186.66);

  // ---- Cashier: visa sale ----
  store.getState().scanBarcode("22222");
  await store.getState().completeCheckout("VISA", 0);
  s = st();
  check("role: visa 5.8 untouched drawer", s.shiftTotals.visaSales === 5.8 && s.shiftTotals.expectedCashInDrawer === 186.66 && s.shiftTotals.totalSales === 64.96);

  // ---- Manager-authorized return of the cash invoice ----
  store.getState().requestReturnModeToggle();
  const began = await store.getState().beginReturnByInvoice(cashSyncId);
  s = st();
  check("role: return restores negated items", began === true && s.totals.total === -59.16 && s.items[0].qty === -4);
  await store.getState().completeCheckout("CASH", 0);
  s = st();
  check("role: return reverses drawer to 127.5", s.shiftTotals.cashSales === 0 && s.shiftTotals.returns === 59.16 && s.shiftTotals.totalSales === 5.8 && s.shiftTotals.expectedCashInDrawer === 127.5);

  // Drawer invariant: expectedCashInDrawer == starting + Σ cash portions
  // - expenses + debt collections (settlements credit the drawer, expenses
  // debit it; neither appears as a shift transaction).
  const portions = s.shiftTransactions.reduce((sum, tx) => sum + tx.cashPortion, 0);
  check("role: drawer == starting + cash portions - expenses + collections", s.shiftTotals.expectedCashInDrawer === 100 + portions - s.shiftTotals.expenses + s.shiftTotals.debtCollections);

  // ---- Close shift, Z-report, stock reconciliation ----
  await store.getState().closeShift(127.5);
  s = st();
  check("role: closed with zero variance", s.shiftState.status === "CLOSED" && s.shiftTotals.totalSales === 0);

  const pending = await getSyncsByStatus("PENDING");
  const closed = pending.find((r) => r.action_type === "SHIFT_CLOSED");
  if (closed) {
    const p = closed.payload as unknown as Record<string, number>;
    check(
      "role: Z-report totals exact",
      p.startingCash === 100 &&
        p.cashSales === 0 &&
        p.visaSales === 5.8 &&
        p.debtSales === 0 &&
        p.debtCollections === 40 &&
        p.totalSales === 5.8 &&
        p.discounts === 17 &&
        p.returns === 59.16 &&
        p.expenses === 12.5 &&
        p.expectedCashInDrawer === 127.5 &&
        p.actualCash === 127.5 &&
        p.variance === 0,
    );
  } else {
    check("role: SHIFT_CLOSED queued", false);
  }

  // Inventory reconciliation from the wire ledger: net kola/chips 0, mada +1.
  const ledger = await stockLedgerByBarcode();
  check("role: stock net kola 0", (ledger.get("11111") ?? 0) === 0);
  check("role: stock net chips 0", (ledger.get("33333") ?? 0) === 0);
  check("role: stock net mada +1", (ledger.get("22222") ?? 0) === 1);
  await clearSyncQueue();
  usePosStore.setState({ adminSession: null });
}

// ---------------------------------------------------------------------------
// 2. Rapid-fire cart stress (2000-op deterministic walk, no drift)
// ---------------------------------------------------------------------------
async function rapidCartStress(): Promise<void> {
  const store = usePosStore;
  store.getState().loginCashier("1111");
  await store.getState().openShift(100);

  const rand = mulberry32(1337);
  const codes = ["11111", "22222", "33333", "44444"];
  const t0 = performance.now();

  for (let i = 0; i < 2000; i++) {
    const r = rand();
    if (r < 0.55) {
      store.getState().scanBarcode(codes[Math.floor(rand() * codes.length)]);
    } else if (r < 0.75) {
      const n = st().items.length;
      if (n > 0) store.getState().updateQty(Math.floor(rand() * n), 1 + Math.floor(rand() * 8));
    } else if (r < 0.85) {
      const n = st().items.length;
      if (n > 0) store.getState().removeItem(Math.floor(rand() * n));
    } else if (r < 0.95) {
      if (st().items.length > 0) {
        store.getState().applyDiscount({ scope: "TOTAL", type: "PERCENT", value: 1 + Math.floor(rand() * 9) });
      }
    } else {
      store.getState().clearDiscount();
    }

    // Invariant after EVERY op: stored totals == recompute-from-scratch.
    const ref = computeSaleTotals(st().items, st().invoiceDiscount, effectiveTaxPercent(st().currentStore));
    if (!totalsEqual(st().totals, ref)) {
      check(`stress: no drift at op ${i}`, false);
      return;
    }
  }

  const dt = performance.now() - t0;
  check("stress: 2000-op walk never diverges", true);
  check("stress: 2000 cart ops under 8s", dt < 8000);
  console.log(`  perf: 2000 cart ops in ${dt.toFixed(1)}ms`);

  // State must be internally consistent after the storm.
  const s = st();
  const ref = computeSaleTotals(s.items, s.invoiceDiscount, 16);
  check("stress: final state consistent", totalsEqual(s.totals, ref) && s.ready === true);

  // No two lines may ever represent the same item identity (duplicate rows).
  const identities = new Set<string>();
  let dupLine = false;
  for (const it of s.items) {
    const id = it.barcode || `p:${it.productId}`;
    if (identities.has(id)) {
      dupLine = true;
      break;
    }
    identities.add(id);
  }
  check("stress: no duplicate cart lines after storm", !dupLine);
  await clearSyncQueue();
}

// ---------------------------------------------------------------------------
// 2b. Cross-path duplicate prevention: quick key (no barcode) then scan of
//     the same product's code must merge into one line, never two.
// ---------------------------------------------------------------------------
async function crossPathMerge(): Promise<void> {
  const store = usePosStore;
  store.getState().loginCashier("1111");
  await store.getState().openShift(100);

  // Tap a quick key that carries NO barcode (p2 "ماء", unit عبوة, price 5).
  store
    .getState()
    .addQuickKeyItem({
      id: "qk-tap",
      categoryId: "c1",
      label: "ماء",
      bgColor: "#0f766e",
      sortOrder: 2,
      productId: "p2",
      unitName: "عبوة",
      price: 5,
    });
  let s = st();
  check(
    "dup: barcode-less quick key adds one line",
    s.items.length === 1 && s.items[0].barcode === "" && s.items[0].qty === 1,
  );

  // Scan that same product's code (22222 = p2, unit عبوة, price 5): the
  // lines have identical unit + price, so they MUST merge into one row.
  store.getState().scanBarcode("22222");
  s = st();
  check(
    "dup: scan after tap merges into one line (qty 2, code adopted)",
    s.items.length === 1 &&
      s.items[0].qty === 2 &&
      s.items[0].barcode === "22222" &&
      s.items[0].unitName === "عبوة" &&
      s.items[0].unitPrice === 5,
  );
  check(
    "dup: totals consistent after cross-path merge",
    totalsEqual(s.totals, computeSaleTotals(s.items, null, effectiveTaxPercent(s.currentStore))),
  );

  // A third identical scan keeps merging (never splits into a new row).
  store.getState().scanBarcode("22222");
  s = st();
  check(
    "dup: third identical scan still merges (qty 3, one line)",
    s.items.length === 1 && s.items[0].qty === 3,
  );

  // A DIFFERENT product with a different unit/price must open its own line.
  store
    .getState()
    .addQuickKeyItem({
      id: "qk-tap2",
      categoryId: "c2",
      label: "شيبس",
      bgColor: "#b45309",
      sortOrder: 3,
      productId: "p3",
      unitName: "كيس",
      price: 20,
    });
  store.getState().scanBarcode("33333");
  s = st();
  check(
    "dup: matching-unit scan of a second product merges (2 lines total)",
    s.items.length === 2 &&
      s.items.some((it) => it.barcode === "22222" && it.qty === 3) &&
      s.items.some((it) => it.barcode === "33333" && it.qty === 2),
  );

  // Different-unit barcode (44444 is a 12-pack of p4, unit كرتونة) must stay
  // a separate line even when the same product was tapped first without a
  // code (the tapped line is unit حبة — different sale unit).
  store
    .getState()
    .addQuickKeyItem({
      id: "qk-tap3",
      categoryId: "c2",
      label: "منتج شامل الضريبة",
      bgColor: "#b45309",
      sortOrder: 4,
      productId: "p4",
      unitName: "حبة",
      price: 10,
    });
  store.getState().scanBarcode("44444");
  s = st();
  check(
    "dup: different-unit barcode opens its own line (4 lines total)",
    s.items.length === 4 &&
      s.items.filter((it) => it.barcode === "").length === 1 &&
      s.items.filter((it) => it.barcode === "44444").length === 1 &&
      s.items.some((it) => it.barcode === "" && it.productId === "p4" && it.unitName === "حبة" && it.qty === 1) &&
      s.items.some((it) => it.barcode === "44444" && it.unitName === "كرتونة" && it.qty === 1),
  );

  // Reverse order: scan first, then tap a barcode-less quick key for the same
  // product+unit+price — must merge into the scanned row, never duplicate it.
  store.getState().scanBarcode("22222");
  store
    .getState()
    .addQuickKeyItem({
      id: "qk-tap4",
      categoryId: "c1",
      label: "ماء",
      bgColor: "#0f766e",
      sortOrder: 5,
      productId: "p2",
      unitName: "عبوة",
      price: 5,
    });
  s = st();
  check(
    "dup: barcode-less tap after scan merges into the scanned row (qty 5)",
    s.items.filter((it) => it.barcode === "22222").length === 1 &&
      s.items.some((it) => it.barcode === "22222" && it.qty === 5) &&
      s.items.filter((it) => it.productId === "p2").length === 1,
  );
  await clearSyncQueue();
}

// ---------------------------------------------------------------------------
// 2c. Hardware double-read coalescing unit checks.
// ---------------------------------------------------------------------------
async function scanCoalesceUnit(): Promise<void> {
  const now = 1_000_000;
  check(
    "coalesce: same code inside window coalesces",
    shouldCoalesceScan("11111", now - 40, "11111", now) === true,
  );
  check(
    "coalesce: different code never coalesces",
    shouldCoalesceScan("11111", now - 40, "22222", now) === false,
  );
  check(
    "coalesce: same code at the window edge does not coalesce",
    shouldCoalesceScan("11111", now - SCAN_COALESCE_MS, "11111", now) === false,
  );
  check(
    "coalesce: first scan (no history) never coalesces",
    shouldCoalesceScan(null, 0, "11111", now) === false,
  );
  check(
    "coalesce: distinct scans beyond the window both commit",
    shouldCoalesceScan("11111", now - SCAN_COALESCE_MS - 1, "11111", now) === false,
  );
}

// ---------------------------------------------------------------------------
// 3. Concurrent checkout racing (isCompleting guard)
// ---------------------------------------------------------------------------
async function concurrentCheckout(): Promise<void> {
  const store = usePosStore;
  store.getState().loginCashier("1111");
  await store.getState().openShift(100);
  store.getState().scanBarcode("11111");
  store.getState().scanBarcode("11111");
  store.getState().scanBarcode("22222");

  const txBefore = st().shiftTransactions.length;
  const queueBefore = (await getSyncsByStatus("PENDING")).length;

  await Promise.all(Array.from({ length: 8 }, () => store.getState().completeCheckout("CASH", 100)));

  const s = st();
  const queueAfter = (await getSyncsByStatus("PENDING")).length;
  check("race: exactly one of 8 checkouts wins", s.shiftTransactions.length - txBefore === 1 && queueAfter - queueBefore === 1 && s.items.length === 0);
  check("race: winner drawer +29", s.shiftTotals.expectedCashInDrawer === 129 && s.shiftTotals.cashSales === 29);
  check("race: isCompleting released", s.isCompleting === false);

  // Subsequent checkout on the new empty cart must be refused (not stuck).
  await store.getState().completeCheckout("CASH", 10);
  check("race: no stale guard blocks later flow", st().notice?.tone === "error");
  await clearSyncQueue();
}

// ---------------------------------------------------------------------------
// 4. Sync-queue drain stress (batch cap, idempotency, no overlapping POSTs)
// ---------------------------------------------------------------------------
async function syncDrainStress(): Promise<void> {
  setTenantStoreId("store-main");
  const realFetch = globalThis.fetch;
  let fetchCalls = 0;
  let inFlight = 0;
  let maxOverlap = 0;
  const batches: number[] = [];

  try {
    const seed = (n: number) =>
      Array.from({ length: n }, async (_, i) => {
        const id = `stress-${Math.random().toString(36).slice(2)}-${i}`;
        await enqueueSync({
          sync_id: id,
          action_type: "INVOICE_CREATED",
          payload: {
            items: [],
            subtotal: 0,
            tax: 0,
            discount: 0,
            deliveryFee: 0,
            total: i,
            amountPaid: i,
            change: 0,
            paymentMethod: "CASH",
            completed_at: new Date().toISOString(),
          },
          status: "PENDING",
          created_at: new Date().toISOString(),
        });
      });
    await Promise.all(await seed(120));

    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      fetchCalls += 1;
      inFlight += 1;
      maxOverlap = Math.max(maxOverlap, inFlight);
      const body = JSON.parse(String((init as RequestInit)?.body ?? "[]")) as SyncQueueRecord[];
      batches.push(body.length);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
      return new Response(JSON.stringify({ success: true, synced_ids: body.map((r) => r.sync_id) }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    // Serial drain loop.
    let drained = 0;
    let guard = 0;
    while ((await getSyncsByStatus("PENDING")).length > 0 && guard < 10) {
      const r = await processSyncQueue();
      drained += r.syncedCount;
      guard += 1;
    }
    check("drain: 120 events all synced", drained === 120 && (await getSyncsByStatus("PENDING")).length === 0);
    check("drain: every batch within 50 cap", batches.every((b) => b <= 50));
    check("drain: exactly 3 posts (50/50/20)", fetchCalls === 3 && batches.join(",") === "50,50,20");

    // Idempotency: nothing PENDING left -> drain posts nothing.
    fetchCalls = 0;
    batches.length = 0;
    await processSyncQueue();
    check("drain: idempotent (no duplicate post)", fetchCalls === 0);

    // 80 more events + 8 concurrent drains: lock must serialize POSTs.
    await Promise.all(await seed(80));
    fetchCalls = 0;
    batches.length = 0;
    maxOverlap = 0;
    await Promise.all(Array.from({ length: 8 }, () => processSyncQueue()));
    check("race: sync lock serializes (no overlap)", maxOverlap === 1);
    guard = 0;
    while ((await getSyncsByStatus("PENDING")).length > 0 && guard < 10) {
      await processSyncQueue();
      guard += 1;
    }
    check("race: 80-event remainder drained cleanly", (await getSyncsByStatus("PENDING")).length === 0);
    check("race: drained in exactly 2 serialized posts (50/30)", fetchCalls === 2 && batches.join(",") === "50,30");
  } finally {
    globalThis.fetch = realFetch;
    setTenantStoreId(null);
    await clearSyncQueue();
  }
}

// ---------------------------------------------------------------------------
// 5. Network drop / reconnect cycles
// ---------------------------------------------------------------------------
async function networkResilience(): Promise<void> {
  const store = usePosStore;
  const realFetch = globalThis.fetch;
  setTenantStoreId("store-main");
  try {
    store.getState().loginCashier("1111");
    await store.getState().openShift(100);
    store.getState().setOnline(false);

    // Offline sale: must still enqueue + persist locally.
    store.getState().scanBarcode("11111");
    await store.getState().completeCheckout("CASH", 11.6);
    let pending = await getSyncsByStatus("PENDING");
    check("net: offline sale persisted to queue", pending.some((r) => r.action_type === "INVOICE_CREATED"));

    // Drain attempt while offline (real fetch to a relative URL throws) —
    // the record must survive, never be dropped or marked SYNCED.
    await processSyncQueue();
    pending = await getSyncsByStatus("PENDING");
    check("net: failed offline drain keeps record PENDING", pending.some((r) => r.action_type === "INVOICE_CREATED"));

    // Reconnect: endpoint answers; the queued sale drains losslessly.
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String((init as RequestInit)?.body ?? "[]")) as SyncQueueRecord[];
      return new Response(JSON.stringify({ success: true, synced_ids: body.map((r) => r.sync_id) }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    store.getState().setOnline(true);
    await processSyncQueue();
    const synced = await getSyncsByStatus("SYNCED");
    check("net: reconnect drains offline sale", synced.some((r) => r.action_type === "INVOICE_CREATED"));
    check("net: queue drained empty", (await getSyncsByStatus("PENDING")).length === 0);
    check("net: isOnline restored", st().isOnline === true);
  } finally {
    globalThis.fetch = realFetch;
    setTenantStoreId(null);
    await clearSyncQueue();
  }
}

// ---------------------------------------------------------------------------
// 6. Money precision audit
// ---------------------------------------------------------------------------
async function precisionAudit(): Promise<void> {
  // Decimal half-up vectors — the exact cases naive float rounding gets wrong.
  const halfUp: Array<[number, number]> = [
    [1.005, 1.01],
    [2.675, 2.68],
    [0.005, 0.01],
    [10.005, 10.01],
    [100.005, 100.01],
    [5.55, 5.55],
    [0.1 + 0.2, 0.3],
    [1.004, 1.0],
    [0.999, 1.0],
    [0.994, 0.99],
    [49.999, 50.0],
  ];
  for (const [value, expected] of halfUp) {
    check(`cents: roundMoney(${value}) === ${expected}`, roundMoney(value) === expected);
  }

  // Cent-integrity sweep: after rounding, the result is always an exact
  // integer number of cents (no hidden sub-cent residue).
  const rand = mulberry32(99);
  let centClean = true;
  for (let i = 0; i < 10_000; i++) {
    const x = (rand() - 0.5) * 10_000;
    const r = roundMoney(x);
    if (Math.abs(Math.round(r * 100) - r * 100) > 1e-9) {
      centClean = false;
      break;
    }
  }
  check("cents: 10k sweep leaves no sub-cent residue", centClean);

  // Zero never serializes as "-0" to the wire/ledger; genuine negatives stay.
  check("cents: negative epsilon never yields -0 on the wire", JSON.stringify(roundMoney(-0.0001)) === "0" && JSON.stringify(roundMoney(-0.004)) === "0");
  check("cents: genuine negative values preserved", roundMoney(-0.5) === -0.5);

  // VAT-inclusive (p4: 10 gross incl 16% -> net 8.62 + tax 1.38).
  const store = usePosStore;
  store.getState().scanBarcode("44444");
  const s = st();
  check("tax: incl 10 -> net 8.62 + tax 1.38 = 10", s.totals.subtotal === 8.62 && s.totals.tax === 1.38 && s.totals.total === 10);
  const incl = computeFiscalBreakdown(s.items, 0, 16);
  check("tax: incl per-line net+tax===gross", incl.lines[0].net + incl.lines[0].tax === incl.lines[0].gross && incl.lines[0].gross === 10);

  // Cross-layer parity: for every queued invoice, the payload totals must
  // equal a from-scratch fiscal recompute of the exact queued items.
  store.getState().loginCashier("1111");
  await store.getState().openShift(100);
  store.getState().clearInvoice();
  store.getState().scanBarcode("11111");
  store.getState().applyDiscount({ scope: "ITEM", index: 0, type: "PERCENT", value: 10 });
  await store.getState().completeCheckout("CASH", 12);
  store.getState().scanBarcode("44444");
  await store.getState().completeCheckout("VISA", 0);

  const pending = await getSyncsByStatus("PENDING");
  let parity = true;
  for (const r of pending) {
    if (r.action_type !== "INVOICE_CREATED") continue;
    const p = r.payload as {
      items?: SaleItem[];
      subtotal: number;
      tax: number;
      discount: number;
      total: number;
      amountPaid: number;
      change: number;
    };
    const items = p.items ?? [];
    const derivedInvoiceDiscount = roundMoney(Math.max(0, p.discount - items.reduce((sum, it) => sum + Math.max(0, it.discount ?? 0), 0)));
    const fiscal = computeFiscalBreakdown(items, derivedInvoiceDiscount, 16);
    const expectedChange = roundMoney(Math.max(0, p.amountPaid - p.total));
    if (
      fiscal.subtotal !== p.subtotal ||
      fiscal.tax !== p.tax ||
      fiscal.total !== p.total ||
      p.change !== expectedChange
    ) {
      parity = false;
      break;
    }
  }
  check("parity: every queued invoice == fiscal recompute + change math", parity);
  const invoiceTotals = pending
    .filter((r) => r.action_type === "INVOICE_CREATED")
    .map((r) => (r.payload as { total?: number }).total);
  check("parity: queued invoice totals 10.44 + 10", invoiceTotals.includes(10.44) && invoiceTotals.includes(10));
  await clearSyncQueue();
}

// ---------------------------------------------------------------------------
// 7. Category-switch performance + modal guard matrix
// ---------------------------------------------------------------------------
async function categoryAndModalPerf(): Promise<void> {
  // Rapid category switching (the UI micro-animation path under load).
  const t0 = performance.now();
  for (let i = 0; i < 300; i++) {
    st().setActiveCategoryId(i % 3 === 0 ? null : i % 3 === 1 ? "c1" : "c2");
  }
  const dt = performance.now() - t0;
  check("perf: 300 category switches under 1s", dt < 1000);
  check("perf: final category consistent", st().activeCategoryId === "c2");
  console.log(`  perf: 300 category switches in ${dt.toFixed(1)}ms`);

  // Modal guard matrix: every modal flag must trip `anyPosModalOpen`.
  const store = usePosStore;
  store.getState().loginCashier("1111");
  store.getState().scanBarcode("11111");

  store.getState().openCheckout();
  check("guard: checkout open", anyPosModalOpen(st()) === true);
  store.getState().closeCheckout();

  store.getState().openHoldModal();
  check("guard: hold open", anyPosModalOpen(st()) === true);
  store.getState().closeHoldModal();

  store.getState().openCloseShiftModal();
  check("guard: close-shift open", anyPosModalOpen(st()) === true);
  store.getState().closeCloseShiftModal();

  store.getState().openDebtSettlementModal();
  check("guard: debt settlement open", anyPosModalOpen(st()) === true);
  store.getState().closeDebtSettlementModal();

  store.getState().openExpenseModal();
  check("guard: expense open", anyPosModalOpen(st()) === true);
  store.getState().closeExpenseModal();

  store.getState().openSmartSearch();
  check("guard: smart search open", anyPosModalOpen(st()) === true);
  store.getState().closeSmartSearch();

  store.getState().openAdminHub();
  check("guard: admin hub open", anyPosModalOpen(st()) === true);
  store.getState().closeAdminHub();

  store.getState().requestSecondaryAuth({ type: "open_drawer" });
  check("guard: secondary auth open", anyPosModalOpen(st()) === true);
  store.getState().cancelSecondaryAuth();

  store.getState().openPreviousInvoicesModal();
  check("guard: previous invoices open", anyPosModalOpen(st()) === true);
  store.getState().closePreviousInvoicesModal();

  store.getState().openAuditLogModal();
  check("guard: audit log open", anyPosModalOpen(st()) === true);
  store.getState().closeAuditLogModal();

  check("guard: all closed -> false", anyPosModalOpen(st()) === false);

  // All ten simultaneously (belt-and-braces).
  usePosStore.setState({
    isCheckoutModalOpen: true,
    isHoldModalOpen: true,
    isCloseShiftModalOpen: true,
    isDebtSettlementModalOpen: true,
    isExpenseModalOpen: true,
    isSmartSearchOpen: true,
    isAdminHubOpen: true,
    isSecondaryAuthOpen: true,
    isPreviousInvoicesModalOpen: true,
    isAuditLogOpen: true,
  });
  check("guard: all ten at once", anyPosModalOpen(st()) === true);
  await clearSyncQueue();
}

// ---------------------------------------------------------------------------
// 8. Persist freeze guard — the zustand persist path must never put a
//    synchronous full-snapshot JSON.stringify on the scan hot path.
// ---------------------------------------------------------------------------
async function persistAdapterContract(): Promise<void> {
  const { posPersistStorage, flushPersistWrites } = await import("../lib/persistStorage");
  storage.clear();
  flushPersistWrites();

  const snapshotValue = {
    state: {
      items: [
        { barcode: "11111", productId: "p1", name: "كولا", unitName: "عبوة", qty: 1, unitPrice: 10, discount: 0, lineTotal: 10 },
      ],
      shiftTransactions: Array.from({ length: 500 }, (_, i) => ({
        syncId: `tx-${i}`,
        shiftId: "shift-1",
        paymentMethod: "CASH",
        total: 15,
        cashPortion: 15,
        completed_at: new Date(Date.now() - i * 1000).toISOString(),
      })),
    },
    version: 1,
  };

  // The adapter must never serialize on `setItem` itself: N rapid writes are
  // coalesced into a single stringify + write at the end of the window.
  const beforeWrite = storage.get("pos-store");
  const t0 = performance.now();
  for (let i = 0; i < 300; i++) {
    posPersistStorage.setItem("pos-store", snapshotValue);
  }
  const dt = performance.now() - t0;
  check("freeze: 300 adapter setItem calls serialize nothing synchronously", dt < 50);
  check("freeze: no write hits localStorage before flush", storage.get("pos-store") === beforeWrite);
  flushPersistWrites();
  check(
    "freeze: flush coalesces the latest snapshot into a single write",
    storage.get("pos-store") === JSON.stringify(snapshotValue),
  );
  console.log(`  perf: 300 adapter setItem calls in ${dt.toFixed(2)}ms (serialization deferred)`);
}

async function heavyLedgerCartBurst(): Promise<void> {
  const { flushPersistWrites } = await import("../lib/persistStorage");
  flushPersistWrites();

  const store = usePosStore;
  store.getState().loginCashier("1111");
  await store.getState().openShift(100);

  // A long shift: a heavy ledger makes the partialized snapshot ~600KB. If
  // the persist pipeline serializes on every mutation (the pre-fix behavior),
  // 300 cart ops would stringify ~180MB synchronously and blow past the bound.
  const heavyLedger: ShiftTransaction[] = Array.from({ length: 4000 }, (_, i) => ({
    syncId: `shift-tx-${i}`,
    shiftId: "shift-heavy",
    paymentMethod: "CASH",
    total: 15,
    cashPortion: 15,
    completed_at: new Date(Date.now() - i * 1000).toISOString(),
  }));
  usePosStore.setState({ shiftTransactions: heavyLedger });

  const t0 = performance.now();
  for (let i = 0; i < 300; i++) {
    store.getState().scanBarcode("11111");
  }
  const dt = performance.now() - t0;
  check(
    "freeze: 300 cart ops under a 4000-tx ledger stay under 400ms",
    dt < 400,
  );
  console.log(`  perf: 300 cart ops with 4000-tx ledger in ${dt.toFixed(1)}ms`);

  // The burst must still produce a correct, coherent cart.
  const s = st();
  check(
    "freeze: cart coherent after heavy-ledger burst",
    s.items.length === 1 &&
      s.items[0].qty === 300 &&
      totalsEqual(s.totals, computeSaleTotals(s.items, null, effectiveTaxPercent(s.currentStore))),
  );

  flushPersistWrites();
  await clearSyncQueue();
}

async function main(): Promise<void> {
  await group("multi-role shift (cashier/manager/accountant)", multiRoleShift);
  await group("rapid cart stress (2000 ops)", rapidCartStress);
  await group("cross-path duplicate prevention", crossPathMerge);
  await group("scanner double-read coalescing", scanCoalesceUnit);
  await group("concurrent checkout race", concurrentCheckout);
  await group("sync drain stress", syncDrainStress);
  await group("network resilience", networkResilience);
  await group("money precision audit", precisionAudit);
  await group("category + modal guard perf", categoryAndModalPerf);
  await group("persist freeze guard (adapter contract)", persistAdapterContract);
  await group("persist freeze guard (heavy-ledger cart burst)", heavyLedgerCartBurst);

  console.log(`\nStress suite: ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.error("Failures:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
}

void main();
