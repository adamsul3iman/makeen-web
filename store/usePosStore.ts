import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
  AdminSession,
  BarcodeIndex,
  BarcodeMap,
  Branch,
  Cashier,
  CashMovement,
  CashMovementType,
  CategoryMap,
  CompletedInvoice,
  DiscountInput,
  HeldInvoice,
  PaymentMethod,
  PosCustomer,
  PosSnapshot,
  ProductMap,
  QuickKeyItem,
  SaleItem,
  SaleTotals,
  ShiftState,
  ShiftTotals,
  ShiftTransaction,
  ShortageFlag,
  Store,
  StoreSummary,
  SubscriptionStatus,
  Terminal,
} from "@/types/pos.types";
import {
  countIstdFailed,
  countIstdPending,
  countPoisonSyncRecords,
  enqueueSync,
  ensurePriceMemoryCache,
  deletePendingShortageFlags,
  findInvoiceById,
  getIstdStates,
  getSyncsByStatus,
  isInvoiceReturned,
  loadCatalogBootCacheSync,
  loadCatalogCache,
  loadCustomersBootCacheSync,
  loadCustomersCache,
  loadPriceMemoryForCustomer,
  loadShortageFlagCache,
  saveCatalogCache,
  saveCustomersCache,
  saveShortageFlagCache,
  upsertPriceMemoryFromPayload,
  type SyncQueueRecord,
} from "@/lib/idb";
import { priceMemoryLookupKey, type PriceMemoryEntry } from "@/lib/priceMemory";
import { sha256Hex } from "@/lib/sha256";
import { openCashDrawer } from "@/lib/cashDrawer";
import { loadDeviceHardwareSettings } from "@/lib/deviceHardware";
import { pushAudit } from "@/lib/audit";
import { newUuid } from "@/lib/uuid";
import { getTenantStoreId, setTenantStoreId } from "@/lib/tenantClient";
import { STORE_HEADER } from "@/lib/tenant";
import { effectiveTaxPercent } from "@/lib/qr";
import { computeFiscalBreakdown, computeSaleTotals } from "@/lib/saleMath";
import { derivePaymentBuckets } from "@/lib/paymentBuckets";
import {
  createPosPersistStorage,
  flushPersistWrites,
  posPersistStorage,
} from "@/lib/persistStorage";
import { emitPosSound } from "@/lib/posSound";
import { getSupabaseBrowser, isSupabaseBrowserConfigured } from "@/lib/supabaseBrowser";
import { hasCapability, STAFF_ROLE_PRESETS, normalizeStaffRoleCode, homePathForDevice } from "@/lib/permissions";
import { pushInvoiceToIstd } from "@/lib/clientIstd";

/** Legacy fallback VAT percent for stores without fiscal settings. */
const TAX_RATE = 16;

/** Discounts beyond these limits require the owner's password to apply. */
const DISCOUNT_PERCENT_APPROVAL = 10;
const DISCOUNT_AMOUNT_APPROVAL = 50;

/**
 * Rebuild the ISTD-pushable invoice from a settled queue record, so a FAILED
 * submission can be retried by `retryPendingIstd` without re-running checkout.
 */
function completedInvoiceFromQueueRecord(
  record: Extract<SyncQueueRecord, { action_type: "INVOICE_CREATED" }>,
): CompletedInvoice | null {
  const payload = record.payload;
  return {
    syncId: record.sync_id,
    shiftId: payload.shiftId ?? "",
    items: payload.items ?? [],
    subtotal: payload.subtotal ?? 0,
    tax: payload.tax ?? 0,
    discount: payload.discount ?? 0,
    deliveryFee: payload.deliveryFee ?? 0,
    total: payload.total ?? 0,
    paymentMethod: payload.paymentMethod,
    amountPaid: payload.amountPaid ?? 0,
    change: payload.change ?? 0,
    customerName: payload.customerName,
    customerId: payload.customerId,
    customerPhone: payload.customerPhone,
    cashierName: payload.cashierName,
    originalInvoiceId: payload.originalInvoiceId,
    branchId: payload.branchId,
    terminalId: payload.terminalId,
    istdUuid: payload.istd_uuid,
    istdQr: payload.istd_qr,
    completed_at: payload.completed_at,
  };
}

/**
 * Offline unlock device lockout (F3). A 4-digit PIN is brute-forceable in
 * ≤10k tries from a leaked snapshot, so the register enforces an escalating
 * cooldown on consecutive failures. Resets on a successful unlock.
 */
const PIN_MAX_ATTEMPTS = 5;
const PIN_LOCKOUT_BASE_MS = 30_000;
const PIN_LOCKOUT_CAP_MS = 30 * 60_000;

function pinCooldownMs(level: number): number {
  return Math.min(PIN_LOCKOUT_CAP_MS, PIN_LOCKOUT_BASE_MS * Math.pow(2, level));
}

function pinLockedNotice(lockedUntil: number): string {
  const secs = Math.max(1, Math.ceil((lockedUntil - Date.now()) / 1000));
  return `تم تعطيل رمز PIN مؤقتاً — حاول مجدداً بعد ${secs} ثانية`;
}

/** Reference back to the original invoice a return reverses. */
export interface ReturnReference {
  originalSyncId: string;
  originalCompletedAt: string;
  /**
   * Per-line snapshot of the negated return document (index-aligned with the
   * original invoice lines). `qty` is the full original quantity and `unitNet`
   * the prorated discounted net per unit, so a partial return can be rebuilt
   * exactly: `lineTotal = -unitNet * selectedQty`.
   */
  lines: Array<{
    qty: number;
    unitNet: number;
    item: SaleItem;
  }>;
}

export interface UiNotice {
  message: string;
  tone: "error" | "success";
}

/** A destructive/inline action awaiting the owner's password (secondary auth). */
export type SecondaryAction =
  | { type: "open_drawer" }
  | { type: "cancel_invoice"; syncId: string; label?: string }
  | {
      type: "save_cashier";
      cashier: {
        id?: string;
        name: string;
        role: string;
        roleId?: string;
        pin: string;
        username?: string;
        isActive?: boolean;
      };
    }
  | {
      type: "delete_cashier";
      cashierId: string;
      name?: string;
    }
  | { type: "approve_discount"; discount: DiscountInput }
  | { type: "toggle_return_mode" };

/** New/edited cashier row collected by the inline management modal. */
export interface CashierDraft {
  id?: string;
  name: string;
  role: string;
  roleId?: string;
  pin: string;
  username?: string;
  isActive?: boolean;
}

interface CartSlot {
  id: string;
  items: SaleItem[];
  invoiceDiscount: DiscountInput | null;
  deliveryFee: number;
}

interface PosStoreState {
  ready: boolean;
  catalogUpdatedAt: string;
  _catalogHydrated: boolean;
  categories: CategoryMap;
  products: ProductMap;
  barcodes: BarcodeMap;
  barcodeIndex: BarcodeIndex;
  quickKeys: QuickKeyItem[];
  customers: PosCustomer[];
  customersUpdatedAt: string;
  customersLoading: boolean;
  /** Category tab active in the quick-keys grid (null = "الأكثر طلباً" all). */
  activeCategoryId: string | null;
  /** Multi-cart: each slot holds one invoice tab's data. */
  cartSlots: CartSlot[];
  activeCartIndex: number;
  items: SaleItem[];
  totals: SaleTotals;
  notice: UiNotice | null;
  heldInvoices: HeldInvoice[];
  isCheckoutModalOpen: boolean;
  isHoldModalOpen: boolean;
  /** Incremented on every checkout open to remount the modal fresh. */
  checkoutSession: number;
  isOnline: boolean;
  pendingSyncCount: number;
  /** Count of poison sync records parked in the `sync_poison` quarantine. */
  poisonSyncCount: number;
  /** Invoices not yet cleared with JoFotara (PENDING/SUBMITTING/FAILED). */
  istdPendingCount: number;
  /** Invoices whose ISTD submission was rejected — surfaced, never silent. */
  istdFailedCount: number;
  /** True when another tab/device holds this register's lease (read-only). */
  registerLeaseHeld: boolean;
  shiftState: ShiftState;
  shiftTotals: ShiftTotals;
  shiftTransactions: ShiftTransaction[];
  /** Manual cash movements (deposits/withdrawals) during the active shift. */
  cashMovements: CashMovement[];
  isCloseShiftModalOpen: boolean;
  isShiftDetailsModalOpen: boolean;
  isShiftClosedSuccess: boolean;
  closedShiftSummary: {
    shiftId: string | null;
    startTime: string | null;
    closeTime: string;
    startingCash: number;
    cashSales: number;
    visaSales: number;
    cliqSales: number;
    debtSales: number;
    debtCollections: number;
    totalSales: number;
    discounts: number;
    returns: number;
    expenses: number;
    expectedCashInDrawer: number;
    actualCash: number;
    variance: number;
    expectedCard: number;
    actualCard: number;
    cardVariance: number;
    expectedCliq: number;
    actualCliq: number;
    cliqVariance: number;
    cashInTotal: number;
    cashOutTotal: number;
    discrepancyReason: string;
    discrepancyNote: string;
  } | null;
  isCashMovementModalOpen: boolean;
  /** Which type of cash movement modal is open (CASH_IN or CASH_OUT). */
  cashMovementModalType: CashMovementType | null;
  isDebtSettlementModalOpen: boolean;
  isExpenseModalOpen: boolean;
  isSmartSearchOpen: boolean;
  /** Admin Hub overlay (Ctrl+Shift+A) with quick links to the back office. */
  isAdminHubOpen: boolean;
  isReturnMode: boolean;
  /** Active invoice-level discount input (خصم على الفاتورة). */
  invoiceDiscount: DiscountInput | null;
  /** Optional delivery surcharge on the current invoice (رسوم التوصيل). */
  deliveryFee: number;
  /** Original invoice reference for the current secure-return document. */
  returnReference: ReturnReference | null;
  /** Guards against double-submit while a checkout is being persisted. */
  isCompleting: boolean;
  /** Bumped on every modal open so parents can remount modals fresh. */
  modalSession: number;
  lastCompletedInvoice: CompletedInvoice | null;
  currentCashier: {
    id: string;
    name: string;
    role: string;
    roleId?: string;
    roleCode?: string;
    roleName?: string;
    capabilities?: string[];
    limits?: Record<string, number | null>;
    sessionReady?: boolean;
  } | null;
  cashiers: Cashier[];
  /** Salt for `sha256(pin + pinSalt)` shipped by /api/catalog. */
  pinSalt: string;
  /**
   * Offline unlock lockout state (F3): consecutive failed PIN attempts and
   * the device-wide lockout deadline. Persisted so a reload can't reset it.
   */
  pinFailCount: number;
  pinLockedUntil: number;
  pinLockoutLevel: number;
  /** Tenant partition bound to this device (set by /api/login). */
  currentStore: Store | null;
  /**
   * Tenant that owns the persisted cart/shift runtime. It deliberately
   * survives a full admin logout so a later login can distinguish a safe
   * same-store resume from a cross-store device handover.
   */
  runtimeStoreId: string | null;
  /**
   * Store-owner session from the dashboard email/password login. This is the
   * ONLY source of the POS store context — the PIN pad never offers a tenant
   * dropdown.
   */
  adminSession: AdminSession | null;
  /** Public store registry rendered on the login picker. */
  stores: StoreSummary[];
  /** Branches of the current store (Phase 26). */
  branches: Branch[];
  /** Terminals across the current store's branches (Phase 26). */
  terminals: Terminal[];
  /** Branch the register is bound to (default = main branch on login). */
  activeBranchId: string | null;
  /** Terminal whose drawer this register operates. */
  activeTerminalId: string | null;
  /** Password re-entry gate for destructive admin actions (P2). */
  isSecondaryAuthOpen: boolean;
  /** The action waiting on the owner's password. */
  pendingSecondaryAction: SecondaryAction | null;
  /** Inline previous-invoices modal (admin). */
  isPreviousInvoicesModalOpen: boolean;
  /** Cart line index whose unit price is being overridden (admin). */
  lineEditTarget: number | null;
  /** P3: read-only admin audit-log timeline (سجل الرقابة). */
  isAuditLogOpen: boolean;
  /**
   * P4: customer assigned to the current cart. Drives the last-price memory
   * badges and is stamped onto the completed invoice.
   */
  activeCustomerId: string | null;
  /**
   * P4: in-memory last-price index for the active customer, keyed by the
   * price-memory lookup key (`p:${productId}` | `b:${barcode}`). Loaded off
   * the IDB `customer` index so the badge read is a synchronous map hit.
   */
  priceMemory: Record<string, PriceMemoryEntry>;
  /**
   * P5: manual shortage flags raised from the register, keyed by product id
   * (the latest unresolved flag per product). Durable in the IDB shortage
   * cache; `flagShortage` persists both here and to the sync queue.
   */
  shortageFlags: Record<string, ShortageFlag>;
}

interface PosStoreActions {
  loadSnapshot: (snapshot: PosSnapshot) => void;
  upsertCustomer: (customer: PosCustomer) => void;
  scanBarcode: (raw: string) => void;
  addQuickKeyItem: (key: QuickKeyItem) => void;
  /** Keyboard ring-up: add a product (or a specific barcode) to the cart. */
  addSearchItem: (productId: string, qty?: number, barcode?: string) => void;
  updateQty: (index: number, qty: number) => void;
  removeItem: (index: number) => void;
  /** Ad-hoc item with no catalog/inventory record (name + price + optional barcode). */
  addQuickItem: (name: string, price: number, barcode?: string) => void;
  /** Set the optional delivery surcharge on the current invoice. */
  setDeliveryFee: (fee: number) => void;
  clearInvoice: () => void;
  setNotice: (message: string, tone?: UiNotice["tone"]) => void;
  dismissNotice: () => void;
  openCheckout: () => void;
  closeCheckout: () => void;
  openHoldModal: () => void;
  closeHoldModal: () => void;
  holdInvoice: () => void;
  restoreInvoice: (id: string) => void;
  completeCheckout: (
    paymentMethod: PaymentMethod,
    amountPaid: number,
    customerName?: string,
    customerId?: string,
    customerPhone?: string,
  ) => Promise<void>;
  setOnline: (online: boolean) => void;
  setPendingSyncCount: (count: number) => void;
  /** Refresh the count of poison (quarantined) sync records for the badge. */
  refreshPoisonSyncCount: () => Promise<void>;
  /** Refresh the ISTD pending/failed badge counts from IndexedDB. */
  refreshIstdCounts: () => Promise<void>;
  /** Re-submit all FAILED ISTD invoices for the active store (owner retry). */
  retryPendingIstd: () => Promise<{ retried: number }>;
  /** Switch the quick-keys category filter (null = show all). */
  setActiveCategoryId: (categoryId: string | null) => void;
  openShift: (startingCash: number, branchId?: string, terminalId?: string) => Promise<void>;
  closeShift: (actualCash: number, actualCard: number, actualCliq: number, discrepancyReason: string, discrepancyNote: string) => Promise<void>;
  openCloseShiftModal: () => void;
  closeCloseShiftModal: () => void;
  openShiftDetailsModal: () => void;
  closeShiftDetailsModal: () => void;
  setShiftClosedSuccess: (v: boolean) => void;
  incrementDrawerOpenCount: () => void;
  /** Record a manual cash deposit or withdrawal during the shift. */
  recordCashMovement: (type: CashMovementType, amount: number, reason: string, notes: string) => Promise<void>;
  openCashMovementModal: (type: CashMovementType) => void;
  closeCashMovementModal: () => void;
  openDebtSettlementModal: () => void;
  closeDebtSettlementModal: () => void;
  openExpenseModal: () => void;
  closeExpenseModal: () => void;
  openSmartSearch: () => void;
  closeSmartSearch: () => void;
  openAdminHub: () => void;
  closeAdminHub: () => void;
  toggleSmartSearch: () => void;
  processDebtSettlement: (customerName: string, amount: number, customerId?: string) => Promise<void>;
  recordExpense: (category: string, amount: number, notes?: string) => Promise<void>;
  toggleReturnMode: () => void;
  requestReturnModeToggle: () => void;
  applyDiscount: (input: DiscountInput) => void;
  commitDiscount: (input: DiscountInput) => void;
  clearDiscount: () => void;
  beginReturnByInvoice: (syncId: string) => Promise<boolean>;
  /** Restrict a loaded return to a line-level quantity (0 drops the line). */
  setReturnLineQty: (index: number, qty: number) => void;
  clearLastInvoice: () => void;
  /** Stamp the ISTD clearance result onto the last completed invoice (if it still matches). */
  setLastCompletedInvoice: (invoice: CompletedInvoice) => void;
  loginCashier: (pin: string) => boolean;
  /** Owner-only: open the register directly as the owner (no PIN). */
  loginAsOwner: () => boolean;
  logoutCashier: () => void;
  /** Multi-tenant login: binds a store + cashier via /api/login. */
  loginStore: (pin: string, storeId: string) => Promise<boolean>;
  /** Unified staff login: store code + username + PIN via /api/login. */
  staffLogin: (input: { storeCode: string; username: string; pin: string }) => Promise<boolean>;
  /** Dashboard admin login (email + password) via /api/admin/login. */
  adminLogin: (email: string, password: string) => Promise<boolean>;
  /** Lock the register: keep store context, drop the cashier session. */
  lockScreen: () => Promise<void>;
  setCurrentStore: (store: Store) => void;
  loadStores: (stores: StoreSummary[]) => void;
  /** Bind the register to a branch + terminal (Phase 26). */
  selectTerminal: (branchId: string, terminalId: string) => void;
  /** Change the admin session email after a credentials update. */
  setAdminSessionEmail: (email: string) => void;
  /** Populate branch/terminal registry + defaults from /api/login. */
  setBranchesAndTerminals: (
    branches: Branch[],
    terminals: Terminal[],
    defaultBranchId?: string | null,
    defaultTerminalId?: string | null,
  ) => void;
  hydrateCatalog: () => Promise<void>;
  /** Ask for the owner password before a destructive action. */
  requestSecondaryAuth: (action: SecondaryAction) => void;
  /** Close the password gate without doing anything. */
  cancelSecondaryAuth: () => void;
  /** Verify the owner password, then run the pending action. */
  confirmSecondaryAction: (password: string) => Promise<boolean>;
  /** Admin-only: open the ESC/POS cash drawer (after auth). */
  openDrawer: () => Promise<void>;
  /** Admin-only: enqueue a full reversal of a completed invoice (after auth). */
  cancelInvoice: (syncId: string) => Promise<void>;
  /** Admin-only: inline override of a cart line's unit price. */
  adminSetLinePrice: (index: number, price: number) => void;
  /** Admin-only: persist a new/edited cashier (self-verifies the password). */
  saveCashier: (draft: CashierDraft, password: string) => Promise<boolean>;
  deleteCashier: (id: string, password: string) => Promise<boolean>;
  openPreviousInvoicesModal: () => void;
  closePreviousInvoicesModal: () => void;
  setLineEditTarget: (index: number | null) => void;
  openAuditLogModal: () => void;
  closeAuditLogModal: () => void;
  /** P4: assign (or clear, with null) the customer the cart belongs to. */
  setActiveCustomer: (customerId: string | null) => void;
  /** P4: (re)load the active customer's last-price index from IndexedDB. */
  refreshPriceMemory: () => Promise<void>;
  /** P4: cashier-level one-click override of a line to its remembered price. */
  applyMemoryPrice: (index: number) => void;
  /** P5: raise an emergency shortage flag — hits the radar even when stock says otherwise. */
  flagShortage: (productId: string, reason?: string) => Promise<void>;
  /** Multi-cart: switch to another invoice tab, saving the current cart first. */
  switchCart: (index: number) => void;
  /** Multi-cart: create a new empty invoice tab and switch to it. */
  createCart: () => void;
  /** Multi-cart: close an invoice tab. Cannot close the last remaining tab. */
  closeCart: (index: number) => void;
}

export type PosStore = PosStoreState & PosStoreActions;

type ShallowEntity = object;
const POS_PERSIST_NAME = "pos-store";
const POS_PERSIST_VERSION = 1;

const catalogHydrationJobs = new Map<string, Promise<void>>();

function shallowEqualEntity<T extends ShallowEntity>(left: T | undefined, right: T | undefined): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (!Object.is(leftRecord[key], rightRecord[key])) return false;
  }
  return true;
}

function mergeEntityMap<T extends ShallowEntity>(
  current: Record<string, T>,
  next: Record<string, T>,
): Record<string, T> {
  const currentKeys = Object.keys(current);
  const nextKeys = Object.keys(next);
  let changed = currentKeys.length !== nextKeys.length;
  const merged: Record<string, T> = {};
  for (const key of nextKeys) {
    const previous = current[key];
    const incoming = next[key];
    if (previous && shallowEqualEntity(previous, incoming)) {
      merged[key] = previous;
      continue;
    }
    merged[key] = incoming;
    changed = true;
  }
  return changed ? merged : current;
}

function mergeEntityArray<T extends { id: string }>(
  current: T[],
  next: T[],
): T[] {
  let changed = current.length !== next.length;
  const currentById = new Map(current.map((item) => [item.id, item] as const));
  const merged = next.map((item) => {
    const previous = currentById.get(item.id);
    if (previous && shallowEqualEntity(previous, item)) return previous;
    changed = true;
    return item;
  });
  return changed ? merged : current;
}

function normalizeCustomers(customers: PosCustomer[]): PosCustomer[] {
  return [...customers]
    .map((customer) => ({
      id: customer.id,
      name: customer.name,
      phone: customer.phone ?? "",
      balance: Number(customer.balance) || 0,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "ar"));
}

function mergeCustomers(current: PosCustomer[], next: PosCustomer[]): PosCustomer[] {
  return mergeEntityArray(current, normalizeCustomers(next));
}

function bootCatalogState(cache: ReturnType<typeof loadCatalogBootCacheSync>) {
  if (!cache) {
    return {
      ready: false,
      catalogUpdatedAt: "",
      _catalogHydrated: false,
      categories: {} as CategoryMap,
      products: {} as ProductMap,
      barcodes: {} as BarcodeMap,
      barcodeIndex: {} as BarcodeIndex,
      quickKeys: [] as QuickKeyItem[],
      cashiers: [] as Cashier[],
      pinSalt: "",
    };
  }
  return {
    ready: true,
    catalogUpdatedAt: cache.updatedAt,
    _catalogHydrated: true,
    categories: cache.categories,
    products: cache.products,
    barcodes: cache.barcodes,
    barcodeIndex: cache.barcodeIndex,
    quickKeys: [...cache.quickKeys].sort((a, b) => a.sortOrder - b.sortOrder),
    cashiers: cache.cashiers,
    pinSalt: cache.pinSalt,
  };
}

function bootCustomerState(cache: ReturnType<typeof loadCustomersBootCacheSync>) {
  return {
    customers: cache ? normalizeCustomers(cache.customers) : ([] as PosCustomer[]),
    customersUpdatedAt: cache?.updatedAt ?? "",
    customersLoading: false,
  };
}

function applyCatalogState(
  state: Pick<
    PosStoreState,
    | "categories"
    | "products"
    | "barcodes"
    | "barcodeIndex"
    | "quickKeys"
    | "cashiers"
    | "pinSalt"
  >,
  snapshot: PosSnapshot,
) {
  return {
    ready: true,
    catalogUpdatedAt: snapshot.updatedAt,
    _catalogHydrated: true,
    categories: mergeEntityMap(state.categories, snapshot.categories),
    products: mergeEntityMap(state.products, snapshot.products),
    barcodes: mergeEntityMap(state.barcodes, snapshot.barcodes),
    barcodeIndex: mergeEntityMap(state.barcodeIndex, snapshot.barcodeIndex),
    quickKeys: mergeEntityArray(
      state.quickKeys,
      [...snapshot.quickKeys].sort((a, b) => a.sortOrder - b.sortOrder),
    ),
    cashiers: mergeEntityArray(state.cashiers, snapshot.cashiers),
    pinSalt: snapshot.pinSalt,
  };
}

function snapshotFromCatalogCache(
  cache: NonNullable<Awaited<ReturnType<typeof loadCatalogCache>>>,
): PosSnapshot {
  return {
    schemaVersion: 1,
    updatedAt: cache.updatedAt,
    categories: cache.categories,
    products: cache.products,
    barcodes: cache.barcodes,
    barcodeIndex: cache.barcodeIndex,
    quickKeys: cache.quickKeys,
    cashiers: cache.cashiers,
    pinSalt: cache.pinSalt,
  };
}

/**
 * Single source of truth for "is any modal/dialog open". Used by hotkeys,
 * the hardware-scanner listener and the barcode form handler so no action or
 * scan can ever fire "behind" an open dialog (previous-invoices, audit log
 * and the owner password gate included).
 */
export function anyPosModalOpen(s: PosStore): boolean {
  return (
    s.isCheckoutModalOpen ||
    s.isHoldModalOpen ||
    s.isCloseShiftModalOpen ||
    s.isShiftDetailsModalOpen ||
    s.isDebtSettlementModalOpen ||
    s.isExpenseModalOpen ||
    s.isCashMovementModalOpen ||
    s.isSmartSearchOpen ||
    s.isAdminHubOpen ||
    s.isSecondaryAuthOpen ||
    s.isPreviousInvoicesModalOpen ||
    s.isAuditLogOpen
  );
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Cross-tab submit lock (Risk 6). `isCompleting` is per-tab in the zustand
 * store, so two tabs of the same register could each run `completeCheckout`.
 * Mirroring the flag to localStorage during the critical section lets
 * `useCrossTabSync` propagate the lock to every other tab — one sale, one
 * submit, one invoice.
 */
const POS_COMPLETING_KEY = "pos.is-completing";

function setCompletingCrossTab(active: boolean): void {
  if (typeof localStorage === "undefined") return;
  try {
    if (active) {
      localStorage.setItem(POS_COMPLETING_KEY, "1");
    } else {
      localStorage.removeItem(POS_COMPLETING_KEY);
    }
  } catch {
    // storage unavailable: per-tab isCompleting still guards this tab.
  }
}

function flushCriticalPersistWrites(): void {
  if (typeof queueMicrotask === "function") {
    queueMicrotask(flushPersistWrites);
    return;
  }
  setTimeout(flushPersistWrites, 0);
}

function partializePosState(state: PosStore) {
  return {
    runtimeStoreId: state.runtimeStoreId,
    shiftState: state.shiftState,
    shiftTotals: state.shiftTotals,
    shiftTransactions: state.shiftTransactions,
    cashMovements: state.cashMovements,
    currentCashier: state.currentCashier,
    currentStore: state.currentStore,
    adminSession: state.adminSession,
    cartSlots: state.cartSlots,
    activeCartIndex: state.activeCartIndex,
    items: state.items,
    totals: state.totals,
    heldInvoices: state.heldInvoices,
    isReturnMode: state.isReturnMode,
    invoiceDiscount: state.invoiceDiscount,
    deliveryFee: state.deliveryFee,
    activeCustomerId: state.activeCustomerId,
    pinFailCount: state.pinFailCount,
    pinLockedUntil: state.pinLockedUntil,
    pinLockoutLevel: state.pinLockoutLevel,
  };
}

function persistDurablePosState(state: PosStore): void {
  if (typeof localStorage === "undefined") {
    flushCriticalPersistWrites();
    return;
  }
  try {
    posPersistStorage.setItem(POS_PERSIST_NAME, {
      state: partializePosState(state),
      version: POS_PERSIST_VERSION,
    });
    flushPersistWrites();
  } catch {
    flushCriticalPersistWrites();
  }
}

/** Money impact of a discount input against a gross base. */
function discountMoney(input: DiscountInput, gross: number): number {
  if (!Number.isFinite(input.value) || input.value <= 0) return 0;
  if (input.type === "PERCENT") {
    const pct = Math.min(100, Math.max(0, input.value));
    return round2((Math.abs(gross) * pct) / 100);
  }
  return round2(Math.min(input.value, Math.abs(gross)));
}

/**
 * Line net recomputed after a qty change, preserving the active discount
 * (percent re-derives from discountPct; fixed stays but clamps to the gross).
 */
function applyQtyToLine(item: SaleItem, qty: number): SaleItem {
  const gross = round2(qty * item.unitPrice);
  if (item.discountPct) {
    const discount = round2((Math.abs(gross) * item.discountPct) / 100);
    return { ...item, qty, discount, lineTotal: round2(gross - discount) };
  }
  if (item.discount) {
    const discount = round2(Math.min(item.discount, Math.abs(gross)));
    return { ...item, qty, discount, lineTotal: round2(gross - discount) };
  }
  return { ...item, qty, lineTotal: gross };
}

/**
 * Deterministic temp barcode for an ad-hoc quick item. Derived from
 * name + price so repeated rings of the same quick item merge into one cart
 * line (the same identity rule as catalog lines), while different quick items
 * always produce distinct codes. The `QK-` prefix can never collide with a
 * real product barcode (catalog codes are 12/13-digit numeric EAN strings).
 */
function quickItemBarcode(name: string, price: number): string {
  let h = 2166136261;
  const input = `${name}|${price}`;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `QK-${(h >>> 0).toString(36).toUpperCase().padStart(6, "0")}`;
}

/**
 * Identity used to decide that two cart lines are the same sale item.
 * Exact barcode match wins; a barcode-less line (added via a quick key or a
 * search without a code) is the same line as scanning that product's code,
 * so it is only merged when the unit and price also agree — a differently
 * priced variant/multipack must always stay a separate line.
 */
function findMergeIndex(
  items: SaleItem[],
  line: Omit<SaleItem, "lineTotal">,
): number {
  if (line.barcode) {
    const exact = items.findIndex((it) => it.barcode === line.barcode);
    if (exact >= 0) return exact;
    return items.findIndex(
      (it) =>
        it.barcode === "" &&
        it.productId === line.productId &&
        (it.unitName === line.unitName || it.unitName === "" || line.unitName === "") &&
        it.unitPrice === line.unitPrice,
    );
  }
  const barcodeLess = items.findIndex(
    (it) => it.barcode === "" && it.productId === line.productId,
  );
  if (barcodeLess >= 0) return barcodeLess;
  // A tapped/search row without a code is the same sale line as an existing
  // scanned row for that product when the unit and price agree.
  return items.findIndex(
    (it) =>
      it.barcode !== "" &&
      it.productId === line.productId &&
      (it.unitName === line.unitName || it.unitName === "" || line.unitName === "") &&
      it.unitPrice === line.unitPrice,
  );
}

/**
 * Atomic single-line upsert shared by every add-to-cart path (scan, quick
 * key, search). It works on the cart snapshot the caller passes in, merges
 * into an existing line by identity, removes the line at qty 0, and never
 * mutates in place — rapid sequential adds can never interleave into
 * duplicate rows for the same item.
 */
function addLine(
  items: SaleItem[],
  line: Omit<SaleItem, "lineTotal">,
  delta: number,
): SaleItem[] {
  const existing = findMergeIndex(items, line);
  if (existing >= 0) {
    const nextQty = items[existing].qty + delta;
    if (nextQty === 0) return items.filter((_, i) => i !== existing);
    // A scan merging into a barcode-less row adopts the scanned barcode/unit
    // so the line is canonical for later scans and the receipt.
    const merged = {
      ...items[existing],
      barcode: line.barcode || items[existing].barcode,
      unitName: line.unitName || items[existing].unitName,
      unitPrice: line.unitPrice ?? items[existing].unitPrice,
    };
    return items.map((it, i) => (i !== existing ? it : applyQtyToLine(merged, nextQty)));
  }
  return [...items, { ...line, lineTotal: round2(delta * line.unitPrice) }];
}

function computeTotals(
  items: SaleItem[],
  invoiceDiscount: DiscountInput | null = null,
  taxPercent: number = TAX_RATE,
  deliveryFee = 0,
): SaleTotals {
  return computeSaleTotals(items, invoiceDiscount, taxPercent, deliveryFee);
}

function emptyTotals(): SaleTotals {
  return { subtotal: 0, tax: 0, discount: 0, deliveryFee: 0, total: 0, itemCount: 0 };
}

function emptyShiftTotals(startingCash = 0): ShiftTotals {
  return {
    cashSales: 0,
    visaSales: 0,
    cliqSales: 0,
    debtSales: 0,
    debtCollections: 0,
    totalSales: 0,
    discounts: 0,
    returns: 0,
    expenses: 0,
    expectedCashInDrawer: startingCash,
    cashInTotal: 0,
    cashOutTotal: 0,
    expectedCard: 0,
    actualCard: 0,
    cardVariance: 0,
    expectedCliq: 0,
    actualCliq: 0,
    cliqVariance: 0,
    drawerOpenCount: 0,
    hasDiscrepancy: false,
    discrepancyReason: "",
    discrepancyNote: "",
  };
}

function hasTransactionalRuntime(state: PosStoreState): boolean {
  return (
    state.shiftState.status === "OPEN" ||
    state.items.length > 0 ||
    state.heldInvoices.length > 0 ||
    state.shiftTransactions.length > 0 ||
    state.invoiceDiscount !== null ||
    state.deliveryFee !== 0 ||
    state.returnReference !== null
  );
}

function shouldResetRuntimeForTenant(state: PosStoreState, nextStoreId: string): boolean {
  const previousStoreId =
    state.runtimeStoreId ?? state.currentStore?.id ?? state.adminSession?.storeId ?? null;

  if (previousStoreId) return previousStoreId !== nextStoreId;

  // Legacy persisted snapshots did not carry runtimeStoreId. An orphaned
  // cart/shift cannot be attributed safely, so it must never be adopted by
  // whichever tenant logs in next.
  return hasTransactionalRuntime(state);
}

function resetTransactionalRuntime(state: PosStoreState) {
  return {
    activeCategoryId: null,
    cartSlots: [{ id: "1", items: [], invoiceDiscount: null, deliveryFee: 0 }],
    activeCartIndex: 0,
    items: [] as SaleItem[],
    totals: emptyTotals(),
    heldInvoices: [] as HeldInvoice[],
    isCheckoutModalOpen: false,
    isHoldModalOpen: false,
    checkoutSession: state.checkoutSession + 1,
    pendingSyncCount: 0,
    poisonSyncCount: 0,
    istdPendingCount: 0,
    istdFailedCount: 0,
    registerLeaseHeld: false,
    shiftState: {
      status: "CLOSED" as const,
      shiftId: null,
      startTime: null,
      startingCash: 0,
      branchId: null,
      terminalId: null,
    },
    shiftTotals: emptyShiftTotals(),
    shiftTransactions: [] as ShiftTransaction[],
    cashMovements: [] as CashMovement[],
    isCloseShiftModalOpen: false,
    isShiftDetailsModalOpen: false,
    isShiftClosedSuccess: false,
    closedShiftSummary: null,
    isCashMovementModalOpen: false,
    cashMovementModalType: null,
    isDebtSettlementModalOpen: false,
    isExpenseModalOpen: false,
    isSmartSearchOpen: false,
    isAdminHubOpen: false,
    isReturnMode: false,
    invoiceDiscount: null,
    deliveryFee: 0,
    returnReference: null,
    isCompleting: false,
    modalSession: state.modalSession + 1,
    lastCompletedInvoice: null,
    currentCashier: null,
    isSecondaryAuthOpen: false,
    pendingSecondaryAction: null,
    isPreviousInvoicesModalOpen: false,
    lineEditTarget: null,
    isAuditLogOpen: false,
    activeCustomerId: null,
    priceMemory: {},
    shortageFlags: {},
  };
}

type LoginPayloadData = {
  store: Store;
  cashier: NonNullable<PosStoreState["currentCashier"]>;
  branches?: Array<{ id: string; name: string }>;
  terminals?: Array<{ id: string; branchId: string; name: string }>;
  defaultBranchId?: string | null;
  defaultTerminalId?: string | null;
};

/**
 * Shared post-login commit used by /api/login (staff), /api/admin/login
 * (owner) and the unified staffLogin action: binds the tenant id for all
 * network calls, boots catalog/customers caches, resets any cross-tenant
 * transactional runtime and persists the durable state.
 */
function applyLoginPayloadToStore(
  set: (partial: Partial<PosStore>) => void,
  get: () => PosStore,
  data: LoginPayloadData,
  admin?: AdminSession | null,
): void {
  setTenantStoreId(data.store.id);
  const branches: Branch[] = (data.branches ?? []).map((b) => ({
    id: b.id,
    storeId: data.store.id,
    name: b.name,
    createdAt: "",
  }));
  const terminals: Terminal[] = (data.terminals ?? []).map((t) => ({
    id: t.id,
    branchId: t.branchId,
    name: t.name,
    createdAt: "",
  }));
  const catalogBoot = bootCatalogState(loadCatalogBootCacheSync(data.store.id));
  const customerBoot = bootCustomerState(loadCustomersBootCacheSync(data.store.id));
  const stateBeforeLogin = get();
  const runtimeReset = shouldResetRuntimeForTenant(stateBeforeLogin, data.store.id)
    ? resetTransactionalRuntime(stateBeforeLogin)
    : {};
  set({
    ...runtimeReset,
    ...catalogBoot,
    ...customerBoot,
    // Owner login (admin) binds the back-office session but never unlocks the
    // register; staff login sets the register cashier immediately.
    ...(admin ? {} : { currentCashier: { ...data.cashier, sessionReady: true } }),
    currentStore: data.store,
    runtimeStoreId: data.store.id,
    // A staff/cashier login always severs any lingering owner session on the
    // device, exactly like the server revokes the admin cookie. An owner
    // session must never survive a handover to a PIN-only cashier.
    ...(admin ? { adminSession: admin } : { adminSession: null }),
    branches,
    terminals,
    activeBranchId: data.defaultBranchId ?? branches[0]?.id ?? null,
    activeTerminalId: data.defaultTerminalId ?? terminals[0]?.id ?? null,
    pinFailCount: 0,
    pinLockoutLevel: 0,
    pinLockedUntil: 0,
  });
  persistDurablePosState(get());
  void get().hydrateCatalog();
}

type StaffLoginLookup = {
  /** Legacy register flow: store id + PIN. */
  storeId?: string;
  /** Unified staff flow: human-friendly store code + username + PIN. */
  storeCode?: string;
  username?: string;
  pin: string;
};

type StaffLoginResult =
  | { ok: true; payload: LoginPayloadData }
  | { ok: false; error: string; unauthorized?: boolean };

/**
 * Direct-Supabase staff authentication shared by the register flows that used
 * to round-trip through /api/login. Resolves the store (by id or code),
 * verifies the PIN against cashier rows via sha256(pin + salt) and assembles
 * the full login payload (role, branches, terminals) exactly like the legacy
 * route did — minus the signed device cookie, which only server routes set.
 */
async function resolveStaffLoginPayload(
  sb: NonNullable<ReturnType<typeof getSupabaseBrowser>>,
  input: StaffLoginLookup,
): Promise<StaffLoginResult> {
  let storeQuery = sb
    .from("stores")
    .select("id,name,owner_name,email,phone,logo_url,address,receipt_header,receipt_footer,loyalty_enabled,points_per_spend,point_value,tax_percent,tax_number,receipt_show_tax_number,receipt_show_cashier_time,receipt_show_barcode_qr,receipt_compact_spacing,subscription_status,code")
    .limit(1);
  if (input.storeId) {
    storeQuery = storeQuery.eq("id", input.storeId);
  } else if (input.storeCode) {
    storeQuery = storeQuery.eq("code", input.storeCode.trim().toUpperCase());
  } else {
    return { ok: false, error: "بيانات الدخول مطلوبة" };
  }
  const { data: store, error: storeError } = await storeQuery.maybeSingle();
  if (storeError) throw storeError;
  if (!store) {
    return { ok: false, error: input.storeCode ? "كود المتجر غير صحيح" : "المتجر غير موجود" };
  }
  if (store.subscription_status === "suspended") {
    return { ok: false, error: "هذا المتجر موقوف" };
  }

  const { data: cashierRows, error: cashierError } = await sb
    .from("cashiers")
    .select("id,name,role,role_id,pin,pin_salt,pin_hash,username,is_active")
    .eq("store_id", store.id);
  if (cashierError) throw cashierError;

  // Suspended staff can't sign in, but their row stays discoverable so the
  // sign-in page can say "الحساب موقوف" rather than a generic 401.
  const username = input.username?.trim().toLowerCase() ?? "";
  if (username) {
    const suspended = (cashierRows ?? []).find(
      (r) =>
        r.role !== "admin" &&
        r.role !== "مدير" &&
        r.username &&
        r.username.trim().toLowerCase() === username &&
        r.is_active === false,
    );
    if (suspended) {
      return { ok: false, error: "الحساب موقوف — تواصل مع مدير المتجر" };
    }
  }

  // F3: verify against the stored per-cashier hash (sha256(pin + salt)).
  // Legacy rows without a hash fall back to the plaintext pin column. Only
  // cashier rows are eligible — the owner (role 'admin') holds dashboard
  // credentials and never a PIN, so its hash can never unlock a register.
  const cashier = (cashierRows ?? []).find((r) => {
    if (r.role === "admin" || r.role === "مدير") return false;
    if (r.is_active === false) return false;
    if (username && (!r.username || r.username.trim().toLowerCase() !== username)) return false;
    return r.pin_hash
      ? sha256Hex(input.pin + (r.pin_salt ?? sha256Hex(`pos:pin-salt:${store.id}`).slice(0, 16))) === r.pin_hash
      : r.pin != null && r.pin === input.pin;
  });
  if (!cashier) {
    return { ok: false, error: "بيانات الدخول غير صحيحة", unauthorized: true };
  }

  const fallbackRoleCode = normalizeStaffRoleCode(cashier.role);
  let staffRole = {
    id: cashier.role_id as string | null,
    code: fallbackRoleCode,
    name: STAFF_ROLE_PRESETS[fallbackRoleCode].name,
    capabilities: [...STAFF_ROLE_PRESETS[fallbackRoleCode].capabilities],
    limits: { ...STAFF_ROLE_PRESETS[fallbackRoleCode].limits },
  };
  if (cashier.role_id) {
    const { data: roleRow } = await sb
      .from("staff_roles")
      .select("id,code,name,capabilities,limits")
      .eq("id", cashier.role_id)
      .eq("store_id", store.id)
      .maybeSingle();
    if (roleRow) {
      staffRole = {
        id: roleRow.id,
        code: normalizeStaffRoleCode(roleRow.code),
        name: roleRow.name,
        capabilities: Array.isArray(roleRow.capabilities) ? roleRow.capabilities : [],
        limits: roleRow.limits && typeof roleRow.limits === "object"
          ? roleRow.limits as typeof staffRole.limits
          : { ...STAFF_ROLE_PRESETS[fallbackRoleCode].limits },
      };
    }
  }

  const { data: branches } = await sb
    .from("branches")
    .select("id,name")
    .eq("store_id", store.id)
    .order("created_at", { ascending: true });
  const branchRows = (branches ?? []) as Array<{ id: string; name: string }>;
  const branchIds = branchRows.map((b) => b.id);

  const { data: terminals } = await sb
    .from("terminals")
    .select("id,branch_id,name")
    .in("branch_id", branchIds.length > 0 ? branchIds : ["00000000-0000-0000-0000-000000000000"]);
  const terminalRows = (terminals ?? []) as Array<{ id: string; branch_id: string; name: string }>;

  // The auto-seeded "الفرع الرئيسي" / "الكاشير الرئيسي" are the safe defaults;
  // fall back to the first branch/terminal of this store when absent.
  const defaultBranchId =
    branchRows.find((b) => b.name === "الفرع الرئيسي")?.id ?? branchRows[0]?.id ?? null;
  const defaultTerminalId =
    terminalRows.find((t) => t.branch_id === defaultBranchId && t.name === "الكاشير الرئيسي")?.id ??
    terminalRows.find((t) => t.branch_id === defaultBranchId)?.id ??
    terminalRows[0]?.id ??
    null;

  return {
    ok: true,
    payload: {
      store: {
        id: store.id,
        code: store.code,
        name: store.name,
        ownerName: store.owner_name,
        email: store.email,
        phone: store.phone,
        subscriptionStatus: store.subscription_status,
        logoUrl: store.logo_url,
        address: store.address,
        receiptHeader: store.receipt_header,
        receiptFooter: store.receipt_footer,
        loyaltyEnabled: store.loyalty_enabled !== false,
        pointsPerSpend: Number(store.points_per_spend) || 1,
        pointValue: Number(store.point_value) || 0.01,
        taxPercent: store.tax_percent != null ? Number(store.tax_percent) : 16,
        taxNumber: store.tax_number ?? "",
        receiptShowTaxNumber: store.receipt_show_tax_number !== false,
        receiptShowCashierTime: store.receipt_show_cashier_time !== false,
        receiptShowBarcodeQr: store.receipt_show_barcode_qr !== false,
        receiptCompactSpacing: store.receipt_compact_spacing === true,
      },
      cashier: {
        id: cashier.id,
        name: cashier.name,
        role: cashier.role,
        roleId: staffRole.id ?? undefined,
        roleCode: staffRole.code,
        roleName: staffRole.name,
        capabilities: staffRole.capabilities,
        limits: staffRole.limits,
      },
      branches: branchRows,
      terminals: terminalRows.map((t) => ({ id: t.id, branchId: t.branch_id, name: t.name })),
      defaultBranchId,
      defaultTerminalId,
    },
  };
}

export const usePosStore = create<PosStore>()(
  persist(
    (set, get) => ({
      ...bootCatalogState(null),
      ...bootCustomerState(null),
      activeCategoryId: null,
      cartSlots: [{ id: "1", items: [], invoiceDiscount: null, deliveryFee: 0 }],
      activeCartIndex: 0,
      items: [],
      totals: emptyTotals(),
      notice: null,
      heldInvoices: [],
      isCheckoutModalOpen: false,
      isHoldModalOpen: false,
      checkoutSession: 0,
      isOnline: typeof navigator !== "undefined" ? navigator.onLine : true,
      pendingSyncCount: 0,
      poisonSyncCount: 0,
      istdPendingCount: 0,
      istdFailedCount: 0,
      registerLeaseHeld: false,
      shiftState: { status: "CLOSED", shiftId: null, startTime: null, startingCash: 0, branchId: null, terminalId: null },
      shiftTotals: emptyShiftTotals(),
      shiftTransactions: [],
      cashMovements: [],
      isCloseShiftModalOpen: false,
      isShiftDetailsModalOpen: false,
      isShiftClosedSuccess: false,
      closedShiftSummary: null,
      isCashMovementModalOpen: false,
      cashMovementModalType: null,
      isDebtSettlementModalOpen: false,
      isExpenseModalOpen: false,
      isSmartSearchOpen: false,
      isAdminHubOpen: false,
      isReturnMode: false,
      invoiceDiscount: null,
      deliveryFee: 0,
      returnReference: null,
      isCompleting: false,
      modalSession: 0,
      lastCompletedInvoice: null,
      currentCashier: null,
      pinFailCount: 0,
      pinLockedUntil: 0,
      pinLockoutLevel: 0,
      currentStore: null,
      runtimeStoreId: null,
      adminSession: null,
      stores: [],
      branches: [],
      terminals: [],
      activeBranchId: null,
      activeTerminalId: null,
      isSecondaryAuthOpen: false,
      pendingSecondaryAction: null,
      isPreviousInvoicesModalOpen: false,
      lineEditTarget: null,
      isAuditLogOpen: false,
      activeCustomerId: null,
      priceMemory: {},
      shortageFlags: {},

      loadSnapshot: (snapshot) =>
        set((state) => {
          // Skip if the snapshot is stale or identical — prevents redundant
          // identity swaps that cause flickering during mount.
          if (
            snapshot.updatedAt &&
            state.catalogUpdatedAt &&
            snapshot.updatedAt <= state.catalogUpdatedAt
          ) {
            return {};
          }
          return {
            ...applyCatalogState(state, snapshot),
            // The live cart, held invoices and return reference are deliberately
            // preserved here: they are persisted and must survive a reload or a
            // mid-shift catalog refresh. Only catalog data is refreshed.
            invoiceDiscount: state.invoiceDiscount,
            // Only reset modal sessions during explicit login/terminal switches,
            // NOT during background catalog refreshes. Background snapshots must
            // never kill an open checkout or modal mid-flow.
            ...(state._catalogHydrated
              ? {}
              : {
                  isCheckoutModalOpen: false,
                  isHoldModalOpen: false,
                  isCompleting: false,
                  modalSession: 0,
                  checkoutSession: 0,
                }),
          };
        }),

      upsertCustomer: (customer) => {
        const storeId = get().currentStore?.id ?? getTenantStoreId();
        const updatedAt = `local:${Date.now()}`;
        set((state) => {
          const customers = mergeCustomers(state.customers, [customer]);
          void saveCustomersCache({ storeId, customers, updatedAt }, storeId);
          return {
            customers,
            customersUpdatedAt: updatedAt,
          };
        });
      },

      scanBarcode: async (raw) => {
        const barcode = raw.trim();
        if (!barcode) return;

        const lookup = get().barcodeIndex[barcode];
        if (!lookup) {
          // In Return Mode an unknown code is likely the barcode of a
          // printed receipt, i.e. the original invoice's sync id.
          if (get().isReturnMode && (await get().beginReturnByInvoice(barcode))) {
            emitPosSound("SCAN_ACCEPTED");
            return;
          }
          set({ notice: { message: `رمز الباركود غير معروف: ${barcode}`, tone: "error" } });
          return;
        }

        const sign = get().isReturnMode ? -1 : 1;
        const unitName = get().barcodes[barcode]?.unitName ?? "حبة";
        const product = get().products[lookup.product_id];
        const items = addLine(
          get().items,
          {
            productId: lookup.product_id,
            name: lookup.name,
            barcode,
            variantLabel: lookup.variantLabel ?? get().barcodes[barcode]?.variantLabel,
            qty: sign,
            unitName,
            unitPrice: lookup.price,
            taxPercent: product?.taxPercent ?? effectiveTaxPercent(get().currentStore),
            taxIncluded: product?.taxIncluded ?? false,
          },
          sign,
        );

        set({ items, totals: computeTotals(items, get().invoiceDiscount, effectiveTaxPercent(get().currentStore), get().deliveryFee) });
        emitPosSound("SCAN_ACCEPTED");
      },

      addQuickKeyItem: (key) => {
        if (!key.productId) {
          set({ notice: { message: "هذا الزر لا يضيف صنفاً", tone: "error" } });
          return;
        }

        const sign = get().isReturnMode ? -1 : 1;
        const unitPrice = key.price ?? 0;
        const code = key.barcode ?? "";
        const items = addLine(
          get().items,
          {
            productId: key.productId,
            name: key.label,
            barcode: code,
            variantLabel: key.variantLabel,
            qty: sign,
            unitName: key.unitName ?? "",
            unitPrice,
            taxPercent: key.taxPercent ?? get().products[key.productId]?.taxPercent ?? effectiveTaxPercent(get().currentStore),
            taxIncluded: key.taxIncluded ?? get().products[key.productId]?.taxIncluded ?? false,
          },
          sign,
        );

        set({ items, totals: computeTotals(items, get().invoiceDiscount, effectiveTaxPercent(get().currentStore), get().deliveryFee) });
      },

      addSearchItem: (productId, qty = 1, barcode) => {
        const product = get().products[productId];
        if (!product) return;

        const code = (barcode ?? "").trim();
        let unitPrice = product.price ?? 0;
        let unitName = product.baseUnit ?? "";
        let variantLabel = "";
        if (code) {
          const meta = get().barcodes[code];
          if (meta) {
            unitName = meta.unitName || unitName;
            unitPrice = meta.price ?? unitPrice;
            variantLabel = meta.variantLabel ?? "";
          }
        }

        const sign = get().isReturnMode ? -1 : 1;
        const q = Math.max(1, Math.round(qty || 1)) * sign;
        const items = addLine(
          get().items,
          {
            productId,
            name: product.name,
            barcode: code,
            variantLabel,
            qty: q,
            unitName,
            unitPrice,
            taxPercent: product.taxPercent ?? effectiveTaxPercent(get().currentStore),
            taxIncluded: product.taxIncluded ?? false,
          },
          q,
        );

        set({ items, totals: computeTotals(items, get().invoiceDiscount, effectiveTaxPercent(get().currentStore), get().deliveryFee) });
      },

      updateQty: (index, qty) => {
        if (!Number.isFinite(qty)) return;
        // Zero quantity removes the line; negative quantities are only
        // reachable in Return Mode and must stay valid there.
        if (qty === 0) {
          get().removeItem(index);
          return;
        }
        const items = get().items.map((it, i) =>
          i !== index ? it : applyQtyToLine(it, qty),
        );
        set({ items, totals: computeTotals(items, get().invoiceDiscount, effectiveTaxPercent(get().currentStore), get().deliveryFee) });
      },

      removeItem: (index) => {
        const items = get().items.filter((_, i) => i !== index);
        set({ items, totals: computeTotals(items, get().invoiceDiscount, effectiveTaxPercent(get().currentStore), get().deliveryFee) });
      },

      addQuickItem: (name, price, barcode) => {
        const trimmed = (name ?? "").trim();
        const value = round2(Math.max(0, price));
        if (!trimmed || !Number.isFinite(value) || value <= 0) {
          set({ notice: { message: "أدخل اسم وسعر صحيحين للصنف السريع", tone: "error" } });
          return;
        }
        const sign = get().isReturnMode ? -1 : 1;
        const code = (barcode ?? "").trim();
        const items = addLine(
          get().items,
          {
            productId: "",
            name: trimmed,
            barcode: code || quickItemBarcode(trimmed, value),
            qty: sign,
            unitName: "حبة",
            unitPrice: value,
            taxPercent: effectiveTaxPercent(get().currentStore),
            taxIncluded: true,
          },
          sign,
        );
        set({
          items,
          totals: computeTotals(items, get().invoiceDiscount, effectiveTaxPercent(get().currentStore), get().deliveryFee),
          notice: { message: `تمت إضافة صنف سريع: ${trimmed}`, tone: "success" },
        });
      },

      setDeliveryFee: (fee) => {
        const value = Number.isFinite(fee) ? round2(Math.max(0, fee)) : 0;
        set({
          deliveryFee: value,
          totals: computeTotals(get().items, get().invoiceDiscount, effectiveTaxPercent(get().currentStore), value),
        });
      },

      clearInvoice: () => {
        if (get().items.length === 0) {
          set({ notice: { message: "الفاتورة فارغة", tone: "error" } });
          return;
        }
        set({
          items: [],
          totals: emptyTotals(),
          invoiceDiscount: null,
          deliveryFee: 0,
          returnReference: null,
          notice: { message: "تم إلغاء الفاتورة", tone: "success" },
        });
      },

      setNotice: (message, tone = "success") => set({ notice: { message, tone } }),
      dismissNotice: () => set({ notice: null }),

      setOnline: (online) => set({ isOnline: online }),
      setPendingSyncCount: (count) => set({ pendingSyncCount: count }),
      refreshPoisonSyncCount: async () => {
        try {
          const count = await countPoisonSyncRecords();
          set({ poisonSyncCount: count });
        } catch {
          set({ poisonSyncCount: 0 });
        }
      },
      refreshIstdCounts: async () => {
        const storeId = getTenantStoreId();
        if (!storeId) {
          set({ istdPendingCount: 0, istdFailedCount: 0 });
          return;
        }
        try {
          const [istdPendingCount, istdFailedCount] = await Promise.all([
            countIstdPending(storeId),
            countIstdFailed(storeId),
          ]);
          set({ istdPendingCount, istdFailedCount });
        } catch {
          set({ istdPendingCount: 0, istdFailedCount: 0 });
        }
      },
      retryPendingIstd: async () => {
        const storeId = getTenantStoreId();
        if (!storeId) return { retried: 0 };
        const states = await getIstdStates(storeId);
        const failed = states.filter((s) => s.status === "FAILED");
        let retried = 0;
        for (const state of failed) {
          const record = await findInvoiceById(state.sync_id);
          if (!record || record.action_type !== "INVOICE_CREATED") continue;
          const invoice = completedInvoiceFromQueueRecord(record);
          if (!invoice) continue;
          void pushInvoiceToIstd(invoice);
          retried += 1;
        }
        if (retried > 0) await get().refreshIstdCounts();
        return { retried };
      },
      setActiveCategoryId: (categoryId) => set({ activeCategoryId: categoryId }),

      openCheckout: () => {
        if (get().currentCashier && !hasCapability(get().currentCashier, "pos.sell")) {
          set({ notice: { message: "هذا الدور لا يملك صلاحية البيع", tone: "error" } });
          return;
        }
        if (get().items.length === 0) {
          set({ notice: { message: "الفاتورة فارغة، أضف أصنافاً أولاً", tone: "error" } });
          return;
        }
        set((state) => ({
          isCheckoutModalOpen: true,
          checkoutSession: state.checkoutSession + 1,
          modalSession: state.modalSession + 1,
        }));
      },

      closeCheckout: () => set({ isCheckoutModalOpen: false }),

      openHoldModal: () => set((s) => ({ isHoldModalOpen: true, modalSession: s.modalSession + 1 })),
      closeHoldModal: () => set({ isHoldModalOpen: false }),

      holdInvoice: () => {
        if (get().currentCashier && !hasCapability(get().currentCashier, "pos.hold_invoice")) {
          set({ notice: { message: "هذا الدور لا يملك صلاحية تعليق الفواتير", tone: "error" } });
          return;
        }
        const { items, totals } = get();
        if (items.length === 0) {
          set({ notice: { message: "الفاتورة فارغة، لا يمكن تعليقها", tone: "error" } });
          return;
        }
        const held: HeldInvoice = {
          id: newUuid(),
          created_at: new Date().toISOString(),
          items,
          total: totals.total,
          invoiceDiscount: get().invoiceDiscount,
          deliveryFee: get().deliveryFee,
        };
        set({
          heldInvoices: [...get().heldInvoices, held],
          items: [],
          totals: emptyTotals(),
          invoiceDiscount: null,
          deliveryFee: 0,
          notice: { message: "تم تعليق الفاتورة", tone: "success" },
        });
      },

      restoreInvoice: (id) => {
        const held = get().heldInvoices.find((h) => h.id === id);
        if (!held) return;
        set({
          heldInvoices: get().heldInvoices.filter((h) => h.id !== id),
          items: held.items,
          invoiceDiscount: held.invoiceDiscount ?? null,
          deliveryFee: held.deliveryFee ?? 0,
          totals: computeTotals(held.items, held.invoiceDiscount ?? null, effectiveTaxPercent(get().currentStore), held.deliveryFee ?? 0),
          isHoldModalOpen: false,
          notice: { message: "تمت استعادة الفاتورة", tone: "success" },
        });
      },

      completeCheckout: async (paymentMethod, amountPaid, customerName, customerId, customerPhone) => {
        if (get().isCompleting) return;
        const { items, totals } = get();
        if (items.length === 0) {
          set({ notice: { message: "لا توجد أصناف للدفع", tone: "error" } });
          return;
        }
        if (totals.total === 0) {
          set({ notice: { message: "قيمة الفاتورة صفر — تحقق من الكميات", tone: "error" } });
          return;
        }
        if (get().shiftState.status !== "OPEN") {
          set({ notice: { message: "افتح الوردية قبل إتمام الدفع", tone: "error" } });
          return;
        }
        const validMethods = ["CASH", "VISA", "SPLIT", "DEBT", "CLIQ"];
        const negativeInvoice = totals.total < 0;
        if (
          !validMethods.includes(paymentMethod) ||
          !Number.isFinite(amountPaid) ||
          (amountPaid < 0 && !negativeInvoice) ||
          (negativeInvoice && paymentMethod === "DEBT")
        ) {
          set({ notice: { message: "بيانات الدفع غير صالحة", tone: "error" } });
          return;
        }
        if (paymentMethod === "DEBT" && !customerName?.trim() && !get().activeCustomerId) {
          set({ notice: { message: "أدخل اسم الزبون للبيع على الذمم", tone: "error" } });
          return;
        }

        // Customer memory: an explicit checkout selection wins, otherwise the
        // cart-assigned customer (activeCustomerId) is used. Name/phone fall
        // back to the customer directory so DEBT and receipts stay complete.
        const resolvedCustomerId = customerId?.trim() || get().activeCustomerId || undefined;
        let resolvedCustomerName = customerName?.trim() || undefined;
        let resolvedCustomerPhone = customerPhone?.trim() || undefined;
        if (resolvedCustomerId && !resolvedCustomerName) {
          const active = get().customers.find((customer) => customer.id === resolvedCustomerId);
          resolvedCustomerName = active?.name?.trim() || undefined;
          resolvedCustomerPhone = resolvedCustomerPhone ?? (active?.phone?.trim() || undefined);
        }

        const change = round2(Math.max(0, amountPaid - totals.total));
        const cashier = get().currentCashier;
        const cashierName = cashier?.name;
        const originalInvoiceId = get().returnReference?.originalSyncId;
        const activeShift = get().shiftState;
        const branchId = activeShift.branchId ?? get().activeBranchId ?? null;
        const terminalId = activeShift.terminalId ?? get().activeTerminalId ?? null;

        // Authoritative payment buckets, stamped on the payload so the server
        // ledger mirrors the exact drawer movement. SPLIT reversals honor the
        // cash portion handed back (negative sign follows the invoice total)
        // instead of dumping the whole return into cash.
        const buckets = derivePaymentBuckets(paymentMethod, totals.total, amountPaid);
        const netCash = buckets.cash;
        const cardPortion = buckets.visa;
        const cliqPortion = buckets.cliq;
        const debtPortion = buckets.debt;

        const record: SyncQueueRecord = {
          sync_id: newUuid(),
          action_type: "INVOICE_CREATED",
          payload: {
            items,
            subtotal: totals.subtotal,
            tax: totals.tax,
            discount: totals.discount,
            deliveryFee: totals.deliveryFee,
            total: totals.total,
            paymentMethod,
            amountPaid,
            change,
            cashAmount: buckets.cash,
            visaAmount: buckets.visa,
            cliqAmount: buckets.cliq,
            debtAmount: buckets.debt,
            customerName: resolvedCustomerName,
            customerId: resolvedCustomerId,
            customerPhone: resolvedCustomerPhone,
            originalInvoiceId,
            cashierId: cashier?.id,
            cashierName,
            shiftId: activeShift.shiftId ?? undefined,
            branchId: branchId ?? undefined,
            terminalId: terminalId ?? undefined,
            completed_at: new Date().toISOString(),
          },
          status: "PENDING",
          created_at: new Date().toISOString(),
          cashierName,
        };

        setCompletingCrossTab(true);
        set({ isCompleting: true });
        try {
          await enqueueSync(record);
          const pendingSyncCount = (await getSyncsByStatus("PENDING")).length;

          // P4: learn the customer's prices from the settled invoice. Async
          // IDB writes — never on the render/main-thread path. Anonymous
          // sales short-circuit before any I/O.
          const activeStoreId =
            get().currentStore?.id ?? getTenantStoreId() ?? record.storeId ?? null;
          if (activeStoreId) {
            await upsertPriceMemoryFromPayload(record.payload, activeStoreId);
          }

          let shiftTotals = get().shiftTotals;
          let shiftTransactions = get().shiftTransactions;
          const shiftState = get().shiftState;
          if (shiftState.status === "OPEN" && shiftState.shiftId) {
            const isReturnInvoice = totals.total < 0;
            const newVisaSales = round2(shiftTotals.visaSales + cardPortion);
            const newCliqSales = round2((shiftTotals.cliqSales ?? 0) + cliqPortion);
            shiftTotals = {
              cashSales: round2(shiftTotals.cashSales + netCash),
              visaSales: newVisaSales,
              cliqSales: newCliqSales,
              debtSales: round2(shiftTotals.debtSales + debtPortion),
              debtCollections: shiftTotals.debtCollections,
              totalSales: round2(
                shiftTotals.totalSales + totals.total,
              ),
              discounts: round2(shiftTotals.discounts + totals.discount),
              returns: round2(
                shiftTotals.returns + (isReturnInvoice ? Math.abs(totals.total) : 0),
              ),
              expenses: shiftTotals.expenses,
              expectedCashInDrawer: round2(
                shiftTotals.expectedCashInDrawer + netCash,
              ),
              cashInTotal: shiftTotals.cashInTotal,
              cashOutTotal: shiftTotals.cashOutTotal,
              expectedCard: newVisaSales,
              actualCard: shiftTotals.actualCard,
              cardVariance: round2(shiftTotals.actualCard - newVisaSales),
              expectedCliq: newCliqSales,
              actualCliq: shiftTotals.actualCliq,
              cliqVariance: round2(shiftTotals.actualCliq - newCliqSales),
              drawerOpenCount: shiftTotals.drawerOpenCount,
              hasDiscrepancy: shiftTotals.hasDiscrepancy,
              discrepancyReason: shiftTotals.discrepancyReason,
              discrepancyNote: shiftTotals.discrepancyNote,
            };
            const tx: ShiftTransaction = {
              syncId: record.sync_id,
              shiftId: shiftState.shiftId,
              paymentMethod,
              total: totals.total,
              cashPortion: netCash,
              completed_at: record.payload.completed_at,
            };
            shiftTransactions = [...shiftTransactions, tx];
          }

          const completedInvoice: CompletedInvoice = {
            syncId: record.sync_id,
            shiftId: get().shiftState.shiftId ?? "",
            items,
            subtotal: totals.subtotal,
            tax: totals.tax,
            discount: totals.discount,
            deliveryFee: totals.deliveryFee,
            total: totals.total,
            paymentMethod,
            amountPaid,
            change,
            customerName: record.payload.customerName,
            customerId: record.payload.customerId,
            customerPhone: record.payload.customerPhone,
            cashierName,
            originalInvoiceId,
            branchId: branchId ?? undefined,
            terminalId: terminalId ?? undefined,
            completed_at: record.payload.completed_at,
          };

          set({
            items: [],
            totals: emptyTotals(),
            deliveryFee: 0,
            isCheckoutModalOpen: false,
            pendingSyncCount,
            shiftTotals,
            shiftTransactions,
            lastCompletedInvoice: completedInvoice,
            invoiceDiscount: null,
            returnReference: null,
            isReturnMode: false,
            activeCustomerId: null,
            priceMemory: {},
            notice: { message: "تم حفظ الفاتورة محلياً وستتم المزامنة", tone: "success" },
          });
          emitPosSound("SALE_COMPLETED");

          // ISTD/JoFotara e-invoicing fast path. Detached and never awaited:
          // the local TLV QR already guarantees a valid printed receipt, and
          // the official QR replaces it only when clearance returns. While
          // offline, no push happens here — the background sync catch-up
          // (runIstdCatchUp) clears the invoice once connectivity returns.
          if (get().isOnline) {
            void pushInvoiceToIstd(completedInvoice, (cleared) => {
              get().setLastCompletedInvoice(cleared);
            });
          }
        } catch (err) {
          console.error("Failed to persist invoice to IndexedDB:", err);
          set({ notice: { message: "فشل حفظ الفاتورة محلياً", tone: "error" } });
        } finally {
          setCompletingCrossTab(false);
          set({ isCompleting: false });
        }
      },

      openShift: async (startingCash, branchId, terminalId) => {
        const shiftState = get().shiftState;
        if (shiftState.status === "OPEN") {
          set({ notice: { message: "الوردية مفتوحة بالفعل", tone: "error" } });
          return;
        }
        if (get().isCompleting) return;
        if (!Number.isFinite(startingCash)) {
          set({ notice: { message: "قيمة رصيد بداية الوردية غير صحيحة", tone: "error" } });
          return;
        }

        // Phase 26: bind the shift to a branch + terminal. The selected
        // register is persisted on the ShiftState so a mid-shift refresh
        // keeps the drawer attached to the same terminal. Legacy devices
        // without a selection simply omit the ids (null columns server-side).
        const effectiveBranchId =
          branchId ?? get().activeBranchId ?? shiftState.branchId ?? null;
        const effectiveTerminalId =
          terminalId ?? get().activeTerminalId ?? shiftState.terminalId ?? null;

        const cash = round2(Math.max(0, startingCash));
        const shiftId = newUuid();
        const startTime = new Date().toISOString();
        const record: SyncQueueRecord = {
          sync_id: newUuid(),
          action_type: "SHIFT_OPENED",
          payload: {
            shiftId,
            startTime,
            startingCash: cash,
            openedAt: startTime,
            branchId: effectiveBranchId ?? undefined,
            terminalId: effectiveTerminalId ?? undefined,
            cashierId: get().currentCashier?.id,
            cashierName: get().currentCashier?.name,
          },
          status: "PENDING",
          created_at: startTime,
          cashierName: get().currentCashier?.name,
        };

        set({
          shiftState: {
            status: "OPEN",
            shiftId,
            startTime,
            startingCash: cash,
            branchId: effectiveBranchId,
            terminalId: effectiveTerminalId,
          },
          shiftTotals: emptyShiftTotals(cash),
          shiftTransactions: [],
          cashMovements: [],
          activeBranchId: effectiveBranchId,
          activeTerminalId: effectiveTerminalId,
          notice: { message: "تم فتح الوردية", tone: "success" },
        });

        try {
          await enqueueSync(record);
          const pendingSyncCount = (await getSyncsByStatus("PENDING")).length;
          set({ pendingSyncCount });
        } catch (err) {
          console.error("Failed to queue SHIFT_OPENED event:", err);
        }
      },

      closeShift: async (actualCash, actualCard, actualCliq, discrepancyReason, discrepancyNote) => {
        const { shiftState, shiftTotals, items } = get();
        if (shiftState.status !== "OPEN" || !shiftState.shiftId) {
          set({ notice: { message: "لا توجد وردية مفتوحة", tone: "error" } });
          return;
        }
        if (get().isCompleting) return;
        if (!Number.isFinite(actualCash)) {
          set({ notice: { message: "قيمة الرصيد الفعلي غير صحيحة", tone: "error" } });
          return;
        }
        if (!Number.isFinite(actualCard)) {
          set({ notice: { message: "قيمة رصيد البطاقة غير صحيحة", tone: "error" } });
          return;
        }
        if (!Number.isFinite(actualCliq)) {
          set({ notice: { message: "قيمة رصيد كليك غير صحيحة", tone: "error" } });
          return;
        }
        if (items.length > 0) {
          set({
            notice: {
              message: "أكمل أو ألغِ الفاتورة الحالية قبل إغلاق الوردية",
              tone: "error",
            },
          });
          return;
        }

        const cash = round2(Math.max(0, actualCash));
        const card = round2(Math.max(0, actualCard));
        const cliq = round2(Math.max(0, actualCliq));
        const variance = round2(cash - shiftTotals.expectedCashInDrawer);
        const cardVariance = round2(card - shiftTotals.expectedCard);
        const cliqVariance = round2(cliq - (shiftTotals.cliqSales ?? 0));
        const hasDiscrepancy = variance !== 0 || cardVariance !== 0 || cliqVariance !== 0;

        if (hasDiscrepancy && (!discrepancyReason || !discrepancyNote.trim())) {
          set({ notice: { message: "يجب ذكر سبب الفرق في التسوية", tone: "error" } });
          return;
        }

        const closeTime = new Date().toISOString();
        const closingCashier = get().currentCashier;
        const record: SyncQueueRecord = {
          sync_id: newUuid(),
          action_type: "SHIFT_CLOSED",
          payload: {
            shiftId: shiftState.shiftId,
            startTime: shiftState.startTime as string,
            closeTime,
            startingCash: shiftState.startingCash,
            cashSales: shiftTotals.cashSales,
            visaSales: shiftTotals.visaSales,
            cliqSales: shiftTotals.cliqSales ?? 0,
            debtSales: shiftTotals.debtSales,
            debtCollections: shiftTotals.debtCollections,
            totalSales: shiftTotals.totalSales,
            discounts: shiftTotals.discounts,
            returns: shiftTotals.returns,
            expenses: shiftTotals.expenses,
            expectedCashInDrawer: shiftTotals.expectedCashInDrawer,
            actualCash: cash,
            variance,
            cashInTotal: shiftTotals.cashInTotal,
            cashOutTotal: shiftTotals.cashOutTotal,
            expectedCard: shiftTotals.expectedCard,
            actualCard: card,
            cardVariance,
            expectedCliq: shiftTotals.cliqSales ?? 0,
            actualCliq: cliq,
            cliqVariance,
            drawerOpenCount: shiftTotals.drawerOpenCount,
            discrepancyReason: hasDiscrepancy ? discrepancyReason : "",
            discrepancyNote: hasDiscrepancy ? discrepancyNote.trim() : "",
            branchId: shiftState.branchId ?? undefined,
            terminalId: shiftState.terminalId ?? undefined,
            cashierId: closingCashier?.id,
            cashierName: closingCashier?.name,
          },
          status: "PENDING",
          created_at: closeTime,
          cashierName: get().currentCashier?.name,
        };

        setCompletingCrossTab(true);
        set({ isCompleting: true });
        try {
          // The close event is the durable Z document. Never clear the live
          // shift until IndexedDB confirms that the event was written.
          await enqueueSync(record);
          const pendingSyncCount = (await getSyncsByStatus("PENDING")).length;

          const summarySnapshot = {
            shiftId: shiftState.shiftId,
            startTime: shiftState.startTime,
            closeTime,
            startingCash: shiftState.startingCash,
            cashSales: shiftTotals.cashSales,
            visaSales: shiftTotals.visaSales,
            cliqSales: shiftTotals.cliqSales ?? 0,
            debtSales: shiftTotals.debtSales,
            debtCollections: shiftTotals.debtCollections,
            totalSales: shiftTotals.totalSales,
            discounts: shiftTotals.discounts,
            returns: shiftTotals.returns,
            expenses: shiftTotals.expenses,
            expectedCashInDrawer: shiftTotals.expectedCashInDrawer,
            actualCash: cash,
            variance,
            expectedCard: shiftTotals.expectedCard,
            actualCard: card,
            cardVariance,
            expectedCliq: shiftTotals.cliqSales ?? 0,
            actualCliq: cliq,
            cliqVariance,
            cashInTotal: shiftTotals.cashInTotal,
            cashOutTotal: shiftTotals.cashOutTotal,
            discrepancyReason: hasDiscrepancy ? discrepancyReason : "",
            discrepancyNote: hasDiscrepancy ? discrepancyNote.trim() : "",
          };

          set({
            shiftState: {
              status: "CLOSED",
              shiftId: null,
              startTime: null,
              startingCash: 0,
              branchId: null,
              terminalId: null,
            },
            shiftTotals: emptyShiftTotals(),
            shiftTransactions: [],
            cashMovements: [],
            isCloseShiftModalOpen: false,
            isShiftClosedSuccess: true,
            closedShiftSummary: summarySnapshot,
            pendingSyncCount,
            notice: { message: "تم إغلاق الوردية وحفظ تقرير Z محلياً", tone: "success" },
          });
        } catch (err) {
          console.error("Failed to queue SHIFT_CLOSED event:", err);
          set({
            notice: {
              message: "تعذر حفظ تقرير Z محلياً — بقيت الوردية مفتوحة، أعد المحاولة",
              tone: "error",
            },
          });
        } finally {
          setCompletingCrossTab(false);
          set({ isCompleting: false });
        }
      },

      openCloseShiftModal: () => set((s) => ({ isCloseShiftModalOpen: true, modalSession: s.modalSession + 1 })),
      closeCloseShiftModal: () => set({ isCloseShiftModalOpen: false }),
      openShiftDetailsModal: () => set((s) => ({ isShiftDetailsModalOpen: true, modalSession: s.modalSession + 1 })),
      closeShiftDetailsModal: () => set({ isShiftDetailsModalOpen: false }),
      setShiftClosedSuccess: (v) => set({ isShiftClosedSuccess: v }),
      incrementDrawerOpenCount: () => set((s) => ({
        shiftTotals: { ...s.shiftTotals, drawerOpenCount: s.shiftTotals.drawerOpenCount + 1 },
      })),

      recordCashMovement: async (type, amount, reason, notes) => {
        const shiftState = get().shiftState;
        if (shiftState.status !== "OPEN" || !shiftState.shiftId) {
          set({ notice: { message: "افتح الوردية قبل تسجيل حركة نقدية", tone: "error" } });
          return;
        }
        if (get().isCompleting) return;
        if (!Number.isFinite(amount) || amount <= 0) {
          set({ notice: { message: "المبلغ غير صالح", tone: "error" } });
          return;
        }

        const value = round2(Math.max(0, amount));
        const cashierName = get().currentCashier?.name ?? "";
        const cashierId = get().currentCashier?.id ?? null;
        const movementId = newUuid();

        const record: SyncQueueRecord = {
          sync_id: newUuid(),
          action_type: "CASH_MOVEMENT",
          payload: {
            movementId,
            shiftId: shiftState.shiftId,
            type,
            amount: value,
            reason,
            notes: notes.trim(),
            cashierId,
            cashierName,
            created_at: new Date().toISOString(),
            branchId: shiftState.branchId ?? undefined,
            terminalId: shiftState.terminalId ?? undefined,
          },
          status: "PENDING",
          created_at: new Date().toISOString(),
          cashierName,
        };

        try {
          await enqueueSync(record);
          const pendingSyncCount = (await getSyncsByStatus("PENDING")).length;

          const movement: CashMovement = {
            id: movementId,
            shiftId: shiftState.shiftId,
            type,
            amount: value,
            reason,
            notes: notes.trim(),
            cashierId,
            cashierName,
            branchId: shiftState.branchId,
            terminalId: shiftState.terminalId,
            createdAt: new Date().toISOString(),
          };

          const prev = get().shiftTotals;
          const cashDelta = type === "CASH_IN" ? value : -value;
          const shiftTotals = {
            ...prev,
            cashInTotal: type === "CASH_IN" ? round2(prev.cashInTotal + value) : prev.cashInTotal,
            cashOutTotal: type === "CASH_OUT" ? round2(prev.cashOutTotal + value) : prev.cashOutTotal,
            expectedCashInDrawer: round2(prev.expectedCashInDrawer + cashDelta),
          };

          set({
            cashMovements: [...get().cashMovements, movement],
            shiftTotals,
            pendingSyncCount,
            isCashMovementModalOpen: false,
            cashMovementModalType: null,
            notice: { message: type === "CASH_IN" ? "تم تسجيل الإيداع" : "تم تسجيل السحب", tone: "success" },
          });
        } catch (err) {
          console.error("Failed to queue CASH_MOVEMENT:", err);
          set({
            notice: { message: "تعذر حفظ الحركة النقدية", tone: "error" },
          });
        }
      },

      openCashMovementModal: (type) => set((s) => ({
        isCashMovementModalOpen: true,
        cashMovementModalType: type,
        modalSession: s.modalSession + 1,
      })),
      closeCashMovementModal: () => set({ isCashMovementModalOpen: false, cashMovementModalType: null }),

      openDebtSettlementModal: () => {
        if (get().currentCashier && !hasCapability(get().currentCashier, "pos.collect_debt")) return;
        set((s) => ({ isDebtSettlementModalOpen: true, modalSession: s.modalSession + 1 }));
      },
      closeDebtSettlementModal: () => set({ isDebtSettlementModalOpen: false }),

      openExpenseModal: () => {
        if (get().currentCashier && !hasCapability(get().currentCashier, "pos.record_expense")) return;
        set((s) => ({ isExpenseModalOpen: true, modalSession: s.modalSession + 1 }));
      },
      closeExpenseModal: () => set({ isExpenseModalOpen: false }),

      openSmartSearch: () => set((s) => ({ isSmartSearchOpen: true, modalSession: s.modalSession + 1 })),
      closeSmartSearch: () => set({ isSmartSearchOpen: false }),
      openAdminHub: () => set((s) => ({ isAdminHubOpen: true, modalSession: s.modalSession + 1 })),
      closeAdminHub: () => set({ isAdminHubOpen: false }),
      toggleSmartSearch: () => {
        if (get().isSmartSearchOpen) {
          set({ isSmartSearchOpen: false });
        } else {
          get().openSmartSearch();
        }
      },

      processDebtSettlement: async (customerName, amount, customerId) => {
        if (get().currentCashier && !hasCapability(get().currentCashier, "pos.collect_debt")) {
          set({ notice: { message: "هذا الدور لا يملك صلاحية تسوية الذمم", tone: "error" } });
          return;
        }
        const name = customerName.trim();
        if (!name) {
          set({ notice: { message: "أدخل اسم الزبون لتسجيل السداد", tone: "error" } });
          return;
        }
        if (get().isCompleting) return;
        if (!Number.isFinite(amount)) {
          set({ notice: { message: "قيمة السداد غير صحيحة", tone: "error" } });
          return;
        }
        const value = round2(Math.max(0, amount));
        if (value <= 0) {
          set({ notice: { message: "المبلغ المدفوع غير صالح", tone: "error" } });
          return;
        }
        const shiftState = get().shiftState;
        if (shiftState.status !== "OPEN" || !shiftState.shiftId) {
          set({ notice: { message: "افتح الوردية قبل تسجيل السداد", tone: "error" } });
          return;
        }

        const cashierName = get().currentCashier?.name;
        const record: SyncQueueRecord = {
          sync_id: newUuid(),
          action_type: "DEBT_SETTLEMENT",
          payload: {
            shiftId: shiftState.shiftId,
            customerId: customerId?.startsWith("local-") ? undefined : customerId,
            customerName: name,
            amount: value,
            branchId: shiftState.branchId ?? undefined,
            terminalId: shiftState.terminalId ?? undefined,
            completed_at: new Date().toISOString(),
          },
          status: "PENDING",
          created_at: new Date().toISOString(),
          cashierName,
        };

        try {
          await enqueueSync(record);
          const pendingSyncCount = (await getSyncsByStatus("PENDING")).length;

          const prev = get().shiftTotals;
          const shiftTotals = {
            ...prev,
            debtCollections: round2(prev.debtCollections + value),
            expectedCashInDrawer: round2(prev.expectedCashInDrawer + value),
          };

          const completedInvoice: CompletedInvoice = {
            syncId: record.sync_id,
            shiftId: shiftState.shiftId,
            items: [],
            subtotal: 0,
            tax: 0,
            discount: 0,
            total: value,
            paymentMethod: "CASH",
            amountPaid: value,
            change: 0,
            customerName: name,
            customerId,
            cashierName,
            isSettlement: true,
            completed_at: record.payload.completed_at,
          };

          set({
            shiftTotals,
            isDebtSettlementModalOpen: false,
            pendingSyncCount,
            lastCompletedInvoice: completedInvoice,
            notice: { message: "تم تسجيل سداد الذمة وطباعة السند", tone: "success" },
          });
        } catch (err) {
          console.error("Failed to persist debt settlement to IndexedDB:", err);
          set({ notice: { message: "فشل حفظ سند القبض محلياً", tone: "error" } });
        }
      },

      recordExpense: async (category, amount, notes) => {
        if (get().currentCashier && !hasCapability(get().currentCashier, "pos.record_expense")) {
          set({ notice: { message: "هذا الدور لا يملك صلاحية تسجيل المصروفات", tone: "error" } });
          return;
        }
        if (get().isCompleting) return;
        if (!Number.isFinite(amount)) {
          set({ notice: { message: "قيمة المصروف غير صحيحة", tone: "error" } });
          return;
        }
        const value = round2(Math.max(0, amount));
        if (value <= 0) {
          set({ notice: { message: "المبلغ غير صالح", tone: "error" } });
          return;
        }
        const shiftState = get().shiftState;
        if (shiftState.status !== "OPEN" || !shiftState.shiftId) {
          set({ notice: { message: "افتح الوردية قبل تسجيل المصروف", tone: "error" } });
          return;
        }

        const cashierName = get().currentCashier?.name;
        const cashierId = get().currentCashier?.id ?? null;
        const expenseId = newUuid();
        const record: SyncQueueRecord = {
          sync_id: newUuid(),
          action_type: "EXPENSE_RECORDED",
          payload: {
            expenseId,
            cashierId,
            category,
            amount: value,
            notes: notes?.trim() || undefined,
            shiftId: shiftState.shiftId,
            branchId: shiftState.branchId ?? undefined,
            terminalId: shiftState.terminalId ?? undefined,
            created_at: new Date().toISOString(),
          },
          status: "PENDING",
          created_at: new Date().toISOString(),
          cashierName,
        };

        try {
          await enqueueSync(record);
          const pendingSyncCount = (await getSyncsByStatus("PENDING")).length;

          const prev = get().shiftTotals;
          const shiftTotals = {
            ...prev,
            expenses: round2(prev.expenses + value),
            expectedCashInDrawer: round2(prev.expectedCashInDrawer - value),
          };

          set({
            shiftTotals,
            pendingSyncCount,
            isExpenseModalOpen: false,
            notice: { message: "تم تسجيل المصروف", tone: "success" },
          });
        } catch (err) {
          console.error("Failed to persist expense to IndexedDB:", err);
          set({ notice: { message: "فشل حفظ المصروف محلياً", tone: "error" } });
        }
      },

      toggleReturnMode: () =>
        set((state) => ({
          isReturnMode: !state.isReturnMode,
          returnReference: !state.isReturnMode ? null : state.returnReference,
          notice: state.isReturnMode
            ? { message: "تم الخروج من وضع المرتجع", tone: "success" }
            : { message: "وضع المرتجع مفعّل — الأصناف تضاف سالبة", tone: "success" },
        })),

      requestReturnModeToggle: () => {
        const state = get();
        if (state.isReturnMode) {
          get().toggleReturnMode();
          return;
        }

        if (state.currentCashier && !hasCapability(state.currentCashier, "pos.request_return")) {
          set({ notice: { message: "هذا الدور لا يملك صلاحية طلب مرتجع", tone: "error" } });
          return;
        }

        const ownerMode =
          Boolean(state.adminSession) ||
          state.currentCashier?.role === "admin" ||
          state.currentCashier?.role === "مدير";
        if (ownerMode) {
          get().toggleReturnMode();
          void pushAudit(state.adminSession?.email ?? state.currentStore?.email, "ENTER_RETURN_MODE", null, {
            cashierId: state.currentCashier?.id,
            cashierName: state.currentCashier?.name,
            branchId: state.activeBranchId ?? undefined,
            terminalId: state.activeTerminalId ?? undefined,
          });
          return;
        }

        get().requestSecondaryAuth({ type: "toggle_return_mode" });
      },

      applyDiscount: (input) => {
        const { items, currentCashier } = get();
        if (currentCashier && !hasCapability(currentCashier, "pos.request_discount")) {
          set({ notice: { message: "هذا الدور لا يملك صلاحية طلب خصم", tone: "error" } });
          return;
        }
        if (items.length === 0) {
          set({ notice: { message: "لا توجد أصناف للخصم", tone: "error" } });
          return;
        }
        if (!Number.isFinite(input.value) || input.value <= 0) {
          set({ notice: { message: "قيمة الخصم غير صالحة", tone: "error" } });
          return;
        }

        let gross = 0;
        if (input.scope === "ITEM") {
          const idx = input.index ?? -1;
          const item = items[idx];
          if (!item) {
            set({ notice: { message: "الصنف غير موجود", tone: "error" } });
            return;
          }
          if (item.qty <= 0) {
            set({ notice: { message: "لا يمكن خصم سطر سالب (مرتجع)", tone: "error" } });
            return;
          }
          gross = item.qty * item.unitPrice;
        } else {
          gross = items.reduce((s, it) => s + it.qty * it.unitPrice, 0);
          if (gross <= 0) {
            set({ notice: { message: "لا يمكن خصم فاتورة مرتجع", tone: "error" } });
            return;
          }
        }

        const moneyImpact = discountMoney(input, gross);
        if (moneyImpact <= 0) {
          set({ notice: { message: "قيمة الخصم صفر", tone: "error" } });
          return;
        }

        const pct = input.type === "PERCENT" ? input.value : 0;
        // An active owner session (Admin Mode) overrides everything inline —
        // no approval gate, no self-service caps.
        const needsAdmin =
          !get().adminSession &&
          currentCashier?.role !== "admin" &&
          ((pct > 0 && pct > DISCOUNT_PERCENT_APPROVAL) ||
            moneyImpact > DISCOUNT_AMOUNT_APPROVAL);

        if (needsAdmin) {
          // Owner/cashier separation: approval no longer takes a supervisor
          // PIN (the owner never holds one) — the cashier must enter the
          // owner's dashboard password in the secondary-auth modal instead.
          get().requestSecondaryAuth({
            type: "approve_discount",
            discount: { ...input },
          });
          return;
        }
        get().commitDiscount(input);
      },

      commitDiscount: (input) => {
        if (input.scope === "ITEM") {
          const idx = input.index ?? -1;
          const item = get().items[idx];
          if (!item) return;
          const gross = item.qty * item.unitPrice;
          const discount = discountMoney(input, gross);
          const items = get().items.map((it, i) =>
            i !== idx
              ? it
              : {
                  ...it,
                  discount,
                  discountPct: input.type === "PERCENT" ? Math.min(100, Math.max(0, input.value)) : undefined,
                  lineTotal: round2(gross - discount),
                },
          );
          set({ items, totals: computeTotals(items, get().invoiceDiscount, effectiveTaxPercent(get().currentStore), get().deliveryFee) });
        } else {
          set({
            invoiceDiscount: { ...input },
            totals: computeTotals(get().items, { ...input }, effectiveTaxPercent(get().currentStore), get().deliveryFee),
          });
        }
        set({ notice: { message: "تم تطبيق الخصم", tone: "success" } });
      },

      clearDiscount: () => {
        const items = get().items.map((it) =>
          it.discount || it.discountPct
            ? { ...it, discount: 0, discountPct: undefined, lineTotal: round2(it.qty * it.unitPrice) }
            : it,
        );
        set({
          items,
          invoiceDiscount: null,
          totals: computeTotals(items, null, effectiveTaxPercent(get().currentStore), get().deliveryFee),
          notice: { message: "تم إلغاء الخصم", tone: "success" },
        });
      },

      beginReturnByInvoice: async (syncId) => {
        const id = (syncId ?? "").trim();
        if (!id) return false;
        const existing = get().returnReference;
        if (existing && existing.originalSyncId === id) {
          set({ notice: { message: "هذه الفاتورة قيد المرتجع بالفعل", tone: "error" } });
          return false;
        }
        // Prevent voiding the SAME invoice more than once (double return).
        const duplicate = await isInvoiceReturned(id).catch(() => false);
        if (duplicate) {
          set({ notice: { message: "تمت معالجة هذه الفاتورة كمرتجع مسبقاً", tone: "error" } });
          return false;
        }
        let record: SyncQueueRecord | null = null;
        try {
          record = await findInvoiceById(id);
        } catch (err) {
          console.error("Failed to look up original invoice:", err);
        }
        if (!record || record.action_type !== "INVOICE_CREATED") return false;
        const payload = record.payload;
        const originalItems = payload.items ?? [];
        if (originalItems.length === 0) return false;

        // A return must refund the DISCOUNTED net, not the pre-discount
        // gross. Invoice-level discounts live on the invoice, not on its
        // items, so re-run the fiscal split against the original payload:
        // each negated line then carries its already-allocated share of the
        // original discount baked into its (negative) lineTotal. Refunding
        // the gross instead silently over-refunds every discounted invoice
        // by exactly the discount amount.
        const itemDiscountSum = round2(
          originalItems.reduce((sum, it) => sum + Math.max(0, it.discount ?? 0), 0),
        );
        const invoiceDiscountMoney = round2(
          Math.max(0, (payload.discount ?? 0) - itemDiscountSum),
        );
        const fiscal = computeFiscalBreakdown(
          originalItems,
          invoiceDiscountMoney,
          effectiveTaxPercent(get().currentStore),
        );

        const items: SaleItem[] = originalItems.map((it, index) => ({
          ...it,
          qty: -Math.abs(it.qty),
          lineTotal: -Math.abs(fiscal.lines[index]?.adjustedBasis ?? it.lineTotal),
          discount: 0,
          discountPct: undefined,
        }));

        // Keep the per-line prorated discounted net so `setReturnLineQty` can
        // rebuild a partial document: refunding only the selected lines at
        // their discounted share (never the gross) preserves the fiscal split
        // of the original invoice.
        const lines = originalItems.map((it, index) => {
          const qty = Math.abs(it.qty);
          const net = Math.abs(fiscal.lines[index]?.adjustedBasis ?? it.lineTotal);
          return { qty, unitNet: qty > 0 ? round2(net / qty) : 0, item: items[index] };
        });

        set({
          items,
          invoiceDiscount: null,
          deliveryFee: 0,
          totals: computeTotals(items, null, effectiveTaxPercent(get().currentStore), 0),
          isReturnMode: true,
          returnReference: {
            originalSyncId: id,
            originalCompletedAt: payload.completed_at ?? new Date().toISOString(),
            lines,
          },
          notice: { message: `تم تحميل فاتورة المرتجع • ${id.slice(0, 8)}`, tone: "success" },
        });
        return true;
      },

      setReturnLineQty: (index, qty) => {
        const ref = get().returnReference;
        if (!ref || !Array.isArray(ref.lines)) return;
        const target = ref.lines[index];
        if (!target) return;
        const clamped = Math.min(Math.max(0, Math.round(qty)), target.qty);
        // Rebuild from the reference snapshot (original line order), so the
        // operation is idempotent and never drifts after a line is dropped.
        const items: SaleItem[] = [];
        ref.lines.forEach((line, i) => {
          const q = i === index ? clamped : line.qty;
          if (q <= 0) return;
          items.push({
            ...line.item,
            qty: -q,
            lineTotal: -round2(line.unitNet * q),
            discount: 0,
            discountPct: undefined,
          });
        });
        set({
          items,
          invoiceDiscount: null,
          totals: computeTotals(items, null, effectiveTaxPercent(get().currentStore), 0),
          notice: { message: "تم تحديث كميات المرتجع", tone: "success" },
        });
      },

      clearLastInvoice: () => set({ lastCompletedInvoice: null }),

      setLastCompletedInvoice: (invoice) => set({ lastCompletedInvoice: invoice }),

      loginCashier: (pin) => {
        const code = pin.trim();
        const state = get();
        if (state.pinLockedUntil > Date.now()) {
          set({ notice: { message: pinLockedNotice(state.pinLockedUntil), tone: "error" } });
          return false;
        }
        // Owner/cashier separation: only cashier rows can unlock a register.
        // The owner (role 'admin') logs in with email + password on the
        // dashboard and never holds a PIN, so its empty hash must never match.
        const cashier = state.cashiers.find(
          (c) =>
            c.role !== "admin" &&
            c.role !== "مدير" &&
            c.pinHash === sha256Hex(code + (c.pinSalt ?? state.pinSalt)),
        );
        if (!cashier) {
          const next = state.pinFailCount + 1;
          if (next >= PIN_MAX_ATTEMPTS) {
            const level = state.pinLockoutLevel;
            set({
              pinFailCount: 0,
              pinLockoutLevel: level + 1,
              pinLockedUntil: Date.now() + pinCooldownMs(level),
              notice: {
                message: `تم تعطيل رمز PIN مؤقتاً — حاول مجدداً بعد ${Math.max(1, Math.ceil(pinCooldownMs(level) / 1000))} ثانية`,
                tone: "error",
              },
            });
          } else {
            set({ pinFailCount: next });
          }
          return false;
        }
        set({ pinFailCount: 0, pinLockoutLevel: 0, pinLockedUntil: 0 });
        set({
          currentCashier: {
            id: cashier.id,
            name: cashier.name,
            role: cashier.role,
            roleId: cashier.roleId,
            roleCode: cashier.roleCode,
            roleName: cashier.roleName,
            capabilities: cashier.capabilities,
            limits: cashier.limits,
            sessionReady: false,
          },
        });
        persistDurablePosState(get());

        // Offline unlock remains immediate. When online, verify against live
        // cashier rows and refresh the signed role snapshot straight from
        // Supabase — the legacy /api/login round-trip is gone.
        const storeId = state.currentStore?.id;
        if (storeId) {
          void (async () => {
            const sb = getSupabaseBrowser();
            if (!sb || !isSupabaseBrowserConfigured()) return;
            const result = await resolveStaffLoginPayload(sb, { storeId, pin: code });
            if (!result.ok || get().currentCashier?.id !== cashier.id) return;
            set({ currentCashier: { ...result.payload.cashier, sessionReady: true } });
            persistDurablePosState(get());
          })().catch(() => undefined);
        }
        return true;
      },

      logoutCashier: () => {
        set({ currentCashier: null, adminSession: null });
        persistDurablePosState(get());
      },

      loginAsOwner: () => {
        const state = get();
        if (!state.adminSession) return false;
        const ownerRow = state.cashiers.find(
          (c) => c.role === "admin" || c.role === "مدير",
        );
        set({
          currentCashier: ownerRow
            ? { id: ownerRow.id, name: ownerRow.name, role: "admin" }
            : { id: "owner", name: state.adminSession.name, role: "admin" },
          pinFailCount: 0,
          pinLockoutLevel: 0,
          pinLockedUntil: 0,
        });
        persistDurablePosState(get());
        return true;
      },

      loginStore: async (pin, storeId) => {
        const code = pin.trim();
        if (!storeId) {
          set({ notice: { message: "اختر المتجر أولاً", tone: "error" } });
          return false;
        }
        if (get().pinLockedUntil > Date.now()) {
          set({ notice: { message: pinLockedNotice(get().pinLockedUntil), tone: "error" } });
          return false;
        }
        try {
          const sb = getSupabaseBrowser();
          if (!sb || !isSupabaseBrowserConfigured()) {
            set({ notice: { message: "Supabase غير مُعد — تحقق من ملف .env.local", tone: "error" } });
            return false;
          }
          const result = await resolveStaffLoginPayload(sb, { storeId, pin: code });
          if (!result.ok) {
            if (result.unauthorized) {
              const s = get();
              const next = s.pinFailCount + 1;
              if (next >= PIN_MAX_ATTEMPTS) {
                const level = s.pinLockoutLevel;
                set({
                  pinFailCount: 0,
                  pinLockoutLevel: level + 1,
                  pinLockedUntil: Date.now() + pinCooldownMs(level),
                  notice: {
                    message: `تم تعطيل رمز PIN مؤقتاً — حاول مجدداً بعد ${Math.max(1, Math.ceil(pinCooldownMs(level) / 1000))} ثانية`,
                    tone: "error",
                  },
                });
              } else {
                set({ pinFailCount: next });
              }
            } else {
              set({
                notice: {
                  message: result.error,
                  tone: "error",
                },
              });
            }
            return false;
          }
          applyLoginPayloadToStore(set, get, result.payload);
          return true;
        } catch (err) {
          console.error("🔥 RAW LOGIN STORE ERROR:", err);
          set({ notice: { message: "تعذر الاتصال — تحقق من الشبكة", tone: "error" } });
          return false;
        }
      },

      staffLogin: async ({ storeCode, username, pin }) => {
        const code = pin.trim();
        if (!storeCode.trim() || !username.trim() || !code) {
          set({
            notice: { message: "أدخل كود المتجر واسم المستخدم ورمز PIN", tone: "error" },
          });
          return false;
        }
        try {
          const sb = getSupabaseBrowser();
          if (!sb || !isSupabaseBrowserConfigured()) {
            set({ notice: { message: "Supabase غير مُعد — تحقق من ملف .env.local", tone: "error" } });
            return false;
          }

          // 1. Resolve store by code.
          const storeCodeNorm = storeCode.trim().toUpperCase();
          const { data: store, error: storeError } = await sb
            .from("stores")
            .select("id,code,name,owner_name,email,phone,logo_url,address,receipt_header,receipt_footer,loyalty_enabled,points_per_spend,point_value,tax_percent,tax_number,receipt_show_tax_number,receipt_show_cashier_time,receipt_show_barcode_qr,receipt_compact_spacing,subscription_status")
            .eq("code", storeCodeNorm)
            .maybeSingle();
          if (storeError) throw storeError;
          if (!store) {
            set({ notice: { message: "كود المتجر غير صحيح", tone: "error" } });
            return false;
          }
          if (store.subscription_status === "suspended") {
            set({ notice: { message: "هذا المتجر موقوف", tone: "error" } });
            return false;
          }

          // 2. Fetch all non-admin cashiers for this store.
          const { data: cashierRows, error: cashierError } = await sb
            .from("cashiers")
            .select("id,name,role,role_id,pin,pin_salt,pin_hash,username,is_active")
            .eq("store_id", store.id);
          if (cashierError) throw cashierError;

          // Check for suspended staff.
          const uname = username.trim().toLowerCase();
          const suspended = (cashierRows ?? []).find(
            (r) =>
              r.role !== "admin" &&
              r.role !== "مدير" &&
              r.username &&
              r.username.trim().toLowerCase() === uname &&
              r.is_active === false,
          );
          if (suspended) {
            set({ notice: { message: "الحساب موقوف — تواصل مع مدير المتجر", tone: "error" } });
            return false;
          }

          // 3. Match PIN against cashier rows (sha256(pin + salt)).
          const cashier = (cashierRows ?? []).find((r) => {
            if (r.role === "admin" || r.role === "مدير") return false;
            if (r.is_active === false) return false;
            if (uname) {
              if (!r.username || r.username.trim().toLowerCase() !== uname) return false;
            }
            return r.pin_hash
              ? sha256Hex(code + (r.pin_salt ?? sha256Hex(`pos:pin-salt:${store.id}`).slice(0, 16))) === r.pin_hash
              : r.pin != null && r.pin === code;
          });
          if (!cashier) {
            set({ notice: { message: "بيانات الدخول غير صحيحة", tone: "error" } });
            return false;
          }

          // 4. Resolve staff role (custom or preset).
          const fallbackRoleCode = normalizeStaffRoleCode(cashier.role);
          let staffRole = {
            id: cashier.role_id as string | null,
            code: fallbackRoleCode,
            name: STAFF_ROLE_PRESETS[fallbackRoleCode].name,
            capabilities: [...STAFF_ROLE_PRESETS[fallbackRoleCode].capabilities],
            limits: { ...STAFF_ROLE_PRESETS[fallbackRoleCode].limits },
          };
          if (cashier.role_id) {
            const { data: roleRow } = await sb
              .from("staff_roles")
              .select("id,code,name,capabilities,limits")
              .eq("id", cashier.role_id)
              .eq("store_id", store.id)
              .maybeSingle();
            if (roleRow) {
              staffRole = {
                id: roleRow.id,
                code: normalizeStaffRoleCode(roleRow.code),
                name: roleRow.name,
                capabilities: Array.isArray(roleRow.capabilities) ? roleRow.capabilities : [],
                limits: roleRow.limits && typeof roleRow.limits === "object"
                  ? roleRow.limits as typeof staffRole.limits
                  : { ...STAFF_ROLE_PRESETS[fallbackRoleCode].limits },
              };
            }
          }

          // 5. Fetch branches + terminals.
          const { data: branches } = await sb
            .from("branches")
            .select("id,name")
            .eq("store_id", store.id)
            .order("created_at", { ascending: true });
          const branchRows = (branches ?? []) as Array<{ id: string; name: string }>;
          const branchIds = branchRows.map((b) => b.id);
          const { data: terminals } = await sb
            .from("terminals")
            .select("id,branch_id,name")
            .in("branch_id", branchIds.length > 0 ? branchIds : ["00000000-0000-0000-0000-000000000000"]);
          const terminalRows = (terminals ?? []) as Array<{ id: string; branch_id: string; name: string }>;

          const defaultBranchId =
            branchRows.find((b) => b.name === "الفرع الرئيسي")?.id ?? branchRows[0]?.id ?? null;
          const defaultTerminalId =
            terminalRows.find((t) => t.branch_id === defaultBranchId && t.name === "الكاشير الرئيسي")?.id ??
            terminalRows.find((t) => t.branch_id === defaultBranchId)?.id ??
            terminalRows[0]?.id ??
            null;

          // 6. Build and commit login payload.
          const payload: LoginPayloadData = {
            store: {
              id: store.id,
              code: store.code,
              name: store.name,
              ownerName: store.owner_name,
              email: store.email,
              phone: store.phone,
              subscriptionStatus: store.subscription_status,
              logoUrl: store.logo_url,
              address: store.address,
              receiptHeader: store.receipt_header,
              receiptFooter: store.receipt_footer,
              loyaltyEnabled: store.loyalty_enabled !== false,
              pointsPerSpend: Number(store.points_per_spend) || 1,
              pointValue: Number(store.point_value) || 0.01,
              taxPercent: store.tax_percent != null ? Number(store.tax_percent) : 16,
              taxNumber: store.tax_number ?? "",
              receiptShowTaxNumber: store.receipt_show_tax_number !== false,
              receiptShowCashierTime: store.receipt_show_cashier_time !== false,
              receiptShowBarcodeQr: store.receipt_show_barcode_qr !== false,
              receiptCompactSpacing: store.receipt_compact_spacing === true,
            },
            cashier: {
              id: cashier.id,
              name: cashier.name,
              role: cashier.role,
              roleId: staffRole.id ?? undefined,
              roleCode: staffRole.code,
              roleName: staffRole.name,
              capabilities: staffRole.capabilities,
              limits: staffRole.limits,
            },
            branches: branchRows,
            terminals: terminalRows.map((t) => ({ id: t.id, branchId: t.branch_id, name: t.name })),
            defaultBranchId,
            defaultTerminalId,
          };
          applyLoginPayloadToStore(set, get, payload);
          return true;
        } catch (err) {
          console.error("RAW STAFF LOGIN ERROR:", err);
          set({ notice: { message: "تعذر الاتصال — تحقق من الشبكة", tone: "error" } });
          return false;
        }
      },

      setCurrentStore: (store) => {
        setTenantStoreId(store.id);
        set({ currentStore: store });
        persistDurablePosState(get());
      },

      setAdminSessionEmail: (email) => {
        const session = get().adminSession;
        if (!session) return;
        set({ adminSession: { ...session, email } });
        persistDurablePosState(get());
      },

      adminLogin: async (email, password) => {
        const mail = email.trim().toLowerCase();
        if (!mail || !password) {
          set({ notice: { message: "أدخل البريد الإلكتروني وكلمة المرور", tone: "error" } });
          return false;
        }
        try {
          const sb = getSupabaseBrowser();
          if (!sb || !isSupabaseBrowserConfigured()) {
            set({ notice: { message: "Supabase غير مُعد — تحقق من ملف .env.local", tone: "error" } });
            return false;
          }

          const { data, error } = await sb.rpc("authenticate_admin_client", {
            p_email: mail,
            p_password: password,
          });
          if (error) throw error;
          if (!data || typeof data !== "object") {
            set({ notice: { message: "بيانات الدخول غير صحيحة", tone: "error" } });
            return false;
          }

          const payload = data as {
            store: Record<string, unknown>;
            cashier: { id: string; name: string; role: string; email: string };
            branches?: Array<{ id: string; name: string }>;
            terminals?: Array<{ id: string; branch_id: string; name: string }>;
          };

          if (payload.store.subscription_status === "suspended") {
            set({ notice: { message: "هذا المتجر موقوف", tone: "error" } });
            return false;
          }

          const branchRows = payload.branches ?? [];
          const terminalRows = payload.terminals ?? [];
          const defaultBranchId =
            branchRows.find((b) => b.name === "الفرع الرئيسي")?.id ?? branchRows[0]?.id ?? null;
          const defaultTerminalId =
            terminalRows.find((t) => t.branch_id === defaultBranchId && t.name === "الكاشير الرئيسي")?.id ??
            terminalRows.find((t) => t.branch_id === defaultBranchId)?.id ??
            terminalRows[0]?.id ??
            null;

          const s = payload.store;
          const loginData: LoginPayloadData & {
            cashier: LoginPayloadData["cashier"] & { email?: string };
          } = {
            store: {
              id: s.id as string,
              code: s.code as string,
              name: s.name as string,
              ownerName: s.owner_name as string,
              email: s.email as string,
              phone: s.phone as string,
              subscriptionStatus: (s.subscription_status ?? "active") as SubscriptionStatus,
              logoUrl: s.logo_url as string,
              address: s.address as string,
              receiptHeader: s.receipt_header as string,
              receiptFooter: s.receipt_footer as string,
              loyaltyEnabled: s.loyalty_enabled !== false,
              pointsPerSpend: Number(s.points_per_spend) || 1,
              pointValue: Number(s.point_value) || 0.01,
              taxPercent: s.tax_percent != null ? Number(s.tax_percent) : 16,
              taxNumber: s.tax_number as string,
              receiptShowTaxNumber: s.receipt_show_tax_number !== false,
              receiptShowCashierTime: s.receipt_show_cashier_time !== false,
              receiptShowBarcodeQr: s.receipt_show_barcode_qr !== false,
              receiptCompactSpacing: s.receipt_compact_spacing === true,
            },
            cashier: {
              id: payload.cashier.id,
              name: payload.cashier.name,
              role: payload.cashier.role,
              email: payload.cashier.email,
            },
            branches: branchRows,
            terminals: terminalRows.map((t) => ({ id: t.id, branchId: t.branch_id, name: t.name })),
            defaultBranchId,
            defaultTerminalId,
          };
          applyLoginPayloadToStore(set, get, loginData, {
            storeId: payload.store.id as string,
            email: payload.cashier.email ?? mail,
            name: payload.cashier.name,
          });
          return true;
        } catch (err) {
          console.error("RAW ADMIN LOGIN ERROR:", err);
          set({ notice: { message: "تعذر الاتصال — تحقق من الشبكة", tone: "error" } });
          return false;
        }
      },

      lockScreen: async () => {
        // Locking the register is a full sign-out: drop the local cashier and
        // any owner session. Cookie revocation and the hard redirect to the
        // unified /login gateway happen client-side (RegisterGate → logoutToLogin),
        // so no network call is required here and an offline register can still
        // hand over.
        set({ currentCashier: null, adminSession: null });
        persistDurablePosState(get());
      },

      selectTerminal: (branchId, terminalId) => {
        const shift = get().shiftState;
        if (shift.status === "OPEN") {
          set({ notice: { message: "أغلق الوردية قبل تبديل الفرع أو الكاشير", tone: "error" } });
          return;
        }
        set({
          activeBranchId: branchId,
          activeTerminalId: terminalId,
          shiftState: { ...shift, branchId, terminalId },
        });
      },

      setBranchesAndTerminals: (branches, terminals, defaultBranchId, defaultTerminalId) =>
        set((s) => ({
          branches,
          terminals,
          activeBranchId:
            defaultBranchId ?? s.activeBranchId ?? branches[0]?.id ?? null,
          activeTerminalId:
            defaultTerminalId ?? s.activeTerminalId ?? terminals[0]?.id ?? null,
        })),

      loadStores: (stores) => set({ stores }),

      hydrateCatalog: async () => {
        const storeId = get().currentStore?.id ?? getTenantStoreId();
        if (!storeId) return;
        const existingJob = catalogHydrationJobs.get(storeId);
        if (existingJob) return existingJob;

        const job = (async () => {
          const matchesStore = () =>
            (get().currentStore?.id ?? getTenantStoreId()) === storeId;
          const catalogHeaders: Record<string, string> = { [STORE_HEADER]: storeId };
          if (get().catalogUpdatedAt) {
            catalogHeaders["If-None-Match"] = get().catalogUpdatedAt;
          }
          const customerHeaders: Record<string, string> = { [STORE_HEADER]: storeId };
          if (get().customersUpdatedAt) {
            customerHeaders["If-None-Match"] = get().customersUpdatedAt;
          }

          set({ customersLoading: true });

          const localCatalogPromise = loadCatalogCache(storeId).catch((err) => {
            console.error("Failed to read catalog cache:", err);
            return null;
          });
          const localCustomersPromise = loadCustomersCache(storeId).catch((err) => {
            console.error("Failed to read customers cache:", err);
            return null;
          });
          const remoteCatalogPromise = fetch("/api/catalog", {
            cache: "no-store",
            headers: catalogHeaders,
          });
          const remoteCustomersPromise = fetch("/api/customers", {
            cache: "no-store",
            headers: customerHeaders,
          });
          const [localCatalog, localCustomers] = await Promise.all([
            localCatalogPromise,
            localCustomersPromise,
          ]);

          if (!matchesStore()) return;
          // Dead guard restored: surface a notice when there's no local copy
          // AND nothing has loaded yet, so the user knows why the grid is empty.
          if (!localCatalog && !get().catalogUpdatedAt && !get().ready) {
            set({
              ready: true,
              notice: { message: "تعذّر تحميل الكتالوج — لا يوجد نسخة محلية", tone: "error" },
            });
          }
          if (
            localCatalog &&
            (!get().catalogUpdatedAt || get().catalogUpdatedAt !== localCatalog.updatedAt)
          ) {
            get().loadSnapshot(snapshotFromCatalogCache(localCatalog));
          }

          if (
            localCustomers &&
            (!get().customersUpdatedAt ||
              get().customersUpdatedAt !== localCustomers.updatedAt ||
              get().customers.length === 0)
          ) {
            set((state) => ({
              customers: mergeCustomers(state.customers, localCustomers.customers),
              customersUpdatedAt: localCustomers.updatedAt,
            }));
          }

          let catalogOnline = false;
          let customersOnline = false;

          const [remoteCatalog, remoteCustomers] = await Promise.allSettled([
            remoteCatalogPromise,
            remoteCustomersPromise,
          ]);

          if (!matchesStore()) return;

          if (remoteCatalog.status === "fulfilled") {
            const response = remoteCatalog.value;
            if (response.status === 304) {
              catalogOnline = true;
            } else if (response.ok) {
              catalogOnline = true;
              const snapshot = (await response.json()) as PosSnapshot;
              if (snapshot.updatedAt !== get().catalogUpdatedAt) {
                await saveCatalogCache(
                  {
                    storeId,
                    categories: snapshot.categories,
                    products: snapshot.products,
                    barcodes: snapshot.barcodes,
                    barcodeIndex: snapshot.barcodeIndex,
                    quickKeys: snapshot.quickKeys,
                    cashiers: snapshot.cashiers,
                    pinSalt: snapshot.pinSalt,
                    updatedAt: snapshot.updatedAt,
                  },
                  storeId,
                );
                if (!matchesStore()) return;
                get().loadSnapshot(snapshot);
              }
            }
          }

          if (remoteCustomers.status === "fulfilled") {
            const response = remoteCustomers.value;
            if (response.status === 304) {
              customersOnline = true;
            } else if (response.ok) {
              const data = (await response.json()) as {
                customers?: PosCustomer[];
                updatedAt?: string;
              };
              const customers = normalizeCustomers(
                Array.isArray(data.customers) ? data.customers : [],
              );
              const updatedAt =
                typeof data.updatedAt === "string" && data.updatedAt
                  ? data.updatedAt
                  : `remote:${Date.now()}`;
              customersOnline = true;
              if (
                updatedAt !== get().customersUpdatedAt ||
                customers.length !== get().customers.length
              ) {
                await saveCustomersCache({ storeId, customers, updatedAt }, storeId);
                if (!matchesStore()) return;
                set((state) => ({
                  customers: mergeCustomers(state.customers, customers),
                  customersUpdatedAt: updatedAt,
                }));
              }
            }
          }

          set({ isOnline: catalogOnline || customersOnline });

          if (!catalogOnline && !localCatalog && !get().ready) {
            set({
              ready: true,
              notice: {
                message: "تعذّر تحميل الكتالوج — لا يوجد نسخة محلية",
                tone: "error",
              },
            });
          }
        })().finally(() => {
          catalogHydrationJobs.delete(storeId);
          if ((get().currentStore?.id ?? getTenantStoreId()) === storeId) {
            set({ customersLoading: false });
          }
        });

        catalogHydrationJobs.set(storeId, job);
        return job;
      },

      requestSecondaryAuth: (action) =>
        set({ isSecondaryAuthOpen: true, pendingSecondaryAction: action }),

      cancelSecondaryAuth: () =>
        set({ isSecondaryAuthOpen: false, pendingSecondaryAction: null }),

      confirmSecondaryAction: async (password) => {
        const action = get().pendingSecondaryAction;
        if (!action) return false;
        if (!password) {
          set({ notice: { message: "أدخل كلمة المرور", tone: "error" } });
          return false;
        }
        try {
          // Cashier upserts are self-verifying server-side; everything else
          // (drawer, invoice void, discount approval, return mode) has no
          // server write of its own and needs a password re-check first.
          if (action.type === "save_cashier") {
            const ok = await get().saveCashier(action.cashier, password);
            if (ok) {
              set({ isSecondaryAuthOpen: false, pendingSecondaryAction: null });
              return true;
            }
            return false;
          }

          if (action.type === "delete_cashier") {
            const ok = await get().deleteCashier(action.cashierId, password);
            if (ok) {
              set({ isSecondaryAuthOpen: false, pendingSecondaryAction: null });
              return true;
            }
            return false;
          }

          // Re-verify admin password via Supabase RPC.
          const sb = getSupabaseBrowser();
          if (!sb) {
            set({ notice: { message: "Supabase غير مُعد", tone: "error" } });
            return false;
          }
          const adminEmail = get().adminSession?.email ?? "";
          const { data: reverifyData, error: reverifyError } = await sb.rpc("authenticate_admin_client", {
            p_email: adminEmail,
            p_password: password,
          });
          if (reverifyError || !reverifyData || typeof reverifyData !== "object") {
            set({ notice: { message: "كلمة المرور غير صحيحة", tone: "error" } });
            return false;
          }
          // Verify the store matches.
          const rvStore = (reverifyData as { store?: { id?: string; subscription_status?: string } }).store;
          if (get().currentStore?.id && rvStore?.id && rvStore.id !== get().currentStore?.id) {
            set({ notice: { message: "كلمة المرور غير صحيحة", tone: "error" } });
            return false;
          }
          if (rvStore?.subscription_status === "suspended") {
            set({ notice: { message: "تم إيقاف هذا المتجر", tone: "error" } });
            return false;
          }

          if (action.type === "open_drawer") {
            await get().openDrawer();
          } else if (action.type === "cancel_invoice") {
            await get().cancelInvoice(action.syncId);
          } else if (action.type === "approve_discount") {
            get().commitDiscount(action.discount);
          } else if (action.type === "toggle_return_mode") {
            const state = get();
            get().toggleReturnMode();
            void pushAudit(state.adminSession?.email ?? state.currentStore?.email, "ENTER_RETURN_MODE", null, {
              cashierId: state.currentCashier?.id,
              cashierName: state.currentCashier?.name,
              branchId: state.activeBranchId ?? undefined,
              terminalId: state.activeTerminalId ?? undefined,
            });
          }
          set({ isSecondaryAuthOpen: false, pendingSecondaryAction: null });
          return true;
        } catch {
          set({ notice: { message: "تعذر الاتصال — تحقق من الشبكة", tone: "error" } });
          return false;
        }
      },

      openDrawer: async () => {
        const opened = await openCashDrawer(
          loadDeviceHardwareSettings(get().activeTerminalId),
        );
        set({
          notice: opened
            ? { message: "تم فتح الدرج", tone: "success" }
            : {
                message: "تعذر فتح الدرج — لا يوجد طابعة حرارية أو درج متصل",
                tone: "error",
              },
        });
        if (opened) {
          const session = get().adminSession;
          void pushAudit(session?.email, "OPEN_DRAWER", null, {
            branchId: get().activeBranchId ?? undefined,
            terminalId: get().activeTerminalId ?? undefined,
          });
        }
      },

      cancelInvoice: async (syncId) => {
        try {
          const record = await findInvoiceById(syncId);
          if (!record || record.action_type !== "INVOICE_CREATED") {
            set({ notice: { message: "الفاتورة غير موجودة", tone: "error" } });
            return;
          }
          const alreadyVoided = await isInvoiceReturned(syncId).catch(() => false);
          if (alreadyVoided) {
            set({
              notice: {
                message: "هذه الفاتورة أُلغيَت أو رُدَّت سابقاً",
                tone: "error",
              },
            });
            return;
          }
          const payload = record.payload;
          const originalItems = payload.items ?? [];
          if (originalItems.length === 0) {
            set({ notice: { message: "لا يمكن إلغاء فاتورة فارغة", tone: "error" } });
            return;
          }

          const reversalTotal = -Math.abs(payload.total ?? 0);

          // Derive reversal buckets from the ORIGINAL signed buckets when the
          // invoice carried them, so a SPLIT reversal keeps its 60/40 shape
          // instead of re-deriving into 100% cash. Re-derivation via
          // derivePaymentBuckets is the fallback for legacy invoices.
          const explicit = {
            cashAmount: payload.cashAmount,
            visaAmount: payload.visaAmount,
            cliqAmount: payload.cliqAmount,
            debtAmount: payload.debtAmount,
          };
          const hasExplicitBuckets = [explicit.cashAmount, explicit.visaAmount, explicit.cliqAmount, explicit.debtAmount].some(
            (v) => typeof v === "number",
          );
          const buckets = hasExplicitBuckets
            ? {
                cash: -Math.abs(explicit.cashAmount ?? 0),
                visa: -Math.abs(explicit.visaAmount ?? 0),
                cliq: -Math.abs(explicit.cliqAmount ?? 0),
                debt: -Math.abs(explicit.debtAmount ?? 0),
              }
            : derivePaymentBuckets(payload.paymentMethod ?? "CASH", reversalTotal, reversalTotal);

          const items: SaleItem[] = originalItems.map((it) => ({
            ...it,
            qty: -Math.abs(it.qty),
            lineTotal: -Math.abs(it.lineTotal),
            discount: 0,
            discountPct: undefined,
          }));

          const reversal: SyncQueueRecord = {
            sync_id: newUuid(),
            action_type: "INVOICE_CREATED",
            payload: {
              items,
              subtotal: -Math.abs(payload.subtotal ?? 0),
              tax: -Math.abs(payload.tax ?? 0),
              discount: 0,
              deliveryFee: -Math.abs(payload.deliveryFee ?? 0),
              total: reversalTotal,
              paymentMethod: payload.paymentMethod ?? "CASH",
              amountPaid: -Math.abs(payload.amountPaid ?? payload.total ?? 0),
              change: 0,
              cashAmount: buckets.cash,
              visaAmount: buckets.visa,
              cliqAmount: buckets.cliq,
              debtAmount: buckets.debt,
              customerName: payload.customerName,
              customerId: payload.customerId,
              customerPhone: payload.customerPhone,
              originalInvoiceId: syncId,
              isCancellation: true,
              cashierName: get().adminSession?.name,
              shiftId: payload.shiftId,
              branchId: payload.branchId,
              terminalId: payload.terminalId,
              completed_at: new Date().toISOString(),
            },
            status: "PENDING",
            created_at: new Date().toISOString(),
            cashierName: get().adminSession?.name,
          };

          await enqueueSync(reversal);
          const pendingSyncCount = (await getSyncsByStatus("PENDING")).length;
          set({
            pendingSyncCount,
            notice: {
              message: `تم إلغاء الفاتورة #${syncId.slice(0, 8)} — سيتم عكسها عند المزامنة`,
              tone: "success",
            },
          });
          const session = get().adminSession;
          void pushAudit(session?.email, "CANCEL_INVOICE", syncId, {
            total: -Math.abs(payload.total ?? 0),
            items: originalItems.length,
            customerName: payload.customerName,
          });
        } catch (err) {
          console.error("Failed to cancel invoice:", err);
          set({ notice: { message: "فشل إلغاء الفاتورة محلياً", tone: "error" } });
        }
      },

      adminSetLinePrice: (index, price) => {
        if (!get().adminSession) return;
        if (!Number.isFinite(price) || price < 0) {
          set({ notice: { message: "السعر غير صالح", tone: "error" } });
          return;
        }
        const item = get().items[index];
        if (!item) return;
        const gross = round2(item.qty * price);
        const previousPrice = item.unitPrice;
        let discount = 0;
        if (item.discountPct) {
          discount = round2((Math.abs(gross) * item.discountPct) / 100);
        } else if (item.discount) {
          discount = round2(Math.min(item.discount, Math.abs(gross)));
        }
        const items = get().items.map((it, i) =>
          i !== index
            ? it
            : {
                ...it,
                unitPrice: round2(price),
                discount,
                lineTotal: round2(gross - discount),
              },
        );
        set({
          items,
          totals: computeTotals(
            items,
            get().invoiceDiscount,
            effectiveTaxPercent(get().currentStore),
            get().deliveryFee,
          ),
          notice: { message: "تم تعديل سعر الصنف", tone: "success" },
        });
        const session = get().adminSession;
        void pushAudit(session?.email, "OVERRIDE_PRICE", item.productId, {
          productName: item.name,
          from: previousPrice,
          to: round2(price),
          qty: item.qty,
        });
      },

      saveCashier: async (draft, password) => {
        const session = get().adminSession;
        if (!session) return false;
        try {
          const sb = getSupabaseBrowser();
          if (!sb) {
            set({ notice: { message: "Supabase غير مُعد", tone: "error" } });
            return false;
          }
          const storeId = get().currentStore?.id;
          if (!storeId) return false;

          // Verify admin password.
          const { data: authData } = await sb.rpc("authenticate_admin_client", {
            p_email: session.email,
            p_password: password,
          });
          if (!authData || typeof authData !== "object") {
            set({ notice: { message: "كلمة المرور غير صحيحة", tone: "error" } });
            return false;
          }

          if (!draft.id) {
            // CREATE: generate salt + hash, insert row.
            const pinSalt = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
            const pinHash = sha256Hex(draft.pin + pinSalt);
            const roleCode = normalizeStaffRoleCode(draft.role);
            const username = draft.username?.trim().toLowerCase() || draft.name.trim().replace(/[^\p{L}\p{N}_\-\. ]/gu, "").toLowerCase() || "user";

            const { error: insertError } = await sb
              .from("cashiers")
              .insert({
                name: draft.name.trim(),
                username,
                role: roleCode,
                role_id: draft.roleId || null,
                pin_salt: pinSalt,
                pin_hash: pinHash,
                store_id: storeId,
                is_active: draft.isActive !== false,
              });
            if (insertError) {
              if (insertError.code === "23505") {
                set({ notice: { message: "اسم المستخدم مستخدم مسبقاً", tone: "error" } });
              } else {
                set({ notice: { message: insertError.message ?? "تعذر حفظ الموظف", tone: "error" } });
              }
              return false;
            }
          } else {
            // UPDATE: patch fields.
            const patch: Record<string, unknown> = {};
            if (draft.name) patch.name = draft.name.trim();
            if (draft.username) patch.username = draft.username.trim().toLowerCase();
            if (draft.isActive !== undefined) patch.is_active = draft.isActive;
            if (draft.pin) {
              const pinSalt = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
              patch.pin_salt = pinSalt;
              patch.pin_hash = sha256Hex(draft.pin + pinSalt);
            }
            if (draft.role) {
              const roleCode = normalizeStaffRoleCode(draft.role);
              patch.role = roleCode;
              patch.role_id = draft.roleId || null;
            }
            if (Object.keys(patch).length === 0) {
              set({ notice: { message: "لا توجد تغييرات", tone: "error" } });
              return false;
            }
            const { error: updateError } = await sb
              .from("cashiers")
              .update(patch)
              .eq("id", draft.id)
              .eq("store_id", storeId);
            if (updateError) {
              if (updateError.code === "23505") {
                set({ notice: { message: "اسم المستخدم مستخدم مسبقاً", tone: "error" } });
              } else {
                set({ notice: { message: updateError.message ?? "تعذر حفظ الموظف", tone: "error" } });
              }
              return false;
            }
          }

          await get().hydrateCatalog();
          set({ notice: { message: "تم حفظ الموظف", tone: "success" } });
          void pushAudit(session.email, "SAVE_CASHIER", draft.id ?? null, {
            name: draft.name,
            role: draft.role,
            username: draft.username,
            isActive: draft.isActive,
          });
          return true;
        } catch {
          set({ notice: { message: "تعذر الاتصال — تحقق من الشبكة", tone: "error" } });
          return false;
        }
      },

      deleteCashier: async (id, password) => {
        const session = get().adminSession;
        if (!session) return false;
        try {
          const sb = getSupabaseBrowser();
          if (!sb) {
            set({ notice: { message: "Supabase غير مُعد", tone: "error" } });
            return false;
          }
          const storeId = get().currentStore?.id;
          if (!storeId) return false;

          // Verify admin password.
          const { data: authData } = await sb.rpc("authenticate_admin_client", {
            p_email: session.email,
            p_password: password,
          });
          if (!authData || typeof authData !== "object") {
            set({ notice: { message: "كلمة المرور غير صحيحة", tone: "error" } });
            return false;
          }

          // Check the target cashier exists and is not an admin.
          const { data: row } = await sb
            .from("cashiers")
            .select("id,role")
            .eq("id", id)
            .eq("store_id", storeId)
            .maybeSingle();
          if (!row) {
            set({ notice: { message: "الموظف غير موجود", tone: "error" } });
            return false;
          }
          if (row.role === "admin" || row.role === "مدير") {
            set({ notice: { message: "لا يمكن حذف حساب مدير المتجر", tone: "error" } });
            return false;
          }

          const { error: deleteError } = await sb.from("cashiers").delete().eq("id", id);
          if (deleteError) {
            set({ notice: { message: deleteError.message ?? "تعذر حذف الموظف", tone: "error" } });
            return false;
          }
          await get().hydrateCatalog();
          set({ notice: { message: "تم حذف الموظف", tone: "success" } });
          void pushAudit(session.email, "DELETE_CASHIER", id);
          return true;
        } catch {
          set({ notice: { message: "تعذر الاتصال — تحقق من الشبكة", tone: "error" } });
          return false;
        }
      },

      openPreviousInvoicesModal: () => set({ isPreviousInvoicesModalOpen: true }),
      closePreviousInvoicesModal: () => set({ isPreviousInvoicesModalOpen: false }),
      setLineEditTarget: (index) => set({ lineEditTarget: index }),
      openAuditLogModal: () => set({ isAuditLogOpen: true }),
      closeAuditLogModal: () => set({ isAuditLogOpen: false }),

      setActiveCustomer: (customerId) => {
        const id = customerId?.trim() || null;
        set({ activeCustomerId: id, priceMemory: {} });
        if (id) void get().refreshPriceMemory();
      },

      refreshPriceMemory: async () => {
        const customerId = get().activeCustomerId;
        const storeId =
          get().currentStore?.id ?? getTenantStoreId() ?? get().runtimeStoreId ?? null;
        if (!customerId || !storeId) return;
        await ensurePriceMemoryCache(storeId);
        const entries = await loadPriceMemoryForCustomer(storeId, customerId);
        const priceMemory: Record<string, PriceMemoryEntry> = {};
        for (const entry of entries) {
          const lookupKey = priceMemoryLookupKey(entry.productId, entry.barcode);
          if (lookupKey) priceMemory[lookupKey] = entry;
        }
        set({ priceMemory });
      },

      applyMemoryPrice: (index) => {
        const item = get().items[index];
        if (!item) return;
        const lookupKey = priceMemoryLookupKey(item.productId, item.barcode);
        const entry = lookupKey ? get().priceMemory[lookupKey] : undefined;
        if (!entry || !Number.isFinite(entry.unitPrice) || entry.unitPrice < 0) {
          set({ notice: { message: "لا يوجد سعر محفوظ لهذا الصنف", tone: "error" } });
          return;
        }
        const price = entry.unitPrice;
        const previousPrice = item.unitPrice;
        const gross = round2(item.qty * price);
        let discount = 0;
        if (item.discountPct) {
          discount = round2((Math.abs(gross) * item.discountPct) / 100);
        } else if (item.discount) {
          discount = round2(Math.min(item.discount, Math.abs(gross)));
        }
        const items = get().items.map((it, i) =>
          i !== index
            ? it
            : {
                ...it,
                unitPrice: round2(price),
                discount,
                lineTotal: round2(gross - discount),
              },
        );
        set({
          items,
          totals: computeTotals(
            items,
            get().invoiceDiscount,
            effectiveTaxPercent(get().currentStore),
            get().deliveryFee,
          ),
          notice: {
            message: `تم تطبيق آخر سعر للزبون: ${round2(price).toFixed(2)}`,
            tone: "success",
          },
        });
        void pushAudit(get().adminSession?.email, "OVERRIDE_PRICE", item.productId, {
          productName: item.name,
          from: previousPrice,
          to: round2(price),
          qty: item.qty,
          source: "customer-memory",
          customerId: get().activeCustomerId ?? undefined,
        });
      },

      flagShortage: async (productId, reason) => {
        const product = get().products[productId];
        if (!product) {
          set({ notice: { message: "الصنف غير موجود في الكتالوج", tone: "error" } });
          return;
        }
        const now = new Date().toISOString();
        const cashier = get().currentCashier;
        const shiftState = get().shiftState;
        const currentStock = Math.max(0, product.totalStock ?? 0);
        const trimmedReason = reason?.trim() || undefined;
        const flag: ShortageFlag = {
          id: newUuid(),
          productId,
          productName: product.name,
          currentStock,
          reason: trimmedReason,
          cashierId: cashier?.id,
          cashierName: cashier?.name,
          createdAt: now,
          resolved: false,
        };
        const record: SyncQueueRecord = {
          sync_id: newUuid(),
          action_type: "SHORTAGE_FLAGGED",
          payload: {
            productId,
            productName: product.name,
            currentStock,
            reason: trimmedReason,
            cashierId: cashier?.id,
            cashierName: cashier?.name,
            branchId: shiftState.branchId ?? undefined,
            terminalId: shiftState.terminalId ?? undefined,
            created_at: now,
          },
          status: "PENDING",
          created_at: now,
          cashierName: cashier?.name,
        };

        try {
          await deletePendingShortageFlags(productId);
          await enqueueSync(record);
          const pendingSyncCount = (await getSyncsByStatus("PENDING")).length;
          set((state) => ({
            shortageFlags: { ...state.shortageFlags, [productId]: flag },
            pendingSyncCount,
            notice: { message: `تم إبلاغ نقص: ${product.name}`, tone: "success" },
          }));
          // Upsert into the durable tenant cache: replace any prior flag for
          // the product (the latest cashier report wins) but keep resolved
          // history so the admin radar stays auditable.
          const tenantId = getTenantStoreId();
          const cached = await loadShortageFlagCache(tenantId);
          const merged = [
            ...(cached?.flags ?? []).filter((f) => f.productId !== productId || f.resolved),
            flag,
          ];
          await saveShortageFlagCache({ storeId: tenantId, flags: merged, updatedAt: now }, tenantId);
        } catch (err) {
          console.error("Failed to persist shortage flag locally:", err);
          set({ notice: { message: "فشل حفظ إبلاغ النقص محلياً", tone: "error" } });
        }
      },

      /* ── Multi-cart ─────────────────────────────────────────────── */

      switchCart: (index) => {
        const { cartSlots, activeCartIndex, items, invoiceDiscount, deliveryFee, currentStore } = get();
        if (index === activeCartIndex || index < 0 || index >= cartSlots.length) return;
        // Save current cart into the active slot
        const updatedSlots = cartSlots.map((slot, i) =>
          i === activeCartIndex
            ? { ...slot, items, invoiceDiscount, deliveryFee }
            : slot,
        );
        const target = updatedSlots[index];
        const taxPercent = effectiveTaxPercent(currentStore);
        set({
          cartSlots: updatedSlots,
          activeCartIndex: index,
          items: target.items,
          invoiceDiscount: target.invoiceDiscount,
          deliveryFee: target.deliveryFee,
          totals: computeTotals(target.items, target.invoiceDiscount, taxPercent, target.deliveryFee),
        });
      },

      createCart: () => {
        const { cartSlots, activeCartIndex, items, invoiceDiscount, deliveryFee, currentStore } = get();
        const nextIndex = cartSlots.length;
        const newId = newUuid();
        // Save current cart into the active slot
        const updatedSlots = cartSlots.map((slot, i) =>
          i === activeCartIndex
            ? { ...slot, items, invoiceDiscount, deliveryFee }
            : slot,
        );
        set({
          cartSlots: [...updatedSlots, { id: newId, items: [], invoiceDiscount: null, deliveryFee: 0 }],
          activeCartIndex: nextIndex,
          items: [],
          invoiceDiscount: null,
          deliveryFee: 0,
          totals: computeTotals([], null, effectiveTaxPercent(currentStore), 0),
        });
      },

      closeCart: (index) => {
        const { cartSlots, activeCartIndex, currentStore } = get();
        if (cartSlots.length <= 1) {
          set({ notice: { message: "لا يمكن إغلاق الفاتورة الأخيرة", tone: "error" } });
          return;
        }
        if (index < 0 || index >= cartSlots.length) return;
        const nextSlots = cartSlots.filter((_, i) => i !== index);
        // Determine which tab to switch to
        let nextActive = activeCartIndex;
        if (index < activeCartIndex) {
          nextActive = activeCartIndex - 1;
        } else if (index === activeCartIndex) {
          nextActive = Math.min(index, nextSlots.length - 1);
        }
        const taxPercent = effectiveTaxPercent(currentStore);
        const target = nextSlots[nextActive];
        set({
          cartSlots: nextSlots,
          activeCartIndex: nextActive,
          items: target.items,
          invoiceDiscount: target.invoiceDiscount,
          deliveryFee: target.deliveryFee,
          totals: computeTotals(target.items, target.invoiceDiscount, taxPercent, target.deliveryFee),
        });
      },
    }),
    {
      name: POS_PERSIST_NAME,
      version: POS_PERSIST_VERSION,
      storage: createPosPersistStorage<ReturnType<typeof partializePosState>>(),
      partialize: partializePosState,
      onRehydrateStorage: () => (state) => {
        if (state?.currentStore?.id) setTenantStoreId(state.currentStore.id);
      },
    },
  ),
);

// Deferred boot-cache application (UI-freeze guard): the catalog/customer
// boot mirror is a multi-MB JSON blob in localStorage. Parsing it at module
// import blocked the main thread before first paint — the "register freezes
// on load" symptom as the catalog grows. The mirror is now read and applied
// off the critical path, once the tab is idle, and only when async hydration
// has not already produced an equal-or-newer snapshot for the active tenant.
if (typeof window !== "undefined") {
  const applyBootCache = (): void => {
    const state = usePosStore.getState();
    const storeId =
      state.runtimeStoreId ?? state.currentStore?.id ?? state.adminSession?.storeId ?? null;
    if (!storeId) return;
    const cache = loadCatalogBootCacheSync(storeId);
    if (!cache) return;
    if (state.ready && state.catalogUpdatedAt === cache.updatedAt) return;
    if (state.catalogUpdatedAt && state.catalogUpdatedAt !== cache.updatedAt) return;
    usePosStore.setState({ ...bootCatalogState(cache) });
    const customers = loadCustomersBootCacheSync(storeId);
    if (customers) usePosStore.setState({ ...bootCustomerState(customers) });
  };
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(() => applyBootCache(), { timeout: 300 });
  } else {
    setTimeout(applyBootCache, 0);
  }
}
