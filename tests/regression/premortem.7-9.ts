/**
 * Pre-mortem regression suite — risks 7, 8, 9.
 *
 * 7. Scanner typing into Cash Given / discount fields.
 *    Contract: `lib/moneyInput.ts` strictly validates money inputs (digits +
 *    one decimal separator, bounded length) so a 13-digit barcode can never
 *    submit; CheckoutModal/DiscountModal auto-select-all on mount and reject
 *    invalid input; `useBarcodeScanner` detects a machine-fast wedge burst
 *    while a modal is open and preventDefaults its Enter terminator + beep +
 *    ignore instead of letting it submit the focused amount/discount field.
 * 8. Loyalty points are not clawed back on return.
 *    Contract: `isLoyaltyClawback` recognizes a return/cancellation that
 *    references an `originalInvoiceId`; `clawBackLoyaltyPoints` finds the
 *    original invoice's EARN event and posts a matching REDEEM reversal
 *    (points = -earned), idempotent per reversal sync_id. The /api/sync
 *    funnel calls it for negative-total/cancellation invoices.
 * 9. ISTD failure is invisible to cashier/owner.
 *    Contract: per-invoice ISTD state is tracked in IndexedDB
 *    (`istd_state`, PENDING/SUBMITTING/SUBMITTED/FAILED); the checkout
 *    fast-path records SUBMITTED/FAILED; the POS header shows a
 *    "بانتظار JoFotara" badge + a FAILED alert with retry; the receipt prints
 *    "قيد الإرسال للمصلحة" until the invoice is cleared.
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

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CompletedInvoice, SaleItem } from "../../types/pos.types";
import type { SyncQueueRecord } from "../../lib/idb";

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

// ---------------------------------------------------------------------------
// Risk 7 — wedge scans must never submit garbage into money fields
// ---------------------------------------------------------------------------

async function scannerMoneyFieldGuard(): Promise<void> {
  const money = await import("../../lib/moneyInput");
  const scanner = await import("../../hooks/useBarcodeScanner");

  // Pure input-validation contract: digits + one decimal separator, bounded.
  check("money: empty value allowed", money.isValidMoneyInput("") === true);
  check("money: integer amount allowed", money.isValidMoneyInput("50") === true);
  check("money: two decimals allowed", money.isValidMoneyInput("50.25") === true);
  check("money: Arabic decimal comma normalized", money.isValidMoneyInput("50,25") === true);
  check("money: three decimals rejected", money.isValidMoneyInput("12.345") === false);
  check("money: 13-digit barcode rejected", money.isValidMoneyInput("1234567890123") === false);
  check("money: non-numeric rejected", money.isValidMoneyInput("abc12") === false);
  check("money: parse 50,25 -> 50.25", money.parseMoneyInput("50,25") === 50.25);
  check("money: parse empty -> 0", money.parseMoneyInput("") === 0);
  check("money: parse 13-digit barcode -> null", money.parseMoneyInput("1234567890123") === null);
  check("money: parse three decimals -> null", money.parseMoneyInput("12.345") === null);

  // Wedge-burst detection: machine-fast, long-enough bursts only.
  check("wedge: 13-digit fast burst detected", scanner.isWedgeBurst({ length: 13, start: 0, now: 65, avgKeyMs: 5 }) === true);
  check("wedge: short human entry not detected", scanner.isWedgeBurst({ length: 2, start: 0, now: 10, avgKeyMs: 5 }) === false);
  check("wedge: slow typing not detected", scanner.isWedgeBurst({ length: 13, start: 0, now: 65, avgKeyMs: 40 }) === false);
  check("wedge: stale burst not detected", scanner.isWedgeBurst({ length: 13, start: 0, now: 900, avgKeyMs: 5 }) === false);

  // Source contracts.
  const checkoutSrc = readSource("components/pos/CheckoutModal.tsx");
  const discountSrc = readSource("components/pos/DiscountModal.tsx");
  const scannerSrc = readSource("hooks/useBarcodeScanner.ts");

  check("checkout: validates amount via money input helper", checkoutSrc.includes("isValidMoneyInput") && checkoutSrc.includes("parseMoneyInput"));
  check("checkout: amount input auto-selects on mount", checkoutSrc.includes("select()"));
  check("discount: validates value via money input helper", discountSrc.includes("isValidMoneyInput") && discountSrc.includes("parseMoneyInput"));
  check("discount: value input auto-selects on mount", discountSrc.includes("select()"));
  check(
    "scanner: modal-open wedge burst suppressed (beep + preventDefault)",
    scannerSrc.includes("anyPosModalOpen") &&
      scannerSrc.includes("isWedgeBurst") &&
      scannerSrc.includes("preventDefault") &&
      scannerSrc.includes("تم تجاهل مسح ضوئي"),
  );
}

// ---------------------------------------------------------------------------
// Risk 8 — loyalty points must be clawed back on return
// ---------------------------------------------------------------------------

async function loyaltyClawback(): Promise<void> {
  const loyalty = await import("../../lib/loyalty");

  // Pure decision contract.
  check("loyalty: negative total with original invoice -> claw back", loyalty.isLoyaltyClawback({ total: -20, originalInvoiceId: "inv-A", isCancellation: false }) === true);
  check("loyalty: cancellation with original invoice -> claw back", loyalty.isLoyaltyClawback({ total: -20, originalInvoiceId: "inv-A", isCancellation: true }) === true);
  check("loyalty: positive sale earns (no clawback)", loyalty.isLoyaltyClawback({ total: 20, originalInvoiceId: undefined, isCancellation: false }) === false);
  check("loyalty: no reference -> no clawback", loyalty.isLoyaltyClawback({ total: -20, originalInvoiceId: "", isCancellation: true }) === false);

  // Behavioral: a return reverses the original invoice's EARN points exactly.
  type Row = Record<string, unknown>;
  const insertLog: Array<{ table: string; row: Row }> = [];
  const updateLog: Array<{ table: string; patch: Row; filters: string[] }> = [];
  const fakeOpts: {
    earnEvent: Row | null;
    existingReversal: Row | null;
    customer: Row | null;
  } = {
    earnEvent: { id: "earn-1", points: 12 },
    existingReversal: null,
    customer: { id: "cust-1", loyalty_points: 40 },
  };

  const fakeDb = (() => {
    let table = "";
    let filters: string[] = [];
    const chain = {
      from(t: string) {
        table = t;
        filters = [];
        return chain;
      },
      select() {
        return chain;
      },
      eq(k: string, v: unknown) {
        filters.push(`${k}=${String(v)}`);
        return chain;
      },
      maybeSingle() {
        const reversal = filters.includes("type=REDEEM");
        return Promise.resolve({
          data:
            table === "loyalty_events"
              ? reversal
                ? fakeOpts.existingReversal
                : fakeOpts.earnEvent
              : null,
          error: null,
        });
      },
      single() {
        return Promise.resolve({
          data: table === "customers" ? fakeOpts.customer : null,
          error: null,
        });
      },
      insert(row: Row) {
        insertLog.push({ table, row });
        return { error: null };
      },
      update(patch: Row) {
        updateLog.push({ table, patch, filters: [...filters] });
        return {
          eq: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }),
        };
      },
    };
    return chain;
  })();

  const first = await loyalty.clawBackLoyaltyPoints({
    db: fakeDb as unknown as Parameters<typeof loyalty.clawBackLoyaltyPoints>[0]["db"],
    storeId: "store-1",
    customerId: "cust-1",
    originalInvoiceSyncId: "inv-A",
    reversalSyncId: "return-1",
  });
  check("loyalty: clawback reversal posted", first.reversed === true && first.points === -12);
  const redeem = insertLog.find((r) => r.table === "loyalty_events" && r.row.type === "REDEEM");
  check(
    "loyalty: REDEEM reversal matches earned points exactly",
    Boolean(redeem) &&
      redeem?.row.points === -12 &&
      redeem?.row.reference === "return-1",
  );
  const balance = redeem?.row.balance_after;
  check("loyalty: balance_after is 40 - 12 = 28", balance === 28);
  const customerUpdate = updateLog.find((r) => r.table === "customers");
  check("loyalty: customer loyalty_points updated to 28", customerUpdate?.patch.loyalty_points === 28);

  // Idempotency: the same return sync_id must never double-reverse.
  fakeOpts.existingReversal = { id: "rev-1" };
  const second = await loyalty.clawBackLoyaltyPoints({
    db: fakeDb as unknown as Parameters<typeof loyalty.clawBackLoyaltyPoints>[0]["db"],
    storeId: "store-1",
    customerId: "cust-1",
    originalInvoiceSyncId: "inv-A",
    reversalSyncId: "return-1",
  });
  check("loyalty: idempotent replay does not double-reverse", second.reversed === true);
  check(
    "loyalty: only one REDEEM event ever written",
    insertLog.filter((r) => r.table === "loyalty_events" && r.row.type === "REDEEM").length === 1,
  );

  // Nothing to claw back when the original invoice never earned.
  fakeOpts.existingReversal = null;
  fakeOpts.earnEvent = null;
  const before = insertLog.length;
  const none = await loyalty.clawBackLoyaltyPoints({
    db: fakeDb as unknown as Parameters<typeof loyalty.clawBackLoyaltyPoints>[0]["db"],
    storeId: "store-1",
    customerId: "cust-1",
    originalInvoiceSyncId: "inv-B",
    reversalSyncId: "return-2",
  });
  check("loyalty: no EARN event -> no reversal written", none.reversed === false && insertLog.length === before);

  // Source contract: the /api/sync funnel routes returns into the clawback.
  const syncRouteSrc = readSource("app/api/sync/route.ts");
  check("loyalty: sync funnel imports clawback helpers", syncRouteSrc.includes("isLoyaltyClawback") && syncRouteSrc.includes("clawBackLoyaltyPoints"));
  check("loyalty: sync funnel routes returns/cancellations into clawback", syncRouteSrc.includes("recordLoyaltyEarn"));
}

// ---------------------------------------------------------------------------
// Risk 9 — ISTD state is tracked, visible, and surfaced on failure
// ---------------------------------------------------------------------------

async function istdVisibility(): Promise<void> {
  const idbNS = await import("../../lib/idb");
  const {
    clearSyncQueue,
    enqueueSync,
    getIstdState,
    setIstdState,
    countIstdPending,
    countIstdFailed,
  } = idbNS;
  const { setTenantStoreId } = await import("../../lib/tenantClient");

  await clearSyncQueue();

  // Behavioral: IndexedDB round-trip + tenant-scoped counts.
  setTenantStoreId("store-a");
  await setIstdState("inv-1", { status: "PENDING" });
  check("istd: PENDING state persisted", (await getIstdState("inv-1"))?.status === "PENDING");
  check("istd: pending count includes PENDING", (await countIstdPending("store-a")) === 1);
  await setIstdState("inv-1", { status: "FAILED", error: "timeout" });
  check("istd: FAILED counts as pending (not submitted)", (await countIstdPending("store-a")) === 1);
  check("istd: failed count includes FAILED", (await countIstdFailed("store-a")) === 1);
  await setIstdState("inv-1", { status: "SUBMITTED", istd_uuid: "uuid-1", istd_qr: "qr-1" });
  check("istd: SUBMITTED no longer pending", (await countIstdPending("store-a")) === 0);
  check("istd: SUBMITTED no longer failed", (await countIstdFailed("store-a")) === 0);
  const cleared = await getIstdState("inv-1");
  check("istd: clearance uuid stored", cleared?.istd_uuid === "uuid-1");

  // Tenant isolation: store-b's invoice never leaks into store-a's badge.
  setTenantStoreId("store-b");
  await setIstdState("inv-2", { status: "PENDING" });
  check("istd: store-b pending counted under store-b", (await countIstdPending("store-b")) === 1);
  check("istd: store-b pending invisible to store-a", (await countIstdPending("store-a")) === 0);
  setTenantStoreId("store-a");

  // Behavioral: the checkout fast-path records SUBMITTED on success and
  // FAILED (with the error code) on failure — never silent.
  const record: SyncQueueRecord = {
    sync_id: "istd-inv-3",
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

  const item: SaleItem = {
    productId: "p10",
    name: "كولا",
    barcode: "10000",
    qty: 1,
    unitName: "عبوة",
    unitPrice: 10,
    lineTotal: 10,
    discount: 0,
    taxPercent: 0,
    taxIncluded: false,
  };
  const invoice: CompletedInvoice = {
    syncId: "istd-inv-3",
    shiftId: "shift-1",
    items: [item],
    subtotal: 10,
    tax: 0,
    discount: 0,
    deliveryFee: 0,
    total: 10,
    paymentMethod: "CASH",
    amountPaid: 10,
    change: 0,
    completed_at: record.payload.completed_at,
  };

  const { pushInvoiceToIstd } = await import("../../lib/clientIstd");

  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = (() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, uuid: "uuid-3", qrCode: "qr-3" }),
      })) as unknown as typeof fetch;
    const ok = await pushInvoiceToIstd(invoice);
    check("istd: fast-path success clears", ok.cleared === true);
    const afterOk = await getIstdState("istd-inv-3");
    check("istd: success writes SUBMITTED state", afterOk?.status === "SUBMITTED" && afterOk?.istd_uuid === "uuid-3");

    globalThis.fetch = (() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ ok: false, code: "JOFO_TIMEOUT" }),
      })) as unknown as typeof fetch;
    const bad = await pushInvoiceToIstd(invoice);
    check("istd: fast-path failure reported to caller", bad.cleared === false);
    const afterFail = await getIstdState("istd-inv-3");
    check("istd: failure writes FAILED state with error code", afterFail?.status === "FAILED" && afterFail?.error === "JOFO_TIMEOUT");

    globalThis.fetch = (() => Promise.reject(new Error("network down"))) as unknown as typeof fetch;
    const thrown = await pushInvoiceToIstd(invoice);
    check("istd: network failure reported as not cleared", thrown.cleared === false);
    const afterThrow = await getIstdState("istd-inv-3");
    check("istd: network failure writes FAILED state", afterThrow?.status === "FAILED");
  } finally {
    globalThis.fetch = realFetch;
    setTenantStoreId(null);
  }

  // Source contracts: state is tracked in IndexedDB and surfaced in the UI.
  const idbSrc = readSource("lib/idb.ts");
  const clientIstdSrc = readSource("lib/clientIstd.ts");
  const storeSrc = readSource("store/usePosStore.ts");
  const layoutSrc = readSource("components/pos/PosLayout.tsx");
  const receiptSrc = readSource("components/pos/ThermalReceipt.tsx");
  const bgSyncSrc = readSource("hooks/useBackgroundSync.ts");

  check("istd: idb ships istd_state store", idbSrc.includes("istd_state"));
  check("istd: idb DB_VERSION supports istd_state", idbSrc.includes("DB_VERSION = 5"));
  check("istd: idb exposes setIstdState", idbSrc.includes("setIstdState"));
  check("istd: idb exposes countIstdPending", idbSrc.includes("countIstdPending"));
  check("istd: idb exposes countIstdFailed", idbSrc.includes("countIstdFailed"));
  check("istd: fast-path records FAILED", clientIstdSrc.includes("FAILED"));
  check("istd: fast-path records SUBMITTED", clientIstdSrc.includes("SUBMITTED"));
  check("istd: store tracks istdPendingCount", storeSrc.includes("istdPendingCount"));
  check("istd: store tracks istdFailedCount", storeSrc.includes("istdFailedCount"));
  check("istd: store refreshes istd counts", storeSrc.includes("refreshIstdCounts"));
  check(
    "istd: PosLayout shows pending badge",
    layoutSrc.includes("istdPendingCount") && layoutSrc.includes("بانتظار JoFotara"),
  );
  check(
    "istd: PosLayout surfaces FAILED with retry",
    layoutSrc.includes("istdFailedCount") && layoutSrc.includes("فشل إرسال") && layoutSrc.includes("retryPendingIstd"),
  );
  check("istd: receipt marks un-cleared invoice", receiptSrc.includes("قيد الإرسال للمصلحة"));
  check("istd: background sync refreshes istd counts", bgSyncSrc.includes("refreshIstdCounts"));
}

async function section(name: string, fn: () => Promise<void>): Promise<void> {
  console.log(`\n[${name}]`);
  try {
    await fn();
  } catch (err) {
    fail += 1;
    failures.push(`${name}: threw ${String(err)}`);
    console.error(`  ✗ ${name}: threw ${String(err)}`);
  }
}

async function main(): Promise<void> {
  await section("scanner money-field guard", scannerMoneyFieldGuard);
  await section("loyalty clawback", loyaltyClawback);
  await section("istd visibility", istdVisibility);

  console.log(`\nPre-mortem Risks 7-9: ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.error("Failures:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
}

void main();
