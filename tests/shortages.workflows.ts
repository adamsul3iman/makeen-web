/**
 * Phase 5 — Shortage Radar workflow suite (runs via tsx, no server needed).
 *
 * Part A — Pure radar helpers (`lib/shortages.ts`): threshold defaulting,
 * radar filtering (`current_stock <= reorder_level`), the gap formula
 * `(ideal_stock_level - current_stock) = suggested_order_qty`, supplier
 * grouping for Draft PO / WhatsApp export, and the wa.me URL builder.
 *
 * Part B — POS emergency flag: `flagShortage` must push the item into the
 * radar even when system stock says otherwise, persist a PENDING
 * SHORTAGE_FLAGGED sync record, and survive into the IndexedDB cache.
 *
 * Part C — Route validation: `/api/shortages` + the sync pipeline accept a
 * shortage flag, never crash on malformed payloads.
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

const { usePosStore } = await import("../store/usePosStore");
const { clearSyncQueue, getSyncsByStatus, loadShortageFlagCache } = await import("../lib/idb");
const { setTenantStoreId } = await import("../lib/tenantClient");
const {
  buildShortageWhatsAppText,
  buildWhatsAppUrl,
  computeShortageRadar,
  groupShortagesBySupplier,
  isBelowReorderLevel,
  shortageThresholds,
  suggestedOrderQty,
} = await import("../lib/shortages");

import type { SyncQueueRecord } from "../lib/idb";
import type {
  BarcodeMap,
  Cashier,
  PosSnapshot,
  ProductMap,
  ShortageFlag,
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
  startingCash: 0,
  expectedCashInDrawer: 0,
  actualCash: 0,
  variance: 0,
};

// A mixed catalog: below-threshold, at-threshold, above-threshold, unset
// thresholds, one manually-flagged product with ample stock.
const products: ProductMap = {
  low: { id: "low", categoryId: "c1", name: "زيت دوار الشمس 1 لتر", baseUnit: "قارورة", isWeighed: false, price: 2.9, costPrice: 2.5, totalStock: 6, reorderLevel: 24, idealStockLevel: 60, supplierId: "sup-a", supplierName: "مورد الزيوت" },
  at: { id: "at", categoryId: "c1", name: "كاسات بلاستيك 7 أونص", baseUnit: "حبة", isWeighed: false, price: 0.15, costPrice: 0.09, totalStock: 24, reorderLevel: 24, idealStockLevel: 100, supplierId: "sup-a", supplierName: "مورد الزيوت" },
  above: { id: "above", categoryId: "c1", name: "ماء معدني 500 مل", baseUnit: "عبوة", isWeighed: false, price: 0.25, costPrice: 0.18, totalStock: 100, reorderLevel: 20, idealStockLevel: 60, supplierId: "sup-b", supplierName: "مورد المياه" },
  unset: { id: "unset", categoryId: "c1", name: "شيبس عائلي", baseUnit: "كيس", isWeighed: false, price: 0.35, costPrice: 0.25, totalStock: 0 },
  manual: { id: "manual", categoryId: "c1", name: "حليب طويل الأمد", baseUnit: "عبوة", isWeighed: false, price: 0.95, costPrice: 0.8, totalStock: 200, reorderLevel: 5, idealStockLevel: 40, supplierId: "sup-c", supplierName: "مورد الألبان" },
};

const barcodes: BarcodeMap = {};

const cashiers: Cashier[] = [
  { id: "cashier-1", name: "كاشير", pinHash: "", role: "cashier" },
];

const snapshot: PosSnapshot = {
  schemaVersion: 1,
  updatedAt: new Date().toISOString(),
  categories: {},
  products,
  barcodes,
  barcodeIndex: {},
  quickKeys: [],
  cashiers,
  pinSalt: "test-salt",
};

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
    isCheckoutModalOpen: false,
    isReturnMode: false,
    invoiceDiscount: null,
    returnReference: null,
    isCompleting: false,
    lastCompletedInvoice: null,
    currentCashier: null,
    currentStore: null,
    runtimeStoreId: null,
    adminSession: null,
    shiftState: { status: "CLOSED", shiftId: null, startTime: null, startingCash: 0, branchId: null, terminalId: null },
    shiftTotals: { ...emptyShiftTotals },
    shiftTransactions: [],
    isCloseShiftModalOpen: false,
    isDebtSettlementModalOpen: false,
    isExpenseModalOpen: false,
    isHoldModalOpen: false,
    isSecondaryAuthOpen: false,
    pendingSecondaryAction: null,
    isPreviousInvoicesModalOpen: false,
    lineEditTarget: null,
    isAuditLogOpen: false,
    checkoutSession: 0,
    modalSession: 0,
    pendingSyncCount: 0,
    customers: [],
    customersUpdatedAt: "",
    customersLoading: false,
    activeCustomerId: null,
    priceMemory: {},
    shortageFlags: {},
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
// Part A: pure radar helpers
// ---------------------------------------------------------------------------

async function thresholdDefaults(): Promise<void> {
  const t = shortageThresholds({});
  check("thresholds: both default to 0", t.minStockLevel === 0 && t.idealStockLevel === 0);
  check("thresholds: floors negatives to 0", shortageThresholds({ reorderLevel: -5, idealStockLevel: -1 }).minStockLevel === 0 && shortageThresholds({ reorderLevel: -5, idealStockLevel: -1 }).idealStockLevel === 0);
  check("thresholds: reads set values", shortageThresholds({ reorderLevel: 24, idealStockLevel: 60 }).minStockLevel === 24 && shortageThresholds({ reorderLevel: 24, idealStockLevel: 60 }).idealStockLevel === 60);
}

async function radarFilter(): Promise<void> {
  check("radar: unset threshold (0) never flags even at zero stock", isBelowReorderLevel(0, undefined) === false);
  check("radar: explicit zero threshold disables auto-flag", isBelowReorderLevel(0, 0) === false);
  check("radar: stock below threshold flags", isBelowReorderLevel(6, 24) === true);
  check("radar: stock at threshold flags", isBelowReorderLevel(24, 24) === true);
  check("radar: stock above threshold does not flag", isBelowReorderLevel(25, 24) === false);
  check("radar: missing stock reads as 0", isBelowReorderLevel(undefined, 24) === true);
}

async function gapFormula(): Promise<void> {
  check("gap: ideal - current = suggested qty", suggestedOrderQty(6, 60) === 54);
  check("gap: exact coverage -> 0", suggestedOrderQty(60, 60) === 0);
  check("gap: above ideal -> 0 (never negative)", suggestedOrderQty(100, 60) === 0);
  check("gap: unset ideal defaults to 0", suggestedOrderQty(6, undefined) === 0);
  check("gap: unset stock reads as 0", suggestedOrderQty(undefined, 60) === 60);
}

async function radarComputation(): Promise<void> {
  const radar = computeShortageRadar(products, []);
  check("radar: only at/below-threshold products listed", radar.length === 2);
  check("radar: zero-threshold product excluded", !radar.some((r) => r.productId === "unset"));
  check("radar: above-threshold product excluded", !radar.some((r) => r.productId === "above"));
  const oil = radar.find((r) => r.productId === "low");
  check("radar: gap carried onto the item", oil?.suggestedOrderQty === 54);
  check("radar: source is radar", oil?.source === "radar");
  check("radar: supplier resolved", oil?.supplierId === "sup-a" && oil?.supplierName === "مورد الزيوت");

  // Manual flag on a product with ample stock still lands on the radar.
  const flag: ShortageFlag = {
    id: "flag-1",
    productId: "manual",
    productName: "حليب طويل الأمد",
    currentStock: 200,
    createdAt: "2026-08-16T10:00:00.000Z",
    resolved: false,
  };
  const withManual = computeShortageRadar(products, [flag]);
  check("radar: manual flag bypasses stock", withManual.some((r) => r.productId === "manual"));
  const manualRow = withManual.find((r) => r.productId === "manual");
  check("radar: manual row keeps product gap/thresholds", manualRow?.source === "manual" && manualRow?.suggestedOrderQty === 0 && manualRow?.minStockLevel === 5);
  check("radar: manual row carries flag time", manualRow?.flaggedAt === "2026-08-16T10:00:00.000Z");

  // Resolved flags must disappear from the radar.
  const resolved = computeShortageRadar(products, [{ ...flag, resolved: true }]);
  check("radar: resolved manual flag drops out", !resolved.some((r) => r.productId === "manual"));

  // A manual flag for a product missing from the snapshot still surfaces.
  const ghost = computeShortageRadar(products, [{
    id: "flag-2",
    productId: "ghost",
    productName: "منتج محذوف",
    currentStock: 3,
    createdAt: "2026-08-16T11:00:00.000Z",
    resolved: false,
  }]);
  const ghostRow = ghost.find((r) => r.productId === "ghost");
  check("radar: missing-product flag still surfaces", ghostRow?.source === "manual" && ghostRow?.name === "منتج محذوف" && ghostRow?.currentStock === 3);
}

async function supplierGrouping(): Promise<void> {
  const radar = computeShortageRadar(products, [{
    id: "flag-1",
    productId: "manual",
    productName: "حليب طويل الأمد",
    currentStock: 200,
    createdAt: "2026-08-16T10:00:00.000Z",
    resolved: false,
  }]);
  const groups = groupShortagesBySupplier(radar);
  check("group: one group per supplier", groups.length === 2);
  const oilGroup = groups.find((g) => g.supplierId === "sup-a");
  check("group: radar rows share their supplier", oilGroup?.items.length === 2);
  check("group: group total is the sum of suggested qty", oilGroup?.totalOrderQty === 54 + (100 - 24));

  const text = buildShortageWhatsAppText(oilGroup!);
  check("group: message lists supplier + items", text.includes("مورد الزيوت") && text.includes("زيت دوار الشمس 1 لتر") && text.includes("54"));

  const url = buildWhatsAppUrl("0791234567", text);
  check("group: wa.me strips non-digits", url.startsWith("https://wa.me/0791234567?text="));
  check("group: wa.me encodes the message", decodeURIComponent(url.split("text=")[1]).includes("مورد الزيوت"));
  check("group: empty phone -> no url", buildWhatsAppUrl("", text) === "");
}

// ---------------------------------------------------------------------------
// Part B: POS emergency flag -> state + sync queue + IDB cache
// ---------------------------------------------------------------------------

async function emergencyFlag(): Promise<void> {
  const storeId = "store-main";
  setTenantStoreId(storeId);

  await st().flagShortage("manual", "الرفوف فارغة رغم أن النظام يعرض رصيداً");
  const state = st();

  check("flag: state marks the product unresolved", state.shortageFlags["manual"]?.resolved === false);
  check("flag: reason captured", state.shortageFlags["manual"]?.reason === "الرفوف فارغة رغم أن النظام يعرض رصيداً");
  check("flag: current stock captured", state.shortageFlags["manual"]?.currentStock === 200);

  const pending = await getSyncsByStatus("PENDING");
  const shortageEvents = pending.filter(
    (r): r is SyncQueueRecord & { action_type: "SHORTAGE_FLAGGED" } => r.action_type === "SHORTAGE_FLAGGED",
  );
  check("flag: a SHORTAGE_FLAGGED event is queued", shortageEvents.length === 1);
  check("flag: payload carries product + stock", shortageEvents[0]?.payload.productId === "manual" && shortageEvents[0]?.payload.currentStock === 200);

  const cached = await loadShortageFlagCache(storeId);
  check("flag: survives into the IDB cache", cached?.flags.some((f) => f.productId === "manual" && !f.resolved) === true);

  const radar = computeShortageRadar(products, Object.values(state.shortageFlags));
  check("flag: radar now lists the flagged product", radar.some((r) => r.productId === "manual" && r.source === "manual"));

  // A second flag on the same product must not duplicate the queue row
  // (idempotent upsert by product) but can refresh the reason.
  await st().flagShortage("manual", "نقص مؤكد");
  const pendingAfter = await getSyncsByStatus("PENDING");
  const shortageEventsAfter = pendingAfter.filter((r) => r.action_type === "SHORTAGE_FLAGGED");
  check("flag: repeated flag refreshes the row, never duplicates", shortageEventsAfter.length === 1);
  check("flag: reason refreshed", st().shortageFlags["manual"]?.reason === "نقص مؤكد");
}

// ---------------------------------------------------------------------------
// Part C: route validation (throwaway client, dead port 9)
// ---------------------------------------------------------------------------

let adminCookie = "";
let deviceCookie = "";

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

  const shortages = await import("../_legacy_api/shortages/route");
  const syncRoute = await import("../_legacy_api/sync/route");

  const POST = (name: string, fn: () => Promise<Response>, expected: number): Promise<void> =>
    expectResponse(name, fn, expected);

  // Shortages endpoint: isolation + validation before any DB work.
  await POST("shortages GET no-session", () => shortages.GET(makeReq("GET", undefined, false, false)), 401);
  await POST("shortages GET cashier without capability", () => shortages.GET(makeReq("GET", undefined, false)), 403);
  await POST("shortages GET admin -> DB attempt", () => shortages.GET(makeReq("GET", undefined, true)), 500);
  await POST("shortages POST missing body", () => shortages.POST(makeReq("POST", undefined, true)), 400);
  await POST("shortages POST missing productId", () => shortages.POST(makeReq("POST", "{}", true)), 400);
  await POST("shortages POST invalid body", () => shortages.POST(makeReq("POST", "{bad", true)), 400);
  await POST("shortages POST valid -> DB attempt", () =>
    shortages.POST(makeReq("POST", JSON.stringify({ productId: "low" }), true)), 500);

  // Sync pipeline: a well-formed shortage flag is accepted into the queue
  // (hits the DB on the dead port -> 500); a malformed one is rejected 400-free.
  const validShortage = JSON.stringify([
    {
      sync_id: "route-shortage-1",
      action_type: "SHORTAGE_FLAGGED",
      payload: {
        productId: "low",
        productName: "زيت دوار الشمس 1 لتر",
        currentStock: 6,
        created_at: new Date().toISOString(),
      },
    },
  ]);
  await POST("sync SHORTAGE_FLAGGED valid -> DB attempt", () => syncRoute.POST(makeReq("POST", validShortage, false)), 500);

  const malformedShortage = JSON.stringify([
    {
      sync_id: "route-shortage-bad",
      action_type: "SHORTAGE_FLAGGED",
      payload: { currentStock: 6 },
    },
  ]);
  const res = await syncRoute.POST(makeReq("POST", malformedShortage, false));
  const data = (await res.json()) as { rejected?: Array<{ sync_id: string; reason: string }> };
  check("sync SHORTAGE_FLAGGED malformed -> rejected, not accepted", res.status === 200 && data.rejected?.some((r) => r.reason === "shortage_product_id_missing") === true);
}

async function main(): Promise<void> {
  await group("threshold defaults", thresholdDefaults);
  await group("radar filter", radarFilter);
  await group("gap formula", gapFormula);
  await group("radar computation", radarComputation);
  await group("supplier grouping + WhatsApp", supplierGrouping);
  await group("emergency flag", emergencyFlag);
  await routeValidation();

  console.log(`\nShortage workflows: ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.error("Failures:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
}

void main();
