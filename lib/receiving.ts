/**
 * Goods-In / Smart Receiving — pure domain logic (Phase 3).
 *
 * Everything here is deterministic and free of I/O so the Negotiation Shield,
 * the cash-drawer deduction, the margin-maintenance prompt, and the queued
 * sync payload can be unit-tested without a device, network, or store.
 */

import type { SyncQueueRecord, SupplierCreatePayload } from "./idb";
import type {
  PaymentMethod,
  ReceivingDraft,
  ReceivingDraftLine,
  ReceivingMoney,
  ReceivingPayment,
  NegotiationShield,
  PurchaseRecord,
} from "../types/receiving.types";
import type { ShiftTotals } from "../types/pos.types";

export const DEFAULT_TARGET_MARGIN = 0.3;
/** Minimum gross margin the guard enforces before a goods-in can commit. */
export const DEFAULT_MIN_MARGIN = 0.15;
export const MAX_RECEIVING_LINES = 100;
export const RECEIVING_CATEGORY_LABEL = "مشتريات نقدية للمورد";

/** All methods the payment center can split an invoice across. */
export const PAYMENT_METHODS: readonly PaymentMethod[] = ["CASH", "BANK", "CARD", "CLIQ", "WALLET"];

/** Input shape the unit-conversion helpers accept (quantity/cost in a unit). */
export interface ReceivingUnitInput {
  quantity?: number;
  unitCost?: number;
  multiplier?: number;
}

export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
export const round4 = (n: number): number => Math.round((n + Number.EPSILON) * 10000) / 10000;

/**
 * Derive a variant label by stripping the shared prefix between a child name
 * and its parent name — the exact same logic the `merge_into_variant_parent`
 * RPC uses, kept in TS so the receiving mirror can label on-the-fly variants
 * without the tablet asking the worker to type one.
 *
 *   deriveVariantLabel("معطر جو ليمون", "معطر جو 300مل") -> "ليمون"
 *   deriveVariantLabel("Air Freshener Lemon", "Air Freshener 300ml") -> "Lemon"
 */
export function deriveVariantLabel(childName: string, parentName: string): string {
  const child = childName.trim();
  const parent = parentName.trim();
  const cl = child.toLowerCase();
  const pl = parent.toLowerCase();
  let common = 0;
  if (pl !== "" && cl.startsWith(pl)) {
    common = parent.length;
  } else {
    for (let i = 0; i < Math.min(child.length, parent.length); i++) {
      if (cl[i] === pl[i]) common = i + 1;
      else break;
    }
    // Back off to the last word boundary so "معطر جو ليمون" under
    // "معطر جو 300مل" never yields a label that starts mid-word.
    while (common > 0 && child[common - 1] !== " ") common -= 1;
  }
  let label = child.slice(common).trim();
  if (label === "") label = child;
  return label.slice(0, 112);
}

/** Money that is finite and non-negative. */
export function isFiniteMoney(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Money that is finite and strictly positive. */
export function isPositiveMoney(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export interface ReceivingTotals {
  subtotal: number;
  tax: number;
  total: number;
}

/**
 * Invoice totals mirroring `create_supplier_invoice` exactly: per-line
 * net = qty·unitCost, line tax rounded to 2dp at the line, and the buckets
 * summed with 2dp rounding so the client preview and the server row agree to
 * the penny.
 */
export function computeReceivingTotals(
  lines: Pick<ReceivingDraftLine, "quantity" | "unitCost" | "taxPercent">[],
): ReceivingTotals {
  let subtotal = 0;
  let tax = 0;
  let total = 0;
  for (const line of lines) {
    const qty = typeof line.quantity === "number" && Number.isFinite(line.quantity) ? line.quantity : 0;
    const unitCost = typeof line.unitCost === "number" && Number.isFinite(line.unitCost) ? line.unitCost : 0;
    const taxPercent = typeof line.taxPercent === "number" && Number.isFinite(line.taxPercent) ? line.taxPercent : 0;
    const net = round2(qty * unitCost);
    const lineTax = round2((net * Math.max(0, Math.min(100, taxPercent))) / 100);
    subtotal = round2(subtotal + net);
    tax = round2(tax + lineTax);
    total = round2(total + round2(net + lineTax));
  }
  return { subtotal, tax, total };
}

export interface ShieldInput {
  barcode: string;
  description: string;
  currentCost: number;
  currentRetail: number;
  /** Full purchase history (any order); the newest 3 are shown. */
  lastPurchases: PurchaseRecord[];
  enteredCost: number;
}

function sortNewestFirst(records: PurchaseRecord[]): PurchaseRecord[] {
  return [...records].sort((a, b) => (b.purchasedAt ?? "").localeCompare(a.purchasedAt ?? ""));
}

/**
 * The Negotiation Shield: the card shown instantly when an item is scanned.
 * It surfaces the last 3 purchase costs with their vendor names, compares the
 * entered cost against every known cost, and (when the cost rises) asks
 * "update retail price to maintain margin?" with an exact suggested price.
 */
export function buildNegotiationShield(input: ShieldInput): NegotiationShield {
  const history = sortNewestFirst(input.lastPurchases ?? []).slice(0, 3);
  const currentCost = isFiniteMoney(input.currentCost) ? input.currentCost : 0;
  const currentRetail = isFiniteMoney(input.currentRetail) ? input.currentRetail : 0;
  const enteredCost = isFiniteMoney(input.enteredCost) ? input.enteredCost : 0;

  const costs = history.map((p) => (isFiniteMoney(p.cost) ? p.cost : 0)).filter((c) => c > 0);
  const highestCost = costs.length > 0 ? Math.max(...costs) : 0;
  const lowestCost = costs.length > 0 ? Math.min(...costs) : 0;
  const averageCost = costs.length > 0 ? round2(costs.reduce((s, c) => s + c, 0) / costs.length) : 0;

  const isCostIncrease = enteredCost > Math.max(currentCost, highestCost);

  let marginPercent: number | null = null;
  if (currentRetail > 0 && currentCost > 0 && currentRetail > currentCost) {
    marginPercent = round4((currentRetail - currentCost) / currentRetail);
  }

  // The proposed gross margin keeps retail at currentRetail while the cost
  // moves to enteredCost — the number the margin-floor guard evaluates.
  let proposedMarginPercent: number | null = null;
  if (currentRetail > 0 && enteredCost > 0) {
    proposedMarginPercent = currentRetail > enteredCost
      ? round4((currentRetail - enteredCost) / currentRetail)
      : 0;
  }
  const belowFloor =
    proposedMarginPercent !== null && proposedMarginPercent < DEFAULT_MIN_MARGIN;

  const suggestedRetail = maintainMarginRetailPrice(enteredCost, currentCost, currentRetail);

  return {
    barcode: input.barcode,
    description: input.description,
    currentCost,
    currentRetail,
    lastPurchases: history,
    highestCost,
    lowestCost,
    averageCost,
    enteredCost,
    isCostIncrease,
    marginPercent,
    suggestedRetail,
    shouldPromptRetailUpdate: isCostIncrease && currentRetail > 0,
    hasHistory: history.length > 0,
    marginFloor: DEFAULT_MIN_MARGIN,
    belowFloor,
    proposedMarginPercent,
  };
}

/**
 * Retail that keeps the current gross-margin percentage when the cost moves.
 * Falls back to `cost · (1 + DEFAULT_TARGET_MARGIN)` when there is no usable
 * margin to preserve (no retail yet, zero cost, or a below-cost price).
 */
export function maintainMarginRetailPrice(
  enteredCost: number,
  currentCost: number,
  currentRetail: number,
): number {
  const cost = isFiniteMoney(enteredCost) ? enteredCost : 0;
  if (cost <= 0) return 0;
  if (currentRetail > 0 && currentCost > 0 && currentRetail > currentCost) {
    const margin = (currentRetail - currentCost) / currentRetail;
    if (margin > 0 && margin < 1) {
      return round2(cost / (1 - margin));
    }
  }
  return round2(cost * (1 + DEFAULT_TARGET_MARGIN));
}

/** Deterministic 6-char hash used to seed the internal SKU. */
function nameHash(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i += 1) {
    h = (h * 31 + name.charCodeAt(i)) | 0;
  }
  return ((h >>> 0).toString(36).toUpperCase() + "000000").slice(0, 6);
}

/**
 * Internal SKU for a Quick-Add item with an unknown barcode. `MKN` prefix +
 * a name hash (so identical names collide deterministically) + a short random
 * tail (so different devices never mint the same code). Uppercase, scannable.
 */
export function generateInternalSku(name: string): string {
  const random = Math.random().toString(36).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4).padEnd(4, "0");
  return `MKN${nameHash(name)}${random}`;
}

/**
 * Cash Drawer Integration: money paid to the vendor out of the register is a
 * linked drawer deduction. The mirror reuses the shift-bound `expenses`
 * ledger, so the cashier's Z-report counts it in `expenses` and the expected
 * drawer drops by exactly the amount paid — no reconciliation shortfall.
 */
export function applyCashDrawerDeduction(
  totals: ShiftTotals,
  cashPaid: ReceivingMoney,
): ShiftTotals {
  const amount = round2(cashPaid);
  if (!(amount > 0)) return totals;
  return {
    ...totals,
    expenses: round2(totals.expenses + amount),
    expectedCashInDrawer: round2(totals.expectedCashInDrawer - amount),
  };
}

/**
 * Auto invoice number for a vendor invoice with no reference yet:
 * `AUTO-YYMMDD-HHMM` (local time). Deterministic per minute, scannable, and
 * unique enough for offline devices without a server round-trip.
 */
export function generateAutoInvoiceNumber(date: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  const ymd = `${pad(date.getFullYear() % 100)}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  const hm = `${pad(date.getHours())}${pad(date.getMinutes())}`;
  return `AUTO-${ymd}-${hm}`;
}

/**
 * Due date for a supplier invoice: `invoiceDate` plus the supplier's default
 * payment terms in days (clamped to non-negative). Invalid input is echoed.
 */
export function computeDueDate(invoiceDate: string, paymentTermsDays: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(invoiceDate ?? "");
  if (!match) return invoiceDate;
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  date.setUTCDate(date.getUTCDate() + Math.max(0, Math.floor(paymentTermsDays || 0)));
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** Aggregate of a payment-center breakdown against an invoice total. */
export interface PaymentTotals {
  totalPaid: number;
  /** Sum of CASH payments — the money leaving the register drawer. */
  cashPortion: number;
  nonCash: number;
  /** total − totalPaid, floored at 0. */
  remaining: number;
  fullyPaid: boolean;
}

export function computePaymentTotals(
  total: number,
  payments: Array<Pick<ReceivingPayment, "method" | "amount">>,
): PaymentTotals {
  const list = Array.isArray(payments) ? payments : [];
  const cashPortion = round2(list.reduce((sum, p) => sum + (p.method === "CASH" ? Math.max(0, p.amount) : 0), 0));
  const nonCash = round2(list.reduce((sum, p) => sum + (p.method !== "CASH" ? Math.max(0, p.amount) : 0), 0));
  const totalPaid = round2(cashPortion + nonCash);
  const invoiceTotal = isFiniteMoney(total) ? total : 0;
  const remaining = round2(Math.max(0, invoiceTotal - totalPaid));
  return { totalPaid, cashPortion, nonCash, remaining, fullyPaid: remaining === 0 };
}

/** Effective multiplier for a line (1 when unset). */
function unitMultiplier(line: ReceivingUnitInput): number {
  return typeof line.multiplier === "number" && Number.isFinite(line.multiplier) && line.multiplier > 0
    ? line.multiplier
    : 1;
}

/** Stock impact of a line: quantity expressed in base units. */
export function lineBaseQuantity(line: ReceivingUnitInput): number {
  return round4((isFiniteMoney(line.quantity) ? line.quantity : 0) * unitMultiplier(line));
}

/** Base-unit cost of a line: per-unit cost converted back to the base unit. */
export function lineBaseUnitCost(line: ReceivingUnitInput): number {
  const cost = isFiniteMoney(line.unitCost) ? line.unitCost : 0;
  return round4(cost / unitMultiplier(line));
}

/**
 * Re-express a line in another unit while preserving its base-unit value:
 * `quantity` and `unitCost` are scaled so `quantity × unitCost` (the invoice
 * value) and the base-unit stock impact stay identical.
 */
export function convertLineUnit(
  line: ReceivingUnitInput,
  multiplier: number,
): { quantity: number; unitCost: number; multiplier: number } {
  const target = typeof multiplier === "number" && Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1;
  const baseQty = lineBaseQuantity(line);
  const baseCost = lineBaseUnitCost(line);
  return {
    quantity: round4(baseQty / target),
    unitCost: round4(baseCost * target),
    multiplier: target,
  };
}

/** Outcome of the margin-floor guard for one draft line. */
export interface MarginFloorResult {
  /** Retail the guard evaluates (accepted newRetailPrice or currentRetail). */
  retail: number | null;
  baseCost: number;
  marginPercent: number | null;
  belowFloor: boolean;
  floor: number;
}

/**
 * The margin-floor guard: evaluates the gross margin a line would earn after
 * commit (using the accepted new retail, else the catalog retail) at the
 * entered base-unit cost. A line at/below cost, or under DEFAULT_MIN_MARGIN,
 * breaches the floor unless the cashier confirms `marginOverride`. Unknown
 * retail never blocks (a new product with no price yet).
 */
export function evaluateMarginFloor(
  line: { unitCost?: number; multiplier?: number; newRetailPrice?: number | null; currentRetail?: number },
): MarginFloorResult {
  const floor = DEFAULT_MIN_MARGIN;
  const baseCost = lineBaseUnitCost(line);
  if (baseCost <= 0) return { retail: null, baseCost: 0, marginPercent: null, belowFloor: false, floor };

  const retail = isFiniteMoney(line.newRetailPrice) && line.newRetailPrice > 0
    ? line.newRetailPrice
    : isFiniteMoney(line.currentRetail) && line.currentRetail > 0
      ? line.currentRetail
      : null;
  if (retail === null) return { retail: null, baseCost, marginPercent: null, belowFloor: false, floor };
  if (retail <= baseCost) return { retail, baseCost, marginPercent: 0, belowFloor: true, floor };

  const marginPercent = round4((retail - baseCost) / retail);
  return { retail, baseCost, marginPercent, belowFloor: marginPercent < floor, floor };
}

/** Context the client has when committing a goods-in draft. */
export interface ReceivingCommitContext {
  syncId: string;
  cashierId?: string | null;
  cashierName?: string;
  branchId?: string | null;
  terminalId?: string | null;
  shift: { shiftId: string; status: string } | null;
  /** Client-generated UUID for the drawer-deduction expense row. */
  drawerExpenseId?: string;
}

/**
 * Validation gate for a goods-in draft. Returns an Arabic, UI-ready error
 * message, or null when the draft may be committed. Cash drawn from the
 * register REQUIRES an open shift: a payment recorded without a drawer would
 * leave the reconciliation bookkeeping permanently unbalanced.
 */
export function validateReceivingDraft(
  draft: ReceivingDraft,
  ctx: { shift: { shiftId: string; status: string } | null },
): string | null {
  if (!draft.supplierId) return "اختر المورد";
  if (!draft.supplierName) return "اختر المورد";
  const invoiceNumber = (draft.invoiceNumber ?? "").trim();
  if (!invoiceNumber) return "أدخل رقم فاتورة المورد";
  if (invoiceNumber.length > 80) return "رقم الفاتورة طويل جداً";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.invoiceDate) || !/^\d{4}-\d{2}-\d{2}$/.test(draft.dueDate)) {
    return "تواريخ الفاتورة غير صالحة";
  }
  if (draft.dueDate < draft.invoiceDate) return "تاريخ الاستحقاق يسبق تاريخ الفاتورة";
  if (!Array.isArray(draft.lines) || draft.lines.length === 0) return "أضف صنفاً واحداً على الأقل";
  if (draft.lines.length > MAX_RECEIVING_LINES) return `الحد الأقصى ${MAX_RECEIVING_LINES} بند في الفاتورة`;

  for (const line of draft.lines) {
    if (!isPositiveMoney(line.quantity)) return `كمية غير صالحة لصنف "${line.description || line.barcode}"`;
    if (!isFiniteMoney(line.unitCost)) return `سعر تكلفة غير صالح لصنف "${line.description || line.barcode}"`;
    if (!isFiniteMoney(line.taxPercent) || line.taxPercent > 100) return `ضريبة غير صالحة لصنف "${line.description || line.barcode}"`;
    const parentName = (line.parentName ?? "").trim();
    if (parentName.length > 255) return `اسم المجموعة طويل جداً لصنف "${line.description || line.barcode}"`;
  }

  // Margin floor: accepting a cost that drags the retail margin under
  // DEFAULT_MIN_MARGIN is blocked unless the cashier confirms the override.
  for (const line of draft.lines) {
    const floor = evaluateMarginFloor(line);
    if (floor.belowFloor && !line.marginOverride) {
      return `سعر البيع لا يحافظ على الحد الأدنى لهامش الربح لصنف "${line.description || line.barcode}" — حدّث السعر أو أكّد التجاوز`;
    }
  }

  // Payment center: known methods, finite amounts, never more than the total.
  // Legacy `cashPaid`-only drafts skip the cap — the drawer amount may be a
  // larger down payment (the mirror caps it at the balance due).
  const payments = Array.isArray(draft.payments) ? draft.payments : [];
  if (payments.length > 0) {
    for (const payment of payments) {
      if (!PAYMENT_METHODS.includes(payment.method)) return "طريقة دفع غير صالحة";
      if (!isFiniteMoney(payment.amount)) return "مبلغ دفع غير صالح";
    }
    const invoiceTotal = computeReceivingTotals(draft.lines).total;
    const paid = computePaymentTotals(invoiceTotal, payments);
    if (paid.totalPaid > invoiceTotal) return "الدفع يتجاوز قيمة الفاتورة";
  }

  if (!isFiniteMoney(draft.cashPaid)) return "المبلغ النقدي غير صالح";
  const cashPortion = payments.length > 0 ? computePaymentTotals(0, payments).cashPortion : draft.cashPaid;
  if (cashPortion > 0) {
    if (!ctx.shift || ctx.shift.status !== "OPEN" || !ctx.shift.shiftId) {
      return "افتح الوردية قبل دفع النقد للمورد من الصندوق";
    }
  }
  return null;
}

/**
 * Turn a validated draft into the queued sync event. Callers must run
 * `validateReceivingDraft` first — when `cashPaid > 0` an open shift is
 * mandatory and yields the linked `drawerDeduction` block.
 */
export function buildReceivingSyncRecord(
  draft: ReceivingDraft,
  ctx: ReceivingCommitContext,
): SyncQueueRecord {
  const totals = computeReceivingTotals(draft.lines);
  const created_at = new Date().toISOString();

  const lines = draft.lines.map((line, index) => {
    const netAmount = round2(line.quantity * line.unitCost);
    const taxAmount = round2((netAmount * Math.max(0, Math.min(100, line.taxPercent))) / 100);
    const totalAmount = round2(netAmount + taxAmount);
    return {
      lineNo: index + 1,
      productId: line.productId ?? null,
      barcode: line.barcode,
      description: line.description,
      quantity: line.quantity,
      unitCost: line.unitCost,
      taxPercent: line.taxPercent,
      netAmount,
      taxAmount,
      totalAmount,
      applyCost: line.applyCost,
      newRetailPrice: line.newRetailPrice ?? null,
      unitMultiplier: line.multiplier ?? 1,
      unitName: line.unitName ?? line.baseUnit,
    };
  });

  // Payment-center reconciliation: cashPaid (drawer) = the CASH portion,
  // totalPaid = every method. Legacy cashPaid-only drafts fall back to a
  // single CASH payment so the mirror's behaviour is unchanged.
  const payments = Array.isArray(draft.payments) ? draft.payments : [];
  const cashPortion = payments.length > 0
    ? computePaymentTotals(0, payments).cashPortion
    : round2(draft.cashPaid);
  const totalPaid = payments.length > 0
    ? computePaymentTotals(0, payments).totalPaid
    : round2(draft.cashPaid);
  const payloadPayments = payments.length > 0
    ? payments.map((p) => ({ method: p.method, amount: round2(p.amount) }))
    : cashPortion > 0
      ? [{ method: "CASH" as const, amount: cashPortion }]
      : [];

  const newProducts = draft.lines
    .filter((line) => line.isNewProduct)
    .map((line) => ({
      sku: line.barcode,
      name: line.description,
      unitCost: line.unitCost,
      retailPrice: isFiniteMoney(line.newRetailPrice) && line.newRetailPrice > 0
        ? line.newRetailPrice
        : maintainMarginRetailPrice(line.unitCost, 0, 0),
      taxPercent: line.taxPercent,
      baseUnit: line.baseUnit,
      ...(line.categoryId ? { categoryId: line.categoryId } : {}),
      ...(line.categoryName?.trim() ? { categoryName: line.categoryName.trim() } : {}),
      ...(line.brandId ? { brandId: line.brandId } : {}),
      ...(line.brandName?.trim() ? { brandName: line.brandName.trim() } : {}),
      ...(line.parentName?.trim() ? { parentName: line.parentName.trim() } : {}),
      ...(line.variantLabel?.trim() ? { variantLabel: line.variantLabel.trim() } : {}),
    }));

  const drawerDeduction =
    cashPortion > 0 && ctx.shift?.status === "OPEN" && ctx.shift.shiftId
      ? {
          expenseId: ctx.drawerExpenseId ?? `supplier-${ctx.syncId}`,
          cashierId: ctx.cashierId ?? null,
          cashierName: ctx.cashierName,
          amount: cashPortion,
          notes: `${RECEIVING_CATEGORY_LABEL} • فاتورة ${draft.invoiceNumber.trim()}`,
          shiftId: ctx.shift.shiftId,
          branchId: ctx.branchId ?? undefined,
          terminalId: ctx.terminalId ?? undefined,
          created_at,
        }
      : undefined;

  return {
    sync_id: ctx.syncId,
    action_type: "SUPPLIER_INVOICE_CREATED",
    payload: {
      supplierId: draft.supplierId!,
      supplierName: draft.supplierName,
      invoiceNumber: draft.invoiceNumber.trim(),
      invoiceDate: draft.invoiceDate,
      dueDate: draft.dueDate,
      notes: draft.notes.trim() || undefined,
      taxPercent: draft.taxPercent,
      subtotal: totals.subtotal,
      tax: totals.tax,
      total: totals.total,
      lines,
      newProducts,
      cashPaid: cashPortion,
      totalPaid,
      payments: payloadPayments,
      drawerDeduction,
      branchId: ctx.branchId ?? undefined,
      terminalId: ctx.terminalId ?? undefined,
      cashierId: ctx.cashierId ?? undefined,
      cashierName: ctx.cashierName,
      created_at,
    },
    status: "PENDING",
    created_at,
    cashierName: ctx.cashierName,
  };
}

/** Client context stamping an inline supplier create (offline-first). */
export interface SupplierCreateContext {
  syncId: string;
  branchId?: string | null;
  terminalId?: string | null;
  cashierId?: string | null;
  cashierName?: string;
}

/**
 * Serialize an inline supplier creation into the queued SUPPLIER_CREATE event.
 * The server mirror upserts the client-generated id so a SUPPLIER_INVOICE_CREATED
 * referencing it (queued later by `buildReceivingSyncRecord`) always finds its
 * vendor row, even when the whole batch only drains after going online.
 */
export function buildSupplierCreateSyncRecord(
  input: { id: string; name: string; phone?: string },
  ctx: SupplierCreateContext,
): SyncQueueRecord {
  const created_at = new Date().toISOString();
  const payload: SupplierCreatePayload = {
    id: input.id,
    name: input.name.trim(),
    phone: (input.phone ?? "").trim() || undefined,
    branchId: ctx.branchId ?? undefined,
    terminalId: ctx.terminalId ?? undefined,
    cashierId: ctx.cashierId ?? undefined,
    cashierName: ctx.cashierName,
    created_at,
  };
  return {
    sync_id: ctx.syncId,
    action_type: "SUPPLIER_CREATE",
    payload,
    status: "PENDING",
    created_at,
    cashierName: ctx.cashierName,
  };
}
