/**
 * Pre-mortem regression suite — the Top-3 critical risks.
 *
 * 1. Closing a shift while INVOICE_CREATED / DEBT_SETTLEMENT events are still
 *    PENDING freezes a Z-report recomputed from a partial ledger.
 * 2. A SPLIT return (60 cash / 40 visa) is reversed 100% to cash because the
 *    SPLIT derivation sets `cashAmount = total` for negative invoices.
 * 3. product_barcodes.barcode is globally unique, blocking shared GTINs and
 *    letting store-unscoped upserts clobber another store's barcode row.
 *
 * Runs under tsx with fake-indexeddb (no server, no live DB).
 */

import "fake-indexeddb/auto";

// Dummy credentials so route handlers construct a dead client; the pure store
// tests never touch the network.
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

// The store + idb modules must load AFTER the polyfills above (ESM static
// imports hoist, so these are dynamic).
const { usePosStore } = await import("../../store/usePosStore");
const { clearSyncQueue, getSyncsByStatus, isInvoiceReturned } = await import("../../lib/idb");
const { sha256Hex } = await import("../../lib/sha256");
const { evaluateShiftCloseGuard } = await import("../../lib/shiftGuard");
const { splitPaymentPortions, derivePaymentBuckets } = await import("../../lib/paymentBuckets");
const { barcodeConflictInStore } = await import("../../lib/catalogProducts");

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { InvoiceCreatedPayload, SyncQueueRecord } from "../../lib/idb";
import type {
  BarcodeIndex,
  BarcodeMap,
  Cashier,
  PosSnapshot,
  ProductMap,
  QuickKeyItem,
} from "../../types/pos.types";

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

const categories: PosSnapshot["categories"] = {
  c1: { id: "c1", name: "مشروبات", parentId: null, bgColor: "#0f766e", isQuickKey: true, sortOrder: 1 },
};

const products: ProductMap = {
  p1: { id: "p1", categoryId: "c1", name: "كولا", baseUnit: "عبوة", isWeighed: false, price: 10, costPrice: 6 },
  p9: { id: "p9", categoryId: "c1", name: "سلعة 100", baseUnit: "حبة", isWeighed: false, price: 100, costPrice: 60 },
};

const barcodes: BarcodeMap = {
  "11111": { barcode: "11111", productId: "p1", variantId: "v-11111", variantLabel: "", unitName: "عبوة", qtyMultiplier: 1, price: 10, costPrice: 6 },
  "99999": { barcode: "99999", productId: "p9", variantId: "v-99999", variantLabel: "", unitName: "حبة", qtyMultiplier: 1, price: 100, costPrice: 60 },
};

const barcodeIndex: BarcodeIndex = {
  "11111": { product_id: "p1", variantId: "v-11111", name: "كولا", price: 10, variantLabel: "" },
  "99999": { product_id: "p9", variantId: "v-99999", name: "سلعة 100", price: 100, variantLabel: "" },
};

const quickKeys: QuickKeyItem[] = [
  { id: "qk1", categoryId: "c1", label: "كولا", bgColor: "#0f766e", sortOrder: 1, productId: "p1", unitName: "عبوة", price: 10, barcode: "11111" },
];

const TEST_PIN_SALT = "pos-test-salt-v1";
const pinHash = (pin: string): string => sha256Hex(pin + TEST_PIN_SALT);

const cashiers: Cashier[] = [
  { id: "cashier-1", name: "كاشير", pinHash: pinHash("1111"), role: "cashier" },
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
    items: [],
    totals: { ...emptyTotals },
    notice: null,
    heldInvoices: [],
    isCheckoutModalOpen: false,
    isHoldModalOpen: false,
    checkoutSession: 0,
    pendingSyncCount: 0,
    shiftState: { status: "CLOSED", shiftId: null, startTime: null, startingCash: 0, branchId: null, terminalId: null },
    shiftTotals: { ...emptyShiftTotals },
    shiftTransactions: [],
    isCloseShiftModalOpen: false,
    isDebtSettlementModalOpen: false,
    isExpenseModalOpen: false,
    isReturnMode: false,
    invoiceDiscount: null,
    returnReference: null,
    isCompleting: false,
    modalSession: 0,
    lastCompletedInvoice: null,
    currentCashier: null,
    currentStore: null,
    runtimeStoreId: null,
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

async function findPending(actionType: string, predicate: (p: Record<string, unknown>) => boolean = () => true): Promise<SyncQueueRecord | undefined> {
  const pending = await getSyncsByStatus("PENDING");
  return pending.find(
    (r) => r.action_type === actionType && predicate(r.payload as unknown as Record<string, unknown>),
  );
}

// ---------------------------------------------------------------------------
// Risk 1 — shift close while events are still PENDING
// ---------------------------------------------------------------------------

async function shiftCloseGuard(): Promise<void> {
  const g = (overrides: Partial<Parameters<typeof evaluateShiftCloseGuard>[0]> = {}) =>
    evaluateShiftCloseGuard({
      pendingSyncCount: 0,
      isOnline: true,
      actualCashValid: true,
      isCompleting: false,
      ...overrides,
    });

  check("shift-guard: online + pending events blocks close", g({ pendingSyncCount: 3 }).canClose === false);
  check(
    "shift-guard: online + pending reports pending_sync",
    g({ pendingSyncCount: 1 }).blockingReason === "pending_sync",
  );
  check("shift-guard: online + empty queue allows close", g({ pendingSyncCount: 0 }).canClose === true);
  check(
    "shift-guard: offline + pending allows local-first close",
    g({ pendingSyncCount: 5, isOnline: false }).canClose === true,
  );
  check("shift-guard: invalid blind count blocks", g({ actualCashValid: false }).canClose === false);
  check("shift-guard: completing blocks", g({ isCompleting: true }).canClose === false);

  // The modal guard reads pendingSyncCount from the store; a completed sale
  // must surface immediately so the Z-close button cannot be pressed while
  // the invoice is still unsynced (SHIFT_OPENED + INVOICE_CREATED are both
  // still PENDING at this point).
  const store = usePosStore;
  store.getState().loginCashier("1111");
  await store.getState().openShift(100);
  store.getState().scanBarcode("11111");
  await store.getState().completeCheckout("CASH", 20);
  check(
    "shift-guard: sale leaves pending events visible to modal",
    st().pendingSyncCount >= 1 && st().pendingSyncCount === (await getSyncsByStatus("PENDING")).length,
  );

  // Contract: the close modal must actually consume the guard (a guard that
  // exists but is never wired protects nothing).
  const modalSrc = readFileSync(join(process.cwd(), "components/pos/EndShiftModal.tsx"), "utf8");
  check(
    "shift-guard: modal consumes evaluateShiftCloseGuard",
    modalSrc.includes("evaluateShiftCloseGuard") && modalSrc.includes("pendingSyncCount"),
  );

  // Contract: the server must defer finalize while the shift ledger is
  // incomplete instead of freezing a partial Z-report.
  const routeSrc = readFileSync(join(process.cwd(), "_legacy_api/sync/route.ts"), "utf8");
  check(
    "shift-guard: server defers finalize on incomplete ledger",
    routeSrc.includes("shift_ledger_incomplete") && routeSrc.includes("assessShiftLedgerCompleteness"),
  );
}

// ---------------------------------------------------------------------------
// Risk 2 — SPLIT return reversed 100% to cash
// ---------------------------------------------------------------------------

async function splitReturn(): Promise<void> {
  // Pure derivation: a -100 return of a 60/40 sale must reverse -60/-40.
  const pure = splitPaymentPortions(-100, -60);
  check("split-return: pure -60/-40 reversal", pure.cash === -60 && pure.visa === -40);
  check(
    "split-return: pure positive split unchanged",
    (() => {
      const q = splitPaymentPortions(100, 60);
      return q.cash === 60 && q.visa === 40;
    })(),
  );
  check(
    "split-return: pure reversal honors positive cashback",
    (() => {
      const q = splitPaymentPortions(-100, 60);
      return q.cash === -60 && q.visa === -40;
    })(),
  );
  check(
    "split-return: pure overpaid positive all cash",
    (() => {
      const q = splitPaymentPortions(5.8, 30);
      return q.cash === 5.8 && q.visa === 0;
    })(),
  );
  check(
    "split-return: pure 3 / 2.8 split",
    (() => {
      const q = splitPaymentPortions(5.8, 3);
      return q.cash === 3 && q.visa === 2.8;
    })(),
  );
  const buckets = derivePaymentBuckets("SPLIT", -100, -60);
  check(
    "split-return: derivePaymentBuckets SPLIT reversal",
    buckets.cash === -60 && buckets.visa === -40 && buckets.cliq === 0 && buckets.debt === 0,
  );
  const cashReversal = derivePaymentBuckets("CASH", -34.8, 0);
  check(
    "split-return: derivePaymentBuckets cash full reversal",
    cashReversal.cash === -34.8 && cashReversal.visa === 0,
  );

  const store = usePosStore;
  const ADMIN_SESSION = { storeId: "store-main", email: "admin@demo.test", name: "مدير" };

  // Tax-free store so a single 100 scan yields a clean 60 cash / 40 visa
  // split (the pre-mortem vector) with no tax distortion.
  usePosStore.setState({ currentStore: { id: "store-main", name: "متجر", taxPercent: 0 } as never });

  // Scenario A — admin void of a SPLIT sale. The reversal payload must carry
  // -60 cash / -40 visa so the server ledger reverses the original buckets.
  store.getState().loginCashier("1111");
  await store.getState().openShift(100);
  store.getState().scanBarcode("99999");
  await store.getState().completeCheckout("SPLIT", 60);
  const saleSyncId = st().lastCompletedInvoice?.syncId ?? "";
  check("split-return: split sale queued", saleSyncId.length > 0);

  const saleEvent = await findPending("INVOICE_CREATED", (p) => p.sync_id === saleSyncId || p.originalInvoiceId === undefined && p.total === 100);
  check(
    "split-return: sale payload carries explicit buckets 60/40",
    (saleEvent?.payload as InvoiceCreatedPayload | undefined)?.cashAmount === 60 &&
      (saleEvent?.payload as InvoiceCreatedPayload | undefined)?.visaAmount === 40,
  );

  usePosStore.setState({ adminSession: ADMIN_SESSION });
  await store.getState().cancelInvoice(saleSyncId);
  const reversal = await findPending("INVOICE_CREATED", (p) => p.originalInvoiceId === saleSyncId);
  check("split-return: admin void queued", reversal !== undefined);
  if (reversal) {
    const p = reversal.payload as InvoiceCreatedPayload;
    check(
      "split-return: reversal payload reverses -60/-40",
      p.total === -100 && p.paymentMethod === "SPLIT" && p.cashAmount === -60 && p.visaAmount === -40,
    );
  }
  check("split-return: void marked returned", (await isInvoiceReturned(saleSyncId)) === true);
  // Close the scenario-A shift so scenario B re-opens a fresh drawer (the
  // openShift guard refuses while a shift is still OPEN).
  await store.getState().closeShift(160);
  await clearSyncQueue();

  // Scenario B — secure return settled in the same shift. The drawer must
  // restore to zero for both buckets (full reversal of the 60/40 sale).
  store.getState().loginCashier("1111");
  await store.getState().openShift(100);
  store.getState().scanBarcode("99999");
  await store.getState().completeCheckout("SPLIT", 60);
  const returnSource = st().lastCompletedInvoice?.syncId ?? "";

  store.getState().toggleReturnMode();
  await store.getState().beginReturnByInvoice(returnSource);
  await store.getState().completeCheckout("SPLIT", -60);
  const state = st();
  check(
    "split-return: drawer reverses both buckets to zero",
    state.shiftTotals.cashSales === 0 && state.shiftTotals.visaSales === 0 && state.shiftTotals.totalSales === 0,
  );
  check("split-return: expected drawer restored", state.shiftTotals.expectedCashInDrawer === 100);
  check("split-return: returns counter", state.shiftTotals.returns === 100);

  const returnEvent = await findPending("INVOICE_CREATED", (p) => p.originalInvoiceId === returnSource);
  check("split-return: secure return queued", returnEvent !== undefined);
  if (returnEvent) {
    const p = returnEvent.payload as InvoiceCreatedPayload;
    check(
      "split-return: secure return carries -60/-40 buckets",
      p.cashAmount === -60 && p.visaAmount === -40,
    );
  }
}

// ---------------------------------------------------------------------------
// Risk 3 — globally-unique barcode blocks shared GTINs
// ---------------------------------------------------------------------------

async function barcodeStoreScope(): Promise<void> {
  // Store-scoped uniqueness: the same GTIN may exist in another store.
  check(
    "barcode: same GTIN in another store is allowed",
    barcodeConflictInStore({ store_id: "store-b", product_id: "p-other" }, "store-a") === false,
  );
  check(
    "barcode: same GTIN same store different product blocked",
    barcodeConflictInStore({ store_id: "store-a", product_id: "p1" }, "store-a", "p2") === true,
  );
  check(
    "barcode: same GTIN same store same product allowed",
    barcodeConflictInStore({ store_id: "store-a", product_id: "p1" }, "store-a", "p1") === false,
  );
  check(
    "barcode: bare conflict within store blocked",
    barcodeConflictInStore({ store_id: "store-a", product_id: "p1" }, "store-a") === true,
  );

  // Migration contract: 056 must drop the global uniqueness and install the
  // composite (store_id, barcode) unique.
  let migration = "";
  try {
    migration = readFileSync(join(process.cwd(), "db/migrations/056_barcode_store_unique.sql"), "utf8");
  } catch {
    migration = "";
  }
  check(
    "barcode: migration 056 drops global barcode uniqueness",
    migration.includes("DROP CONSTRAINT IF EXISTS product_barcodes_barcode_key"),
  );
  check(
    "barcode: migration 056 adds store-scoped unique",
    migration.includes("uq_product_barcodes_store_barcode") && migration.includes("(store_id, barcode)"),
  );

  // Upsert contract: catalog writes must conflict on the composite key, not
  // the global barcode (which would overwrite another store's row).
  const catalogSrc = readFileSync(join(process.cwd(), "lib/catalogProducts.ts"), "utf8");
  check(
    "barcode: catalog upsert conflicts on store_id,barcode",
    catalogSrc.includes('onConflict: "store_id,barcode"') && !catalogSrc.includes('onConflict: "barcode"'),
  );
  const migrateSrc = readFileSync(join(process.cwd(), "scripts/migrate_legacy_catalog.ts"), "utf8");
  check(
    "barcode: legacy migration upsert conflicts on store_id,barcode",
    migrateSrc.includes('onConflict: "store_id,barcode"') && !migrateSrc.includes('onConflict: "barcode"'),
  );
}

async function main(): Promise<void> {
  await group("shift-close pending guard", shiftCloseGuard);
  await group("split return reversal", splitReturn);
  await group("barcode store scope", barcodeStoreScope);

  console.log(`\nPre-mortem Top-3: ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.error("Failures:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
}

void main();
