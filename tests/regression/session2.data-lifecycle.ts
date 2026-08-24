/**
 * Session 2 regression suite — data retention & sync integrity.
 *
 * Covers the four remediated areas end-to-end (fake-indexeddb, no network):
 *
 *  1. SYNC-F1 — once `enqueueSync` resolves, the sale IS saved: a simulated
 *     quota failure in post-enqueue bookkeeping must still settle success
 *     (cart cleared, drawer advanced, invoice queued exactly once), while a
 *     failure OF the enqueue itself must keep the cart and surface an error.
 *  2. MEM-1 — `pruneSyncedSyncQueue` deletes only SYNCED rows acked beyond
 *     the retention window; PENDING sales are never touched.
 *  3. MEM-2 — `pruneIstdStates` deletes only aged SUBMITTED rows; FAILED
 *     rows survive regardless of age (they must stay visible).
 *  4. MEM-1 v10 indexes — double-return lookups (`findReturnedOriginals`,
 *     `isInvoiceReturned`) and tenant invoice listings (`listInvoices`) must
 *     return exactly what the legacy whole-store scans returned (parity
 *     contract), and `originalInvoiceId` must be promoted top-level at
 *     enqueue time for the `invoice_return` index.
 *
 * Runs via tsx: npx tsx tests/regression/session2.data-lifecycle.ts
 */

import "fake-indexeddb/auto";
import { IDBObjectStore } from "fake-indexeddb";
import { openDB as rawOpen } from "idb";

// Dummy credentials: modules construct a dead client they never successfully
// reach — the flows under test are purely local (IndexedDB + zustand).
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
const {
  clearSyncQueue,
  countIstdFailed,
  enqueueSync,
  findInvoiceById,
  findReturnedOriginals,
  getIstdState,
  getSyncsByStatus,
  isInvoiceReturned,
  listInvoices,
  markSyncCompleted,
  pruneIstdStates,
  pruneSyncedSyncQueue,
  setIstdState,
} = await import("../../lib/idb");
import type {
  InvoiceCreatedPayload,
  SyncQueueRecord,
} from "../../lib/idb";
const { sha256Hex } = await import("../../lib/sha256");
const { setTenantStoreId } = await import("../../lib/tenantClient");

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

// ---------------------------------------------------------------------------
// Quota-failure injection: selected object stores reject put() like a real
// QuotaExceededError, everything else behaves normally.
// ---------------------------------------------------------------------------

const QUEUE_STORE = "sync_queue";
const PRICE_MEMORY_STORE = "price_memory";

const realPut = IDBObjectStore.prototype.put;
const failPuts = new Set<string>();
IDBObjectStore.prototype.put = function (...args: Parameters<typeof realPut>) {
  if (failPuts.has(this.name)) {
    return Promise.reject(new Error("QuotaExceededError (simulated)"));
  }
  return realPut.apply(this, args);
} as typeof realPut;

// ---------------------------------------------------------------------------
// Fixtures (mirrors tests/store.workflows.ts seeds, trimmed)
// ---------------------------------------------------------------------------

const TEST_PIN_SALT = "pos-test-salt-v1";
const pinHash = (pin: string): string => sha256Hex(pin + TEST_PIN_SALT);

const snapshot = {
  schemaVersion: 1,
  updatedAt: new Date().toISOString(),
  categories: {
    c1: { id: "c1", name: "مشروبات", parentId: null, bgColor: "#0f766e", isQuickKey: true, sortOrder: 1 },
  },
  products: {
    p1: { id: "p1", categoryId: "c1", name: "كولا", baseUnit: "عبوة", isWeighed: false, price: 10, costPrice: 6 },
    p2: { id: "p2", categoryId: "c1", name: "ماء", baseUnit: "عبوة", isWeighed: false, price: 5, costPrice: 3 },
  },
  barcodes: {
    "11111": { barcode: "11111", productId: "p1", variantId: "v-11111", variantLabel: "", unitName: "عبوة", qtyMultiplier: 1, price: 10, costPrice: 6 },
    "22222": { barcode: "22222", productId: "p2", variantId: "v-22222", variantLabel: "", unitName: "عبوة", qtyMultiplier: 1, price: 5, costPrice: 3 },
  },
  barcodeIndex: {
    "11111": { product_id: "p1", variantId: "v-11111", name: "كولا", price: 10, variantLabel: "" },
    "22222": { product_id: "p2", variantId: "v-22222", name: "ماء", price: 5, variantLabel: "" },
  },
  quickKeys: [],
  cashiers: [{ id: "cashier-1", name: "كاشير", pinHash: pinHash("1111"), role: "cashier" }],
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

const st = (): ReturnType<typeof usePosStore.getState> => usePosStore.getState();

async function resetState(): Promise<void> {
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

async function group(name: string, fn: () => Promise<void>): Promise<void> {
  console.log(`\n[${name}]`);
  setTenantStoreId(null);
  await resetState();
  st().loadSnapshot(snapshot);
  try {
    await fn();
  } catch (err) {
    fail += 1;
    failures.push(`${name}: threw ${String(err)}`);
    console.error(`  ✗ ${name}: threw ${String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Queue-row helpers
// ---------------------------------------------------------------------------

let rowSeq = 0;

function invoicePayload(total: number, completedAt?: string): InvoiceCreatedPayload {
  return {
    items: [],
    subtotal: total,
    tax: 0,
    discount: 0,
    deliveryFee: 0,
    total,
    paymentMethod: "CASH",
    amountPaid: total,
    change: 0,
    completed_at: completedAt ?? new Date().toISOString(),
  };
}

type InvoiceRecord = Extract<SyncQueueRecord, { action_type: "INVOICE_CREATED" }>;

async function enqueueInvoice(
  total: number,
  completedAt?: string,
): Promise<InvoiceRecord> {
  const record: InvoiceRecord = {
    sync_id: `inv-${++rowSeq}-${Math.random().toString(36).slice(2, 8)}`,
    action_type: "INVOICE_CREATED",
    payload: invoicePayload(total, completedAt),
    status: "PENDING",
    created_at: new Date().toISOString(),
  };
  await enqueueSync(record);
  return record;
}

async function enqueueReversal(
  originalSyncId: string,
  completedAt?: string,
): Promise<InvoiceRecord> {
  const record: InvoiceRecord = {
    sync_id: `rev-${++rowSeq}-${Math.random().toString(36).slice(2, 8)}`,
    action_type: "INVOICE_CREATED",
    payload: {
      ...invoicePayload(-10, completedAt),
      originalInvoiceId: originalSyncId,
      isCancellation: true,
    },
    status: "PENDING",
    created_at: new Date().toISOString(),
  };
  await enqueueSync(record);
  return record;
}

/** Raw row read/write bypassing the lib cache (for timestamp backdating). */
async function withRawRow(
  syncId: string,
  mutate: (record: Record<string, unknown>) => Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const db = await rawOpen("pos_local_db");
  try {
    const record = (await db.get(QUEUE_STORE, syncId)) as Record<string, unknown> | undefined;
    if (!record) return null;
    const next = mutate(record);
    await db.put(QUEUE_STORE, next);
    return next;
  } finally {
    db.close();
  }
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function minutesAgoIso(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((v) => b.has(v));
}

/** The pre-v10 double-return detection, kept here as the parity oracle. */
async function legacyScanReturnedIds(ids: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  const db = await rawOpen("pos_local_db");
  try {
    const rows = (await db.getAll(QUEUE_STORE)) as Array<Record<string, unknown>>;
    for (const row of rows) {
      if (row.action_type !== "INVOICE_CREATED") continue;
      const payload = row.payload as { originalInvoiceId?: unknown } | undefined;
      const ref = payload?.originalInvoiceId;
      if (typeof ref === "string" && ids.includes(ref)) found.add(ref);
    }
  } finally {
    db.close();
  }
  return found;
}

// ---------------------------------------------------------------------------
// 1) SYNC-F1 — the enqueue put is the point of durability
// ---------------------------------------------------------------------------

async function syncF1SettleGuard(): Promise<void> {
  setTenantStoreId("store-main");
  const store = usePosStore;
  store.getState().loginCashier("1111");
  await store.getState().openShift(100);
  check("syncf1: shift open", st().shiftState.status === "OPEN");

  // A1 — the enqueue itself fails: the sale is NOT saved, the cashier is
  // told so, and the cart survives for a retry.
  store.getState().scanBarcode("11111");
  const drawerBefore = st().shiftTotals.expectedCashInDrawer;
  failPuts.add(QUEUE_STORE);
  await store.getState().completeCheckout("CASH", 20);
  failPuts.delete(QUEUE_STORE);
  let s = st();
  check("syncf1: enqueue failure surfaces error notice", s.notice?.tone === "error");
  check("syncf1: enqueue failure keeps cart for retry", s.items.length === 1);
  check(
    "syncf1: enqueue failure leaves no invoice queued",
    !(await getSyncsByStatus("PENDING")).some((r) => r.action_type === "INVOICE_CREATED"),
  );
  check("syncf1: enqueue failure leaves drawer untouched", st().shiftTotals.expectedCashInDrawer === drawerBefore);

  // A2 — the enqueue succeeds but post-enqueue bookkeeping (the customer
  // price-memory write here) dies with a simulated quota error: the outcome
  // MUST be success-only. Re-ringing must stay impossible.
  usePosStore.setState({
    items: [],
    totals: { ...emptyTotals },
    lastCompletedInvoice: null,
  });
  store.getState().scanBarcode("11111");
  store.getState().scanBarcode("22222");
  const saleTotal = st().totals.total;
  // A customer id forces upsertPriceMemoryFromPayload onto its IDB write
  // path (anonymous sales short-circuit before any I/O).
  failPuts.add(PRICE_MEMORY_STORE);
  await store.getState().completeCheckout("DEBT", 0, "عميل الاختبار", "cust-1");
  failPuts.delete(PRICE_MEMORY_STORE);
  s = st();
  check("syncf1: post-enqueue failure settles success", s.notice?.tone === "success");
  check("syncf1: settled sale clears the cart exactly once", s.items.length === 0);
  check(
    "syncf1: completed invoice recorded with full total",
    s.lastCompletedInvoice !== null && s.lastCompletedInvoice.total === saleTotal,
  );
  const queued = (await getSyncsByStatus("PENDING")).find(
    (r) => r.action_type === "INVOICE_CREATED" && r.sync_id === s.lastCompletedInvoice?.syncId,
  );
  check("syncf1: sale durably queued exactly once", queued !== undefined);
  check(
    "syncf1: debt bucket recorded once",
    Math.abs(st().shiftTotals.debtSales - saleTotal) < 0.005,
  );
}

// ---------------------------------------------------------------------------
// 2) MEM-1 — SYNCED queue retention sweep
// ---------------------------------------------------------------------------

async function queueRetentionSweep(): Promise<void> {
  setTenantStoreId("store-main");
  const agedInv = await enqueueInvoice(10, daysAgoIso(20));
  const freshInv = await enqueueInvoice(12);
  const pendingInv = await enqueueInvoice(14, daysAgoIso(40));
  await markSyncCompleted([agedInv.sync_id, freshInv.sync_id]);
  await withRawRow(agedInv.sync_id, (r) => ({ ...r, synced_at: daysAgoIso(20) }));

  const pruned = await pruneSyncedSyncQueue();
  check("queue-retention: aged SYNCED row pruned", pruned === 1);
  check("queue-retention: aged row gone from lookups", (await findInvoiceById(agedInv.sync_id)) === null);
  check("queue-retention: PENDING row never swept", (await findInvoiceById(pendingInv.sync_id)) !== null);
  check("queue-retention: fresh SYNCED row survives default window", (await findInvoiceById(freshInv.sync_id)) !== null);

  // Sweeping again with an empty aged range is a cheap no-op.
  check("queue-retention: second sweep is a no-op", (await pruneSyncedSyncQueue()) === 0);
}

// ---------------------------------------------------------------------------
// 3) MEM-2 — istd_state retention sweep
// ---------------------------------------------------------------------------

async function istdRetentionSweep(): Promise<void> {
  setTenantStoreId("store-main");
  await setIstdState("istd-aged", { status: "SUBMITTED", istd_uuid: "uuid-aged" });
  await setIstdState("istd-fresh", { status: "SUBMITTED" });
  await setIstdState("istd-fail", { status: "FAILED", error: "rejected" });

  const db = await rawOpen("pos_local_db");
  try {
    for (const [id, ageDays] of [
      ["istd-aged", 91],
      ["istd-fail", 200], // FAILED must never age out, however old
    ] as const) {
      const row = (await db.get("istd_state", id)) as Record<string, unknown>;
      await db.put("istd_state", { ...row, updated_at: daysAgoIso(ageDays) });
    }
  } finally {
    db.close();
  }

  const pruned = await pruneIstdStates();
  check("istd-retention: aged SUBMITTED pruned", pruned === 1);
  check("istd-retention: aged row gone", (await getIstdState("istd-aged")) === undefined);
  check("istd-retention: recent SUBMITTED kept", (await getIstdState("istd-fresh")) !== undefined);
  check("istd-retention: FAILED kept regardless of age", (await getIstdState("istd-fail")) !== undefined);
  check(
    "istd-retention: FAILED badge count still sees kept row",
    (await countIstdFailed("store-main")) === 1,
  );
}

// ---------------------------------------------------------------------------
// 4) MEM-1 v10 — indexed return lookups vs. legacy scan parity
// ---------------------------------------------------------------------------

async function indexedReturnLookups(): Promise<void> {
  // Tenant A owns three originals; tenant B one. One A-reversal is SYNCED
  // (acked reversals must keep guarding), one stays PENDING. Distinct
  // timestamps prove the newest-first sort; reversal documents are themselves
  // INVOICE_CREATED rows, so legacy listings include them too.
  setTenantStoreId("store-a");
  const origA1 = await enqueueInvoice(10, minutesAgoIso(50));
  const revA1 = await enqueueReversal(origA1.sync_id, minutesAgoIso(20));
  const origA2 = await enqueueInvoice(20, minutesAgoIso(40));
  const revA2 = await enqueueReversal(origA2.sync_id, minutesAgoIso(10));
  await markSyncCompleted([revA2.sync_id]);
  const origA3 = await enqueueInvoice(30, minutesAgoIso(30)); // never returned
  setTenantStoreId("store-b");
  const origB1 = await enqueueInvoice(40, minutesAgoIso(45));
  const revB1 = await enqueueReversal(origB1.sync_id, minutesAgoIso(15));

  // Promotion: the v10 stamp happens at enqueue time, alongside the payload.
  const rawReversal = await withRawRow(revA1.sync_id, (r) => r);
  check(
    "returns: originalInvoiceId promoted top-level at enqueue",
    rawReversal?.originalInvoiceId === origA1.sync_id &&
      (rawReversal?.payload as { originalInvoiceId?: string })?.originalInvoiceId === origA1.sync_id,
  );
  const rawOriginal = await withRawRow(origA3.sync_id, (r) => r);
  check("returns: plain invoice carries no promoted key", rawOriginal?.originalInvoiceId === undefined);

  // Parity contract: indexed lookups ≡ legacy whole-store scan.
  const targets = [origA1.sync_id, origA2.sync_id, origA3.sync_id, origB1.sync_id];
  const indexedSet = await findReturnedOriginals(targets);
  const legacySet = await legacyScanReturnedIds(targets);
  check("returns: batched indexed set equals legacy scan", setsEqual(indexedSet, legacySet));
  check("returns: PENDING reversal marks original returned", indexedSet.has(origA1.sync_id));
  check("returns: SYNCED reversal still marks original returned", indexedSet.has(origA2.sync_id));
  check("returns: never-returned invoice absent", !indexedSet.has(origA3.sync_id));
  // Documented legacy semantics: the double-return guard is global across
  // tenants (the old scan had no tenant filter) — parity must preserve it.
  check("returns: cross-tenant reference counted (legacy-global semantics)", indexedSet.has(origB1.sync_id));
  check(
    "returns: single-id lookup agrees with batch",
    (await isInvoiceReturned(origA1.sync_id)) === true && (await isInvoiceReturned(origA3.sync_id)) === false,
  );

  // Tenant invoice listing: only the tenant's own INVOICE_CREATED rows,
  // newest first, regardless of insertion order; non-invoice events and
  // foreign-tenant rows are invisible.
  setTenantStoreId("store-a");
  await enqueueSync({
    sync_id: `shift-${++rowSeq}`,
    action_type: "SHIFT_OPENED",
    payload: {
      shiftId: "sh-list-1",
      startTime: new Date().toISOString(),
      startingCash: 0,
      openedAt: new Date().toISOString(),
    },
    status: "PENDING",
    created_at: new Date().toISOString(),
  });
  const listing = await listInvoices("store-a");
  check(
    "listings: own-tenant invoices only (reversal docs included, legacy semantics)",
    listing.length === 5 && listing.every((r) => r.storeId === "store-a" && r.action_type === "INVOICE_CREATED"),
  );
  check(
    "listings: newest-first ordering",
    listing.map((r) => Number(r.payload.total)).join(",") === "-10,-10,30,20,10",
  );
  const storeB = await listInvoices("store-b");
  check(
    "listings: foreign tenant isolated",
    storeB.length === 2 &&
      setsEqual(new Set(storeB.map((r) => r.sync_id)), new Set([origB1.sync_id, revB1.sync_id])),
  );
  check("listings: unbound tenant lists nothing", (await listInvoices("store-c")).length === 0);
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  try {
    await group("syncf1 settle guard", syncF1SettleGuard);
    await group("queue retention sweep", queueRetentionSweep);
    await group("istd retention sweep", istdRetentionSweep);
    await group("indexed return lookups", indexedReturnLookups);
  } finally {
    IDBObjectStore.prototype.put = realPut;
  }
  console.log(`\nSession 2 data lifecycle: ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log("Failures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(fail === 0 ? 0 : 1);
}

void main();
