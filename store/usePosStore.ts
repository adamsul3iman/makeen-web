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
   ProductUnitsMap,
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
   TerminalInvoiceCounter,
 } from "@/types/pos.types";
import {
  countIstdFailed,
  countIstdPending,
  countPoisonSyncRecords,
  enqueueSync,
  ensurePriceMemoryCache,
  deletePendingShortageFlags,
  findInvoiceById,
  getIstdFailedStates,
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
  saveOrdersCache,
  saveShortageFlagCache,
  upsertPriceMemoryFromPayload,
  type SyncQueueRecord,
} from "@/lib/idb";
import { priceMemoryLookupKey, type PriceMemoryEntry } from "@/lib/priceMemory";
import { sha256Hex } from "@/lib/sha256";
import { openCashDrawer } from "@/lib/cashDrawer";
import { loadDeviceHardwareSettings } from "@/lib/deviceHardware";
import { pushAudit } from "@/lib/audit";
import { requestPersistentStorage } from "@/lib/storageGuard";
import { newUuid } from "@/lib/uuid";
import { getTenantStoreId, setTenantStoreId } from "@/lib/tenantClient";
import { fetchCatalogStamp, rememberCatalogStamp } from "@/lib/catalogInvalidation";
import { fetchCatalogSnapshot, fetchCustomersPayload } from "@/lib/clientCatalog";
import { effectiveTaxPercent } from "@/lib/qr";
import { computeFiscalBreakdown, computeSaleTotals, withB2BMarkup } from "@/lib/saleMath";
import { derivePaymentBuckets } from "@/lib/paymentBuckets";
import {
  createPosPersistStorage,
  flushPersistWrites,
  posPersistStorage,
} from "@/lib/persistStorage";
import { emitPosSound } from "@/lib/posSound";
import { getSupabaseBrowser, isSupabaseBrowserConfigured } from "@/lib/supabaseBrowser";
import { useOrdersStore } from "@/store/useOrdersStore";
import { heldInvoiceToOrder } from "@/types/orders.types";
import {
  clearCachedCashierSession,
  findCachedCashierSessionByCode,
  loadCachedCashierSession,
  saveCachedCashierSession,
} from "@/lib/cashierSessionCache";
import { hasCapability, STAFF_ROLE_PRESETS, normalizeStaffRoleCode, homePathForDevice } from "@/lib/permissions";
import { updateSettings, updateTaxSettings, type StoreSettings } from "@/lib/settingsClient";
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
  | { type: "save_settings"; fields: StoreSettingsUpdate }
  | {
      type: "save_istd";
      fields: { tax_number?: string; istd_client_id?: string; istd_client_secret?: string };
    }
  | { type: "approve_discount"; discount: DiscountInput }
  | { type: "toggle_return_mode" };

/**
 * Settings form payload awaiting the owner's password. When `email` differs
 * from the current store email, the confirm path runs
 * admin_update_owner_email (password proof) BEFORE updateSettings, because the
 * email is the owner's login identity on both stores + cashiers.
 */
export type StoreSettingsUpdate = Partial<Omit<StoreSettings, "id" | "code" | "subscriptionStatus">>;

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
  /**
   * Durable per-terminal invoice counters, keyed by terminal id. Survives
   * reloads and cashier changes (persisted) so each register's receipt
   * numbers keep increasing forever. Never reset on logout.
   */
  terminalInvoiceCounters: Record<string, TerminalInvoiceCounter>;
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
  /**
   * UoM tiers per product id (Phase 2). Carried by the catalog snapshot and
   * always synthesized to at least one base unit per product, so unit-aware
   * cart paths never need existence checks.
   */
  productUnits: ProductUnitsMap;
  /**
   * Parked order currently restored into the cart (Phase 2). Closed against
   * `pos_orders` when its checkout completes; null for a fresh cart.
   */
  activeOrderId: string | null;
  /**
   * Phase 4 (B2B application): the B2B account currently driving cart
   * pricing. When set, every totals/checkout path prices the cart through
   * `withB2BMarkup` using `b2bMarkupPct`; items stay canonical at base
   * prices. Cleared after a completed checkout.
   */
  activeB2BAccountId: string | null;
  /** Display name of the active B2B account (receipt + chip). */
  activeB2BAccountName: string;
  /** Markup percent applied to the whole cart while a B2B account is active. */
  b2bMarkupPct: number;
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
  /**
   * Swap the packaging unit of a cart line (Phase 2 unit chips). Converts the
   * quantity so the physical amount (and roughly the line total) is preserved.
   */
  setLineUnit: (index: number, unitId: string) => void;
  /**
   * Phase 4 (B2B application): attach/detach a B2B account to the cart.
   * Selecting an account applies its default markup to the live totals;
   * detaching reverts them. Pass null to clear.
   */
  setActiveB2BAccount: (account: { id: string; name: string; defaultMarkupPct: number } | null) => void;
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
// v2 (Phase 2): held invoices migrate from the device-local `heldInvoices`
// array into the parked-orders domain (`useOrdersStore` + IDB orders cache).
const POS_PERSIST_VERSION = 2;

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
      productUnits: {} as ProductUnitsMap,
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
    productUnits: cache.productUnits ?? {},
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
    | "productUnits"
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
    // Units are always a full per-product replacement (not a merge): the
    // snapshot is synthesized to cover every product, so stale tiers can
    // never linger after a unit is deleted server-side.
    productUnits: snapshot.productUnits ?? state.productUnits ?? {},
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
    productUnits: cache.productUnits ?? {},
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

/**
 * Terminal-prefixed invoice numbers (رقم الفاتورة). Checkout is offline-first
 * — the receipt prints long before the server ever sees the sale — so each
 * terminal owns a durable local counter and mints `PREFIX-0001` at checkout.
 * Prefixes are unique per terminal, so numbers stay sequential per register
 * and collision-free across registers without any network round-trip.
 */
const TERMINAL_PREFIX_RE = /^T\d{1,4}$/;

/** Resolve (and lazily pin) a stable prefix for the given terminal. */
function resolveTerminalPrefix(
  state: { terminals: Terminal[]; terminalInvoiceCounters?: Record<string, TerminalInvoiceCounter> },
  terminalId: string,
): string {
  const pinned = state.terminalInvoiceCounters?.[terminalId]?.prefix;
  if (pinned) return pinned;
  // Prefer an explicit T#-style terminal name; otherwise derive a stable
  // ordinal from the store's terminal registry (creation order, then id).
  const named = state.terminals
    .find((t) => t.id === terminalId)
    ?.name?.trim()
    .toUpperCase()
    .replace(/\s+/g, "");
  if (named && TERMINAL_PREFIX_RE.test(named)) return named;
  const ordered = [...state.terminals].sort(
    (a, b) => (a.createdAt || "").localeCompare(b.createdAt || "") || a.id.localeCompare(b.id),
  );
  const ordinal = ordered.findIndex((t) => t.id === terminalId);
  return `T${ordinal >= 0 ? ordinal + 1 : 1}`;
}

export function formatTerminalInvoiceNumber(prefix: string, sequence: number): string {
  return `${prefix}-${String(sequence).padStart(4, "0")}`;
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
    activeOrderId: state.activeOrderId,
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
  b2bMarkupPct = 0,
): SaleTotals {
  // Phase 4 (B2B application): totals are always computed from the
  // markup-adjusted view so the header, checkout and sync payload agree.
  return computeSaleTotals(withB2BMarkup(items, b2bMarkupPct), invoiceDiscount, taxPercent, deliveryFee);
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
    productUnits: {},
    activeOrderId: null,
    activeB2BAccountId: null,
    activeB2BAccountName: "",
    b2bMarkupPct: 0,
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
  | { ok: true; payload: LoginPayloadData; username?: string; verifier?: { salt: string; hash: string } }
  | { ok: false; error: string; unauthorized?: boolean };

/**
 * Shape of the `verify_staff_pin` SECURITY DEFINER RPC (migration 078). The
 * roster's PIN hashes never reach the browser; on a successful match the RPC
 * returns the cashier's SAFE profile plus their own verifier so the register
 * can cache the active cashier for offline unlock (cashierSessionCache).
 */
type StaffPinVerification = {
  status: "ok" | "invalid" | "locked" | "account_suspended" | "invalid_store" | "store_suspended";
  cashier?: {
    id: string;
    name: string;
    username: string | null;
    role: string;
    role_id: string | null;
  };
  role?: {
    id: string;
    code: string;
    name: string;
    capabilities: string[] | null;
    limits: Record<string, number | null> | null;
  } | null;
  verifier?: { salt: string; hash: string };
  retry_after_seconds?: number;
};

function staffPinVerificationError(result: StaffPinVerification): string | null {
  switch (result.status) {
    case "account_suspended":
      return "الحساب موقوف — تواصل مع مدير المتجر";
    case "locked": {
      const mins = Math.max(1, Math.ceil((result.retry_after_seconds ?? 60) / 60));
      return `محاولات خاطئة كثيرة — أعد المحاولة بعد ${mins} دقيقة`;
    }
    case "invalid_store":
      return "المتجر غير موجود";
    case "store_suspended":
      return "هذا المتجر موقوف";
    default:
      return null;
  }
}

/**
 * Persists the ACTIVE cashier's offline-unlock material after a successful
 * online verification. Single slot per store — the last verified cashier wins,
 * exactly the scope the business caveat allows.
 */
function writeCashierSessionCache(
  payload: LoginPayloadData,
  verifier: { salt: string; hash: string },
  username: string,
): void {
  if (!verifier.salt || !verifier.hash) return;
  saveCachedCashierSession({
    storeId: payload.store.id,
    storeCode: payload.store.code ?? "",
    username: (username ?? "").trim().toLowerCase(),
    pinHash: verifier.hash,
    pinSalt: verifier.salt,
    store: payload.store,
    cashier: {
      id: payload.cashier.id,
      name: payload.cashier.name,
      role: payload.cashier.role,
      roleId: payload.cashier.roleId,
      roleCode: payload.cashier.roleCode,
      roleName: payload.cashier.roleName,
      capabilities: payload.cashier.capabilities,
      limits: payload.cashier.limits,
    },
    branches: payload.branches ?? [],
    terminals: payload.terminals ?? [],
    defaultBranchId: payload.defaultBranchId ?? null,
    defaultTerminalId: payload.defaultTerminalId ?? null,
    savedAt: new Date().toISOString(),
  });
}

/**
 * Offline /login fallback for the ACTIVE cashier (business caveat: an open
 * shift must survive Wi-Fi loss). Verifies the PIN against the single cached
 * verifier and rebuilds the session entirely from cached safe data. Never
 * succeeds for a different username or the owner account.
 */
function tryOfflineStaffUnlock(
  set: (partial: Partial<PosStore>) => void,
  get: () => PosStore,
  storeCode: string,
  username: string,
  pin: string,
): boolean {
  const cached = findCachedCashierSessionByCode(storeCode);
  if (!cached) return false;
  if ((cached.username || "") !== username.trim().toLowerCase()) return false;
  if (sha256Hex(pin + cached.pinSalt) !== cached.pinHash) return false;
  const profile = cached.cashier;
  if (profile.role === "admin" || profile.role === "مدير") return false;

  applyLoginPayloadToStore(set, get, {
    store: cached.store,
    cashier: {
      id: profile.id,
      name: profile.name,
      role: profile.role,
      roleId: profile.roleId,
      roleCode: profile.roleCode,
      roleName: profile.roleName,
      capabilities: profile.capabilities,
      limits: profile.limits,
    },
    branches: cached.branches,
    terminals: cached.terminals,
    defaultBranchId: cached.defaultBranchId,
    defaultTerminalId: cached.defaultTerminalId,
  });
  set({ notice: { message: "تم فتح الصندوق دون اتصال", tone: "success" } });
  return true;
}

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

  // Migration 078: PIN verification runs inside the verify_staff_pin SECURITY
  // DEFINER RPC — the roster's hash material never reaches the browser.
  const { data: pinData, error: pinError } = await sb.rpc("verify_staff_pin", {
    p_store_id: store.id,
    p_username: input.username?.trim().toLowerCase() || null,
    p_pin: input.pin.trim(),
  });
  if (pinError) throw pinError;
  const pin = (pinData ?? {}) as StaffPinVerification;
  if (pin.status !== "ok" || !pin.cashier) {
    return { ok: false, error: staffPinVerificationError(pin) ?? "بيانات الدخول غير صحيحة", unauthorized: true };
  }
  const cashier = pin.cashier;

  // Role snapshot straight from the RPC (custom staff_roles row when bound,
  // preset fallback otherwise) — same semantics as the previous local build.
  const fallbackRoleCode = normalizeStaffRoleCode(cashier.role);
  const staffRole = {
    id: cashier.role_id,
    code: pin.role ? normalizeStaffRoleCode(pin.role.code) : fallbackRoleCode,
    name: pin.role?.name ?? STAFF_ROLE_PRESETS[fallbackRoleCode].name,
    capabilities:
      Array.isArray(pin.role?.capabilities) && pin.role.capabilities.length > 0
        ? [...pin.role.capabilities]
        : [...STAFF_ROLE_PRESETS[fallbackRoleCode].capabilities],
    limits:
      pin.role?.limits && typeof pin.role.limits === "object"
        ? (pin.role.limits as Record<string, number | null>)
        : { ...STAFF_ROLE_PRESETS[fallbackRoleCode].limits },
  };

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
    username: (cashier.username ?? "").trim().toLowerCase(),
    verifier: pin.verifier,
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
      terminalInvoiceCounters: {},
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
      productUnits: {},
      activeOrderId: null,
      activeB2BAccountId: null,
      activeB2BAccountName: "",
      b2bMarkupPct: 0,

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
        const scannedMeta = get().barcodes[barcode];
        const unitName = scannedMeta?.unitName ?? "حبة";
        const unitMultiplier =
          typeof scannedMeta?.qtyMultiplier === "number" && scannedMeta.qtyMultiplier > 0
            ? scannedMeta.qtyMultiplier
            : 1;
        const product = get().products[lookup.product_id];
        const items = addLine(
          get().items,
          {
            productId: lookup.product_id,
            name: lookup.name,
            barcode,
            variantLabel: lookup.variantLabel ?? scannedMeta?.variantLabel,
            qty: sign,
            unitName,
            unitMultiplier,
            unitId: scannedMeta?.unitId,
            unitPrice: lookup.price,
            taxPercent: product?.taxPercent ?? effectiveTaxPercent(get().currentStore),
            taxIncluded: product?.taxIncluded ?? false,
          },
          sign,
        );

        set({ items, totals: computeTotals(items, get().invoiceDiscount, effectiveTaxPercent(get().currentStore), get().deliveryFee, get().b2bMarkupPct) });
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
        const keyMeta = code ? get().barcodes[code] : undefined;
        const keyMultiplier =
          typeof keyMeta?.qtyMultiplier === "number" && keyMeta.qtyMultiplier > 0
            ? keyMeta.qtyMultiplier
            : 1;
        const items = addLine(
          get().items,
          {
            productId: key.productId,
            name: key.label,
            barcode: code,
            variantLabel: key.variantLabel,
            qty: sign,
            unitName: key.unitName ?? "",
            unitMultiplier: keyMultiplier,
            unitId: keyMeta?.unitId,
            unitPrice,
            taxPercent: key.taxPercent ?? get().products[key.productId]?.taxPercent ?? effectiveTaxPercent(get().currentStore),
            taxIncluded: key.taxIncluded ?? get().products[key.productId]?.taxIncluded ?? false,
          },
          sign,
        );

        set({ items, totals: computeTotals(items, get().invoiceDiscount, effectiveTaxPercent(get().currentStore), get().deliveryFee, get().b2bMarkupPct) });
      },

      addSearchItem: (productId, qty = 1, barcode) => {
        const product = get().products[productId];
        if (!product) return;

        const code = (barcode ?? "").trim();
        let unitPrice = product.price ?? 0;
        let unitName = product.baseUnit ?? "";
        let unitMultiplier = 1;
        let unitId: string | undefined;
        let variantLabel = "";
        if (code) {
          const meta = get().barcodes[code];
          if (meta) {
            unitName = meta.unitName || unitName;
            unitPrice = meta.price ?? unitPrice;
            unitMultiplier =
              typeof meta.qtyMultiplier === "number" && meta.qtyMultiplier > 0
                ? meta.qtyMultiplier
                : 1;
            unitId = meta.unitId;
            variantLabel = meta.variantLabel ?? "";
          }
        }

        // No explicit code: price the line in the product's default-sale unit
        // so the chip row shows a meaningful active tier from the first tap.
        if (!code) {
          const defaultUnit = (get().productUnits[productId] ?? []).find(
            (u) => u.isActive && u.isDefaultSale,
          );
          if (defaultUnit) {
            unitName = defaultUnit.unitName;
            unitPrice = round2(defaultUnit.sellingPrice);
            unitMultiplier = defaultUnit.qtyMultiplier;
            unitId = defaultUnit.id;
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
            unitMultiplier,
            unitId,
            unitPrice,
            taxPercent: product.taxPercent ?? effectiveTaxPercent(get().currentStore),
            taxIncluded: product.taxIncluded ?? false,
          },
          q,
        );

        set({ items, totals: computeTotals(items, get().invoiceDiscount, effectiveTaxPercent(get().currentStore), get().deliveryFee, get().b2bMarkupPct) });
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
        set({ items, totals: computeTotals(items, get().invoiceDiscount, effectiveTaxPercent(get().currentStore), get().deliveryFee, get().b2bMarkupPct) });
      },

      removeItem: (index) => {
        const items = get().items.filter((_, i) => i !== index);
        set({ items, totals: computeTotals(items, get().invoiceDiscount, effectiveTaxPercent(get().currentStore), get().deliveryFee, get().b2bMarkupPct) });
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
          totals: computeTotals(items, get().invoiceDiscount, effectiveTaxPercent(get().currentStore), get().deliveryFee, get().b2bMarkupPct),
          notice: { message: `تمت إضافة صنف سريع: ${trimmed}`, tone: "success" },
        });
      },

      setDeliveryFee: (fee) => {
        const value = Number.isFinite(fee) ? round2(Math.max(0, fee)) : 0;
        set({
          deliveryFee: value,
          totals: computeTotals(get().items, get().invoiceDiscount, effectiveTaxPercent(get().currentStore), value, get().b2bMarkupPct),
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
          // A discarded cart leaves the parked order OPEN (visible again on
          // the board); only checkout closes it.
          activeOrderId: null,
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
        // MEM-2: indexed FAILED-only read — the SUBMITTED history is never
        // deserialized just to find rejections (was a whole-store scan).
        const failed = await getIstdFailedStates(storeId);
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
        const { items } = get();
        if (items.length === 0) {
          set({ notice: { message: "الفاتورة فارغة، لا يمكن تعليقها", tone: "error" } });
          return;
        }
        // Phase 2: parking creates a cross-device LocalOrder (offline-first,
        // mirrored to pos_orders best-effort). The legacy heldInvoices array
        // is no longer written; it stays in persist only for rollback safety.
        const state = get();
        useOrdersStore.getState().createOrder({
          items,
          invoiceDiscount: state.invoiceDiscount,
          deliveryFee: state.deliveryFee,
          customerId: state.activeCustomerId ?? undefined,
          customerName: state.customers.find((c) => c.id === state.activeCustomerId)?.name?.trim() || undefined,
          cashierId: state.currentCashier?.id,
          cashierName: state.currentCashier?.name,
          branchId: state.activeBranchId ?? null,
          terminalId: state.activeTerminalId ?? null,
        });
        set({
          items: [],
          totals: emptyTotals(),
          invoiceDiscount: null,
          deliveryFee: 0,
          notice: { message: "تم تعليق الفاتورة", tone: "success" },
        });
      },

      restoreInvoice: (id) => {
        // Phase 2: restore pulls a parked order back into the cart. The order
        // stays OPEN on other devices until this register's checkout closes
        // it — `activeOrderId` links cart and order for that lifecycle.
        const ordersState = useOrdersStore.getState();
        const order = ordersState.orders.find((o) => o.id === id && o.status === "OPEN");
        if (!order) return;
        if (get().activeOrderId && get().activeOrderId !== id) {
          set({ notice: { message: "توجد فاتورة مستعادة بالفعل في السلة", tone: "error" } });
          return;
        }
        set({
          activeOrderId: order.id,
          activeCustomerId: order.customerId ?? null,
          items: order.items,
          invoiceDiscount: order.invoiceDiscount ?? null,
          deliveryFee: order.deliveryFee ?? 0,
          totals: computeTotals(order.items, order.invoiceDiscount ?? null, effectiveTaxPercent(get().currentStore), order.deliveryFee ?? 0, get().b2bMarkupPct),
          isHoldModalOpen: false,
          notice: { message: "تمت استعادة الفاتورة", tone: "success" },
        });
      },

      setLineUnit: (index, unitId) => {
        const item = get().items[index];
        if (!item) return;
        const unit = (get().productUnits[item.productId] ?? []).find((u) => u.id === unitId);
        if (!unit || !unit.isActive) return;

        // Convert the quantity so the physical amount of product on the line
        // stays constant across the swap (3 cartons ⇄ 36 pieces), then
        // re-price at the target unit. Discount percentage carries over.
        const fromMultiplier =
          typeof item.unitMultiplier === "number" && item.unitMultiplier > 0
            ? item.unitMultiplier
            : 1;
        const toMultiplier =
          typeof unit.qtyMultiplier === "number" && unit.qtyMultiplier > 0
            ? unit.qtyMultiplier
            : 1;
        const convertedQty = round2(
          Math.round(((item.qty * fromMultiplier) / toMultiplier) * 1000) / 1000,
        );
        if (!Number.isFinite(convertedQty) || convertedQty === 0) return;

        const next: SaleItem = {
          ...item,
          qty: convertedQty,
          unitName: unit.unitName,
          unitMultiplier: toMultiplier,
          unitId: unit.id,
          unitPrice: round2(unit.sellingPrice),
        };
        // Reuse the qty-change math so line discounts re-derive identically.
        const items = get().items.map((it, i) =>
          i !== index ? it : applyQtyToLine(next, convertedQty),
        );
        set({ items, totals: computeTotals(items, get().invoiceDiscount, effectiveTaxPercent(get().currentStore), get().deliveryFee, get().b2bMarkupPct) });
      },

      setActiveB2BAccount: (account) => {
        const pct =
          account && Number.isFinite(account.defaultMarkupPct)
            ? Math.max(0, Math.min(500, account.defaultMarkupPct))
            : 0;
        set({
          activeB2BAccountId: account ? account.id : null,
          activeB2BAccountName: account ? account.name : "",
          b2bMarkupPct: pct,
        });
        // Re-price the live cart immediately so the cashier sees the markup
        // land on the header total before checkout opens.
        const { items, invoiceDiscount } = get();
        set({
          totals: computeTotals(items, invoiceDiscount, effectiveTaxPercent(get().currentStore), get().deliveryFee, pct),
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

        // Phase 4 (B2B application): the persisted invoice carries the
        // MARKED-UP line prices so Σ lines == total on the server ledger and
        // the receipt prints what the customer was actually charged. Cart
        // items themselves stay canonical at base prices.
        const b2bMarkupPct = get().b2bMarkupPct;
        const b2bAccountName = get().activeB2BAccountName;
        const saleItems = withB2BMarkup(items, b2bMarkupPct);

        const record: SyncQueueRecord = {
          sync_id: newUuid(),
          action_type: "INVOICE_CREATED",
          payload: {
            items: saleItems,
            b2bAccountName: b2bAccountName || undefined,
            b2bMarkupPct: b2bMarkupPct > 0 ? b2bMarkupPct : undefined,
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
          // SYNC-F1 guard: this IDB put is the point of durability. Once it
          // resolves, the sale IS saved — every step below is success-only
          // bookkeeping and must never surface as "save failed", or the
          // cashier re-rings the sale and both copies mirror (duplicated
          // revenue + double stock deduction).
          await enqueueSync(record);

          // Phase 2: if this checkout settles a restored parked order, close
          // it against pos_orders (best-effort mirror; pendingSync covers
          // offline). Detached from the durability point on purpose — the
          // sale is already saved above no matter what happens here.
          const parkedOrderId = get().activeOrderId;
          if (parkedOrderId) {
            try {
              useOrdersStore.getState().closeWithInvoice(parkedOrderId, record.sync_id);
            } catch (orderCloseError) {
              console.error("Parked-order close failed:", orderCloseError);
            }
          }

          // Pure synchronous derivation first: cannot throw, so the success
          // settlement always has complete data even if a later IDB read/write
          // hiccups.
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
            items: saleItems,
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
            b2bAccountName: b2bAccountName || undefined,
            b2bMarkupPct: b2bMarkupPct > 0 ? b2bMarkupPct : undefined,
            branchId: branchId ?? undefined,
            terminalId: terminalId ?? undefined,
            completed_at: record.payload.completed_at,
          };

          const settleSuccess = () => {
            set({
              items: [],
              totals: emptyTotals(),
              deliveryFee: 0,
              isCheckoutModalOpen: false,
              shiftTotals,
              shiftTransactions,
              lastCompletedInvoice: completedInvoice,
              invoiceDiscount: null,
              returnReference: null,
              isReturnMode: false,
              activeCustomerId: null,
              activeOrderId: null,
              // The B2B pricing context ends with the sale; the next customer
              // starts at base prices.
              activeB2BAccountId: null,
              activeB2BAccountName: "",
              b2bMarkupPct: 0,
              priceMemory: {},
              notice: { message: "تم حفظ الفاتورة محلياً وستتم المزامنة", tone: "success" },
            });
          };

          try {
            const pendingSyncCount = (await getSyncsByStatus("PENDING")).length;

            // P4: learn the customer's prices from the settled invoice. Async
            // IDB writes — never on the render/main-thread path. Anonymous
            // sales short-circuit before any I/O.
            const activeStoreId =
              get().currentStore?.id ?? getTenantStoreId() ?? record.storeId ?? null;
            if (activeStoreId) {
              await upsertPriceMemoryFromPayload(record.payload, activeStoreId);
            }

            settleSuccess();
            set({ pendingSyncCount });
          } catch (postEnqueueError) {
            console.error(
              "Post-enqueue bookkeeping failed; invoice stays durably queued:",
              postEnqueueError,
            );
            settleSuccess();
          }
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
          set({ items, totals: computeTotals(items, get().invoiceDiscount, effectiveTaxPercent(get().currentStore), get().deliveryFee, get().b2bMarkupPct) });
        } else {
          set({
            invoiceDiscount: { ...input },
            totals: computeTotals(get().items, { ...input }, effectiveTaxPercent(get().currentStore), get().deliveryFee, get().b2bMarkupPct),
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
          totals: computeTotals(items, null, effectiveTaxPercent(get().currentStore), get().deliveryFee, get().b2bMarkupPct),
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
          totals: computeTotals(items, null, effectiveTaxPercent(get().currentStore), 0, get().b2bMarkupPct),
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
          totals: computeTotals(items, null, effectiveTaxPercent(get().currentStore), 0, get().b2bMarkupPct),
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
        // Migration 078: production snapshots carry NO hash material (empty
        // pinHash never matches), so this legacy path is test-only; the real
        // offline unlock below uses the active cashier's cached verifier.
        const cashier = state.cashiers.find(
          (c) =>
            c.role !== "admin" &&
            c.role !== "مدير" &&
            c.pinHash === sha256Hex(code + (c.pinSalt ?? state.pinSalt)),
        );
        let unlocked: {
          id: string;
          name: string;
          role: string;
          roleId?: string;
          roleCode?: string;
          roleName?: string;
          capabilities?: string[];
          limits?: Record<string, number | null>;
        } | null = null;
        if (cashier) {
          unlocked = cashier;
        } else {
          // Offline unlock of the ACTIVE cashier only — the single verifier
          // cached by writeCashierSessionCache at the last online login.
          const storeIdForCache = state.currentStore?.id;
          const cached = storeIdForCache
            ? loadCachedCashierSession(storeIdForCache)
            : null;
          if (
            cached &&
            cached.cashier.role !== "admin" &&
            cached.cashier.role !== "مدير" &&
            sha256Hex(code + cached.pinSalt) === cached.pinHash
          ) {
            unlocked = {
              id: cached.cashier.id,
              name: cached.cashier.name,
              role: cached.cashier.role,
              roleId: cached.cashier.roleId,
              roleCode: cached.cashier.roleCode,
              roleName: cached.cashier.roleName,
              capabilities: cached.cashier.capabilities,
              limits: cached.cashier.limits,
            };
          }
        }
        if (!unlocked) {
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
            id: unlocked.id,
            name: unlocked.name,
            role: unlocked.role,
            roleId: unlocked.roleId,
            roleCode: unlocked.roleCode,
            roleName: unlocked.roleName,
            capabilities: unlocked.capabilities,
            limits: unlocked.limits,
            sessionReady: false,
          },
        });
        persistDurablePosState(get());

        // SYNC-F2: re-assert persistent storage on every register unlock.
        // Grants are heuristic and can lapse between OS sessions, and a
        // register signing in is exactly when eviction of the offline
        // queue would hurt most. Fire-and-forget — resolves null (no-op)
        // where the Storage Manager API is unavailable or throws.
        void requestPersistentStorage();

        // Offline unlock remains immediate. When online, verify via the
        // verify_staff_pin RPC and refresh the signed role snapshot (and the
        // active-cashier offline cache) straight from Supabase.
        const storeId = state.currentStore?.id;
        if (storeId) {
          void (async () => {
            const sb = getSupabaseBrowser();
            if (!sb || !isSupabaseBrowserConfigured()) return;
            const result = await resolveStaffLoginPayload(sb, { storeId, pin: code });
            if (!result.ok || get().currentCashier?.id !== unlocked.id) return;
            set({ currentCashier: { ...result.payload.cashier, sessionReady: true } });
            persistDurablePosState(get());
            if (result.ok && result.verifier) {
              writeCashierSessionCache(
                result.payload,
                result.verifier,
                result.username ?? "",
              );
            }
          })().catch(() => undefined);
        }
        return true;
      },

      logoutCashier: () => {
        clearCachedCashierSession(get().currentStore?.id);
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
        const uname = username.trim().toLowerCase();
        if (!storeCode.trim() || !uname || !code) {
          set({
            notice: { message: "أدخل كود المتجر واسم المستخدم ورمز PIN", tone: "error" },
          });
          return false;
        }

        // Migration 078 offline fallback: the LAST ACTIVE cashier of this
        // store can still unlock during an outage (business caveat — open
        // shifts survive Wi-Fi loss). Everyone else must wait for network.
        const tryOffline = (): boolean =>
          tryOfflineStaffUnlock(set, get, storeCode.trim().toUpperCase(), uname, code);

        let sb: NonNullable<ReturnType<typeof getSupabaseBrowser>>;
        {
          const client = getSupabaseBrowser();
          if (!client || !isSupabaseBrowserConfigured()) {
            if (tryOffline()) return true;
            set({ notice: { message: "تعذر الاتصال — تحقق من الشبكة", tone: "error" } });
            return false;
          }
          sb = client;
        }

        try {
          // 1. Resolve the store row by code (needed for the login payload).
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

          // 2. Verify inside the verify_staff_pin SECURITY DEFINER RPC —
          // hash material never reaches the browser (migration 078).
          const { data: pinData, error: pinError } = await sb.rpc("verify_staff_pin", {
            p_store_id: store.id,
            p_username: uname,
            p_pin: code,
          });
          if (pinError) throw pinError;
          const pinResult = (pinData ?? {}) as StaffPinVerification;
          if (pinResult.status !== "ok" || !pinResult.cashier) {
            set({
              notice: {
                message:
                  staffPinVerificationError(pinResult) ?? "بيانات الدخول غير صحيحة",
                tone: "error",
              },
            });
            return false;
          }
          const cashier = pinResult.cashier;

          // 3. Role snapshot from the RPC (custom staff_roles row when bound,
          // preset fallback otherwise).
          const fallbackRoleCode = normalizeStaffRoleCode(cashier.role);
          const staffRole = {
            id: cashier.role_id,
            code: pinResult.role ? normalizeStaffRoleCode(pinResult.role.code) : fallbackRoleCode,
            name: pinResult.role?.name ?? STAFF_ROLE_PRESETS[fallbackRoleCode].name,
            capabilities:
              Array.isArray(pinResult.role?.capabilities) && pinResult.role.capabilities.length > 0
                ? [...pinResult.role.capabilities]
                : [...STAFF_ROLE_PRESETS[fallbackRoleCode].capabilities],
            limits:
              pinResult.role?.limits && typeof pinResult.role.limits === "object"
                ? (pinResult.role.limits as Record<string, number | null>)
                : { ...STAFF_ROLE_PRESETS[fallbackRoleCode].limits },
          };

          // 4. Fetch branches + terminals.
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

          // 5. Build and commit login payload.
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
          if (pinResult.verifier) {
            writeCashierSessionCache(payload, pinResult.verifier, uname);
          }
          applyLoginPayloadToStore(set, get, payload);
          return true;
        } catch (err) {
          if (tryOffline()) return true;
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

          set({ customersLoading: true });

          const localCatalogPromise = loadCatalogCache(storeId).catch((err) => {
            console.error("Failed to read catalog cache:", err);
            return null;
          });
          const localCustomersPromise = loadCustomersCache(storeId).catch((err) => {
            console.error("Failed to read customers cache:", err);
            return null;
          });
          const remoteCatalogPromise = fetchCatalogSnapshot(storeId).catch((err) => {
            console.error("Failed to load catalog snapshot:", err);
            return null;
          });
          const remoteCustomersPromise = fetchCustomersPayload(storeId).catch((err) => {
            console.error("Failed to load customers:", err);
            return null;
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

          if (remoteCatalog.status === "fulfilled" && remoteCatalog.value) {
            catalogOnline = true;
            const snapshot = remoteCatalog.value;
            if (snapshot.updatedAt !== get().catalogUpdatedAt) {
              await saveCatalogCache(
                {
                  storeId,
                  categories: snapshot.categories,
                  products: snapshot.products,
                  barcodes: snapshot.barcodes,
                  barcodeIndex: snapshot.barcodeIndex,
                  productUnits: snapshot.productUnits,
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
            // Remember the server's change stamp for whichever snapshot we
            // just converged on, so stamp polling only re-hydrates on real
            // drift (never on our own echo). Best-effort; failure is fine.
            void fetchCatalogStamp(storeId)
              .then((version) => rememberCatalogStamp(storeId, version))
              .catch(() => undefined);
          }

          if (remoteCustomers.status === "fulfilled" && remoteCustomers.value) {
            const data = remoteCustomers.value;
            const customers = normalizeCustomers(data.customers);
            const updatedAt = data.updatedAt || `remote:${Date.now()}`;
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

          if (action.type === "save_istd") {
            // JoFotara device credentials (migration 079): the write happens
            // inside the Edge Function behind the admin password proof; the
            // secret never round-trips through this bundle.
            const sessionI = get().adminSession;
            if (!sessionI) return false;
            try {
              await updateTaxSettings(action.fields, sessionI.email, password);
              set({ isSecondaryAuthOpen: false, pendingSecondaryAction: null });
              return true;
            } catch (err) {
              set({
                notice: {
                  message:
                    err instanceof Error && err.message
                      ? err.message
                      : "تعذر حفظ بيانات الفوترة",
                  tone: "error",
                },
              });
              return false;
            }
          }

          if (action.type === "save_settings") {
            // Owner email is the login identity on BOTH stores + cashiers —
            // it only moves through admin_update_owner_email with a password
            // proof (migration 078). Everything else is a plain stores write.
            const sbS = getSupabaseBrowser();
            const sessionS = get().adminSession;
            const storeIdS = get().currentStore?.id;
            const fields = action.fields;
            const nextEmail =
              typeof fields.email === "string" ? fields.email.trim().toLowerCase() : "";
            try {
              if (!sbS || !sessionS || !storeIdS) {
                set({ notice: { message: "Supabase غير مُعد", tone: "error" } });
                return false;
              }
              if (nextEmail) {
                const { data: emailData, error: emailError } = await sbS.rpc(
                  "admin_update_owner_email",
                  {
                    p_store_id: storeIdS,
                    p_admin_email: sessionS.email,
                    p_admin_password: password,
                    p_new_email: nextEmail,
                  },
                );
                if (emailError) {
                  set({ notice: { message: emailError.message ?? "تعذر تحديث البريد الإلكتروني", tone: "error" } });
                  return false;
                }
                const emailResult = (emailData ?? {}) as { error?: string };
                if (
                  emailResult.error === "invalid_admin_credentials" ||
                  emailResult.error === "locked"
                ) {
                  set({ notice: { message: "كلمة المرور غير صحيحة", tone: "error" } });
                  return false;
                }
                if (emailResult.error === "duplicate_email") {
                  set({ notice: { message: "هذا البريد الإلكتروني مستخدم مسبقاً", tone: "error" } });
                  return false;
                }
                if (emailResult.error === "invalid_email") {
                  set({ notice: { message: "البريد الإلكتروني غير صالح", tone: "error" } });
                  return false;
                }
                if (emailResult.error) {
                  set({ notice: { message: "تعذر تحديث البريد الإلكتروني", tone: "error" } });
                  return false;
                }
                // Keep future password proofs working: the session email just
                // became the login identity.
                if (get().adminSession) get().setAdminSessionEmail(nextEmail);
              }
              await updateSettings({ ...fields, email: undefined });
              set({ isSecondaryAuthOpen: false, pendingSecondaryAction: null });
              return true;
            } catch {
              set({ notice: { message: "تعذر الاتصال — تحقق من الشبكة", tone: "error" } });
              return false;
            }
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
            get().b2bMarkupPct,
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

          // Migration 078: the admin password proof and the write are folded
          // into one SECURITY DEFINER RPC (proof-per-call). No direct table
          // DML, no client-side PIN hashing — the server salts + hashes.
          const baseArgs = {
            p_store_id: storeId,
            p_admin_email: session.email,
            p_admin_password: password,
          };
          const { data, error: rpcError } = draft.id
            ? await sb.rpc("admin_update_cashier", {
                ...baseArgs,
                p_cashier_id: draft.id,
                p_name: draft.name ?? null,
                p_username: draft.username ?? null,
                p_role: draft.role ?? null,
                p_role_id: draft.roleId || null,
                p_is_active: draft.isActive ?? null,
                p_pin: draft.pin ? String(draft.pin) : null,
              })
            : await sb.rpc("admin_create_cashier", {
                ...baseArgs,
                p_name: draft.name,
                p_role: normalizeStaffRoleCode(draft.role),
                p_username:
                  draft.username?.trim().toLowerCase() ||
                  draft.name.trim().replace(/[^\p{L}\p{N}_\-\. ]/gu, "").toLowerCase() ||
                  "user",
                p_role_id: draft.roleId || null,
                p_pin: draft.pin ? String(draft.pin) : null,
                p_is_active: draft.isActive !== false,
              });
          if (rpcError) {
            set({ notice: { message: rpcError.message ?? "تعذر حفظ الموظف", tone: "error" } });
            return false;
          }
          const result = (data ?? {}) as { error?: string; message?: string };
          if (result.error === "invalid_admin_credentials" || result.error === "locked") {
            set({ notice: { message: "كلمة المرور غير صحيحة", tone: "error" } });
            return false;
          }
          if (result.error === "duplicate_username") {
            set({ notice: { message: "اسم المستخدم مستخدم مسبقاً", tone: "error" } });
            return false;
          }
          if (result.error === "not_found") {
            set({ notice: { message: "الموظف غير موجود", tone: "error" } });
            return false;
          }
          if (result.error) {
            set({ notice: { message: result.message ?? "تعذر حفظ الموظف", tone: "error" } });
            return false;
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

          // Migration 078: proof-per-call delete RPC. The admin check and the
          // admin-target guard live inside the function now.
          const { data, error: rpcError } = await sb.rpc("admin_delete_cashier", {
            p_store_id: storeId,
            p_admin_email: session.email,
            p_admin_password: password,
            p_cashier_id: id,
          });
          if (rpcError) {
            set({ notice: { message: rpcError.message ?? "تعذر حذف الموظف", tone: "error" } });
            return false;
          }
          const result = (data ?? {}) as { error?: string };
          if (result.error === "invalid_admin_credentials" || result.error === "locked") {
            set({ notice: { message: "كلمة المرور غير صحيحة", tone: "error" } });
            return false;
          }
          if (result.error === "cannot_delete_admin") {
            set({ notice: { message: "لا يمكن حذف حساب مدير المتجر", tone: "error" } });
            return false;
          }
          if (result.error === "not_found") {
            set({ notice: { message: "الموظف غير موجود", tone: "error" } });
            return false;
          }
          if (result.error) {
            set({ notice: { message: "تعذر حذف الموظف", tone: "error" } });
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
            get().b2bMarkupPct,
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
          // The B2B pricing context is register-scoped: it survives tab
          // switches and re-prices whichever cart becomes active.
          totals: computeTotals(target.items, target.invoiceDiscount, taxPercent, target.deliveryFee, get().b2bMarkupPct),
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
          totals: computeTotals([], null, effectiveTaxPercent(currentStore), 0, get().b2bMarkupPct),
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
          totals: computeTotals(target.items, target.invoiceDiscount, taxPercent, target.deliveryFee, get().b2bMarkupPct),
        });
      },
    }),
    {
      name: POS_PERSIST_NAME,
      version: POS_PERSIST_VERSION,
      storage: createPosPersistStorage<ReturnType<typeof partializePosState>>(),
      partialize: partializePosState,
      migrate: async (persisted, version) => {
        const state = persisted as ReturnType<typeof partializePosState>;
        if (!state || version >= POS_PERSIST_VERSION) return state;
        // v1→v2 (Phase 2): device-local held invoices migrate into the
        // parked-orders domain as OPEN LocalOrders seeded into the IDB
        // orders cache. The legacy array is emptied so the two systems can
        // never double-show the same cart.
        const legacy = state.heldInvoices;
        if (Array.isArray(legacy) && legacy.length > 0) {
          const storeId = state.currentStore?.id ?? getTenantStoreId();
          if (storeId) {
            const orders = legacy.map((held) => heldInvoiceToOrder(held, storeId));
            try {
              await saveOrdersCache(
                { storeId, orders, updatedAt: new Date().toISOString() },
                storeId,
              );
            } catch {
              // Cache unavailable — the sweep below still returns the drained
              // state; orders re-seed on the next successful cache write.
            }
          }
        }
        return { ...state, heldInvoices: [] };
      },
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
