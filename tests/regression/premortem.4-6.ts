/**
 * Pre-mortem regression suite — risks 4, 5, 6.
 *
 * 4. Partial returns are not supported (full-invoice negation only).
 *    Contract: `beginReturnByInvoice` + `setReturnLineQty(index, qty)`
 *    rebuild the return document from a fresh `computeFiscalBreakdown` over
 *    only the selected lines, with the original invoice discount prorated
 *    proportionally — refund = discounted net, never gross.
 * 5. Poison-event drop silently loses a sale.
 *    Contract: syncService never hard-deletes; poison records are quarantined
 *    into the `sync_poison` IndexedDB store and surfaced as a persistent
 *    "⚠ حركة معلّقة (خارج المزامنة)" badge with count.
 * 6. Cross-tab double-cart / double-submit on the same register.
 *    Contract: a localStorage lease (lib/crossTabLock.ts) bounces the second
 *    tab to a read-only "register in use elsewhere" screen and `isCompleting`
 *    is mirrored to localStorage during the critical section so every tab
 *    honours the same submit lock.
 *
 * Runs under tsx with fake-indexeddb (no server, no live DB).
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

const { usePosStore } = await import("../../store/usePosStore");
const idbNS = await import("../../lib/idb");
const { clearSyncQueue, getSyncsByStatus, enqueueSync, isInvoiceReturned } = idbNS;
const { processSyncQueue } = await import("../../services/syncService");
const { sha256Hex } = await import("../../lib/sha256");
const { setTenantStoreId } = await import("../../lib/tenantClient");

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  BarcodeIndex,
  BarcodeMap,
  Cashier,
  PosSnapshot,
  ProductMap,
  QuickKeyItem,
} from "../../types/pos.types";
import type { InvoiceCreatedPayload, SyncQueueRecord } from "../../lib/idb";

const idbAPI = idbNS as unknown as {
  countPoisonSyncRecords?: () => Promise<number>;
  getPoisonSyncRecords?: () => Promise<Array<{ sync_id: string; reason?: string }>>;
};

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

function readSource(relPath: string): string {
  try {
    return readFileSync(join(process.cwd(), relPath), "utf8");
  } catch {
    return "";
  }
}

const categories: PosSnapshot["categories"] = {
  c1: { id: "c1", name: "مشروبات", parentId: null, bgColor: "#0f766e", isQuickKey: true, sortOrder: 1 },
};

// Tax-free products at clean prices so partial-return proration is exact.
const products: ProductMap = {
  p10: { id: "p10", categoryId: "c1", name: "كولا", baseUnit: "عبوة", isWeighed: false, price: 10, costPrice: 6 },
  p5: { id: "p5", categoryId: "c1", name: "ماء", baseUnit: "حبة", isWeighed: false, price: 5, costPrice: 3 },
};

const barcodes: BarcodeMap = {
  "10000": { barcode: "10000", productId: "p10", variantId: "v-10000", variantLabel: "", unitName: "عبوة", qtyMultiplier: 1, price: 10, costPrice: 6 },
  "50000": { barcode: "50000", productId: "p5", variantId: "v-50000", variantLabel: "", unitName: "حبة", qtyMultiplier: 1, price: 5, costPrice: 3 },
};

const barcodeIndex: BarcodeIndex = {
  "10000": { product_id: "p10", variantId: "v-10000", name: "كولا", price: 10, variantLabel: "" },
  "50000": { product_id: "p5", variantId: "v-50000", name: "ماء", price: 5, variantLabel: "" },
};

const quickKeys: QuickKeyItem[] = [
  { id: "qk1", categoryId: "c1", label: "كولا", bgColor: "#0f766e", sortOrder: 1, productId: "p10", unitName: "عبوة", price: 10, barcode: "10000" },
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
    poisonSyncCount: 0,
    registerLeaseHeld: false,
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

async function findPending(
  actionType: string,
  predicate: (p: Record<string, unknown>) => boolean = () => true,
): Promise<SyncQueueRecord | undefined> {
  const pending = await getSyncsByStatus("PENDING");
  return pending.find(
    (r) => r.action_type === actionType && predicate(r.payload as unknown as Record<string, unknown>),
  );
}

// ---------------------------------------------------------------------------
// Risk 4 — partial returns: line-level qty selection, discounted net
// ---------------------------------------------------------------------------

async function partialReturn(): Promise<void> {
  usePosStore.setState({ currentStore: { id: "store-main", name: "متجر", taxPercent: 0 } as never });
  const store = usePosStore;

  store.getState().loginCashier("1111");
  await store.getState().openShift(100);
  store.getState().scanBarcode("10000");
  store.getState().scanBarcode("10000");
  store.getState().scanBarcode("50000");
  store.getState().applyDiscount({ scope: "TOTAL", type: "FIXED", value: 5 });
  check("partial-return: discounted cart (25−5) totals 20", st().totals.total === 20);
  check("partial-return: two merged lines", st().items.length === 2);

  await store.getState().completeCheckout("CASH", 10);
  const saleSyncId = st().lastCompletedInvoice?.syncId ?? "";
  check("partial-return: sale queued", saleSyncId.length > 0);

  // Full load: invoice-level discount 5 prorated 4 / 1 across 20 / 5 line
  // totals → negated discounted nets −16 / −4 (never gross −20 / −5).
  const loaded = await store.getState().beginReturnByInvoice(saleSyncId);
  check("partial-return: return loaded", loaded === true);
  let items = st().items;
  check(
    "partial-return: full negation uses discounted nets -16/-4",
    items[0]?.qty === -2 && items[0]?.lineTotal === -16 &&
      items[1]?.qty === -1 && items[1]?.lineTotal === -4,
  );
  check("partial-return: full return total -20", st().totals.total === -20);

  // Partial: return only 1 of the 2 units of line 0. The refund must be the
  // discounted net share (8), NOT the gross share (10).
  const action = st().setReturnLineQty;
  check("partial-return: setReturnLineQty exposed on store", typeof action === "function");
  if (typeof action === "function") {
    action(0, 1);
  }
  items = st().items;
  check("partial-return: line0 partial qty -1", items[0]?.qty === -1);
  check("partial-return: line0 refunds discounted net -8, never gross -10", items[0]?.lineTotal === -8);
  check("partial-return: non-selected line untouched -4", items[1]?.qty === -1 && items[1]?.lineTotal === -4);
  check("partial-return: partial return total -12", st().totals.total === -12);

  if (typeof action === "function") {
    await store.getState().completeCheckout("CASH", -12);
    const partialEvent = await findPending("INVOICE_CREATED", (p) => p.originalInvoiceId === saleSyncId);
    check("partial-return: partial return queued", partialEvent !== undefined);
    if (partialEvent) {
      const p = partialEvent.payload as InvoiceCreatedPayload;
      check("partial-return: queued refund -12 (discounted net)", p.total === -12);
      check("partial-return: queued line carries partial qty", p.items?.[0]?.qty === -1);
      check("partial-return: queued line carries partial net", p.items?.[0]?.lineTotal === -8);
    }
    check("partial-return: original marked returned", (await isInvoiceReturned(saleSyncId)) === true);
  } else {
    check("partial-return: partial return queued", false);
    check("partial-return: queued refund -12 (discounted net)", false);
    check("partial-return: queued line carries partial qty", false);
    check("partial-return: queued line carries partial net", false);
  }

  // Source contract: the return builder must re-run the fiscal split over the
  // selected lines and keep the discounted-net invariant.
  const storeSrc = readSource("store/usePosStore.ts");
  check("partial-return: store exposes setReturnLineQty", storeSrc.includes("setReturnLineQty"));
  check("partial-return: store rebuilds via computeFiscalBreakdown", storeSrc.includes("computeFiscalBreakdown"));
}

// ---------------------------------------------------------------------------
// Risk 5 — poison sync events must be quarantined, never hard-deleted
// ---------------------------------------------------------------------------

async function poisonQuarantine(): Promise<void> {
  const syncSrc = readSource("services/syncService.ts");
  const idbSrc = readSource("lib/idb.ts");
  const storeSrc = readSource("store/usePosStore.ts");
  const layoutSrc = readSource("components/pos/PosLayout.tsx");

  // Source contracts
  check("poison: syncService no longer hard-deletes", !syncSrc.includes("deleteSyncs"));
  check("poison: syncService quarantines poison records", syncSrc.includes("quarantineSyncRecord"));
  check("poison: idb ships sync_poison store", idbSrc.includes("sync_poison"));
  check("poison: idb exposes quarantineSyncRecord", idbSrc.includes("quarantineSyncRecord"));
  check("poison: idb exposes countPoisonSyncRecords", idbSrc.includes("countPoisonSyncRecords"));
  check(
    "poison: idb DB_VERSION supports poison store",
    Number((/DB_VERSION = (\d+)/.exec(idbSrc) ?? [])[1]) >= 5,
  );
  check("poison: store tracks poisonSyncCount", storeSrc.includes("poisonSyncCount"));
  check("poison: store refreshes poison count", storeSrc.includes("refreshPoisonSyncCount"));
  check(
    "poison: PosLayout badge rendered with count",
    layoutSrc.includes("poisonSyncCount") && layoutSrc.includes("حركة معلّقة (خارج المزامنة)"),
  );

  // Behavioral: a record the server accepts but never acks must be parked in
  // the quarantine after 8 attempts — not silently dropped.
  let fetchCalls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((() => {
    fetchCalls += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ success: true, synced_ids: [], rejected: [] }),
    };
  }) as unknown) as typeof fetch;
  try {
    setTenantStoreId("store-main");
    const record: SyncQueueRecord = {
      sync_id: "poison-invoice-1",
      action_type: "INVOICE_CREATED",
      payload: {
        items: [],
        subtotal: 0,
        tax: 0,
        discount: 0,
        deliveryFee: 0,
        total: 10,
        paymentMethod: "CASH",
        amountPaid: 10,
        change: 0,
        completed_at: new Date().toISOString(),
      },
      status: "PENDING",
      created_at: new Date().toISOString(),
    };
    await enqueueSync(record);
    for (let i = 0; i < 8; i += 1) {
      await processSyncQueue();
    }
    check("poison: exhausted 8 server attempts", fetchCalls === 8);
    check("poison: record removed from live queue", (await getSyncsByStatus("PENDING")).length === 0);

    const poisonRecords = idbAPI.getPoisonSyncRecords ? await idbAPI.getPoisonSyncRecords() : [];
    check(
      "poison: record parked in sync_poison quarantine",
      poisonRecords.length === 1 && poisonRecords[0]?.sync_id === "poison-invoice-1",
    );
    const poisonCount = idbAPI.countPoisonSyncRecords ? await idbAPI.countPoisonSyncRecords() : -1;
    check("poison: countPoisonSyncRecords returns 1", poisonCount === 1);

    await processSyncQueue();
    check("poison: quarantined record never retried", fetchCalls === 8);
  } finally {
    globalThis.fetch = realFetch;
    setTenantStoreId(null);
  }
}

// ---------------------------------------------------------------------------
// Risk 6 — cross-tab register lease + cross-tab completing lock
// ---------------------------------------------------------------------------

async function crossTabLock(): Promise<void> {
  const lockSrc = readSource("lib/crossTabLock.ts");
  check("cross-tab: lock lib exists", lockSrc.length > 0);
  check("cross-tab: lock lib exposes acquireRegisterLease", lockSrc.includes("acquireRegisterLease"));
  check("cross-tab: lock lib exposes releaseRegisterLease", lockSrc.includes("releaseRegisterLease"));
  check("cross-tab: lease key prefix constant", lockSrc.includes("REGISTER_LEASE_PREFIX"));
  check("cross-tab: lease TTL constant", lockSrc.includes("REGISTER_LEASE_TTL_MS"));

  if (lockSrc.length > 0) {
    const {
      acquireRegisterLease,
      releaseRegisterLease,
      REGISTER_LEASE_PREFIX,
    } = await import("../../lib/crossTabLock");

    check("cross-tab: first tab acquires the lease", acquireRegisterLease("store-1", "term-1") === true);
    releaseRegisterLease("store-1", "term-1");
    check("cross-tab: released lease re-acquirable", acquireRegisterLease("store-1", "term-1") === true);

    // Simulate a second tab: a live lease held by a foreign owner blocks it.
    storage.set(
      `${REGISTER_LEASE_PREFIX}:store-1:term-1`,
      JSON.stringify({ owner: "other-tab", heartbeat: Date.now() }),
    );
    check("cross-tab: second tab on same register refused", acquireRegisterLease("store-1", "term-1") === false);

    // A different terminal has its own lease key and may open.
    check("cross-tab: a different terminal may open", acquireRegisterLease("store-1", "term-2") === true);

    // A tab that crashed without releasing must lose the lease after its TTL.
    storage.set(
      `${REGISTER_LEASE_PREFIX}:store-1:term-9`,
      JSON.stringify({ owner: "crashed-tab", heartbeat: Date.now() - 60_000 }),
    );
    check("cross-tab: stale lease stolen after TTL", acquireRegisterLease("store-1", "term-9") === true);
  }

  // UI + store contracts: a second tab is bounced to a read-only screen and
  // the submit lock is shared across tabs.
  const layoutSrc = readSource("components/pos/PosLayout.tsx");
  const storeSrc = readSource("store/usePosStore.ts");
  const crossTabSrc = readSource("hooks/useCrossTabSync.ts");

  check(
    "cross-tab: PosLayout bounces in-use register to read-only screen",
    layoutSrc.includes("registerLeaseHeld") &&
      layoutSrc.includes("acquireRegisterLease") &&
      layoutSrc.includes("هذا الكاشير مفتوح في نافذة أخرى"),
  );
  check("cross-tab: store tracks registerLeaseHeld", storeSrc.includes("registerLeaseHeld"));
  check(
    "cross-tab: isCompleting mirrored to localStorage during critical section",
    storeSrc.includes("pos.is-completing"),
  );
  check(
    "cross-tab: useCrossTabSync forwards the completing lock",
    crossTabSrc.includes("pos.is-completing") && crossTabSrc.includes("isCompleting"),
  );
}

async function main(): Promise<void> {
  await group("partial return (line selection)", partialReturn);
  await group("poison quarantine", poisonQuarantine);
  await group("cross-tab register lock", crossTabLock);

  console.log(`\nPre-mortem Risks 4-6: ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.error("Failures:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
}

void main();
