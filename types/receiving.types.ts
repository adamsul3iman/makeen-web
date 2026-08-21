/**
 * Goods-In / Smart Receiving schemas (Phase 3).
 *
 * The receiving flow scans items into a draft `supplier_invoice`, then on
 * "Commit" pushes an event through the offline-first sync queue that mirrors
 * into supplier_invoices / supplier_invoice_items / supplier_payments,
 * applies PURCHASE_RECEIPT stock, updates vendor payables, and — when cash was
 * paid out of the register — records a linked drawer deduction against the
 * open shift so the cashier's Z-report never shows a shortfall.
 */

/** Money with the project's 2-decimal precision contract. */
export type ReceivingMoney = number;

/** Payment methods the payment center can split an invoice across. */
export type PaymentMethod = "CASH" | "BANK" | "CARD" | "CLIQ" | "WALLET";

/** One payment-center line: a method and the amount paid with it. */
export interface ReceivingPayment {
  /** Draft-unique key. */
  key: string;
  method: PaymentMethod;
  amount: number;
}

/** A selectable unit for a receiving line (base + pack when known). */
export interface ReceivingLineUnit {
  /** Base-unit multiplier (1 = base unit, 12 = a 12-pack). */
  multiplier: number;
  /** Display label (e.g. "عبوة" / "كرتونة"). */
  name: string;
}

/**
 * One draft line being received. `productId` is null for Quick-Add items
 * (unknown barcode → the SKU is generated and the product is created on the
 * server mirror before the invoice/stock rows land).
 */
export interface ReceivingDraftLine {
  /** Draft-unique key (the barcode / internal SKU). */
  key: string;
  /** Resolved catalog product id when the barcode is known. */
  productId: string | null;
  /** Scanned barcode or generated internal SKU (used as the mirror barcode). */
  barcode: string;
  /** Display name. For new products this is the parent product name. */
  description: string;
  /** Base-unit quantity being received. */
  quantity: number;
  /** Entered unit cost (the negotiable number on the shield). */
  unitCost: number;
  /** VAT percent applied to this line (store default when quick-added). */
  taxPercent: number;
  /** Base-unit label. */
  baseUnit: string;
  /** Mirror must update the parent product's cost_price to `unitCost`. */
  applyCost: boolean;
  /**
   * Retail price accepted after the "update retail price to maintain margin?"
   * prompt (null = keep the current retail). Mirror writes it to
   * the parent product's selling_price.
   */
  newRetailPrice: number | null;
  /** True when the line came from Quick Add (needs product creation). */
  isNewProduct: boolean;
  /** True once the user dismissed the "update retail price?" prompt. */
  retailPromptDismissed?: boolean;
  /**
   * Selected unit multiplier for this line (pack = barcode qtyMultiplier,
   * base = 1). Quantity and unitCost are entered in this unit; helpers convert
   * them back to base for the shield, stock, and price sync.
   */
  multiplier?: number;
  /** Selected unit label (defaults to the base unit). */
  unitName?: string;
  /** Units this line can toggle between (base + pack when known). */
  units?: ReceivingLineUnit[];
  /** Catalog retail seeded on scan — the margin-floor guard reference. */
  currentRetail?: number;
  /** Catalog cost seeded on scan. */
  currentCost?: number;
  /** User confirmed the below-floor margin (commit is then allowed). */
  marginOverride?: boolean;
  // ── 4-Tier Architecture Fields ──────────────────────────────
  /** Tier 1: Category id (for wizard-created products). */
  categoryId?: string;
  /** Tier 1: Category name (for new categories created on sync). */
  categoryName?: string;
  /** Tier 2: Brand id (for wizard-created products). */
  brandId?: string;
  /** Tier 2: Brand name (for new brands created on sync). */
  brandName?: string;
  /**
   * Tier 3: Parent product name. For wizard-created products, this is the
   * base product concept name (e.g. "منظف اسطح 2400 مل"). For known
   * products, this is the product's name from the catalog.
   */
  parentName?: string;
  /**
   * Tier 4: Variant label — the specific flavor, scent, or color
   * (e.g. "ليمون", "فراولة", "أزرق").
   */
  variantLabel?: string;
}

/** The whole goods-in draft. */
export interface ReceivingDraft {
  supplierId: string | null;
  supplierName: string;
  /** Vendor invoice reference (رقم فاتورة المورد). */
  invoiceNumber: string;
  /** YYYY-MM-DD. */
  invoiceDate: string;
  /** YYYY-MM-DD. */
  dueDate: string;
  notes: string;
  lines: ReceivingDraftLine[];
  /** Cash Paid to Vendor from Register (0 = credit only). */
  cashPaid: number;
  /** Payment-center breakdown. Empty = legacy single `cashPaid` flow. */
  payments?: ReceivingPayment[];
  /** Store VAT used for quick-add line defaults. */
  taxPercent: number;
}

/**
 * One historical purchase of a product — the raw material for the
 * Negotiation Shield (last-3 purchase costs + vendor names).
 */
export interface PurchaseRecord {
  cost: number;
  supplierId: string;
  supplierName: string;
  invoiceNumber: string;
  /** ISO timestamp of the purchase. */
  purchasedAt: string;
  quantity: number;
}

/**
 * The card model the Negotiation Shield renders instantly on a scan:
 * the last 3 purchase costs with vendor names, the comparison against the
 * entered cost, and the maintained-margin retail suggestion.
 */
export interface NegotiationShield {
  barcode: string;
  description: string;
  /** Catalog default cost (from parent product cost_price). */
  currentCost: number;
  /** Catalog default retail (from parent product selling_price). */
  currentRetail: number;
  /** Newest first, truncated to 3. */
  lastPurchases: PurchaseRecord[];
  highestCost: number;
  lowestCost: number;
  averageCost: number;
  /** The cost the user is entering on this draft line. */
  enteredCost: number;
  /** True when enteredCost is higher than every known historical cost. */
  isCostIncrease: boolean;
  /** Current gross margin (0..1), or null when retail is 0. */
  marginPercent: number | null;
  /** Retail that keeps the current margin at `enteredCost` (0 when unknown). */
  suggestedRetail: number;
  /** True when the UI must prompt "update retail price to maintain margin?". */
  shouldPromptRetailUpdate: boolean;
  hasHistory: boolean;
  /** Minimum gross margin the guard enforces (DEFAULT_MIN_MARGIN). */
  marginFloor: number;
  /** True when keeping currentRetail at enteredCost breaches the floor. */
  belowFloor: boolean;
  /** Gross margin if retail stays at currentRetail with the entered cost. */
  proposedMarginPercent: number | null;
}

/** Server response for the goods-in price-history lookup. */
export interface PriceHistoryResponse {
  barcode: string;
  currentCost: number;
  currentRetail: number;
  description: string;
  history: PurchaseRecord[];
  /** True when the payload came from the offline cache, not the server. */
  cached?: boolean;
}

/** Quick-Add definition captured by the 4-Tier Creation Wizard. */
export interface QuickAddDefinition {
  name: string;
  cost: number;
  retailPrice: number;
  wholesalePrice?: number;
  taxPercent: number;
  baseUnit: string;
  // ── 4-Tier Architecture Fields ──────────────────────────────
  /** Tier 1: Category id (selected or quick-created). */
  categoryId?: string;
  /** Tier 1: Category name (for new categories). */
  categoryName?: string;
  /** Tier 2: Brand id (selected or quick-created). */
  brandId?: string;
  /** Tier 2: Brand name (for new brands). */
  brandName?: string;
  /**
   * Tier 4: Variant label — the specific flavor, scent, or color.
   * Auto-numbered as "نكهة 1", "نكهة 2" during Excel import.
   */
  variantLabel?: string;
}
