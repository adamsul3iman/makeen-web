/**
 * Local-First POS state schemas.
 *
 * These types describe the in-memory / IndexedDB snapshot used for
 * O(1) lookups at the point of sale. The shape is deliberately
 * denormalized (id maps + barcode index) so a scan of a barcode or a
 * category tap never requires a filter or a join.
 *
 * Numeric quantities are represented as `number` with the same
 * precision contract as the DB: prices at 2 decimals, multipliers at 3.
 */

/** Display unit string, e.g. "kg", "piece", "box", "pack". */
export type UnitName = string;

/** Quantity multiplier of a package relative to the base unit (e.g. box = 12 pieces). */
export type QtyMultiplier = number;

/** Price / cost in the store currency, 2-decimal precision. */
export type Money = number;

/** Accepted payment methods at checkout. */
export type PaymentMethod = "CASH" | "VISA" | "SPLIT" | "DEBT" | "CLIQ";

export interface LocalCategory {
  id: string;
  name: string;
  parentId: string | null;
  bgColor: string | null;
  isQuickKey: boolean;
  sortOrder: number;
  showInPos?: boolean;
}

/** O(1) category lookup, keyed by category id. */
export type CategoryMap = Record<string, LocalCategory>;

/** Quick-key button definition rendered on the POS landing screen. */
export interface QuickKeyItem {
  id: string;
  categoryId: string;
  label: string;
  bgColor: string;
  sortOrder: number;
  /** Product added when the key is pressed (quick-add keys). */
  productId?: string;
  /** Unit label shown on the added line item. */
  unitName?: UnitName;
  /** Unit price used when adding the line item. */
  price?: Money;
  /** Barcode of the explicit default sale package. */
  barcode?: string;
  /** Optional flavor, scent, color, or other barcode-level variation. */
  variantLabel?: string;
  /** VAT policy copied from the product at catalog hydration time. */
  taxPercent?: number;
  taxIncluded?: boolean;
  /** Brand / manufacturer id for 3-level category→brand→product drill-down. */
  brandId?: string;
  /** Resolved brand name at catalog hydration time. */
  brandName?: string;
  /** Whether this product is marked as a quick key for the Speed Dock. */
  isQuickKey?: boolean;
}

/** Ordered array of quick-key buttons, already sorted by sortOrder. */
export type QuickKeyItemList = QuickKeyItem[];

export interface LocalProduct {
  id: string;
  categoryId: string;
  name: string;
  baseUnit: UnitName;
  isWeighed: boolean;
  /** Retail price of one base unit (from parent product selling_price). */
  price: Money;
  /** Default cost used for margin calculations (from parent product cost_price). */
  costPrice: Money;
  /** Wholesale price from parent product. */
  wholesalePrice?: Money;
  /** Warehouse stock count — aggregate of all variant stocks. */
  totalStock?: number;
  brandId?: string;
  brandName?: string;
  supplierId?: string;
  supplierName?: string;
  taxPercent?: number;
  taxIncluded?: boolean;
  isActive?: boolean;
  showInPos?: boolean;
  isSellable?: boolean;
  isPurchasable?: boolean;
  allowPriceChange?: boolean;
  /** Minimum stock threshold: when `totalStock <= reorderLevel` the product
   *  appears on the shortage radar. Defaults to 0 (no auto-flagging). */
  reorderLevel?: number;
  /** Target stock level: `idealStockLevel - totalStock` = suggested order qty. */
  idealStockLevel?: number;
}

/** O(1) product lookup, keyed by product id. */
export type ProductMap = Record<string, LocalProduct>;

export interface LocalBarcode {
  barcode: string;
  productId: string;
  /** Reference to the product_variants row. */
  variantId: string;
  /** Flavor/scent/color label (required — every variant has one). */
  variantLabel: string;
  unitName: UnitName;
  qtyMultiplier: QtyMultiplier;
  /** Retail price (denormalized from parent product selling_price). */
  price: Money;
  /** Cost price (denormalized from parent product cost_price). */
  costPrice: Money;
  wholesalePrice?: Money;
  isDefaultSale?: boolean;
  isDefaultPurchase?: boolean;
  /** Set when this entry is a package unit (product_units row). */
  unitId?: string;
  /** Per-variant stock in base pieces (absent for unit barcodes). */
  totalStock?: number;
}

/** O(1) barcode metadata lookup, keyed by barcode string. */
export type BarcodeMap = Record<string, LocalBarcode>;

/**
 * Denormalized hot-path entry stored on every barcode scan.
 * Contains exactly what the checkout needs to add a line item
 * without dereferencing the product map.
 */
export interface BarcodeLookup {
  product_id: string;
  variantId: string;
  name: string;
  price: number;
  variantLabel: string;
  /** Selling unit label for the scanned code (base unit when absent). */
  unitName?: string;
  /** Pieces per scanned unit (1/undefined = base unit). */
  qtyMultiplier?: QtyMultiplier;
  /** Owning product_units row for package barcodes (absent for variants). */
  unitId?: string;
  /** Per-variant stock in base pieces (absent for unit barcodes). */
  totalStock?: number;
}

/**
 * O(1) scan index: barcode string -> line-item payload.
 * This is the primary structure consumed by the barcode-input handler.
 */
export type BarcodeIndex = Record<string, BarcodeLookup>;

/**
 * A sellable packaging unit (UoM tier) of a product, mirrored from the
 * `product_units` table (migration 080). Stock stays on variants in base
 * pieces; a unit only re-prices and re-scales the sold quantity.
 */
export interface LocalUnit {
  id: string;
  productId: string;
  /** Display label, e.g. "حبة", "كرتون", "علبة". */
  unitName: UnitName;
  /** Pieces per one of this unit (>0). Base piece = 1. */
  qtyMultiplier: QtyMultiplier;
  costPrice: Money;
  sellingPrice: Money;
  wholesalePrice?: Money;
  /** Barcode of the package itself (unique per store when present). */
  barcode?: string;
  isDefaultSale: boolean;
  isActive: boolean;
  sortOrder: number;
}

/** O(1) units lookup keyed by product id. */
export type ProductUnitsMap = Record<string, LocalUnit[]>;

/** Scope of a discount entry: the whole invoice or a single line item. */
export type DiscountScope = "TOTAL" | "ITEM";

/** Discount expressed as a percentage of the base or a fixed money amount. */
export type DiscountType = "PERCENT" | "FIXED";

/** User input describing a discount to apply at checkout. */
export interface DiscountInput {
  scope: DiscountScope;
  /** Line index when scope is ITEM. */
  index?: number;
  type: DiscountType;
  value: number;
}

  /** A line item on the current sale. Qty/lineTotal may be negative in Return Mode. */
export interface SaleItem {
  productId: string;
  name: string;
  barcode: string;
  /** Barcode-level variation such as flavor or scent. */
  variantLabel?: string;
  qty: number;
  unitName: UnitName;
  /**
   * Pieces per sold unit (pack/carton multiplier relative to the base unit).
   * Base units are 1 / undefined; stock is always consumed in base pieces.
   */
  unitMultiplier?: QtyMultiplier;
  /** The packaging unit this line is priced in (product_units.id). */
  unitId?: string;
  unitPrice: Money;
  lineTotal: Money;
  /** Fixed-money discount applied to this line (0 when none). lineTotal is net of it. */
  discount?: Money;
  /** Percentage used to compute the line discount (display only). */
  discountPct?: number;
  /** VAT rate fixed onto the line when it enters the cart. */
  taxPercent?: number;
  /** True when unitPrice already includes VAT. */
  taxIncluded?: boolean;
}

/**
 * A registered cashier who can unlock the register with a 4-digit PIN.
 * The snapshot carries only a salted SHA-256 of the PIN so plaintext
 * credentials never reach the client/wire. Since F3 the salt is random per
 * cashier (never a public constant), so a leaked snapshot cannot be
 * brute-forced with one shared table and every cashier needs separate work.
 */
export interface Cashier {
  id: string;
  name: string;
  /** hex sha256(`pin + pinSalt`). */
  pinHash: string;
  /** Random per-cashier salt. Optional for backwards-compatible cached snapshots. */
  pinSalt?: string;
  role: string;
  roleId?: string;
  roleCode?: string;
  roleName?: string;
  /** Signed server role snapshot used for offline UI decisions. */
  capabilities?: string[];
  /** Operational ceilings; sensitive actions still follow approval policy. */
  limits?: Record<string, number | null>;
}

/** Cached customer ledger row used by the POS checkout comboboxes. */
export interface PosCustomer {
  id: string;
  name: string;
  phone: string;
  balance: number;
}

/**
 * The store-owner session established by the dashboard email/password login.
 * Scopes the POS PIN pad to exactly one store — there is no tenant dropdown.
 */
export interface AdminSession {
  storeId: string;
  email: string;
  name: string;
}

/** Subscription lifecycle of a SaaS tenant. */
export type SubscriptionStatus = "active" | "suspended";

/** A multi-tenant store (متجر) that owns a fully isolated data partition. */
export interface Store {
  id: string;
  /** Short human-friendly tenant code used by the mobile camera login. */
  code?: string;
  name: string;
  ownerName: string;
  email: string;
  phone: string;
  subscriptionStatus: SubscriptionStatus;
  /** URL of the logo printed on receipts (empty = no logo). */
  logoUrl?: string;
  /** Store address shown on receipts + the settings page. */
  address?: string;
  /** Custom message printed above the item list on receipts. */
  receiptHeader?: string;
  /** Custom message printed at the bottom of receipts. */
  receiptFooter?: string;
  /** Loyalty program switch; false hides points features for this store. */
  loyaltyEnabled?: boolean;
  /** Currency spent to earn 1 loyalty point (default 1). */
  pointsPerSpend?: number;
  /** Currency value of 1 loyalty point on redemption (default 0.01). */
  pointValue?: number;
  /** VAT percentage applied at checkout (0 = tax-free). */
  taxPercent?: number;
  /** Fiscal/tax identification number printed in the Smart QR code. */
  taxNumber?: string;
  /** Receipt customization — show/hide the tax number line (default on). */
  receiptShowTaxNumber?: boolean;
  /** Receipt customization — show/hide cashier name + exact timestamp (default on). */
  receiptShowCashierTime?: boolean;
  /** Receipt customization — show/hide the footer barcode + fiscal QR (default on). */
  receiptShowBarcodeQr?: boolean;
  /** Receipt customization — compact (vs standard) vertical spacing (default off). */
  receiptCompactSpacing?: boolean;
}

/** Slim tenant row shown on the login store picker. */
export interface StoreSummary {
  id: string;
  name: string;
  subscriptionStatus: SubscriptionStatus;
}

/** A physical location (فرع) owned by a store. */
export interface Branch {
  id: string;
  storeId: string;
  name: string;
  createdAt: string;
}

/** A cash register (كاشير) inside a branch with its own drawer + shift. */
export interface Terminal {
  id: string;
  branchId: string;
  name: string;
  createdAt: string;
}

/**
 * Durable per-terminal invoice counter state. Each register owns a local
 * sequence so receipts stay sequential and readable (T1-0001) while fully
 * offline; distinct prefixes keep numbers collision-free across terminals.
 */
export interface TerminalInvoiceCounter {
  /** Stable prefix derived from the terminal identity (e.g. "T1"). */
  prefix: string;
  /** Last issued sequence number for this terminal. */
  last: number;
}

/** Auto-calculated money totals for the current invoice. */
export interface SaleTotals {
  subtotal: Money;
  tax: Money;
  discount: Money;
  /** Optional delivery surcharge added to `total` after tax (not a line item). */
  deliveryFee: Money;
  total: Money;
  /** Total unit count across all line items. */
  itemCount: number;
}

/** Immutable-ish snapshot of the current checkout. */
export interface SaleState {
  items: SaleItem[];
  subtotal: Money;
  discount: Money;
  total: Money;
  paidAmount: Money;
}

/**
 * The fully-settled invoice that just completed. Kept until the thermal
 * receipt has been printed, then cleared. Drives the print template.
 */
export interface CompletedInvoice {
  syncId: string;
  shiftId: string;
  items: SaleItem[];
  subtotal: Money;
  tax: Money;
  discount: Money;
  /** Delivery surcharge applied at checkout (0 when none). */
  deliveryFee?: Money;
  total: Money;
  paymentMethod: PaymentMethod;
  amountPaid: Money;
  change: Money;
  /** Printed on receipts when the invoice is assigned to a customer. */
  customerName?: string;
  /** Resolved customer ledger id (when the invoice is assigned). */
  customerId?: string;
  /** Phone captured at checkout for the assigned customer. */
  customerPhone?: string;
  /** Cashier who completed the sale; printed on the receipt. */
  cashierName?: string;
  /** True when this document is a debt settlement voucher (سند قبض), not a sale. */
  isSettlement?: boolean;
  /**
   * Human-readable terminal-scoped number minted at checkout (e.g. T1-0007).
   * Printed on the receipt; absent for legacy/unsynced documents, which fall
   * back to the UUID-derived reference.
   */
  invoiceNumber?: string;
  /** Invoice id this document reverses (secure returns). Printed on the receipt. */
  originalInvoiceId?: string;
  /**
   * Phase 4 (B2B application): the B2B account this sale was priced for.
   * Line prices already include the markup; these are printed for clarity.
   */
  b2bAccountName?: string;
  b2bMarkupPct?: number;
  /** Branch/terminal that settled this invoice (printed on receipts). */
  branchId?: string;
  terminalId?: string;
  /** Official ISTD/JoFotara clearance UUID, when the invoice was cleared. */
  istdUuid?: string;
  /** Official ISTD/JoFotara QR payload, when the invoice was cleared. */
  istdQr?: string;
  completed_at: string;
}

/** An invoice parked mid-sale to be resumed later. */
export interface HeldInvoice {
  id: string;
  created_at: string;
  items: SaleItem[];
  total: Money;
  /** Invoice-level discount active when the invoice was parked. */
  invoiceDiscount?: DiscountInput | null;
  /** Delivery fee active when the invoice was parked. */
  deliveryFee?: Money;
}

/** Lifecycle state of the register's cash shift (وردية). */
export type ShiftStatus = "OPEN" | "CLOSED";

/**
 * Persisted register state for the current shift. Survives page
 * reloads so a mid-shift refresh cannot lose the drawer balance.
 */
export interface ShiftState {
  status: ShiftStatus;
  shiftId: string | null;
  startTime: string | null;
  /** Opening cash declared when the shift started (العهدة). */
  startingCash: Money;
  /** Branch the shift belongs to (null on legacy/no-selection devices). */
  branchId: string | null;
  /** Terminal whose drawer this shift runs (null on legacy devices). */
  terminalId: string | null;
}

/** Aggregated sales figures for the currently open shift. */
export interface ShiftTotals {
  /** Net cash taken into the drawer this shift (refunds are negative). */
  cashSales: Money;
  /** Card portion of all invoices this shift. */
  visaSales: Money;
  /** CliQ instant-transfer portion of all invoices this shift. */
  cliqSales: Money;
  /** Value of invoices settled on credit (ذمم); never enters the drawer. */
  debtSales: Money;
  /** Cash collected from customers settling their debts (سداد الذمم). */
  debtCollections: Money;
  /** Cash + card + debt across all settled invoices. */
  totalSales: Money;
  /** Invoice-level discounts granted this shift. */
  discounts: Money;
  /** Absolute value of returned-goods invoices this shift. */
  returns: Money;
  /** Petty cash paid out of the drawer this shift (المصروفات). */
  expenses: Money;
  /** startingCash + cashSales + cashIn − cashOut − expenses + debtCollections. */
  expectedCashInDrawer: Money;
  /** Manual cash additions to the drawer (إيداعات). */
  cashInTotal: Money;
  /** Manual cash removals from the drawer (سحوبات يدوية). */
  cashOutTotal: Money;
  /** = visaSales — expected card total from the terminal. */
  expectedCard: Money;
  /** Actual terminal total entered by the cashier. */
  actualCard: Money;
  /** actualCard − expectedCard. */
  cardVariance: Money;
  /** = cliqSales — expected CliQ total. */
  expectedCliq: Money;
  /** Actual CliQ total entered by the cashier. */
  actualCliq: Money;
  /** actualCliq − expectedCliq. */
  cliqVariance: Money;
  /** Number of times the cash drawer was opened during the shift. */
  drawerOpenCount: number;
  /** True when any variance (cash, card, or cliq) is non-zero. */
  hasDiscrepancy: boolean;
  /** Dropdown reason for the discrepancy. */
  discrepancyReason: string;
  /** Free-text note explaining the discrepancy. */
  discrepancyNote: string;
}

/** One settled invoice attributed to the open shift. */
export interface ShiftTransaction {
  syncId: string;
  shiftId: string;
  paymentMethod: PaymentMethod;
  /** Invoice total (cash + card portions). */
  total: Money;
  /** Net cash actually taken into the drawer for this invoice. */
  cashPortion: Money;
  completed_at: string;
}

/** Payload persisted to the sync queue when a shift opens. */
export interface ShiftOpenedPayload {
  shiftId: string;
  startTime: string;
  startingCash: Money;
  openedAt: string;
  branchId?: string;
  terminalId?: string;
  cashierId?: string;
  cashierName?: string;
}

/** Payload persisted to the sync queue when a shift closes (Z-report). */
export interface ShiftClosedPayload {
  shiftId: string;
  startTime: string;
  closeTime: string;
  startingCash: Money;
  cashSales: Money;
  visaSales: Money;
  cliqSales: Money;
  debtSales: Money;
  debtCollections: Money;
  totalSales: Money;
  discounts: Money;
  returns: Money;
  expenses: Money;
  expectedCashInDrawer: Money;
  actualCash: Money;
  variance: Money;
  /** Manual cash additions total (إيداعات). */
  cashInTotal: Money;
  /** Manual cash removals total (سحوبات يدوية). */
  cashOutTotal: Money;
  /** Expected card from ledger (= visaSales). */
  expectedCard: Money;
  /** Actual terminal receipt total entered by cashier. */
  actualCard: Money;
  /** actualCard − expectedCard. */
  cardVariance: Money;
  /** Expected CliQ from ledger (= cliqSales). */
  expectedCliq: Money;
  /** Actual CliQ total entered by cashier. */
  actualCliq: Money;
  /** actualCliq − expectedCliq. */
  cliqVariance: Money;
  /** Number of drawer opens during the shift. */
  drawerOpenCount: number;
  /** Reason for discrepancy (empty if none). */
  discrepancyReason: string;
  /** Note explaining the discrepancy (empty if none). */
  discrepancyNote: string;
  branchId?: string;
  terminalId?: string;
  cashierId?: string;
  cashierName?: string;
}

/** Payload persisted to the sync queue when a customer settles a debt. */
export interface DebtSettlementPayload {
  shiftId: string;
  customerId?: string;
  customerName: string;
  amount: Money;
  completed_at: string;
  branchId?: string;
  terminalId?: string;
}

/** Payload persisted to the sync queue when a drawer expense is recorded. */
export interface ExpenseRecordedPayload {
  expenseId: string;
  cashierId: string | null;
  cashierName?: string;
  category: string;
  amount: Money;
  notes?: string;
  shiftId: string;
  created_at: string;
  branchId?: string;
  terminalId?: string;
}

/** Type of manual cash drawer movement. */
export type CashMovementType = "CASH_IN" | "CASH_OUT";

/** A manual cash movement (deposit or withdrawal) during the active shift. */
export interface CashMovement {
  id: string;
  shiftId: string;
  type: CashMovementType;
  amount: Money;
  reason: string;
  notes: string;
  cashierId: string | null;
  cashierName: string;
  branchId: string | null;
  terminalId: string | null;
  createdAt: string;
}

/** Payload persisted to the sync queue for a manual cash drawer movement. */
export interface CashMovementPayload {
  movementId: string;
  shiftId: string;
  type: CashMovementType;
  amount: Money;
  reason: string;
  notes: string;
  cashierId: string | null;
  cashierName: string;
  created_at: string;
  branchId?: string;
  terminalId?: string;
}

/**
 * A manually-flagged shortage raised from the register. The POS pushes the
 * item into the shortages radar even when system stock says otherwise, so the
 * admin dashboard sees cashier-reported stockouts immediately.
 */
export interface ShortageFlag {
  id: string;
  productId: string;
  productName: string;
  /** Stock the cashier saw when flagging (system stock at flag time). */
  currentStock: number;
  reason?: string;
  cashierId?: string;
  cashierName?: string;
  /** YYYY-MM-DDTHH:mm:ss.sssZ */
  createdAt: string;
  /** True when the owner marked the shortage as handled. */
  resolved: boolean;
  resolvedAt?: string;
  resolvedBy?: string;
}

/** Payload of a `SHORTAGE_FLAGGED` event queued for background sync. */
export interface ShortageFlaggedPayload {
  productId: string;
  productName: string;
  currentStock: number;
  reason?: string;
  cashierId?: string;
  cashierName?: string;
  created_at: string;
  branchId?: string;
  terminalId?: string;
}

/**
 * Full offline snapshot persisted to IndexedDB.
 * Loaded once at boot into memory, mutated locally, and synced
 * to Supabase in the background.
 */
export interface PosSnapshot {
  schemaVersion: number;
  /** Deterministic catalog version stamp used for cache invalidation. */
  updatedAt: string;
  categories: CategoryMap;
  /** Normalized manufacturer/brand directory for back-office product forms. */
  brands?: Record<string, { id: string; name: string }>;
  suppliers?: Record<string, { id: string; name: string }>;
  products: ProductMap;
  /** Variant-level barcode data keyed by variant id (product_variants.id). */
  variants?: Record<string, LocalBarcode>;
  /** Legacy barcode map keyed by barcode string. */
  barcodes: BarcodeMap;
  /** Derived from barcodes/variants, kept in sync on every mutation. */
  barcodeIndex: BarcodeIndex;
  /** UoM tiers per product id (absent in pre-units snapshots). */
  productUnits?: ProductUnitsMap;
  /** Derived from `categories` where isQuickKey is true, sorted. */
  quickKeys: QuickKeyItem[];
  /** Cashier accounts used to unlock the register (PINs as salted hashes). */
  cashiers: Cashier[];
  /** Salt appended to a cashier PIN before hashing (non-secret, per-store). */
  pinSalt: string;
}
