/**
 * Phase 4 — Dynamic Customer Pricing / Customer Memory suite (TDD).
 *
 * Customer assignment on the POS cart, a per-line `Last price: X.XX JOD
 * (Date)` memory badge, and an offline-first O(1) IndexedDB last-price cache.
 *
 * Part 1 — Cache: composite-key entries (customerId x product/barcode), the
 * rebuild from queued invoice history, tenant isolation, the effective
 * unit-price (discount-aware) rule, and a non-blocking async lookup.
 *
 * Part 2 — Label: the exact badge text the UI renders.
 *
 * Part 3 — Store workflow: active-customer assignment, the in-memory badge
 * index loaded off the IDB `customer` index, cashier-level (non-admin)
 * price override that honors line discounts, and the checkout stamp that
 * writes memory from the completed sale then clears the cart's customer.
 */

import "fake-indexeddb/auto";

// Dummy credentials so modules that touch supabase-js construct a throwaway
// client that fails fast — no network is ever reached by this suite.
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
// zustand's persist defaults to `window.localStorage` — alias window so the
// middleware resolves to the shim above instead of warning on every write.
(globalThis as Record<string, unknown>).window = globalThis;

const { usePosStore } = await import("../store/usePosStore");
const {
  buildPriceMemoryCache,
  clearSyncQueue,
  enqueueSync,
  getPriceMemory,
  loadPriceMemoryForCustomer,
  upsertPriceMemoryFromPayload,
} = await import("../lib/idb");
const {
  customerPriceMemoryKey,
  effectiveUnitPrice,
  priceMemoryKey,
  priceMemoryLabel,
  priceMemoryLookupKey,
} = await import("../lib/priceMemory");
const { sha256Hex } = await import("../lib/sha256");
const { computeSaleTotals } = await import("../lib/saleMath");
const { effectiveTaxPercent } = await import("../lib/qr");

import type { InvoiceCreatedPayload, SyncQueueRecord } from "../lib/idb";
import type { PriceMemoryEntry } from "../lib/priceMemory";
import type {
  BarcodeIndex,
  BarcodeMap,
  Cashier,
  CategoryMap,
  PosSnapshot,
  ProductMap,
  QuickKeyItem,
  SaleItem,
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

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

const categories: CategoryMap = {
  c1: { id: "c1", name: "مشروبات", parentId: null, bgColor: "#0f766e", isQuickKey: true, sortOrder: 1 },
};

const products: ProductMap = {
  p1: { id: "p1", categoryId: "c1", name: "كولا", baseUnit: "عبوة", isWeighed: false, price: 10, costPrice: 6 },
  p2: { id: "p2", categoryId: "c1", name: "ماء", baseUnit: "عبوة", isWeighed: false, price: 5, costPrice: 3 },
  p3: { id: "p3", categoryId: "c1", name: "شيبس", baseUnit: "كيس", isWeighed: false, price: 20, costPrice: 12 },
};

const barcodes: BarcodeMap = {
  "11111": { barcode: "11111", productId: "p1", variantId: "v-11111", variantLabel: "", unitName: "عبوة", qtyMultiplier: 1, price: 10, costPrice: 6 },
  "22222": { barcode: "22222", productId: "p2", variantId: "v-22222", variantLabel: "", unitName: "عبوة", qtyMultiplier: 1, price: 5, costPrice: 3 },
  "33333": { barcode: "33333", productId: "p3", variantId: "v-33333", variantLabel: "", unitName: "كيس", qtyMultiplier: 1, price: 20, costPrice: 12 },
};

const barcodeIndex: BarcodeIndex = {
  "11111": { product_id: "p1", variantId: "v-11111", name: "كولا", price: 10, variantLabel: "" },
  "22222": { product_id: "p2", variantId: "v-22222", name: "ماء", price: 5, variantLabel: "" },
  "33333": { product_id: "p3", variantId: "v-33333", name: "شيبس", price: 20, variantLabel: "" },
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

const itemP1 = (price: number): SaleItem => ({
  productId: "p1",
  name: "كولا",
  barcode: "11111",
  qty: 1,
  unitName: "عبوة",
  unitPrice: price,
  lineTotal: price,
  taxPercent: 16,
  taxIncluded: false,
});

const itemP2: SaleItem = {
  productId: "p2",
  name: "ماء",
  barcode: "22222",
  qty: 1,
  unitName: "عبوة",
  unitPrice: 5,
  lineTotal: 5,
  taxPercent: 16,
  taxIncluded: false,
};

/** A well-formed queued-invoice payload, mirroring completeCheckout's shape. */
function invoicePayload(
  overrides: Partial<InvoiceCreatedPayload> & { customerId: string },
): InvoiceCreatedPayload {
  const items = overrides.items ?? [itemP1(10)];
  const subtotal = overrides.subtotal ?? round2(items.reduce((sum, item) => sum + item.lineTotal, 0));
  const total = overrides.total ?? round2(subtotal * 1.16);
  return {
    items,
    subtotal,
    tax: overrides.tax ?? round2(total - subtotal),
    discount: 0,
    deliveryFee: 0,
    total,
    paymentMethod: "CASH",
    amountPaid: total,
    change: 0,
    customerName: "أحمد",
    completed_at: overrides.completed_at ?? "2026-08-16T10:00:00.000Z",
    ...overrides,
  };
}

function enqueueInvoice(
  syncId: string,
  payload: InvoiceCreatedPayload,
  storeId: string,
): Promise<void> {
  const record: SyncQueueRecord = {
    sync_id: syncId,
    action_type: "INVOICE_CREATED",
    payload,
    status: "PENDING",
    created_at: payload.completed_at,
    storeId,
  };
  return enqueueSync(record);
}

const st = (): ReturnType<typeof usePosStore.getState> => usePosStore.getState();

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
    customers: [],
    customersUpdatedAt: "",
    customersLoading: false,
    activeCustomerId: null,
    priceMemory: {},
  });
}

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

// ---------------------------------------------------------------------------
// Part 1: IDB cache — composite keys, rebuild, tenant isolation, effective price
// ---------------------------------------------------------------------------

async function idbCache(): Promise<void> {
  const storeId = "store-main";

  // Anonymous / unresolved (local-) customers must never be cached.
  await upsertPriceMemoryFromPayload(invoicePayload({ customerId: "" }), storeId);
  await upsertPriceMemoryFromPayload(invoicePayload({ customerId: "local-abc" }), storeId);
  check("cache: anonymous sale writes nothing", (await getPriceMemory(storeId, "customer-1", "p1", "11111")) === null);
  check("cache: unresolved local customer writes nothing", (await getPriceMemory(storeId, "customer-1", "p1", "11111")) === null);

  // Two historical invoices for the same product at different prices.
  await enqueueInvoice("inv-1", invoicePayload({ customerId: "customer-1", items: [itemP1(10), itemP2], completed_at: "2026-08-01T10:00:00.000Z" }), storeId);
  await enqueueInvoice("inv-2", invoicePayload({ customerId: "customer-1", items: [itemP1(12.5)], completed_at: "2026-08-10T10:00:00.000Z" }), storeId);

  const rebuilt = await buildPriceMemoryCache(storeId);
  check("cache: rebuild materializes unique entries", rebuilt === 2);

  const entry = await getPriceMemory(storeId, "customer-1", "p1", "11111");
  check("cache: latest sale's price wins", entry?.unitPrice === 12.5);
  check("cache: latest sale's date wins", entry?.completedAt === "2026-08-10T10:00:00.000Z");
  check("cache: product entry survives alongside", (await getPriceMemory(storeId, "customer-1", "p2", "22222"))?.unitPrice === 5);

  // Effective unit price is discount-aware: what the customer actually paid.
  const discounted: SaleItem = { ...itemP1(10), discount: 1, lineTotal: 9 };
  check("cache: effective unit price reflects line discount", effectiveUnitPrice(discounted) === 9);
  check("cache: effective unit price = shelf price when no discount", effectiveUnitPrice(itemP1(12.5)) === 12.5);

  // Barcode-only (ad-hoc quick item) lines are cached by their barcode key.
  const barcodeOnly: SaleItem = {
    productId: "",
    name: "منتج حر",
    barcode: "QK-ABC123",
    qty: 1,
    unitName: "حبة",
    unitPrice: 7.5,
    lineTotal: 7.5,
    taxPercent: 16,
    taxIncluded: true,
  };
  await enqueueInvoice("inv-3", invoicePayload({ customerId: "customer-1", items: [barcodeOnly], completed_at: "2026-08-12T10:00:00.000Z" }), storeId);
  await buildPriceMemoryCache(storeId);
  const barcodeEntry = await getPriceMemory(storeId, "customer-1", "", "QK-ABC123");
  check("cache: barcode-only line cached by barcode key", barcodeEntry?.unitPrice === 7.5);
  check("cache: barcode entry keeps productId empty", barcodeEntry?.productId === "");

  // Tenant isolation: the same product/customer in another store is separate.
  await upsertPriceMemoryFromPayload(invoicePayload({ customerId: "customer-9" }), "store-other");
  const otherTenant = await getPriceMemory("store-other", "customer-9", "p1", "11111");
  check("cache: tenant scoped entry exists", otherTenant?.unitPrice === 10);
  check("cache: other tenant invisible from main", (await getPriceMemory(storeId, "customer-9", "p1", "11111")) === null);

  // The `customer` index returns only that (tenant, customer) partition.
  const c1 = await loadPriceMemoryForCustomer(storeId, "customer-1");
  check("cache: index returns customer's rows only", c1.length >= 3 && c1.every((e) => e.customerId === "customer-1"));
  const c9 = await loadPriceMemoryForCustomer("store-other", "customer-9");
  check("cache: index scoped per tenant+customer", c9.length === 1 && c9[0].customerId === "customer-9");

  // Incremental upsert (a repeated purchase) bumps saleCount + last price.
  await upsertPriceMemoryFromPayload(invoicePayload({ customerId: "customer-1", items: [itemP1(10)], completed_at: "2026-08-20T10:00:00.000Z" }), storeId);
  const repeat = await getPriceMemory(storeId, "customer-1", "p1", "11111");
  check("cache: upsert increments saleCount", repeat?.saleCount === 2);
  check("cache: upsert advances last price + date", repeat?.unitPrice === 10 && repeat?.completedAt === "2026-08-20T10:00:00.000Z");

  // Keying rules: deterministic, customer-scoped, distinct per identity.
  const k1 = priceMemoryKey(storeId, "customer-1", "p1", "11111");
  const k2 = priceMemoryKey(storeId, "customer-1", "", "QK-ABC123");
  check("keys: deterministic product key", priceMemoryKey(storeId, "customer-1", "p1", "11111") === k1);
  check("keys: product vs barcode identity differ", k1 !== null && k2 !== null && k1 !== k2);
  check("keys: customer-scoped", priceMemoryKey(storeId, "customer-2", "p1", "11111") !== k1);
  check("keys: no identity is not cacheable", priceMemoryKey(storeId, "customer-1", "", "") === null);
  check("keys: customerKey helpers agree", entry?.customerKey === customerPriceMemoryKey(storeId, "customer-1"));
  check("lookup: product lookup key", priceMemoryLookupKey("p1", "") === "p:p1");
  check("lookup: barcode lookup key", priceMemoryLookupKey("", "QK-ABC123") === "b:QK-ABC123");

  // Lookup is async (IDB direct-key read): it can never block the main thread.
  const probe = getPriceMemory(storeId, "customer-1", "p1", "11111");
  check("cache: lookup is a non-blocking promise", typeof probe?.then === "function");
  await probe;
}

// ---------------------------------------------------------------------------
// Part 2: badge label — exact UI text
// ---------------------------------------------------------------------------

async function badgeLabel(): Promise<void> {
  const entry: PriceMemoryEntry = {
    key: "store-main|customer-1|p:p1",
    storeId: "store-main",
    customerId: "customer-1",
    customerKey: "store-main|customer-1",
    productId: "p1",
    barcode: "11111",
    unitPrice: 12.5,
    unitName: "عبوة",
    completedAt: "2026-08-16T09:00:00.000Z",
    updatedAt: "2026-08-16T09:00:00.000Z",
    saleCount: 1,
  };
  check("label: exact badge text", priceMemoryLabel(entry) === "Last price: 12.50 JOD (2026-08-16)");
  check("label: integer price keeps two decimals", priceMemoryLabel({ ...entry, unitPrice: 10 }) === "Last price: 10.00 JOD (2026-08-16)");
  check("label: missing date renders empty parens", priceMemoryLabel({ ...entry, completedAt: "" }) === "Last price: 12.50 JOD ()");
}

// ---------------------------------------------------------------------------
// Part 3: store workflow — assignment, in-memory badge index, override, checkout
// ---------------------------------------------------------------------------

async function storeWorkflow(): Promise<void> {
  const store = usePosStore;
  const storeId = "store-main";

  store.getState().loginCashier("1111");
  await store.getState().openShift(100);
  usePosStore.setState({ currentStore: { id: storeId, name: "متجر", taxPercent: 16 } as never });
  st().upsertCustomer({ id: "customer-1", name: "أحمد", phone: "0599999999", balance: 0 });

  // Seed history through the queued-invoice rebuild path (offline catch-up).
  await enqueueInvoice("inv-seed", invoicePayload({ customerId: "customer-1", items: [itemP1(12.5)], completed_at: "2026-07-20T10:00:00.000Z" }), storeId);
  await buildPriceMemoryCache(storeId);

  store.getState().setActiveCustomer("customer-1");
  check("store: active customer assigned", st().activeCustomerId === "customer-1");
  await store.getState().refreshPriceMemory();
  check("store: in-memory badge index loaded", st().priceMemory["p:p1"]?.unitPrice === 12.5);
  check("store: badge index is synchronous after load", Object.keys(st().priceMemory).length === 1);

  store.getState().scanBarcode("11111"); // shelf price 10
  check("store: shelf price loaded", st().items[0]?.unitPrice === 10);
  store.getState().applyMemoryPrice(0);
  let state = st();
  check("store: one-click override applies last price", state.items[0].unitPrice === 12.5 && state.items[0].lineTotal === 12.5);
  check("store: override is cashier-level (no admin session)", state.items[0].unitPrice === 12.5 && state.adminSession === null);
  check("store: totals recomputed from memory price", state.totals.subtotal === 12.5 && state.totals.total === 14.5);

  // The override must honor an existing line discount percent.
  usePosStore.setState((s) => {
    const items = s.items.map((it, i) =>
      i === 0 ? { ...it, discount: 0, discountPct: 10, lineTotal: it.unitPrice } : it,
    );
    return { items, totals: computeSaleTotals(items, s.invoiceDiscount, effectiveTaxPercent(s.currentStore), s.deliveryFee) };
  });
  store.getState().applyMemoryPrice(0);
  state = st();
  check("store: override honors line discountPct", state.items[0].unitPrice === 12.5 && state.items[0].discount === 1.25 && state.items[0].lineTotal === 11.25);

  store.getState().clearInvoice();
  store.getState().setActiveCustomer("customer-1");
  await store.getState().refreshPriceMemory();
  store.getState().scanBarcode("33333");
  await store.getState().completeCheckout("CASH", 23.2);
  state = st();
  check("store: checkout stamps the active customer", state.lastCompletedInvoice?.customerId === "customer-1" && state.lastCompletedInvoice?.customerName === "أحمد");
  check("store: active customer cleared after the sale", state.activeCustomerId === null && Object.keys(state.priceMemory).length === 0);
  const after = await getPriceMemory(storeId, "customer-1", "p3", "33333");
  check("store: checkout writes memory from the sale", after?.unitPrice === 20 && after?.customerId === "customer-1" && after?.saleCount === 1);

  // An anonymous (no-customer) sale must not create memory.
  store.getState().scanBarcode("22222");
  await store.getState().completeCheckout("CASH", 5.8);
  check("store: anonymous sale leaves no memory", (await getPriceMemory(storeId, "customer-1", "p2", "22222")) === null);
}

// ---------------------------------------------------------------------------

await group("memory idb cache", idbCache);
await group("memory badge label", badgeLabel);
await group("memory store workflow", storeWorkflow);

console.log(`\nCustomer Memory suite: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("Failures:");
  for (const name of failures) console.error(`  ✗ ${name}`);
  process.exit(1);
}
