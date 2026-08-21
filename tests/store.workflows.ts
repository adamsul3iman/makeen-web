/**
 * Store workflow + route validation suite (runs via tsx, no server needed).
 *
 * Part 1 — Route validation: imports every write route with a throwaway
 * Supabase client (dummy env pointing at a dead port) and proves that
 * missing/malformed payloads return 400 and validation failures return 400,
 * never an uncaught rejection (which Next would surface as a 500).
 *
 * Part 2 — Store workflows: drives the real zustand store + IndexedDB
 * (fake-indexeddb) through cart math, discounts + PIN approval, split
 * payments, secure returns, debt settlement, expenses, and a full shift
 * Z-report, asserting the drawer/ledger invariants.
 */

import "fake-indexeddb/auto";

// Dummy credentials so route handlers construct a live-looking client that
// fails fast on every DB call (dead port) — validation paths must return 400
// BEFORE touching the network.
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

// The store + idb modules must load AFTER the polyfills above (ESM static
// imports hoist, so these are dynamic).
const { usePosStore } = await import("../store/usePosStore");
const { clearSyncQueue, enqueueSync, findInvoiceById, getSyncsByStatus, isInvoiceReturned, isQueueRecordForTenant, listInvoices, markSyncCompleted } = await import("../lib/idb");
const { sha256Hex } = await import("../lib/sha256");
const { recognizedRevenue, resolveGrossProfit } = await import("../lib/accounting");
const { searchCategoryHierarchy } = await import("../lib/categoryTree");
const {
  STAFF_CAPABILITIES,
  STAFF_ROLE_PRESETS,
  capabilityForAdminPath,
  hasCapability,
} = await import("../lib/permissions");

import type { SyncQueueRecord } from "../lib/idb";
import type {
  Cashier,
  CategoryMap,
  PosSnapshot,
  ProductMap,
  BarcodeMap,
  BarcodeIndex,
  QuickKeyItem,
  PaymentMethod,
  SaleItem,
} from "../types/pos.types";

let pass = 0;
let fail = 0;
const failures: string[] = [];
let adminCookie = "";
let deviceCookie = "";

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
  "79661601001": { barcode: "79661601001", productId: "p1", variantId: "v-79661601001", variantLabel: "", unitName: "عبوة", qtyMultiplier: 1, price: 10, costPrice: 6 },
  "44444": { barcode: "44444", productId: "p4", variantId: "v-44444", variantLabel: "", unitName: "كرتونة", qtyMultiplier: 12, price: 10, costPrice: 5, isDefaultSale: true },
};

const barcodeIndex: BarcodeIndex = {
  "11111": { product_id: "p1", variantId: "v-11111", name: "كولا", price: 10, variantLabel: "" },
  "22222": { product_id: "p2", variantId: "v-22222", name: "ماء", price: 5, variantLabel: "" },
  "33333": { product_id: "p3", variantId: "v-33333", name: "شيبس", price: 20, variantLabel: "" },
  "79661601001": { product_id: "p1", variantId: "v-79661601001", name: "كولا", price: 10, variantLabel: "" },
  "44444": { product_id: "p4", variantId: "v-44444", name: "منتج شامل الضريبة", price: 10, variantLabel: "" },
};

const quickKeys: QuickKeyItem[] = [
  { id: "qk1", categoryId: "c1", label: "كولا", bgColor: "#0f766e", sortOrder: 1, productId: "p1", unitName: "عبوة", price: 10, barcode: "11111" },
];

const TEST_PIN_SALT = "pos-test-salt-v1";
const pinHash = (pin: string): string => sha256Hex(pin + TEST_PIN_SALT);

/** Mirrors the store's offline-unlock threshold (usePosStore F3 lockout). */
const PIN_MAX_ATTEMPTS = 5;

const cashiers: Cashier[] = [
  { id: "cashier-1", name: "كاشير", pinHash: pinHash("1111"), role: "cashier" },
  // Owner/cashier separation: the owner row holds NO PIN hash — it can only
  // log in with email + password and must never unlock a register.
  { id: "admin-1", name: "مدير", pinHash: "", role: "admin" },
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

// ---------------------------------------------------------------------------
// Part 1: route validation (throwaway client, dead port 9)
// ---------------------------------------------------------------------------

/** Store-scoped request builder: admin flag controls the role header, store
 *  controls the `x-pos-store-id` header (defaults on so the live branch
 *  reaches its validation/DB logic instead of short-circuiting at the
 *  store-isolation guard). */
function makeReq(method: string, body?: string, admin = false, store = true): Request {
  const headers: Record<string, string> = {};
  if (admin) headers["x-pos-role"] = "admin";
  if (store) headers["x-pos-store-id"] = "store-main";
  if (store) headers.Cookie = admin ? adminCookie : deviceCookie;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return new Request("http://localhost/api", { method, headers, body });
}

async function expectResponse(
  label: string,
  fn: () => Promise<Response>,
  expected: number,
): Promise<void> {
  try {
    const res = await fn();
    let jsonOk = true;
    try {
      await res.json();
    } catch {
      jsonOk = false;
    }
    check(`${label} -> ${expected}`, res.status === expected);
    check(`${label} JSON body`, jsonOk);
  } catch (err) {
    check(`${label} -> ${expected} (uncaught: ${String(err)})`, false);
  }
}

async function routeValidation(): Promise<void> {
  console.log("\n[route validation]");

  const { adminSessionCookieHeader } = await import("../lib/adminSession");
  const { deviceSessionCookieHeader } = await import("../lib/deviceSession");
  adminCookie = adminSessionCookieHeader({
    storeId: "store-main",
    email: "admin@demo.test",
    name: "مدير الاختبار",
  }).split(";", 1)[0];
  deviceCookie = deviceSessionCookieHeader({
    storeId: "store-main",
    actorId: "cashier-test",
    actorName: "كاشير الاختبار",
    role: "cashier",
  }).split(";", 1)[0];

  const customers = await import("../app/api/customers/route");
  const suppliers = await import("../app/api/suppliers/route");
  const expenses = await import("../app/api/expenses/route");
  const purchaseOrders = await import("../app/api/purchase-orders/route");
  const customerTx = await import("../app/api/customers/[id]/transactions/route");
  const importRoute = await import("../app/api/catalog/import/route");
  const syncRoute = await import("../app/api/sync/route");
  const loginRoute = await import("../app/api/login/route");
  const storesRoute = await import("../app/api/stores/route");
  const adminStores = await import("../app/api/admin/stores/route");
  const adminStoresId = await import("../app/api/admin/stores/[id]/route");
  const settingsRoute = await import("../app/api/settings/route");
  const loyaltyRoute = await import("../app/api/loyalty/route");
  const auditRoute = await import("../app/api/admin/audit/route");
  const reportsOverviewRoute = await import("../app/api/reports/overview/route");
  const printServerRoute = await import("../app/api/print-server/route");

  const POST = (name: string, fn: () => Promise<Response>, expected: number): Promise<void> =>
    expectResponse(name, fn, expected);

  // Store isolation: a request that does not identify a store must be
  // rejected (400) before any DB work happens — tenants can never cross.
  await POST("customers POST no-session", () => customers.POST(makeReq("POST", '{"name":"x"}', true, false)), 401);
  await POST("customers GET no-session", () => customers.GET(makeReq("GET", undefined, false, false)), 401);
  await POST("suppliers POST no-session", () => suppliers.POST(makeReq("POST", '{"name":"مورد"}', true, false)), 401);
  await POST("expenses POST no-session", () => expenses.POST(makeReq("POST", '{"category":"transport","amount":5}', true, false)), 401);
  await POST("purchase-orders POST no-session", () => purchaseOrders.POST(makeReq("POST", '{"supplier_id":"s"}', true, false)), 401);
  await POST("catalog/import POST no-session", () => importRoute.POST(makeReq("POST", "csv", true, false)), 401);
  await POST("sync POST no-session", () => syncRoute.POST(makeReq("POST", JSON.stringify([]), false, false)), 401);
  await POST("customer-tx POST no-store-header", () =>
    customerTx.POST(makeReq("POST", '{"type":"SETTLEMENT","amount":10}', true, false), { params: Promise.resolve({ id: "some-id" }) }),
  401);

  // customers
  await POST("customers POST cashier -> DB attempt", () => customers.POST(makeReq("POST", '{"name":"x"}')), 500);
  await POST("customers POST missing body", () => customers.POST(makeReq("POST", undefined, true)), 400);
  await POST("customers POST malformed json", () => customers.POST(makeReq("POST", "{oops", true)), 400);
  await POST("customers POST missing name", () => customers.POST(makeReq("POST", "{}", true)), 400);
  const cashierCustomerReq = new Request("http://localhost/api", {
    method: "POST",
    headers: { Cookie: deviceCookie, "x-pos-role": "cashier", "x-pos-store-id": "store-main", "Content-Type": "application/json" },
    body: '{"name":"زبون كاشير","phone":"077"}',
  });
  await POST("customers POST cashier -> DB attempt", () => customers.POST(cashierCustomerReq), 500);
  await POST("customers POST valid -> DB attempt", () => customers.POST(makeReq("POST", '{"name":"زبون","phone":"077"}', true)), 500);

  // suppliers
  await POST("suppliers POST cashier-session", () => suppliers.POST(makeReq("POST", '{"name":"مورد"}')), 403);
  await POST("suppliers POST missing body", () => suppliers.POST(makeReq("POST", undefined, true)), 400);
  await POST("suppliers POST missing name", () => suppliers.POST(makeReq("POST", "{}", true)), 400);
  await POST("suppliers POST valid -> DB attempt", () => suppliers.POST(makeReq("POST", '{"name":"مورد"}', true)), 500);
  await POST("suppliers PUT missing id", () => suppliers.PUT(makeReq("PUT", '{"name":"مورد"}', true)), 400);
  await POST("suppliers PUT missing body", () => suppliers.PUT(makeReq("PUT", undefined, true)), 400);
  const putValid = new Request("http://localhost/api?id=s-1", {
    method: "PUT",
    headers: { Cookie: adminCookie, "x-pos-role": "admin", "x-pos-store-id": "store-main", "Content-Type": "application/json" },
    body: '{"name":"مورد"}',
  });
  await expectResponse("suppliers PUT valid -> DB attempt", () => suppliers.PUT(putValid), 500);
  // expenses
  await POST("expenses POST cashier-session", () => expenses.POST(makeReq("POST", '{"category":"transport","amount":5}')), 403);
  await POST("expenses POST missing body", () => expenses.POST(makeReq("POST", undefined, true)), 400);
  await POST("expenses POST bad category", () => expenses.POST(makeReq("POST", '{"category":"bogus","amount":5}', true)), 400);
  await POST("expenses POST zero amount", () => expenses.POST(makeReq("POST", '{"category":"transport","amount":0}', true)), 400);
  await POST("expenses POST valid -> DB attempt", () => expenses.POST(makeReq("POST", '{"category":"transport","amount":5}', true)), 500);

  // purchase-orders
  await POST("purchase-orders POST cashier-session", () => purchaseOrders.POST(makeReq("POST", '{"supplier_id":"s"}')), 403);
  await POST("purchase-orders POST missing body", () => purchaseOrders.POST(makeReq("POST", undefined, true)), 400);
  await POST("purchase-orders POST missing supplier", () => purchaseOrders.POST(makeReq("POST", "{}", true)), 400);
  await POST("purchase-orders POST no items", () => purchaseOrders.POST(makeReq("POST", '{"supplier_id":"s"}', true)), 400);
  await POST("purchase-orders POST bad item", () => purchaseOrders.POST(makeReq("POST", '{"supplier_id":"s","items":[{"product_id":"","quantity":1,"unit_cost":1}]}', true)), 400);
  await POST("purchase-orders POST valid -> DB attempt", () =>
    purchaseOrders.POST(makeReq("POST", '{"supplier_id":"s","items":[{"product_id":"p","quantity":2,"unit_cost":3}]}', true)),
  500);
  await POST("purchase-orders PATCH missing id", () => purchaseOrders.PATCH(makeReq("PATCH", "{}", true)), 400);
  await POST("purchase-orders PATCH missing body", () => purchaseOrders.PATCH(makeReq("PATCH", undefined, true)), 400);
  await POST("purchase-orders PATCH valid -> lookup miss/404", () => purchaseOrders.PATCH(makeReq("PATCH", '{"id":"po-1"}', true)), 404);

  // customers/[id]/transactions
  const txCtx = { params: Promise.resolve({ id: "some-id" }) };
  await POST("customer-tx POST cashier-session", () => customerTx.POST(makeReq("POST", '{"type":"SETTLEMENT","amount":10}'), txCtx), 403);
  await POST("customer-tx POST missing body", () => customerTx.POST(makeReq("POST", undefined, true), txCtx), 400);
  await POST("customer-tx POST bad type", () => customerTx.POST(makeReq("POST", '{}', true), txCtx), 400);
  await POST("customer-tx POST zero amount", () => customerTx.POST(makeReq("POST", '{"type":"SETTLEMENT","amount":0}', true), txCtx), 400);
  await POST("customer-tx POST valid -> lookup miss/404", () =>
    customerTx.POST(makeReq("POST", '{"type":"SETTLEMENT","amount":10}', true), txCtx),
  404);

  // catalog/import
  await POST("catalog/import POST cashier-session", () => importRoute.POST(makeReq("POST", "csv", false)), 403);
  await POST("catalog/import POST empty text", () => importRoute.POST(makeReq("POST", "", true)), 400);
  await POST("catalog/import POST header only", () => importRoute.POST(makeReq("POST", "Category, Product Name\n", true)), 400);
  const validCsv =
    "Category, Product Name, Base Unit, Barcode, Unit Name, Multiplier, Cost Price, Selling Price, Total Stock, Is Quick Key\n" +
    "ألبان, حليب, عبوة, 90001, عبوة, 1, 0.8, 1.2, 10, no\n";
  await POST("catalog/import POST valid -> DB attempt", () => importRoute.POST(makeReq("POST", validCsv, true)), 500);

  // sync: malformed always 400; valid batch must not crash (live branch hits dead DB)
  await POST("sync POST missing body", () => syncRoute.POST(makeReq("POST", undefined, false)), 400);
  await POST("sync POST malformed json", () => syncRoute.POST(makeReq("POST", "{bad", false)), 400);
  await POST("sync POST non-array", () => syncRoute.POST(makeReq("POST", '"hello"', false)), 400);
  const syncEvent = JSON.stringify([
    {
      sync_id: "route-sync-1",
      action_type: "INVOICE_CREATED",
      payload: { items: [], subtotal: 0, tax: 0, discount: 0, total: 0, paymentMethod: "CASH", amountPaid: 0, change: 0, completed_at: new Date().toISOString() },
    },
  ]);
  await expectResponse("sync POST valid -> structured response", () => syncRoute.POST(makeReq("POST", syncEvent, false)), 500);

  // sync: BARCODE_LABEL_PRINT deep validation (Phase 4 remote label printing).
  // Rejected events are NOT 400s — the route returns 200 with a `rejected`
  // list so the client quarantines the exact ids. Pin the specific reason.
  const labelEvent = (payload: unknown): string =>
    JSON.stringify([{ sync_id: "route-label-1", action_type: "BARCODE_LABEL_PRINT", payload }]);
  const expectRejected = async (
    name: string,
    fn: () => Promise<Response>,
    reason: string,
  ): Promise<void> => {
    try {
      const res = await fn();
      const body = (await res.json()) as { rejected?: Array<{ sync_id: string; reason: string }> };
      check(`${name} -> 200`, res.status === 200);
      check(`${name} rejected as ${reason}`, body?.rejected?.some((r) => r.reason === reason) === true);
    } catch (err) {
      check(`${name} uncaught (${String(err)})`, false);
    }
  };
  await expectRejected("sync label_print bad price", () =>
    syncRoute.POST(makeReq("POST", labelEvent({ barcode: "X", name: "صنف", price: -1, quantity: 1, templateSize: { widthMm: 40, heightMm: 30 } }), false)), "label_print_bad_price");
  await expectRejected("sync label_print bad quantity", () =>
    syncRoute.POST(makeReq("POST", labelEvent({ barcode: "X", name: "صنف", price: 5, quantity: 0, templateSize: { widthMm: 40, heightMm: 30 } }), false)), "label_print_bad_quantity");
  await expectRejected("sync label_print bad template size", () =>
    syncRoute.POST(makeReq("POST", labelEvent({ barcode: "X", name: "صنف", price: 5, quantity: 1, templateSize: { widthMm: -1, heightMm: 30 } }), false)), "label_print_bad_template_size");
  await expectRejected("sync label_print missing barcode", () =>
    syncRoute.POST(makeReq("POST", labelEvent({ barcode: "  ", name: "صنف", price: 5, quantity: 1, templateSize: { widthMm: 40, heightMm: 30 } }), false)), "label_print_missing_barcode");
  await expectRejected("sync label_print missing name", () =>
    syncRoute.POST(makeReq("POST", labelEvent({ barcode: "X", name: " ", price: 5, quantity: 1, templateSize: { widthMm: 40, heightMm: 30 } }), false)), "label_print_missing_name");
  await POST("sync POST label_print valid -> DB attempt", () =>
    syncRoute.POST(makeReq("POST", labelEvent({ barcode: "X", name: "صنف", unitName: "حبة", price: 5, quantity: 2, templateSize: { widthMm: 40, heightMm: 30 }, created_at: new Date().toISOString() }), false)), 500);

  // print-server kiosk drain endpoint (Phase 4).
  await POST("print-server POST missing body", () => printServerRoute.POST(makeReq("POST", undefined, false)), 400);
  await POST("print-server POST no action", () => printServerRoute.POST(makeReq("POST", "{}", false)), 400);
  await POST("print-server POST unknown action", () => printServerRoute.POST(makeReq("POST", '{"action":"explode"}', false)), 400);
  await POST("print-server POST claim no-session", () => printServerRoute.POST(makeReq("POST", '{"action":"claim"}', false, false)), 401);
  await POST("print-server POST claim -> DB attempt", () => printServerRoute.POST(makeReq("POST", '{"action":"claim","workerId":"w1"}', false)), 500);
  await POST("print-server POST resolve missing jobId", () => printServerRoute.POST(makeReq("POST", '{"action":"resolve"}', false)), 400);
  await POST("print-server POST resolve -> DB attempt", () => printServerRoute.POST(makeReq("POST", '{"action":"resolve","jobId":"j-1"}', false)), 500);
  await POST("print-server POST purge -> DB attempt", () => printServerRoute.POST(makeReq("POST", '{"action":"purge"}', false)), 500);

  // login + store registry
  const loginReq = (pin: string, storeId?: string): Request => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (storeId !== undefined) headers["x-pos-store-id"] = storeId;
    return new Request("http://localhost/api/login", {
      method: "POST",
      headers,
      body: JSON.stringify({ pin, storeId }),
    });
  };
  await POST("login POST missing storeId", () => loginRoute.POST(loginReq("1234")), 400);
  await POST("login POST missing pin", () => loginRoute.POST(loginReq("", "store-main")), 400);
  await POST("login POST short pin", () => loginRoute.POST(loginReq("12", "store-main")), 400);
  await POST("login POST wrong pin -> DB attempt", () => loginRoute.POST(loginReq("0000", "store-main")), 500);
  await POST("login POST valid -> DB attempt", () => loginRoute.POST(loginReq("1234", "store-main")), 500);
  await expectResponse("stores GET -> structured response", () => storesRoute.GET(), 500);

  // super-admin provisioning gates (dead DB => pin can never verify -> 403)
  const superReq = (method: string, body?: string, pin?: string): Request => {
    const headers: Record<string, string> = {};
    if (pin) headers["x-pos-super-admin-pin"] = pin;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return new Request("http://localhost/api", { method, headers, body });
  };
  await POST("admin/stores GET no-pin", () => adminStores.GET(superReq("GET")), 403);
  await POST("admin/stores GET wrong-pin", () => adminStores.GET(superReq("GET", undefined, "0000")), 403);
  await POST("admin/stores GET with-pin (dead DB -> 403)", () => adminStores.GET(superReq("GET", undefined, "7777")), 403);
  await POST("admin/stores POST no-pin", () => adminStores.POST(superReq("POST", '{"name":"متجر"}')), 403);
  await POST("admin/stores POST with-pin (dead DB -> 403)", () => adminStores.POST(superReq("POST", '{"name":"متجر"}', "7777")), 403);
  await POST("admin/stores PATCH no-pin", () =>
    adminStoresId.PATCH(superReq("PATCH", '{"subscription_status":"suspended"}'), { params: Promise.resolve({ id: "store-main" }) }),
  403);
  await POST("admin/stores PATCH bad status -> gate first", () =>
    adminStoresId.PATCH(superReq("PATCH", '{"subscription_status":"bogus"}', "7777"), { params: Promise.resolve({ id: "store-main" }) }),
  403);

  // tenant settings: now gated by the server-issued admin session cookie (F2)
  // rather than the client-supplied store/role headers.
  await POST("settings GET without admin session", () => settingsRoute.GET(), 401);
  await POST("settings GET without admin session (2)", () => settingsRoute.GET(), 401);
  await POST("settings PATCH without admin session", () =>
    settingsRoute.PATCH(makeReq("PATCH", '{"name":"متجر"}', true, false)),
  401);
  await POST("settings PATCH without admin session (2)", () =>
    settingsRoute.PATCH(makeReq("PATCH", '{"name":"متجر"}', false, true)),
  401);
  await POST("settings PATCH missing body (gated)", () =>
    settingsRoute.PATCH(makeReq("PATCH", undefined, true)),
  401);
  await POST("settings PATCH empty name (gated)", () =>
    settingsRoute.PATCH(makeReq("PATCH", '{"name":""}', true)),
  401);
  await POST("settings PATCH valid (gated)", () =>
    settingsRoute.PATCH(makeReq("PATCH", '{"name":"متجر","receipt_footer":"أهلاً"}', true)),
  401);

  await POST("reports overview GET cashier without capability", () => reportsOverviewRoute.GET(makeReq("GET")), 403);

  // loyalty ledger (tenant-scoped reads + admin writes)
  await POST("loyalty GET no-session", () => loyaltyRoute.GET(makeReq("GET", undefined, false, false)), 401);
  await POST("loyalty GET valid -> DB attempt", () => loyaltyRoute.GET(makeReq("GET", undefined, true)), 500);
  await POST("loyalty POST no-session", () =>
    loyaltyRoute.POST(makeReq("POST", '{"action":"adjust","customer_id":"c-1","points":1}', true, false)),
  401);
  await POST("loyalty POST cashier-session", () =>
    loyaltyRoute.POST(makeReq("POST", '{"action":"adjust","customer_id":"c-1","points":1}', false, true)),
  403);
  await POST("loyalty POST missing body", () => loyaltyRoute.POST(makeReq("POST", undefined, true)), 400);
  await POST("loyalty POST malformed json", () => loyaltyRoute.POST(makeReq("POST", "{oops", true)), 400);
  await POST("loyalty POST missing customer", () =>
    loyaltyRoute.POST(makeReq("POST", '{"action":"adjust","points":1}', true)),
  400);
  await POST("loyalty POST bad action", () =>
    loyaltyRoute.POST(makeReq("POST", '{"action":"bogus","customer_id":"c-1","points":1}', true)),
  400);
  await POST("loyalty POST earn zero amount", () =>
    loyaltyRoute.POST(makeReq("POST", '{"action":"earn","customer_id":"c-1","amount":0,"reference":"r"}', true)),
  400);
  await POST("loyalty POST redeem zero points", () =>
    loyaltyRoute.POST(makeReq("POST", '{"action":"redeem","customer_id":"c-1","points":0}', true)),
  400);
  await POST("loyalty POST adjust zero points", () =>
    loyaltyRoute.POST(makeReq("POST", '{"action":"adjust","customer_id":"c-1","points":0}', true)),
  400);
  await POST("loyalty POST valid -> DB attempt", () =>
    loyaltyRoute.POST(makeReq("POST", '{"action":"adjust","customer_id":"c-1","points":5}', true)),
  500);

  // P3: immutable admin audit log (append-only ledger)
  const auditReq = (method: string, body?: string, email = true, store = true): Request => {
    const headers: Record<string, string> = {};
    if (email) headers["x-pos-admin-email"] = "admin@demo.test";
    if (store) headers["x-pos-store-id"] = "store-main";
    if (store) headers.Cookie = adminCookie;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return new Request("http://localhost/api", { method, headers, body });
  };
  await POST("audit GET ignores legacy email header -> DB attempt", () => auditRoute.GET(auditReq("GET", undefined, false)), 500);
  await POST("audit GET no-session", () => auditRoute.GET(auditReq("GET", undefined, true, false)), 401);
  await POST("audit POST ignores legacy email header -> DB attempt", () =>
    auditRoute.POST(auditReq("POST", JSON.stringify({ action_type: "OPEN_DRAWER" }), false)),
  500);
  await POST("audit POST missing-body", () => auditRoute.POST(auditReq("POST", undefined)), 400);
  await POST("audit POST malformed json", () => auditRoute.POST(auditReq("POST", "{oops")), 400);
  await POST("audit POST bad-action", () =>
    auditRoute.POST(auditReq("POST", JSON.stringify({ action_type: "HACK" }))),
  400);
  await POST("audit POST bad-details", () =>
    auditRoute.POST(auditReq("POST", JSON.stringify({ action_type: "OPEN_DRAWER", details: [1, 2] }))),
  400);
  await POST("audit POST no-session", () =>
    auditRoute.POST(auditReq("POST", JSON.stringify({ action_type: "OPEN_DRAWER" }), true, false)),
  401);
  await POST("audit GET valid -> DB attempt", () => auditRoute.GET(auditReq("GET")), 500);
  await POST("audit POST valid -> DB attempt", () =>
    auditRoute.POST(
      auditReq("POST", JSON.stringify({ action_type: "OVERRIDE_PRICE", target_id: "p1", details: { from: 10, to: 12 } })),
    ),
  500);
  await POST("audit POST return-mode action -> DB attempt", () =>
    auditRoute.POST(
      auditReq("POST", JSON.stringify({ action_type: "ENTER_RETURN_MODE", details: { cashierId: "cashier-1" } })),
    ),
  500);

  // Closed self-registration: stores are created only through the Super Admin
  // console (POST /api/admin/stores), so the public register endpoint always
  // refuses regardless of the payload.
  const registerRoute = await import("../app/api/auth/register/route");
  const regReq = (body?: string): Request => {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return new Request("http://localhost/api", { method: "POST", headers, body });
  };
  await POST("register POST blocked without body", () => registerRoute.POST(regReq()), 403);
  await POST("register POST blocked with valid body", () =>
    registerRoute.POST(regReq(JSON.stringify({ name: "متجر", owner_name: "مدير", email: "o@demo.test", password: "secret123" }))),
  403);
}

// ---------------------------------------------------------------------------
// Part 2: store workflows
// ---------------------------------------------------------------------------

async function cartMath(): Promise<void> {
  const store = usePosStore;
  store.getState().scanBarcode("11111");
  let state = st();
  check("cart: single scan qty", state.items.length === 1 && state.items[0].qty === 1);
  check("cart: single line total", state.items[0].lineTotal === 10);
  check("cart: totals 10 + 1.6 tax", state.totals.subtotal === 10 && state.totals.tax === 1.6 && state.totals.total === 11.6);

  store.getState().scanBarcode("11111");
  store.getState().scanBarcode("22222");
  state = st();
  check("cart: merge same barcode", state.items.length === 2 && state.items[0].qty === 2);
  check("cart: 3-line subtotal 25 / total 29", state.totals.subtotal === 25 && state.totals.total === 29);

  store.getState().updateQty(0, 3);
  state = st();
  check("cart: updateQty recomputes line", state.items[0].qty === 3 && state.items[0].lineTotal === 30);
  check("cart: totals 35 / 40.6", state.totals.subtotal === 35 && state.totals.total === 40.6);

  store.getState().updateQty(1, 0);
  state = st();
  check("cart: zero qty removes line", state.items.length === 1 && state.items[0].barcode === "11111");

  store.getState().removeItem(0);
  state = st();
  check("cart: removeItem empties", state.items.length === 0 && state.totals.total === 0);

  store.getState().clearInvoice();
  check("cart: clearInvoice on empty -> error", st().notice?.tone === "error");

  store.getState().scanBarcode("00000");
  check("cart: unknown barcode -> error notice", (st().notice?.message ?? "").includes("غير معروف"));

  store.getState().scanBarcode(" 79661601001 ");
  state = st();
  check("cart: imported long barcode scans", state.items.length === 1 && state.items[0].barcode === "79661601001");
  store.getState().clearInvoice();

  store.getState().addQuickKeyItem(quickKeys[0]);
  state = st();
  check("cart: quick key adds its default barcode unit", state.items.length === 1 && state.items[0].qty === 1 && state.items[0].unitPrice === 10 && state.items[0].barcode === "11111" && state.items[0].unitName === "عبوة");
  store.getState().clearInvoice();

  store.getState().addSearchItem("p4", 1, "44444");
  state = st();
  check("tax: explicit barcode lookup uses its unit", state.items[0].barcode === "44444" && state.items[0].unitName === "كرتونة");
  check("tax: VAT-inclusive 10 -> net 8.62 + tax 1.38", state.totals.subtotal === 8.62 && state.totals.tax === 1.38 && state.totals.total === 10);
}

async function discounts(): Promise<void> {
  const store = usePosStore;
  // Owner session (Admin Mode): the >10% approval gate can't intercept the
  // clamp tests — owner-mode discounts apply inline, no password gate.
  usePosStore.setState({
    adminSession: { storeId: "store-main", email: "admin@demo.test", name: "مدير" },
  });
  // Logged-in cashier so the register is unlocked and cart ops work.
  store.getState().loginCashier("1111");
  store.getState().scanBarcode("11111");
  store.getState().scanBarcode("11111");
  store.getState().scanBarcode("22222");

  store.getState().applyDiscount({ scope: "ITEM", index: 0, type: "PERCENT", value: 10 });
  let state = st();
  check("disc: item 10% of 20 -> 2", state.items[0].discount === 2 && state.items[0].lineTotal === 18);
  check("disc: tax is recalculated after item discount", state.totals.discount === 2 && state.totals.tax === 3.68 && state.totals.total === 26.68);

  store.getState().clearDiscount();
  state = st();
  check("disc: clear restores line + totals", state.items[0].discount === 0 && state.totals.discount === 0 && state.totals.total === 29);

  store.getState().applyDiscount({ scope: "TOTAL", type: "FIXED", value: 5 });
  state = st();
  check("disc: total fixed 5 reduces taxable base", state.invoiceDiscount?.value === 5 && state.totals.discount === 5 && state.totals.total === 23.2);

  store.getState().applyDiscount({ scope: "TOTAL", type: "PERCENT", value: 100 });
  state = st();
  check("disc: 100% clears taxable base and tax", state.totals.discount === 25 && state.totals.tax === 0 && state.totals.total === 0);

  store.getState().clearInvoice();
  store.getState().scanBarcode("11111");
  store.getState().applyDiscount({ scope: "ITEM", index: 0, type: "PERCENT", value: 100 });
  store.getState().applyDiscount({ scope: "TOTAL", type: "PERCENT", value: 100 });
  state = st();
  check("disc: stacked 100% item + 100% invoice never negative", state.totals.total === 0 && state.totals.tax === 0);

  store.getState().clearInvoice();
  store.getState().applyDiscount({ scope: "TOTAL", type: "FIXED", value: 1 });
  check("disc: no items -> error", st().notice?.tone === "error");

  store.getState().applyDiscount({ scope: "TOTAL", type: "FIXED", value: 0 });
  check("disc: zero value -> error", st().notice?.tone === "error");

  store.getState().toggleReturnMode();
  store.getState().scanBarcode("11111");
  store.getState().applyDiscount({ scope: "TOTAL", type: "FIXED", value: 1 });
  check("disc: return invoice blocked", (st().notice?.message ?? "").includes("مرتجع"));
  store.getState().toggleReturnMode();
  store.getState().clearInvoice();
  usePosStore.setState({ adminSession: null });
}

async function discountApproval(): Promise<void> {
  const store = usePosStore;
  const ADMIN_SESSION = {
    storeId: "store-main",
    email: "admin@demo.test",
    name: "مدير",
  };

  check("approval: cashier login", store.getState().loginCashier("1111"));
  store.getState().scanBarcode("33333");

  // >10% opens the owner-password gate (secondary auth), never a PIN pad —
  // the owner/cashier separation means the owner has no PIN to type.
  store.getState().applyDiscount({ scope: "TOTAL", type: "PERCENT", value: 15 });
  let state = st();
  check(
    "approval: >10% opens password gate",
    state.isSecondaryAuthOpen === true &&
      state.pendingSecondaryAction?.type === "approve_discount",
  );
  check("approval: not applied yet", state.totals.discount === 0);

  // Wrong owner password: rejected, gate stays open, discount still off.
  check(
    "approval: wrong password rejected",
    (await store.getState().confirmSecondaryAction("wrong-pass")) === false,
  );
  check(
    "approval: gate still open",
    st().isSecondaryAuthOpen === true && st().totals.discount === 0,
  );
  store.getState().cancelSecondaryAuth();
  check(
    "approval: cancel keeps discount off",
    st().isSecondaryAuthOpen === false && st().totals.discount === 0,
  );

  // An offline (or failed) confirmation leaves the discount un-applied.
  store.getState().applyDiscount({ scope: "TOTAL", type: "PERCENT", value: 15 });
  check(
    "approval: offline confirm fails safely",
    (await store.getState().confirmSecondaryAction("admin-password")) === false,
  );
  check(
    "approval: discount untouched on failed confirm",
    st().totals.discount === 0 &&
      st().pendingSecondaryAction?.type === "approve_discount",
  );
  store.getState().cancelSecondaryAuth();

  // Fixed >50 opens the gate; cancel keeps it off.
  store.getState().clearInvoice();
  store.getState().scanBarcode("33333");
  store.getState().scanBarcode("33333");
  store.getState().scanBarcode("33333");
  store.getState().scanBarcode("33333");
  store.getState().applyDiscount({ scope: "TOTAL", type: "FIXED", value: 60 });
  state = st();
  check(
    "approval: fixed >50 opens gate",
    state.isSecondaryAuthOpen === true &&
      state.pendingSecondaryAction?.type === "approve_discount",
  );
  store.getState().cancelSecondaryAuth();
  state = st();
  check(
    "approval: cancel keeps discount off",
    state.isSecondaryAuthOpen === false &&
      state.pendingSecondaryAction === null &&
      state.totals.discount === 0,
  );

  // commitDiscount applies an approved discount directly (the real flow runs
  // it in confirmSecondaryAction after a successful password reverify).
  store.getState().commitDiscount({ scope: "TOTAL", type: "PERCENT", value: 5 });
  state = st();
  check(
    "approval: approved discount applied",
    state.totals.discount === 4 && state.totals.tax === 12.16 && state.totals.total === 88.16,
  );

  store.getState().clearInvoice();
  store.getState().logoutCashier();
  // An owner session (Admin Mode) bypasses the gate entirely.
  usePosStore.setState({ adminSession: ADMIN_SESSION });
  check("approval: cashier login", store.getState().loginCashier("1111"));
  store.getState().scanBarcode("33333");
  store.getState().applyDiscount({ scope: "TOTAL", type: "PERCENT", value: 15 });
  state = st();
  check(
    "approval: owner session bypasses gate",
    state.isSecondaryAuthOpen === false && state.totals.discount === 3,
  );
  usePosStore.setState({ adminSession: null });

  // F3 device lockout: 5 consecutive failures lock the offline unlock path.
  for (let i = 0; i < PIN_MAX_ATTEMPTS - 1; i++) {
    check(`lockout: attempt ${i + 1} rejected`, store.getState().loginCashier("0000") === false);
  }
  store.getState().loginCashier("0000");
  check("lockout: lock active", st().pinLockedUntil > Date.now());
  check("lockout: correct pin also blocked", store.getState().loginCashier("1111") === false);
  usePosStore.setState({ pinFailCount: 0, pinLockedUntil: 0, pinLockoutLevel: 0 });

  // F3: the online bootstrap path (loginStore) honours the same device
  // lockout — rejected before any fetch while locked.
  usePosStore.setState({ pinLockedUntil: Date.now() + 60_000, pinLockoutLevel: 1 });
  const onlineWhileLocked = await store.getState().loginStore("1111", "store-main");
  check("loginStore: locked -> rejected without fetch", onlineWhileLocked === false);
  check("loginStore: lockout notice shown", (st().notice?.message ?? "").includes("تم تعطيل رمز PIN مؤقتاً"));
  usePosStore.setState({ pinFailCount: 0, pinLockedUntil: 0, pinLockoutLevel: 0, notice: null });
}

async function paymentsAndGuards(): Promise<void> {
  const store = usePosStore;
  store.getState().loginCashier("1111");
  await store.getState().openShift(100);
  check("pay: shift opens at 100", st().shiftTotals.expectedCashInDrawer === 100);

  await store.getState().completeCheckout("CASH", 0);
  check("pay: empty cart blocked", st().notice?.tone === "error");

  store.getState().scanBarcode("11111");
  store.getState().scanBarcode("22222");
  await store.getState().completeCheckout("CASH", 20);
  let state = st();
  check("pay: cash sale totals", state.lastCompletedInvoice?.total === 17.4 && state.lastCompletedInvoice?.change === 2.6);
  check("pay: cash drawer +17.4", state.shiftTotals.cashSales === 17.4 && state.shiftTotals.expectedCashInDrawer === 117.4);
  check("pay: items cleared", state.items.length === 0);
  const pendingAfterCash = await getSyncsByStatus("PENDING");
  const cashInvoiceEvent = pendingAfterCash.find(
    (r): r is Extract<SyncQueueRecord, { action_type: "INVOICE_CREATED" }> =>
      r.action_type === "INVOICE_CREATED" && r.sync_id === state.lastCompletedInvoice?.syncId,
  );
  check("pay: invoice payload carries cashierId", cashInvoiceEvent?.payload.cashierId === "cashier-1");
  check("pay: invoice payload carries shiftId", cashInvoiceEvent?.payload.shiftId === state.shiftState.shiftId);

  store.getState().scanBarcode("11111");
  await store.getState().completeCheckout("VISA", 0);
  state = st();
  check("pay: visa doesn't touch drawer", state.shiftTotals.visaSales === 11.6 && state.shiftTotals.expectedCashInDrawer === 117.4);

  store.getState().scanBarcode("22222");
  await store.getState().completeCheckout("SPLIT", 3);
  state = st();
  check("pay: split cash 3 / card 2.8", state.shiftTotals.cashSales === 20.4 && state.shiftTotals.visaSales === 14.4 && state.shiftTotals.expectedCashInDrawer === 120.4);

  store.getState().scanBarcode("11111");
  await store.getState().completeCheckout("SPLIT", 30);
  state = st();
  check("pay: overpaid split all cash", state.lastCompletedInvoice?.change === 18.4 && state.shiftTotals.cashSales === 32 && state.shiftTotals.visaSales === 14.4);

  store.getState().scanBarcode("33333");
  await store.getState().completeCheckout("DEBT", 0, "أحمد");
  state = st();
  check("pay: debt sale on ledger only", state.shiftTotals.debtSales === 23.2 && state.shiftTotals.expectedCashInDrawer === 132);
  check("pay: debt customer recorded", state.lastCompletedInvoice?.customerName === "أحمد");
  check("pay: transactions count", state.shiftTransactions.length === 5);

  const before = st().shiftTransactions.length;
  store.getState().scanBarcode("11111");
  await store.getState().completeCheckout("INVALID" as unknown as PaymentMethod, 0);
  state = st();
  check("pay: invalid method blocked", state.notice?.tone === "error" && state.items.length === 1 && state.shiftTransactions.length === before);

  await store.getState().completeCheckout("DEBT", 0, "");
  state = st();
  check("pay: debt without customer blocked", state.notice?.tone === "error" && state.items.length === 1);
}

async function closedShiftGuard(): Promise<void> {
  const store = usePosStore;
  store.getState().scanBarcode("11111");
  await store.getState().completeCheckout("CASH", 20);
  const state = st();
  check("guard: checkout without open shift blocked", state.notice?.tone === "error" && state.items.length === 1);
}

async function returnsFlow(): Promise<void> {
  const store = usePosStore;
  store.getState().loginCashier("1111");
  await store.getState().openShift(100);
  store.getState().scanBarcode("11111");
  store.getState().scanBarcode("33333");
  await store.getState().completeCheckout("CASH", 40);
  const syncId = st().lastCompletedInvoice?.syncId ?? "";
  check("return: original invoice completed", syncId.length > 0);

  store.getState().toggleReturnMode();
  const began = await store.getState().beginReturnByInvoice(syncId);
  let state = st();
  check("return: begin by invoice id", began === true && state.isReturnMode === true);
  check("return: items negated", state.items.length === 2 && state.items[0].qty === -1 && state.items[0].lineTotal === -10);
  check("return: totals negative", state.totals.total === -34.8 && state.totals.subtotal === -30);
  check("return: reference set", state.returnReference?.originalSyncId === syncId);

  await store.getState().completeCheckout("CASH", 0);
  state = st();
  check("return: drawer reversed", state.shiftTotals.cashSales === 0 && state.shiftTotals.expectedCashInDrawer === 100);
  check("return: returns counter", state.shiftTotals.returns === 34.8);
  check("return: return mode exits after checkout", state.isReturnMode === false && state.returnReference === null);

  check("return: unknown id rejected", (await store.getState().beginReturnByInvoice("missing-invoice")) === false);

  // Card (VISA) returns are allowed: the store accepts a negative amountPaid
  // on a return invoice and buckets it to card only.
  store.getState().scanBarcode("22222");
  await store.getState().completeCheckout("CASH", 5.8);
  const visaReturnSync = st().lastCompletedInvoice?.syncId ?? "";
  check("return: second invoice completed", visaReturnSync.length > 0);
  store.getState().toggleReturnMode();
  await store.getState().beginReturnByInvoice(visaReturnSync);
  await store.getState().completeCheckout("VISA", st().totals.total);
  state = st();
  check("return: visa refund buckets card only", state.shiftTotals.visaSales === -5.8 && state.shiftTotals.cashSales === 5.8 && state.shiftTotals.returns === 40.6);

  store.getState().toggleReturnMode();
  await store.getState().scanBarcode("9876543210");
  state = st();
  check("return: unknown barcode in return mode -> notice", (state.notice?.message ?? "").includes("غير معروف"));
  store.getState().toggleReturnMode();
}

async function shiftLifecycle(): Promise<void> {
  const store = usePosStore;
  store.getState().loginCashier("1111");
  await store.getState().openShift(100);

  store.getState().scanBarcode("11111");
  await store.getState().completeCheckout("CASH", 11.6);
  store.getState().scanBarcode("22222");
  await store.getState().completeCheckout("VISA", 0);
  store.getState().scanBarcode("33333");
  await store.getState().completeCheckout("DEBT", 0, "محمود");
  await store.getState().processDebtSettlement("محمود", 30, "customer-mahmoud");
  usePosStore.setState({ isExpenseModalOpen: true });
  await store.getState().recordExpense("transport", 10);

  let state = st();
  check("shift: expense modal closes after save", state.isExpenseModalOpen === false);
  check("shift: drawer math", state.shiftTotals.expectedCashInDrawer === 131.6);
  check("shift: bucket sums", state.shiftTotals.cashSales === 11.6 && state.shiftTotals.visaSales === 5.8 && state.shiftTotals.debtSales === 23.2);
  check("shift: collections + expenses", state.shiftTotals.debtCollections === 30 && state.shiftTotals.expenses === 10);
  check("shift: totalSales", state.shiftTotals.totalSales === 40.6);

  await store.getState().closeShift(131.6);
  state = st();
  check("shift: closed with zero variance", state.shiftState.status === "CLOSED" && state.shiftTotals.totalSales === 0);

  const pending = await getSyncsByStatus("PENDING");
  const closed = pending.find((r) => r.action_type === "SHIFT_CLOSED");
  const settlement = pending.find((r) => r.action_type === "DEBT_SETTLEMENT");
  check(
    "shift: debt settlement carries customer id",
    settlement?.action_type === "DEBT_SETTLEMENT" && settlement.payload.customerId === "customer-mahmoud",
  );
  check("shift: SHIFT_CLOSED queued", closed !== undefined);
  if (closed) {
    const p = closed.payload as unknown as Record<string, number>;
    check(
      "shift: z-report payload correct",
      p.startingCash === 100 &&
        p.cashSales === 11.6 &&
        p.visaSales === 5.8 &&
        p.debtSales === 23.2 &&
        p.debtCollections === 30 &&
        p.expenses === 10 &&
        p.expectedCashInDrawer === 131.6 &&
        p.actualCash === 131.6 &&
        p.variance === 0,
    );
  }

  await store.getState().recordExpense("transport", 0);
  check("shift: expense zero blocked", st().notice?.tone === "error");
  await store.getState().processDebtSettlement("", 10);
  check("shift: settlement empty name blocked", st().notice?.tone === "error");
  await store.getState().processDebtSettlement("محمود", 0);
  check("shift: settlement zero blocked", st().notice?.tone === "error");
  await store.getState().processDebtSettlement("محمود", 10);
  check("shift: settlement while closed blocked", st().notice?.tone === "error");

  await store.getState().openShift(50);
  store.getState().scanBarcode("11111");
  await store.getState().closeShift(50);
  state = st();
  check("shift: close with open items blocked", state.shiftState.status === "OPEN" && state.notice?.tone === "error");
}

async function heldInvoicePersistence(): Promise<void> {
  const store = usePosStore;
  store.getState().scanBarcode("11111");
  store.getState().scanBarcode("11111");
  store.getState().applyDiscount({ scope: "TOTAL", type: "FIXED", value: 5 });
  store.getState().holdInvoice();
  let state = st();
  check("hold: invoice parked", state.heldInvoices.length === 1 && state.items.length === 0);
  const heldId = state.heldInvoices[0].id;
  store.getState().restoreInvoice(heldId);
  state = st();
  check("hold: discount + totals restored", state.items.length === 1 && state.items[0].qty === 2 && state.invoiceDiscount?.value === 5 && state.totals.total === 17.4);
}

async function cartSurvivesReload(): Promise<void> {
  const store = usePosStore;
  store.getState().loginCashier("1111");
  await store.getState().openShift(100);
  store.getState().scanBarcode("11111");
  store.getState().applyDiscount({ scope: "TOTAL", type: "FIXED", value: 2 });
  store.getState().holdInvoice();
  store.getState().scanBarcode("33333");
  let state = st();
  check("reload: cart + held parked before refresh", state.items.length === 1 && state.heldInvoices.length === 1);

  // Catalog refresh mid-shift (what a normal reload does) must NOT wipe the
  // live cart or the held invoices (previously reset to [] on every load).
  store.getState().loadSnapshot(snapshot);
  state = st();
  check("reload: live cart survives loadSnapshot", state.items.length === 1 && state.items[0].qty === 1 && state.items[0].unitPrice === 20);
  check("reload: held invoice survives loadSnapshot", state.heldInvoices.length === 1 && state.heldInvoices[0].invoiceDiscount?.value === 2);
  check("reload: invoice discount survives", state.invoiceDiscount === null);
  await clearSyncQueue();
}

async function doubleReturnBlocked(): Promise<void> {
  const store = usePosStore;
  store.getState().loginCashier("1111");
  await store.getState().openShift(100);
  store.getState().scanBarcode("11111");
  await store.getState().completeCheckout("CASH", 11.6);
  const syncId = st().lastCompletedInvoice?.syncId ?? "";
  check("dreturn: original invoice completed", syncId.length > 0);

  store.getState().toggleReturnMode();
  const first = await store.getState().beginReturnByInvoice(syncId);
  check("dreturn: first return starts", first === true && st().isReturnMode === true);
  await store.getState().completeCheckout("CASH", 0);
  check("dreturn: return settled", st().returnReference === null && st().isReturnMode === false);

  store.getState().toggleReturnMode();
  const second = await store.getState().beginReturnByInvoice(syncId);
  check("dreturn: same invoice rejected (double return)", second === false && (st().notice?.message ?? "").includes("مرتجع"));
  store.getState().toggleReturnMode();
  await clearSyncQueue();
}

async function discountedReturnRefund(): Promise<void> {
  const store = usePosStore;
  store.getState().loginCashier("1111");
  // Owner session so the 25% invoice discount applies inline (no gate).
  usePosStore.setState({ adminSession: { storeId: "store-main", email: "admin@demo.test", name: "مدير" } });
  await store.getState().openShift(100);

  // Invoice-level discount: gross 30 (kola 20 + mada 5 + mada 5?) -> use
  // kola 20 + chips 20 = 40 gross, 25% invoice discount = 10 -> net 30.
  store.getState().scanBarcode("11111");
  store.getState().scanBarcode("11111");
  store.getState().scanBarcode("33333");
  store.getState().applyDiscount({ scope: "TOTAL", type: "PERCENT", value: 25 });
  let state = st();
  check("drefund: discounted invoice total 34.8", state.totals.discount === 10 && state.totals.total === 34.8 && state.totals.tax === 4.8);

  await store.getState().completeCheckout("CASH", 40);
  const syncId = st().lastCompletedInvoice?.syncId ?? "";
  check("drefund: invoice completed at net 34.8", syncId.length > 0 && st().lastCompletedInvoice?.total === 34.8);

  // Return must refund the DISCOUNTED net (34.8), not the gross (40) — the
  // over-refund would otherwise be exactly the 10.00 discount.
  store.getState().toggleReturnMode();
  await store.getState().beginReturnByInvoice(syncId);
  state = st();
  check("drefund: return restores discounted net", state.totals.total === -34.8 && state.totals.discount === 0);
  check("drefund: negated lines carry allocated discount", state.items[0].lineTotal === -15 && state.items[1].lineTotal === -15);

  await store.getState().completeCheckout("CASH", 0);
  state = st();
  check("drefund: drawer fully reversed to 100", state.shiftTotals.expectedCashInDrawer === 100 && state.shiftTotals.cashSales === 0 && state.shiftTotals.returns === 34.8);
  await clearSyncQueue();
  usePosStore.setState({ adminSession: null });
}

async function idbRoundTrip(): Promise<void> {
  const store = usePosStore;
  store.getState().loginCashier("1111");
  await store.getState().openShift(100);
  store.getState().scanBarcode("11111");
  await store.getState().completeCheckout("CASH", 11.6);

  const pending = await getSyncsByStatus("PENDING");
  const invoiceSync = st().lastCompletedInvoice?.syncId ?? "";
  check("idb: pending queue tracked", pending.some((r) => r.sync_id === invoiceSync));
  check("idb: pendingSyncCount matches", st().pendingSyncCount === pending.length);

  const found = await findInvoiceById(invoiceSync);
  check("idb: findInvoiceById works", found !== null && found.action_type === "INVOICE_CREATED");

  const ids = pending.map((r) => r.sync_id);
  await markSyncCompleted(ids);
  const stillPending = await getSyncsByStatus("PENDING");
  const synced = await getSyncsByStatus("SYNCED");
  check("idb: markSyncCompleted moves records", stillPending.length === 0 && synced.length === pending.length);
  check("idb: invoice still findable after sync", (await findInvoiceById(invoiceSync)) !== null);

  await clearSyncQueue();
  check("idb: clearSyncQueue empties", (await getSyncsByStatus("SYNCED")).length === 0);
}

async function loyaltyMath(): Promise<void> {
  const { pointsForAmount, pointsValue } = await import("../lib/loyalty");

  const config = { enabled: true, pointsPerSpend: 1, pointValue: 0.01 };
  check("loyalty: 10.00 at 1/point -> 10 points", pointsForAmount(10, config) === 10);
  check("loyalty: 9.99 at 1/point floors to 9", pointsForAmount(9.99, config) === 9);
  check("loyalty: 17.40 at 2/point -> 8 points", pointsForAmount(17.4, { ...config, pointsPerSpend: 2 }) === 8);
  check("loyalty: disabled -> 0 points", pointsForAmount(100, { ...config, enabled: false }) === 0);
  check("loyalty: zero amount -> 0 points", pointsForAmount(0, config) === 0);
  check("loyalty: points value 150 @ 0.01 -> 1.50", pointsValue(150, config) === 1.5);
  check("loyalty: negative points value clamps to 0", pointsValue(-5, config) === 0);

  // The checkout must carry the captured phone into the sync payload so the
  // server can register the new customer with a phone for loyalty lookups.
  const store = usePosStore;
  store.getState().loginCashier("1111");
  await store.getState().openShift(100);
  store.getState().scanBarcode("11111");
  await store.getState().completeCheckout("DEBT", 0, "ليلى", undefined, "0599999999");
  const pending = await getSyncsByStatus("PENDING");
  const debtRecord = pending.find((r) => r.action_type === "INVOICE_CREATED");
  check("loyalty: debt sync carries customerPhone", (debtRecord?.payload as { customerPhone?: string }).customerPhone === "0599999999");
  await clearSyncQueue();
}

async function fiscalQr(): Promise<void> {
  const { buildFiscalQrBase64, renderFiscalQrSvg, effectiveTaxPercent, fiscalAmount } = await import("../lib/qr");

  check("qr: effectiveTaxPercent uses valid store percent", effectiveTaxPercent({ taxPercent: 15 } as never) === 15);
  check("qr: effectiveTaxPercent honors 0 as tax-free", effectiveTaxPercent({ taxPercent: 0 } as never) === 0);
  check("qr: effectiveTaxPercent falls back to 16 for >100", effectiveTaxPercent({ taxPercent: 250 } as never) === 16);
  check("qr: effectiveTaxPercent falls back to 16 when missing", effectiveTaxPercent({} as never) === 16);
  check("qr: effectiveTaxPercent falls back to 16 for null", effectiveTaxPercent(null as never) === 16);
  check("qr: fiscalAmount rounds and never yields -0", fiscalAmount(-0.0004) === "0.00");
  check("qr: fiscalAmount fixes two decimals", fiscalAmount(116) === "116.00");

  const sellerName = "متجر التجربة";
  const fields: Array<[number, string]> = [
    [1, sellerName],
    [2, "311122233300003"],
    [3, "2026-08-06T12:00:00.000Z"],
    [4, "116.00"],
    [5, "16.00"],
  ];
  const b64 = buildFiscalQrBase64({
    sellerName,
    taxNumber: "311122233300003",
    timestamp: "2026-08-06T12:00:00.000Z",
    total: 116,
    tax: 16,
  });
  const bin = Buffer.from(b64, "base64");
  let off = 0;
  for (const [tag, value] of fields) {
    check(`qr: TLV tag ${tag} header byte`, bin[off] === tag);
    const len = bin[off + 1];
    check(`qr: TLV tag ${tag} length`, len === Buffer.byteLength(value));
    check(
      `qr: TLV tag ${tag} value`,
      bin.subarray(off + 2, off + 2 + len).toString("utf8") === value,
    );
    off += 2 + len;
  }
  check("qr: TLV consumes whole payload", off === bin.length);

  const svg = await renderFiscalQrSvg(b64);
  check("qr: renders svg wrapper", svg.startsWith("<svg") && svg.trimEnd().endsWith("</svg>"));
  check("qr: svg includes module rects", (svg.match(/<rect/g) ?? []).length > 16);

  // Checkout totals must respect the tenant tax percent instead of the
  // hardcoded legacy 16%: 10.00 at 5% -> 0.50 tax, 10.50 total.
  const store = usePosStore;
  store.getState().setCurrentStore({ id: "store-main", name: "متجر التجربة", taxPercent: 5, taxNumber: "311122233300003" } as never);
  store.getState().loginCashier("1111");
  await store.getState().openShift(100);
  store.getState().scanBarcode("11111");
  check("qr: totals use store taxPercent 5%", store.getState().totals.tax === 0.5 && store.getState().totals.total === 10.5);
  await clearSyncQueue();
}

async function branchTerminalScope(): Promise<void> {
  const store = usePosStore;
  store.getState().setBranchesAndTerminals(
    [
      { id: "b1", storeId: "store-main", name: "فرع المدينة", createdAt: "" },
      { id: "b2", storeId: "store-main", name: "فرع المطار", createdAt: "" },
    ],
    [
      { id: "t1", branchId: "b1", name: "كاشير 1", createdAt: "" },
      { id: "t2", branchId: "b2", name: "كاشير 2", createdAt: "" },
    ],
    "b1",
    "t1",
  );
  check("terminal: defaults to main branch/register", store.getState().activeBranchId === "b1" && store.getState().activeTerminalId === "t1");

  store.getState().loginCashier("1111");
  await store.getState().openShift(100);
  const opened = store.getState().shiftState;
  check("terminal: shift bound to branch", opened.branchId === "b1");
  check("terminal: shift bound to terminal", opened.terminalId === "t1");
  const pending = await getSyncsByStatus("PENDING");
  const openedEvent = pending.find((r) => r.action_type === "SHIFT_OPENED");
  check("terminal: SHIFT_OPENED stamps terminalId", (openedEvent?.payload as { terminalId?: string }).terminalId === "t1");

  // Switching terminal mid-shift must be refused (drawer integrity).
  store.getState().selectTerminal("b2", "t2");
  check("terminal: select blocked while shift open", store.getState().activeBranchId === "b1" && store.getState().activeTerminalId === "t1");

  store.getState().scanBarcode("11111");
  await store.getState().completeCheckout("CASH", 11.6);
  const invoicePending = await getSyncsByStatus("PENDING");
  const invoiceEvent = invoicePending.find((r) => r.action_type === "INVOICE_CREATED");
  check("terminal: invoice stamps terminalId", (invoiceEvent?.payload as { terminalId?: string }).terminalId === "t1");
  check("terminal: completed invoice carries terminalId", store.getState().lastCompletedInvoice?.terminalId === "t1");
  await clearSyncQueue();

  await store.getState().closeShift(100);
  const closedPending = await getSyncsByStatus("PENDING");
  const closedEvent = closedPending.find((r) => r.action_type === "SHIFT_CLOSED");
  check("terminal: SHIFT_CLOSED stamps branch+terminal", (closedEvent?.payload as { branchId?: string; terminalId?: string }).branchId === "b1" && (closedEvent?.payload as { terminalId?: string }).terminalId === "t1");
  check("terminal: shift reset clears binding", store.getState().shiftState.branchId === null && store.getState().shiftState.terminalId === null);
  await clearSyncQueue();

  // Closed shift: selection is allowed, then an explicit open uses it.
  store.getState().selectTerminal("b2", "t2");
  check("terminal: select allowed while closed", store.getState().activeBranchId === "b2" && store.getState().activeTerminalId === "t2");
  await store.getState().openShift(100);
  check("terminal: reopen uses new terminal", store.getState().shiftState.branchId === "b2" && store.getState().shiftState.terminalId === "t2");
  await clearSyncQueue();
}

async function adminOverrides(): Promise<void> {
  const store = usePosStore;
  store.getState().loginCashier("1111");
  store.getState().scanBarcode("11111");
  store.getState().scanBarcode("22222");

  const ADMIN_SESSION = {
    storeId: "store-main",
    email: "admin@demo.test",
    name: "مدير",
  };

  // Inline price override only works while an owner session is active.
  store.getState().adminSetLinePrice(0, 40);
  let state = st();
  check("override: non-admin price edit ignored", state.items[0].unitPrice === 10);

  usePosStore.setState({ adminSession: ADMIN_SESSION });
  store.getState().adminSetLinePrice(0, 25);
  state = st();
  check(
    "override: admin price edit applies",
    state.items[0].unitPrice === 25 &&
      state.items[0].lineTotal === 25 &&
      state.totals.subtotal === 30,
  );

  // Price edit preserves a percent discount re-derived from the new gross.
  store.getState().clearInvoice();
  store.getState().scanBarcode("11111");
  store.getState().applyDiscount({ scope: "ITEM", index: 0, type: "PERCENT", value: 10 });
  store.getState().adminSetLinePrice(0, 50);
  state = st();
  check(
    "override: discount re-derives from new price",
    state.items[0].discount === 5 && state.items[0].lineTotal === 45,
  );

  // Admin session bypasses the discount approval gate entirely.
  store.getState().clearInvoice();
  store.getState().scanBarcode("33333");
  store.getState().applyDiscount({ scope: "TOTAL", type: "PERCENT", value: 100 });
  state = st();
  check(
    "override: admin bypasses approval + caps",
    state.isSecondaryAuthOpen === false && state.totals.discount === 20,
  );

  usePosStore.setState({ adminSession: null, isReturnMode: false });
  store.getState().requestReturnModeToggle();
  state = st();
  check(
    "return auth: cashier needs owner password",
    state.isReturnMode === false &&
      state.isSecondaryAuthOpen === true &&
      state.pendingSecondaryAction?.type === "toggle_return_mode",
  );
  store.getState().cancelSecondaryAuth();
  usePosStore.setState({ adminSession: ADMIN_SESSION });
  store.getState().requestReturnModeToggle();
  state = st();
  check("return auth: admin enters return mode", state.isReturnMode === true && state.isSecondaryAuthOpen === false);
  store.getState().requestReturnModeToggle();
  state = st();
  check("return auth: exit return mode without prompt", state.isReturnMode === false && state.isSecondaryAuthOpen === false);

  // Secondary-auth gate plumbing.
  store.getState().requestSecondaryAuth({ type: "open_drawer" });
  state = st();
  check(
    "auth: request opens modal with action",
    state.isSecondaryAuthOpen === true &&
      state.pendingSecondaryAction?.type === "open_drawer",
  );
  check(
    "auth: confirm offline fails safely",
    (await store.getState().confirmSecondaryAction("12345678")) === false,
  );
  store.getState().cancelSecondaryAuth();
  state = st();
  check(
    "auth: cancel closes modal",
    state.isSecondaryAuthOpen === false && state.pendingSecondaryAction === null,
  );

  // Inline modal flags.
  store.getState().openPreviousInvoicesModal();
  check("modal: previous invoices opens", st().isPreviousInvoicesModalOpen === true);
  store.getState().closePreviousInvoicesModal();
  check("modal: previous invoices closes", st().isPreviousInvoicesModalOpen === false);
  store.getState().setLineEditTarget(0);
  check("modal: line edit target set", st().lineEditTarget === 0);
  store.getState().setLineEditTarget(null);
  check("modal: line edit target cleared", st().lineEditTarget === null);

  // P3: audit-log timeline modal flags.
  store.getState().openAuditLogModal();
  check("audit: timeline modal opens", st().isAuditLogOpen === true);
  store.getState().closeAuditLogModal();
  check("audit: timeline modal closes", st().isAuditLogOpen === false);

  // Invoice cancellation enqueues a reversing document + double-cancel guard.
  store.getState().clearInvoice();
  store.getState().loginCashier("1111");
  await store.getState().openShift(100);
  store.getState().scanBarcode("11111");
  await store.getState().completeCheckout("CASH", 11.6);
  const syncId = st().lastCompletedInvoice?.syncId ?? "";
  check("cancel: original invoice completed", syncId.length > 0);

  usePosStore.setState({ adminSession: ADMIN_SESSION });
  await store.getState().cancelInvoice(syncId);
  const pending = await getSyncsByStatus("PENDING");
  const reversal = pending.find(
    (r) =>
      r.action_type === "INVOICE_CREATED" &&
      (r.payload as { originalInvoiceId?: string }).originalInvoiceId === syncId,
  );
  check("cancel: reversal queued", reversal !== undefined);
  if (reversal) {
    const items = (reversal.payload as { items?: SaleItem[] }).items ?? [];
    const p = reversal.payload as { total?: number; isCancellation?: boolean };
    check(
      "cancel: reversal negates stock + totals",
      items.length === 1 &&
        items[0].qty === -1 &&
        items[0].lineTotal === -10 &&
        p.total === -11.6 &&
        p.isCancellation === true,
    );
  }
  check("cancel: original marked returned", (await isInvoiceReturned(syncId)) === true);

  await store.getState().cancelInvoice(syncId);
  state = st();
  check(
    "cancel: double-cancel blocked",
    (state.notice?.message ?? "").includes("أُلغيَت"),
  );
  await clearSyncQueue();
  usePosStore.setState({ adminSession: null });
}

async function auditPush(): Promise<void> {
  const { pushAudit } = await import("../lib/audit");
  // Offline (relative URL has no base in the tsx runner) -> resolves false,
  // never throws, and never blocks the action that fired it.
  check("audit: offline push fails safely", (await pushAudit("admin@demo.test", "OPEN_DRAWER")) === false);
  check("audit: no email short-circuits", (await pushAudit(null, "OPEN_DRAWER")) === false);
}

async function syncTenantScoping(): Promise<void> {
  const { setTenantStoreId } = await import("../lib/tenantClient");
  const record: SyncQueueRecord = {
    sync_id: "11111111-1111-4111-8111-111111111111",
    action_type: "INVOICE_CREATED",
    payload: {
      items: [],
      subtotal: 0,
      tax: 0,
      discount: 0,
      deliveryFee: 0,
      total: 0,
      amountPaid: 0,
      change: 0,
      paymentMethod: "CASH",
      completed_at: new Date().toISOString(),
    },
    status: "PENDING",
    created_at: new Date().toISOString(),
  };

  // Records are stamped with the tenant that enqueued them...
  setTenantStoreId("store-a");
  await enqueueSync(record);
  const pending = await getSyncsByStatus("PENDING");
  const stamped = pending.find((r) => r.sync_id === record.sync_id);
  check("sync: enqueue stamps storeId", stamped?.storeId === "store-a");

  // ...and may only sync/count while that tenant is active.
  check(
    "sync: matches own tenant",
    isQueueRecordForTenant(stamped ?? record, "store-a") === true,
  );
  check(
    "sync: blocked for other tenant",
    isQueueRecordForTenant(stamped ?? record, "store-b") === false,
  );
  check(
    "sync: blocked when logged out",
    isQueueRecordForTenant(stamped ?? record, null) === false,
  );

  // listInvoices must never leak another tenant's invoices.
  check(
    "sync: listInvoices own tenant",
    (await listInvoices("store-a")).some((r) => r.sync_id === record.sync_id),
  );
  check(
    "sync: listInvoices other tenant empty",
    (await listInvoices("store-b")).length === 0,
  );

  setTenantStoreId(null);
  await clearSyncQueue();
}

async function tenantRuntimeIsolation(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const loginStoreId = "store-b";

  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/api/admin/login")) {
      return Response.json({
        store: { id: loginStoreId, name: "متجر ب", taxPercent: 16 },
        cashier: { id: "owner-b", name: "مالك ب", role: "admin", email: "b@test.local" },
        branches: [{ id: "branch-b", name: "الفرع الرئيسي" }],
        terminals: [{ id: "terminal-b", branchId: "branch-b", name: "الكاشير الرئيسي" }],
        defaultBranchId: "branch-b",
        defaultTerminalId: "terminal-b",
      });
    }
    if (url.includes("/api/catalog") || url.includes("/api/customers")) {
      return new Response(null, { status: 304 });
    }
    return new Response(null, { status: 404 });
  };

  try {
    const oldLine: SaleItem = {
      productId: "p1",
      name: "سلة متجر أ",
      barcode: "11111",
      unitName: "حبة",
      qty: 1,
      unitPrice: 10,
      lineTotal: 10,
      discount: 0,
      taxPercent: 16,
      taxIncluded: false,
    };
    usePosStore.setState({
      runtimeStoreId: "store-a",
      currentStore: { id: "store-a", name: "متجر أ", taxPercent: 16 } as never,
      adminSession: { storeId: "store-a", email: "a@test.local", name: "مالك أ" },
      currentCashier: { id: "cashier-a", name: "كاشير أ", role: "cashier" },
      items: [oldLine],
      totals: { subtotal: 10, tax: 1.6, discount: 0, deliveryFee: 2, total: 13.6, itemCount: 1 },
      heldInvoices: [{ id: "held-a", created_at: new Date().toISOString(), items: [oldLine], total: 11.6 }],
      shiftState: {
        status: "OPEN",
        shiftId: "shift-a",
        startTime: new Date().toISOString(),
        startingCash: 100,
        branchId: "branch-a",
        terminalId: "terminal-a",
      },
      shiftTotals: { ...emptyShiftTotals, expectedCashInDrawer: 110, cashSales: 10, totalSales: 10 },
      shiftTransactions: [{
        syncId: "invoice-a",
        shiftId: "shift-a",
        paymentMethod: "CASH",
        total: 10,
        cashPortion: 10,
        completed_at: new Date().toISOString(),
      }],
      invoiceDiscount: { scope: "TOTAL", type: "FIXED", value: 1 },
      deliveryFee: 2,
    });

    const switched = await usePosStore.getState().adminLogin("b@test.local", "password");
    let state = st();
    check("tenant switch: login succeeds", switched === true);
    check(
      "tenant switch: binds runtime to new tenant",
      state.currentStore?.id === loginStoreId && state.runtimeStoreId === loginStoreId,
    );
    check(
      "tenant switch: clears cart + held invoices",
      state.items.length === 0 && state.heldInvoices.length === 0 && state.totals.total === 0,
    );
    check(
      "tenant switch: closes foreign shift + ledger",
      state.shiftState.status === "CLOSED" && state.shiftTransactions.length === 0 && state.shiftTotals.totalSales === 0,
    );
    check(
      "tenant switch: clears foreign cashier + invoice state",
      state.currentCashier === null && state.invoiceDiscount === null && state.deliveryFee === 0,
    );

    // Re-authenticating the same owner must keep an in-progress local shift;
    // this preserves the local-first reload/session-expiry contract.
    usePosStore.setState({
      items: [oldLine],
      totals: { subtotal: 10, tax: 1.6, discount: 0, deliveryFee: 0, total: 11.6, itemCount: 1 },
      shiftState: {
        status: "OPEN",
        shiftId: "shift-b",
        startTime: new Date().toISOString(),
        startingCash: 100,
        branchId: "branch-b",
        terminalId: "terminal-b",
      },
    });
    const resumed = await usePosStore.getState().adminLogin("b@test.local", "password");
    state = st();
    check("same tenant: re-login succeeds", resumed === true);
    check(
      "same tenant: preserves local cart + open shift",
      state.items.length === 1 && state.shiftState.shiftId === "shift-b" && state.shiftState.status === "OPEN",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function categoryQuickFilter(): Promise<void> {
  // group() already reset the store and loaded the snapshot fixture:
  // categories c1 "مشروبات" + c2 "أغذية", quickKeys = [qk1 (categoryId c1)].
  check("category: defaults to all (الأكثر طلباً)", st().activeCategoryId === null);

  st().setActiveCategoryId("c1");
  check("category: tab sets active id", st().activeCategoryId === "c1");
  const filtered = st().quickKeys.filter((k) => k.categoryId === st().activeCategoryId);
  check("category: c1 shows its quick key", filtered.length === 1 && filtered[0].id === "qk1");

  st().setActiveCategoryId("c2");
  check(
    "category: empty category yields no keys",
    st().quickKeys.filter((k) => k.categoryId === "c2").length === 0,
  );

  // Stale/unknown ids fall back to the all-tab (component rule).
  st().setActiveCategoryId("ghost-category");
  const fallback = st().categories[st().activeCategoryId ?? ""] ? st().activeCategoryId : null;
  check("category: unknown id falls back to all", fallback === null);

  st().setActiveCategoryId(null);
  check("category: reset returns to all", st().activeCategoryId === null);

  const nested = [
    categories.c1,
    { id: "c3", name: "مياه", parentId: "c1", bgColor: null, isQuickKey: true, sortOrder: 1 },
    { id: "c4", name: "مياه غازية", parentId: "c3", bgColor: null, isQuickKey: true, sortOrder: 1 },
  ];
  const exactResults = searchCategoryHierarchy(nested, "مياه");
  check("category search: exact name ranks first", exactResults[0]?.item.id === "c3");
  check(
    "category search: nested result carries full path",
    exactResults.find((result) => result.item.id === "c4")?.pathNames.join("/") ===
      "مشروبات/مياه/مياه غازية",
  );
  const pathResults = searchCategoryHierarchy(nested, "مشروبات غازية");
  check("category search: full path is searchable", pathResults[0]?.item.id === "c4");
  const filteredResults = searchCategoryHierarchy(nested, "مياه", {
    include: (category) => category.id !== "c3",
  });
  check("category search: availability filter excludes empty categories", filteredResults.every((result) => result.item.id !== "c3"));
}

async function accountingProfitContract(): Promise<void> {
  // subtotal is the post-discount, tax-exclusive control total. The discount
  // stays visible for audit but must never be subtracted from revenue again.
  check("accounting: discounted subtotal is not discounted twice", recognizedRevenue(44, 0) === 44);
  check("accounting: delivery fee is recognized as revenue", recognizedRevenue(44, 5) === 49);

  const complete = resolveGrossProfit(30.6, 49, 0);
  check("accounting: complete costs publish profit", complete.reliable && complete.value === 30.6);
  check("accounting: margin uses subtotal plus delivery", complete.margin === 62.45);

  const incomplete = resolveGrossProfit(35.98, 49, 2);
  check(
    "accounting: zero-cost lines suppress final profit",
    !incomplete.reliable && incomplete.value === null && incomplete.margin === null,
  );
  check("accounting: candidate remains available for audit", incomplete.candidate === 35.98);
}

async function rolePermissionContract(): Promise<void> {
  check("roles: owner receives every capability", STAFF_CAPABILITIES.every((capability) =>
    hasCapability({ role: "admin" }, capability),
  ));
  check("roles: cashier can sell", hasCapability({ roleCode: "cashier" }, "pos.sell"));
  check("roles: cashier cannot open back office", !hasCapability({ roleCode: "cashier" }, "backoffice.access"));
  check("roles: accountant can read reports", hasCapability({ roleCode: "accountant" }, "reports.view"));
  check("roles: accountant can read live X reports", hasCapability({ roleCode: "accountant" }, "shifts.x_report"));
  check("roles: accountant can inspect risk signals", hasCapability({ roleCode: "accountant" }, "risk.view"));
  check("roles: accountant cannot resolve risk signals", !hasCapability({ roleCode: "accountant" }, "risk.review"));
  check("roles: senior cashier cannot see expected live cash", !hasCapability({ roleCode: "senior_cashier" }, "shifts.x_report"));
  check("roles: store manager can resolve risk signals", hasCapability({ roleCode: "store_manager" }, "risk.review"));
  check("roles: accountant cannot edit inventory", !hasCapability({ roleCode: "accountant" }, "inventory.manage"));
  check("roles: inventory manager can edit catalog", hasCapability({ roleCode: "inventory_manager" }, "catalog.manage"));
  check("roles: inventory manager cannot view profitability", !hasCapability({ roleCode: "inventory_manager" }, "reports.profitability"));
  check("roles: explicit empty capability set never falls back to preset", !hasCapability({ roleCode: "store_manager", capabilities: [] }, "reports.view"));
  check("roles: profitability route uses the stronger capability", capabilityForAdminPath("/admin/reports/profitability") === "reports.profitability");
  check("roles: risk route requires risk visibility", capabilityForAdminPath("/admin/risk") === "risk.view");
  check("roles: staff role codes stay unique", new Set(Object.keys(STAFF_ROLE_PRESETS)).size === Object.keys(STAFF_ROLE_PRESETS).length);
}

async function main(): Promise<void> {
  await routeValidation();
  await group("cart math", cartMath);
  await group("discounts", discounts);
  await group("discount approval", discountApproval);
  await group("payments + guards", paymentsAndGuards);
  await group("closed-shift guard", closedShiftGuard);
  await group("secure returns", returnsFlow);
  await group("shift lifecycle", shiftLifecycle);
  await group("held invoice persistence", heldInvoicePersistence);
  await group("cart survives reload", cartSurvivesReload);
  await group("double return blocked", doubleReturnBlocked);
  await group("discounted return refunds net", discountedReturnRefund);
  await group("indexeddb round-trip", idbRoundTrip);
  await group("sync tenant scoping", syncTenantScoping);
  await group("tenant runtime isolation", tenantRuntimeIsolation);
  await group("category quick filter", categoryQuickFilter);
  await group("accounting profit contract", accountingProfitContract);
  await group("role permission contract", rolePermissionContract);
  await group("loyalty math", loyaltyMath);
  await group("fiscal qr + tax", fiscalQr);
  await group("branch + terminal scope", branchTerminalScope);
  await group("admin overrides (P2)", adminOverrides);
  await group("admin audit log (P3)", auditPush);

  console.log(`\nStore workflows: ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.error("Failures:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
}

void main();
