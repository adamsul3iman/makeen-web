import { openDB, type IDBPDatabase } from "idb";
import { getTenantStoreId } from "./tenantClient";
import { newUuid } from "./uuid";
import {
  customerPriceMemoryKey,
  effectiveUnitPrice,
  priceMemoryKey,
  type PriceMemoryEntry,
} from "./priceMemory";
import type {
  BarcodeIndex,
  BarcodeMap,
  CategoryMap,
  Cashier,
  CashMovementPayload,
  DebtSettlementPayload,
  ExpenseRecordedPayload,
  PaymentMethod,
  PosCustomer,
  ProductMap,
  QuickKeyItem,
  SaleItem,
  ShiftClosedPayload,
  ShiftOpenedPayload,
  ShortageFlag,
  ShortageFlaggedPayload,
} from "../types/pos.types";

export type SyncStatus = "PENDING" | "SYNCED";

/** Payload of a settled invoice queued for background sync. */
export interface InvoiceCreatedPayload {
  items: SaleItem[];
  subtotal: number;
  tax: number;
  discount: number;
  /** Delivery surcharge added to the total (0 when none). */
  deliveryFee: number;
  total: number;
  paymentMethod: PaymentMethod;
  amountPaid: number;
  change: number;
  /**
   * Authoritative signed payment buckets the ledger mirrors as-is, so a
   * reversal can never be re-derived into the wrong drawer bucket (e.g. a
   * SPLIT return re-derived as 100% cash).
   */
  cashAmount?: number;
  visaAmount?: number;
  cliqAmount?: number;
  debtAmount?: number;
  /** The customer's name on the ledger; required for DEBT, optional otherwise. */
  customerName?: string;
  /** Resolved customer ledger id when assigned at checkout. */
  customerId?: string;
  /** Phone captured at checkout for the assigned customer. */
  customerPhone?: string;
  /** Invoice this document reverses (secure returns flow). */
  originalInvoiceId?: string;
  /** Set when the document is an admin void of the referenced invoice. */
  isCancellation?: boolean;
  /** Branch/terminal that settled the invoice (set when selected). */
  cashierId?: string;
  cashierName?: string;
  shiftId?: string;
  branchId?: string;
  terminalId?: string;
  /**
   * Terminal-scoped human-readable number minted locally at checkout
   * (e.g. T1-0007). Carried so the server ledger and reports can show the
   * same number the receipt printed.
   */
  invoiceNumber?: string;
  completed_at: string;
  /** ISTD/JoFotara clearance UUID returned by the fast-path push, if any. */
  istd_uuid?: string;
  /** ISTD/JoFotara official QR payload returned by the fast-path push, if any. */
  istd_qr?: string;
}

/** Payload of a committed goods-in (supplier invoice) queued for background sync. */
export interface SupplierInvoiceCreatedPayload {
  supplierId: string;
  supplierName: string;
  /** Vendor invoice reference (رقم فاتورة المورد). */
  invoiceNumber: string;
  /** YYYY-MM-DD. */
  invoiceDate: string;
  /** YYYY-MM-DD. */
  dueDate: string;
  notes?: string;
  /** Store VAT used for the invoice-level tax totals. */
  taxPercent: number;
  subtotal: number;
  tax: number;
  total: number;
  lines: Array<{
    lineNo: number;
    productId: string | null;
    barcode: string;
    description: string;
    quantity: number;
    unitCost: number;
    taxPercent: number;
    netAmount: number;
    taxAmount: number;
    totalAmount: number;
     /** Mirror must update products.cost_price to `unitCost`. */
    applyCost: boolean;
    /** Retail accepted after the maintain-margin prompt (null = keep). */
    newRetailPrice: number | null;
    /** Selected unit multiplier (pack = barcode qtyMultiplier, base = 1). */
    unitMultiplier?: number;
    /** Selected unit label (defaults to the base unit). */
    unitName?: string;
  }>;
  /** Products to create before the invoice/stock rows (Quick-Add items). */
  newProducts?: Array<{
    sku: string;
    name: string;
    unitCost: number;
    retailPrice: number;
    taxPercent: number;
    baseUnit: string;
    categoryId?: string;
    categoryName?: string;
    brandId?: string;
    brandName?: string;
    /** Parent product name — used to find or create the parent product. */
    parentName?: string;
    /** Variant label (defaults to auto-derivation from the child name). */
    variantLabel?: string;
  }>;
  /** Cash Paid to Vendor from Register (0 = credit only) — the CASH portion. */
  cashPaid: number;
  /** Every payment-center entry (all methods); total of `payments`. */
  totalPaid?: number;
  /** Payment-center breakdown. Defaults to one CASH payment when omitted. */
  payments?: Array<{
    method: "CASH" | "BANK" | "CARD" | "CLIQ" | "WALLET";
    amount: number;
  }>;
  /** Drawer deduction mirroring the cash paid out of the register. */
  drawerDeduction?: {
    expenseId: string;
    cashierId?: string | null;
    cashierName?: string;
    amount: number;
    notes?: string;
    shiftId: string;
    branchId?: string;
    terminalId?: string;
    created_at: string;
  };
  branchId?: string;
  terminalId?: string;
  cashierId?: string;
  cashierName?: string;
  /** When the event actually happened on the device. */
  created_at: string;
}

/**
 * Payload of an inline vendor creation queued from the goods-in picker.
 * Carries a client-generated id so the offline mirror creates the exact row
 * the queued SUPPLIER_INVOICE_CREATED will reference.
 */
export interface SupplierCreatePayload {
  /** Client-generated UUID — the mirror upserts onto this exact row. */
  id: string;
  name: string;
  phone?: string;
  branchId?: string;
  terminalId?: string;
  cashierId?: string;
  cashierName?: string;
  /** When the create happened on the device. */
  created_at: string;
}

/**
 * Payload of a remote barcode-label print request. Self-contained: the
 * /print-server kiosk renders the label straight from this event and never
 * dereferences the product, so a product rename after the print was queued
 * cannot alter what comes off the printer.
 */
export interface BarcodeLabelPrintPayload {
  barcode: string;
  name: string;
  /** Flavor/scent/color label (empty for plain products). */
  variantLabel?: string;
  /** Unit label printed on the label (e.g. "حبة"). */
  unitName: string;
  price: number;
  /** Number of identical labels to print. */
  quantity: number;
  /** Label template size in mm — the kiosk sets its @page to this exactly. */
  templateSize: { widthMm: number; heightMm: number };
  cashierId?: string;
  cashierName?: string;
  created_at: string;
}

/** Offline cache of goods-in lookups: per-barcode price history + suppliers. */export interface ReceivingCache {
  storeId?: string | null;
  /** barcode -> latest negotiated history (fills the Negotiation Shield offline). */
  histories: Record<string, ReceivingHistoryRow>;
  /** id -> supplier name (for the vendor picker offline). */
  suppliers: Record<string, { id: string; name: string }>;
  updatedAt: string;
}

/**
 * Offline cache of manual shortage flags raised from the register. One row
 * per tenant (mirrors the catalog/customer cache keying) so a flag survives
 * device restarts and is visible to the radar until it syncs + resolves.
 */
export interface ShortageFlagCache {
  storeId?: string | null;
  flags: ShortageFlag[];
  updatedAt: string;
}

/** One cached price-history row for a barcode. */
export interface ReceivingHistoryRow {
  barcode: string;
  description: string;
  currentCost: number;
  currentRetail: number;
  history: Array<{
    cost: number;
    supplierId: string;
    supplierName: string;
    invoiceNumber: string;
    purchasedAt: string;
    quantity: number;
  }>;
}

/**
 * A syncable event queued for background sync to Supabase.
 * Lives in the `sync_queue` object store of `pos_local_db`.
 * Discriminated on `action_type`.
 */
export type SyncQueueRecord =
  | {
      sync_id: string;
      storeId?: string | null;
      action_type: "INVOICE_CREATED";
      payload: InvoiceCreatedPayload;
      status: SyncStatus;
      created_at: string;
      synced_at?: string;
      cashierName?: string;
      /** Consecutive server-side processing failures (see syncService cap). */
      sync_attempts?: number;
    }
  | {
      sync_id: string;
      storeId?: string | null;
      action_type: "SHIFT_OPENED";
      payload: ShiftOpenedPayload;
      status: SyncStatus;
      created_at: string;
      synced_at?: string;
      cashierName?: string;
      sync_attempts?: number;
    }
  | {
      sync_id: string;
      storeId?: string | null;
      action_type: "SHIFT_CLOSED";
      payload: ShiftClosedPayload;
      status: SyncStatus;
      created_at: string;
      synced_at?: string;
      cashierName?: string;
      sync_attempts?: number;
    }
  | {
      sync_id: string;
      storeId?: string | null;
      action_type: "DEBT_SETTLEMENT";
      payload: DebtSettlementPayload;
      status: SyncStatus;
      created_at: string;
      synced_at?: string;
      cashierName?: string;
      sync_attempts?: number;
    }
  | {
      sync_id: string;
      storeId?: string | null;
      action_type: "EXPENSE_RECORDED";
      payload: ExpenseRecordedPayload;
      status: SyncStatus;
      created_at: string;
      synced_at?: string;
      cashierName?: string;
      sync_attempts?: number;
    }
  | {
      sync_id: string;
      storeId?: string | null;
      action_type: "CASH_MOVEMENT";
      payload: CashMovementPayload;
      status: SyncStatus;
      created_at: string;
      synced_at?: string;
      cashierName?: string;
      sync_attempts?: number;
    }
  | {
      sync_id: string;
      storeId?: string | null;
      action_type: "SUPPLIER_INVOICE_CREATED";
      payload: SupplierInvoiceCreatedPayload;
      status: SyncStatus;
      created_at: string;
      synced_at?: string;
      cashierName?: string;
      sync_attempts?: number;
    }
  | {
      sync_id: string;
      storeId?: string | null;
      action_type: "SHORTAGE_FLAGGED";
      payload: ShortageFlaggedPayload;
      status: SyncStatus;
      created_at: string;
      synced_at?: string;
      cashierName?: string;
      sync_attempts?: number;
    }
  | {
      sync_id: string;
      storeId?: string | null;
      action_type: "SUPPLIER_CREATE";
      payload: SupplierCreatePayload;
      status: SyncStatus;
      created_at: string;
      synced_at?: string;
      cashierName?: string;
      sync_attempts?: number;
    }
  | {
      sync_id: string;
      storeId?: string | null;
      action_type: "BARCODE_LABEL_PRINT";
      payload: BarcodeLabelPrintPayload;
      status: SyncStatus;
      created_at: string;
      synced_at?: string;
      cashierName?: string;
      sync_attempts?: number;
    };

/**
 * Offline cache of the product catalog. Live devices store one cache row per
 * tenant so a stale demo/test snapshot can never hydrate a real store.
 */
export interface CatalogCache {
  storeId?: string | null;
  categories: CategoryMap;
  products: ProductMap;
  barcodes: BarcodeMap;
  barcodeIndex: BarcodeIndex;
  quickKeys: QuickKeyItem[];
  cashiers: Cashier[];
  pinSalt: string;
  updatedAt: string;
}

/**
 * A queued event the server refused to mirror (poison). Parked — never
 * dropped — so the sale stays recoverable and the owner sees it in the
 * quarantine badge / audit view.
 */
export interface PoisonSyncRecord {
  sync_id: string;
  storeId?: string | null;
  action_type: SyncQueueRecord["action_type"];
  payload: SyncQueueRecord["payload"];
  /** Why the server stopped accepting it (rejection reason / attempt cap). */
  reason: string;
  /** Consecutive server-side failures that pushed it into quarantine. */
  sync_attempts?: number;
  poisoned_at: string;
}

export interface CustomerCache {
  storeId?: string | null;
  customers: PosCustomer[];
  updatedAt: string;
}

/** Per-invoice ISTD/JoFotara submission state (Risk 9: no invisible failures). */
export type IstdStatus = "PENDING" | "SUBMITTING" | "SUBMITTED" | "FAILED";

export interface IstdState {
  sync_id: string;
  storeId?: string | null;
  status: IstdStatus;
  istd_uuid?: string;
  istd_qr?: string;
  error?: string;
  updated_at: string;
}

const DB_NAME = "pos_local_db";
const DB_VERSION = 8;
const STORE = "sync_queue";
const POISON_STORE = "sync_poison";
const CATALOG_STORE = "catalog_cache";
const CUSTOMER_STORE = "customer_cache";
const ISTD_STORE = "istd_state";
const RECEIVING_STORE = "receiving_cache";
const PRICE_MEMORY_STORE = "price_memory";
const SHORTAGE_FLAG_STORE = "shortage_flags";
const CATALOG_KEY = "main";
const BOOT_CATALOG_PREFIX = "pos-catalog-boot";
const BOOT_CUSTOMER_PREFIX = "pos-customer-boot";
const POS_PERSIST_KEY = "pos-store";
const PRICE_MEMORY_MARKER_PREFIX = "built:";

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDb(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          const store = db.createObjectStore(STORE, { keyPath: "sync_id" });
          store.createIndex("status", "status");
        }
        if (oldVersion < 2) {
          db.createObjectStore(CATALOG_STORE, { keyPath: "key" });
        }
        if (oldVersion < 3) {
          db.createObjectStore(CUSTOMER_STORE, { keyPath: "key" });
        }
        if (oldVersion < 4) {
          db.createObjectStore(POISON_STORE, { keyPath: "sync_id" });
        }
        if (oldVersion < 5) {
          db.createObjectStore(ISTD_STORE, { keyPath: "sync_id" });
        }
        if (oldVersion < 6) {
          db.createObjectStore(RECEIVING_STORE, { keyPath: "key" });
        }
        if (oldVersion < 7) {
          const store = db.createObjectStore(PRICE_MEMORY_STORE, { keyPath: "key" });
          store.createIndex("customer", "customerKey");
        }
        if (oldVersion < 8) {
          db.createObjectStore(SHORTAGE_FLAG_STORE, { keyPath: "key" });
        }
      },
    });
  }
  return dbPromise;
}

/** Persist a transaction to the offline queue. */
export async function enqueueSync(record: SyncQueueRecord): Promise<void> {
  const db = await getDb();
  const tenantId = getTenantStoreId();
  await db.put(STORE, tenantId ? { ...record, storeId: tenantId } : record);
}

/**
 * Enqueue a remote barcode-label print. The sync mirror lands a `print_jobs`
 * row the /print-server kiosk claims, so the register can request labels
 * without the label printer physically attached to it.
 */
export async function enqueueLabelPrint(
  input: Omit<BarcodeLabelPrintPayload, "created_at">,
  cashierName?: string,
): Promise<void> {
  const created_at = new Date().toISOString();
  const record: SyncQueueRecord = {
    sync_id: newUuid(),
    action_type: "BARCODE_LABEL_PRINT",
    payload: { ...input, created_at },
    status: "PENDING",
    created_at,
    cashierName,
  };
  await enqueueSync(record);
}

/**
 * Drop PENDING SHORTAGE_FLAGGED rows for the same product before a fresh flag
 * is queued. Repeated flags on a product must never accumulate offline rows —
 * the latest cashier report wins, and each flag still keeps its own sync_id so
 * an already-SYNCED row is never overwritten out from under the server mirror.
 */
export async function deletePendingShortageFlags(productId: string): Promise<void> {
  const db = await getDb();
  const tenantId = getTenantStoreId();
  const pending = await db.getAllFromIndex(STORE, "status", "PENDING");
  for (const record of pending) {
    if (record.action_type !== "SHORTAGE_FLAGGED") continue;
    if (record.payload.productId !== productId) continue;
    if (tenantId && record.storeId !== tenantId) continue;
    await db.delete(STORE, record.sync_id);
  }
}

/** Read all queued records filtered by status, using the `status` index. */
export async function getSyncsByStatus(
  status: SyncStatus,
): Promise<SyncQueueRecord[]> {
  const db = await getDb();
  return db.getAllFromIndex(STORE, "status", status);
}

/**
 * Tenant-scoping rule for the offline queue. A record may only be synced —
 * or counted toward the pending badge — while the active tenant is the one
 * that enqueued it. Unbound records (no storeId: fixtures or pre-tagging
 * legacy rows) are never synced because they cannot be safely attributed,
 * so they can never leak into a different store's stock or ledgers.
 */
export function isQueueRecordForTenant(
  record: Pick<SyncQueueRecord, "storeId">,
  currentStoreId: string | null,
): boolean {
  return record.storeId === currentStoreId;
}

/** Mark one or more queued records as successfully synced. */
export async function markSyncCompleted(
  syncIds: string | string[],
): Promise<void> {
  const db = await getDb();
  const ids = Array.isArray(syncIds) ? syncIds : [syncIds];
  for (const syncId of ids) {
    const record = await db.get(STORE, syncId);
    if (record) {
      await db.put(STORE, {
        ...record,
        status: "SYNCED" as SyncStatus,
        synced_at: new Date().toISOString(),
      });
    }
  }
}

/**
 * Permanently drop rejected/corrupt queued records by sync id.
 * DELIBERATELY UNUSED by the sync pipeline: poison records must be
 * quarantined (`quarantineSyncRecord`), never silently deleted — a dropped
 * event is a lost sale.
 */
export async function deleteSyncs(syncIds: string | string[]): Promise<void> {
  const db = await getDb();
  const ids = Array.isArray(syncIds) ? syncIds : [syncIds];
  for (const syncId of ids) {
    await db.delete(STORE, syncId);
  }
}

/**
 * Park a poison record in the `sync_poison` quarantine instead of dropping
 * it. The record leaves the live queue (so it stops retrying and aging the
 * pending badge) but is fully preserved — `getPoisonSyncRecords` +
 * `countPoisonSyncRecords` surface it to the owner for a manual fix/requeue.
 */
export async function quarantineSyncRecord(
  record: SyncQueueRecord,
  reason: string,
): Promise<void> {
  const db = await getDb();
  const poison: PoisonSyncRecord = {
    sync_id: record.sync_id,
    storeId: record.storeId,
    action_type: record.action_type,
    payload: record.payload,
    reason,
    sync_attempts: record.sync_attempts,
    poisoned_at: new Date().toISOString(),
  };
  await db.put(POISON_STORE, poison);
  await db.delete(STORE, record.sync_id);
}

/** All quarantined poison records (newest first is not required — audit sorts). */
export async function getPoisonSyncRecords(): Promise<PoisonSyncRecord[]> {
  const db = await getDb();
  return (await db.getAll(POISON_STORE)) as PoisonSyncRecord[];
}

/** Number of parked poison records (drives the persistent header badge). */
export async function countPoisonSyncRecords(): Promise<number> {
  const db = await getDb();
  return db.count(POISON_STORE);
}

/**
 * Merge a patch into a queued record's payload (e.g. stamp the ISTD clearance
 * result onto an invoice so the later sync mirror writes it without
 * re-submitting to ISTD). No-op when the record no longer exists.
 */
export async function patchSyncRecordPayload(
  syncId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const db = await getDb();
  const record = await db.get(STORE, syncId);
  if (!record) return;
  await db.put(STORE, {
    ...record,
    payload: { ...(record.payload as Record<string, unknown>), ...patch },
  });
}

/**
 * Increment the consecutive server-side failure counter of each record and
 * return the new counts. Only used when the server responded (2xx) yet did
 * not ack the record — a poison event that keeps failing mirroring. Network
 * failures (no response) never count so an outage can't age out the queue.
 */
export async function markSyncAttemptFailed(syncIds: string[]): Promise<number[]> {
  const db = await getDb();
  const counts: number[] = [];
  for (const syncId of syncIds) {
    const record = await db.get(STORE, syncId);
    if (!record) {
      counts.push(0);
      continue;
    }
    const attempts = (record.sync_attempts ?? 0) + 1;
    await db.put(STORE, { ...record, sync_attempts: attempts });
    counts.push(attempts);
  }
  return counts;
}

/** Look up a settled invoice by its sync id (secure returns reference). */
export async function findInvoiceById(
  syncId: string,
): Promise<SyncQueueRecord | null> {
  const db = await getDb();
  const record = await db.get(STORE, syncId);
  return (record as SyncQueueRecord) ?? null;
}

/**
 * True when the invoice identified by `originalSyncId` has already been
 * returned: any queued INVOICE_CREATED record that references it as its
 * `originalInvoiceId` counts as a processed return (double-return guard).
 */
export async function isInvoiceReturned(
  originalSyncId: string,
): Promise<boolean> {
  const db = await getDb();
  const records = await db.getAll(STORE);
  return records.some(
    (r) =>
      r.action_type === "INVOICE_CREATED" &&
      r.payload?.originalInvoiceId === originalSyncId,
  );
}

/** Wipe the queue (used by sync services after server reconciliation). */
export async function clearSyncQueue(): Promise<void> {
  const db = await getDb();
  await db.clear(STORE);
}

/** Type guard narrowing a queue record to an INVOICE_CREATED document. */
function isInvoiceRecord(
  r: SyncQueueRecord,
): r is Extract<SyncQueueRecord, { action_type: "INVOICE_CREATED" }> {
  return r.action_type === "INVOICE_CREATED";
}

/** All settled INVOICE_CREATED documents for one tenant, newest first. */
export async function listInvoices(
  storeId?: string | null,
): Promise<SyncQueueRecord[]> {
  const db = await getDb();
  const records = (await db.getAll(STORE)) as SyncQueueRecord[];
  return records
    .filter(isInvoiceRecord)
    .filter((r) => r.storeId === storeId)
    .sort((a, b) =>
      (b.payload?.completed_at ?? b.created_at).localeCompare(
        a.payload?.completed_at ?? a.created_at,
      ),
    );
}

function catalogKeyFor(storeId?: string | null): string {
  return storeId ? `store:${storeId}` : CATALOG_KEY;
}

function bootKey(prefix: string, storeId?: string | null): string {
  return storeId ? `${prefix}:${storeId}` : `${prefix}:${CATALOG_KEY}`;
}

function readPersistedStoreId(): string | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(POS_PERSIST_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      state?: {
        currentStore?: { id?: unknown } | null;
        adminSession?: { storeId?: unknown } | null;
      };
    };
    const currentStoreId = parsed?.state?.currentStore?.id;
    if (typeof currentStoreId === "string" && currentStoreId) return currentStoreId;
    const adminStoreId = parsed?.state?.adminSession?.storeId;
    return typeof adminStoreId === "string" && adminStoreId ? adminStoreId : null;
  } catch {
    return null;
  }
}

function readBootCacheSync<T>(prefix: string, storeId?: string | null): T | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const scopedStoreId = storeId ?? readPersistedStoreId();
    const raw = localStorage.getItem(bootKey(prefix, scopedStoreId));
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function writeBootCacheSync(prefix: string, value: unknown, storeId?: string | null): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(bootKey(prefix, storeId), JSON.stringify(value));
  } catch {
    // Quota / private mode: IndexedDB remains the source of truth.
  }
}

/** Persist the latest catalog snapshot for offline hydration. */
export async function saveCatalogCache(cache: CatalogCache, storeId?: string | null): Promise<void> {
  const db = await getDb();
  const scopedStoreId = storeId ?? cache.storeId ?? null;
  const key = catalogKeyFor(scopedStoreId);
  const row = { key, ...cache, storeId: scopedStoreId };
  await db.put(CATALOG_STORE, row);
  writeBootCacheSync(BOOT_CATALOG_PREFIX, row, scopedStoreId);
}

/** Load the cached catalog, or null when never hydrated. */
export async function loadCatalogCache(storeId?: string | null): Promise<CatalogCache | null> {
  const db = await getDb();
  const row = await db.get(CATALOG_STORE, catalogKeyFor(storeId));
  if (!row) return null;
  const cached = row as CatalogCache & { key: string };
  return {
    storeId: cached.storeId ?? storeId ?? null,
    categories: cached.categories ?? {},
    products: cached.products ?? {},
    barcodes: cached.barcodes ?? {},
    barcodeIndex: cached.barcodeIndex ?? {},
    quickKeys: cached.quickKeys ?? [],
    cashiers: cached.cashiers ?? [],
    pinSalt: cached.pinSalt ?? "",
    updatedAt: cached.updatedAt ?? "",
  };
}

/** Synchronous boot mirror of the latest catalog cache (localStorage-backed). */
export function loadCatalogBootCacheSync(storeId?: string | null): CatalogCache | null {
  const cached = readBootCacheSync<(CatalogCache & { key?: string })>(BOOT_CATALOG_PREFIX, storeId);
  if (!cached) return null;
  return {
    storeId: cached.storeId ?? storeId ?? readPersistedStoreId(),
    categories: cached.categories ?? {},
    products: cached.products ?? {},
    barcodes: cached.barcodes ?? {},
    barcodeIndex: cached.barcodeIndex ?? {},
    quickKeys: cached.quickKeys ?? [],
    cashiers: cached.cashiers ?? [],
    pinSalt: cached.pinSalt ?? "",
    updatedAt: cached.updatedAt ?? "",
  };
}

/** Persist the latest customer ledger directory for POS checkout lookups. */
export async function saveCustomersCache(cache: CustomerCache, storeId?: string | null): Promise<void> {
  const db = await getDb();
  const scopedStoreId = storeId ?? cache.storeId ?? null;
  const key = catalogKeyFor(scopedStoreId);
  const row = { key, ...cache, storeId: scopedStoreId };
  await db.put(CUSTOMER_STORE, row);
  writeBootCacheSync(BOOT_CUSTOMER_PREFIX, row, scopedStoreId);
}

/** Load the cached customer directory, or null when never hydrated. */
export async function loadCustomersCache(storeId?: string | null): Promise<CustomerCache | null> {
  const db = await getDb();
  const row = await db.get(CUSTOMER_STORE, catalogKeyFor(storeId));
  if (!row) return null;
  const cached = row as CustomerCache & { key: string };
  return {
    storeId: cached.storeId ?? storeId ?? null,
    customers: Array.isArray(cached.customers) ? cached.customers : [],
    updatedAt: cached.updatedAt ?? "",
  };
}

/** Synchronous boot mirror of the latest customer cache (localStorage-backed). */
export function loadCustomersBootCacheSync(storeId?: string | null): CustomerCache | null {
  const cached = readBootCacheSync<(CustomerCache & { key?: string })>(BOOT_CUSTOMER_PREFIX, storeId);
  if (!cached) return null;
  return {
    storeId: cached.storeId ?? storeId ?? readPersistedStoreId(),
    customers: Array.isArray(cached.customers) ? cached.customers : [],
    updatedAt: cached.updatedAt ?? "",
  };
}

/** Synchronous boot mirror of the latest customer cache (localStorage-backed). */
export async function saveReceivingCache(
  cache: ReceivingCache,
  storeId?: string | null,
): Promise<void> {
  const db = await getDb();
  const scopedStoreId = storeId ?? cache.storeId ?? null;
  const key = catalogKeyFor(scopedStoreId);
  await db.put(RECEIVING_STORE, { key, ...cache, storeId: scopedStoreId });
}

/** Load the cached goods-in lookups, or null when never hydrated. */
export async function loadReceivingCache(
  storeId?: string | null,
): Promise<ReceivingCache | null> {
  const db = await getDb();
  const row = await db.get(RECEIVING_STORE, catalogKeyFor(storeId));
  if (!row) return null;
  const cached = row as ReceivingCache & { key: string };
  return {
    storeId: cached.storeId ?? storeId ?? null,
    histories: cached.histories ?? {},
    suppliers: cached.suppliers ?? {},
    updatedAt: cached.updatedAt ?? "",
  };
}

// ---------------------------------------------------------------------------
// Shortage flags — manual POS "Flag as Shortage" cache (Phase 5).
// One row per tenant; flags persist offline until the SHORTAGE_FLAGGED sync
// event mirrors them and the owner resolves them server-side.
// ---------------------------------------------------------------------------

/** Persist the manual shortage flags for a tenant. */
export async function saveShortageFlagCache(
  cache: ShortageFlagCache,
  storeId?: string | null,
): Promise<void> {
  const db = await getDb();
  const scopedStoreId = storeId ?? cache.storeId ?? null;
  const key = catalogKeyFor(scopedStoreId);
  await db.put(SHORTAGE_FLAG_STORE, { key, ...cache, storeId: scopedStoreId });
}

/** Load the cached manual shortage flags, or null when never hydrated. */
export async function loadShortageFlagCache(
  storeId?: string | null,
): Promise<ShortageFlagCache | null> {
  const db = await getDb();
  const row = await db.get(SHORTAGE_FLAG_STORE, catalogKeyFor(storeId));
  if (!row) return null;
  const cached = row as ShortageFlagCache & { key: string };
  return {
    storeId: cached.storeId ?? storeId ?? null,
    flags: Array.isArray(cached.flags) ? cached.flags : [],
    updatedAt: cached.updatedAt ?? "",
  };
}

// ---------------------------------------------------------------------------
// Customer Memory — last-price cache (Phase 4).
// One row per (tenant, customer, product/barcode) pair, addressed by an O(1)
// direct key, partitioned on a `customer` index for per-customer loads. The
// badge lookup path is therefore indexed reads only — never a scan.
// ---------------------------------------------------------------------------

function priceMemoryMarkerKey(storeId: string): string {
  return `${PRICE_MEMORY_MARKER_PREFIX}${storeId}`;
}

/**
 * Incrementally record the prices a settled invoice taught us about a
 * customer. Anonymous sales and unresolved (`local-`) customers are skipped
 * before any I/O, so the common no-customer checkout costs nothing.
 * Returns are skipped too — a reversal must not re-learn a price.
 */
export async function upsertPriceMemoryFromPayload(
  payload: InvoiceCreatedPayload,
  storeId: string,
): Promise<void> {
  const customerId = (payload.customerId ?? "").trim();
  if (!customerId || customerId.startsWith("local-")) return;
  const items = payload.items ?? [];
  if (items.length === 0) return;

  const now = new Date().toISOString();
  const completedAt = payload.completed_at || now;
  const db = await getDb();
  const tx = db.transaction(PRICE_MEMORY_STORE, "readwrite");
  for (const item of items) {
    if (!item || item.qty <= 0) continue;
    const key = priceMemoryKey(storeId, customerId, item.productId, item.barcode);
    if (!key) continue;
    const existing = (await tx.store.get(key)) as PriceMemoryEntry | undefined;
    await tx.store.put({
      key,
      storeId,
      customerId,
      customerKey: customerPriceMemoryKey(storeId, customerId),
      productId: item.productId,
      barcode: item.barcode,
      unitPrice: effectiveUnitPrice(item),
      unitName: item.unitName ?? "",
      completedAt,
      updatedAt: now,
      saleCount: (existing?.saleCount ?? 0) + 1,
    });
  }
  await tx.done;
}

/** O(1) direct-key read of one customer's last price for a product/barcode. */
export async function getPriceMemory(
  storeId: string,
  customerId: string,
  productId: string,
  barcode: string,
): Promise<PriceMemoryEntry | null> {
  const key = priceMemoryKey(storeId, customerId, productId, barcode);
  if (!key) return null;
  const db = await getDb();
  const row = (await db.get(PRICE_MEMORY_STORE, key)) as PriceMemoryEntry | undefined;
  return row ?? null;
}

/** All last-price rows for one (tenant, customer) partition, via the index. */
export async function loadPriceMemoryForCustomer(
  storeId: string,
  customerId: string,
): Promise<PriceMemoryEntry[]> {
  const db = await getDb();
  const rows = await db.getAllFromIndex(
    PRICE_MEMORY_STORE,
    "customer",
    customerPriceMemoryKey(storeId, customerId),
  );
  return rows as PriceMemoryEntry[];
}

/**
 * One-time offline catch-up: rebuild the last-price cache from the queued
 * invoice history (the same payloads the server mirrors into
 * `sales_invoices`/`sales_invoice_items`). Newest sale wins per pair.
 * Returns the number of unique entries materialized.
 */
export async function buildPriceMemoryCache(storeId: string): Promise<number> {
  const invoices = await listInvoices(storeId);
  const db = await getDb();
  const tx = db.transaction(PRICE_MEMORY_STORE, "readwrite");

  // Drop only this tenant's product rows (markers from other stores stay).
  const keys = (await tx.store.getAllKeys()) as string[];
  for (const key of keys) {
    if (typeof key === "string" && key.startsWith(`${storeId}|`)) {
      await tx.store.delete(key);
    }
  }

  const seen = new Set<string>();
  let count = 0;
  // listInvoices is newest-first, so the first sighting of a pair wins.
  for (const invoice of invoices) {
    if (invoice.action_type !== "INVOICE_CREATED") continue;
    const payload = invoice.payload;
    const customerId = (payload.customerId ?? "").trim();
    if (!customerId || customerId.startsWith("local-")) continue;
    const completedAt = payload.completed_at || invoice.created_at;
    for (const item of payload.items ?? []) {
      if (!item || item.qty <= 0) continue;
      const key = priceMemoryKey(storeId, customerId, item.productId, item.barcode);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      await tx.store.put({
        key,
        storeId,
        customerId,
        customerKey: customerPriceMemoryKey(storeId, customerId),
        productId: item.productId,
        barcode: item.barcode,
        unitPrice: effectiveUnitPrice(item),
        unitName: item.unitName ?? "",
        completedAt,
        updatedAt: completedAt,
        saleCount: 1,
      });
      count += 1;
    }
  }

  await tx.store.put({
    key: priceMemoryMarkerKey(storeId),
    storeId,
    updatedAt: new Date().toISOString(),
  });
  await tx.done;
  return count;
}

/** Build the cache once per store (marker-guarded); subsequent calls no-op. */
export async function ensurePriceMemoryCache(storeId: string): Promise<void> {
  const db = await getDb();
  const marker = await db.get(PRICE_MEMORY_STORE, priceMemoryMarkerKey(storeId));
  if (marker) return;
  await buildPriceMemoryCache(storeId);
}

// ---------------------------------------------------------------------------
// ISTD / JoFotara submission state (Risk 9).
// ---------------------------------------------------------------------------

/** Record or update one invoice's ISTD state, tenant-scoped by the active store. */
export async function setIstdState(
  syncId: string,
  patch: {
    status: IstdStatus;
    istd_uuid?: string;
    istd_qr?: string;
    error?: string;
  },
): Promise<void> {
  const db = await getDb();
  const existing = (await db.get(ISTD_STORE, syncId)) as IstdState | undefined;
  const tenantId = getTenantStoreId();
  await db.put(ISTD_STORE, {
    sync_id: syncId,
    storeId: existing?.storeId ?? tenantId,
    status: patch.status,
    istd_uuid: patch.istd_uuid ?? existing?.istd_uuid,
    istd_qr: patch.istd_qr ?? existing?.istd_qr,
    error: patch.error ?? existing?.error,
    updated_at: new Date().toISOString(),
  });
}

/** The current ISTD state of one invoice, or undefined when never submitted. */
export async function getIstdState(syncId: string): Promise<IstdState | undefined> {
  const db = await getDb();
  return (await db.get(ISTD_STORE, syncId)) as IstdState | undefined;
}

/** All ISTD state rows for one tenant. */
export async function getIstdStates(storeId?: string | null): Promise<IstdState[]> {
  const db = await getDb();
  const rows = (await db.getAll(ISTD_STORE)) as IstdState[];
  return storeId ? rows.filter((r) => r.storeId === storeId) : rows;
}

/**
 * Invoices not yet cleared with JoFotara: PENDING/SUBMITTING (never sent or in
 * flight) plus FAILED (sent but rejected — still visible, never silent).
 */
export async function countIstdPending(storeId: string): Promise<number> {
  const rows = await getIstdStates(storeId);
  return rows.filter(
    (r) => r.status === "PENDING" || r.status === "SUBMITTING" || r.status === "FAILED",
  ).length;
}

/** Invoices whose ISTD submission was rejected — must be surfaced, not silent. */
export async function countIstdFailed(storeId: string): Promise<number> {
  const rows = await getIstdStates(storeId);
  return rows.filter((r) => r.status === "FAILED").length;
}
