import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  BarcodeLabelPrintPayload,
  InvoiceCreatedPayload,
  SupplierCreatePayload,
  SupplierInvoiceCreatedPayload,
  SyncQueueRecord,
} from "@/lib/idb";
import type { ShortageFlaggedPayload } from "@/types/pos.types";
import { awardLoyaltyPoints, clawBackLoyaltyPoints, isLoyaltyClawback } from "@/lib/loyalty";
import { computeFiscalBreakdown } from "@/lib/saleMath";
import { derivePaymentBuckets } from "@/lib/paymentBuckets";
import { recordInvoiceRiskSignals, recordRiskSignal } from "@/lib/riskEngine";
import { deriveVariantLabel } from "@/lib/receiving";

/**
 * Client-side write side of the event-sourcing sync engine.
 *
 * Faithful port of the removed /api/sync route: every queued offline event is
 * mirrored straight into the Supabase ledgers with the exact same handlers,
 * ordering guarantees and idempotency keys, so retries after a failed ack can
 * never double-post stock, balances, invoices or Z-reports.
 *
 * Deliberate omission vs. the server route: runIstdCatchUp (best-effort
 * ISTD/JoFotara submission for invoices never cleared online) requires
 * server-held tax-authority credentials and stays out of the browser bundle.
 * Carried fast-path clearance results are still stamped (stampCarriedIstd).
 */

const VALID_ACTION_TYPES = new Set([
  "INVOICE_CREATED",
  "SHIFT_OPENED",
  "SHIFT_CLOSED",
  "DEBT_SETTLEMENT",
  "EXPENSE_RECORDED",
  "CASH_MOVEMENT",
  "SUPPLIER_INVOICE_CREATED",
  "SHORTAGE_FLAGGED",
  "SUPPLIER_CREATE",
  "BARCODE_LABEL_PRINT",
]);

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function money(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? round2(n) : 0;
}

function uuidOrNull(value: unknown): string | null {
  const v = text(value);
  return UUID_RE.test(v) ? v : null;
}

/**
 * Deep numeric validation of an event payload. Money and quantity fields
 * must be finite numbers; a NaN/Infinity must never reach Postgres (it would
 * corrupt invoices, shift reports and stock).
 */
function payloadValidationError(event: SyncQueueRecord): string | null {
  const p = event.payload as unknown as Record<string, unknown> | undefined;
  if (!p || typeof p !== "object") return null;
  const finite = (...keys: string[]): boolean =>
    keys.every((k) => {
      const v = p[k];
      return v === undefined || (typeof v === "number" && Number.isFinite(v));
    });

  switch (event.action_type) {
    case "INVOICE_CREATED": {
      if (!finite("subtotal", "tax", "discount", "deliveryFee", "total", "amountPaid", "change")) {
        return "invoice_has_non_finite_money";
      }
      if (typeof p.total !== "number" || !Number.isFinite(p.total)) {
        return "invoice_total_missing";
      }
      const items = p.items;
      if (!Array.isArray(items)) return "invoice_items_missing";
      for (const it of items as Record<string, unknown>[]) {
        if (
          typeof it.qty !== "number" ||
          !Number.isFinite(it.qty) ||
          typeof it.unitPrice !== "number" ||
          !Number.isFinite(it.unitPrice) ||
          typeof it.lineTotal !== "number" ||
          !Number.isFinite(it.lineTotal)
        ) {
          return "invoice_item_has_non_finite_value";
        }
        if (it.discount !== undefined && (typeof it.discount !== "number" || !Number.isFinite(it.discount))) {
          return "invoice_item_has_non_finite_discount";
        }
      }
      return null;
    }
    case "DEBT_SETTLEMENT":
      if (!finite("amount") || typeof p.amount !== "number" || p.amount <= 0) {
        return "settlement_amount_invalid";
      }
      return null;
    case "EXPENSE_RECORDED":
      if (!finite("amount") || typeof p.amount !== "number" || p.amount <= 0) {
        return "expense_amount_invalid";
      }
      return null;
    case "CASH_MOVEMENT":
      if (!finite("amount") || typeof p.amount !== "number" || p.amount <= 0) {
        return "cash_movement_amount_invalid";
      }
      if (typeof p.type !== "string" || (p.type !== "CASH_IN" && p.type !== "CASH_OUT")) {
        return "cash_movement_type_invalid";
      }
      if (typeof p.shiftId !== "string" || p.shiftId.length === 0) {
        return "cash_movement_shift_missing";
      }
      return null;
    case "SUPPLIER_INVOICE_CREATED": {
      if (!finite("subtotal", "tax", "total", "cashPaid")) {
        return "supplier_invoice_has_non_finite_money";
      }
      if (typeof p.total !== "number" || !Number.isFinite(p.total) || p.total < 0) {
        return "supplier_invoice_total_invalid";
      }
      if (typeof p.cashPaid !== "number" || !Number.isFinite(p.cashPaid) || p.cashPaid < 0) {
        return "supplier_invoice_cash_paid_invalid";
      }
      const lines = p.lines;
      if (!Array.isArray(lines) || lines.length === 0 || lines.length > 100) {
        return "supplier_invoice_lines_invalid";
      }
      for (const line of lines as Record<string, unknown>[]) {
        for (const key of ["quantity", "unitCost", "taxPercent", "netAmount", "taxAmount", "totalAmount"] as const) {
          const v = line[key];
          if (typeof v !== "number" || !Number.isFinite(v)) {
            return "supplier_invoice_line_has_non_finite_value";
          }
        }
        if (typeof line.description !== "string" || (line.description as string).trim().length === 0) {
          return "supplier_invoice_line_description_missing";
        }
        if (line.unitMultiplier !== undefined && (typeof line.unitMultiplier !== "number" || !Number.isFinite(line.unitMultiplier) || line.unitMultiplier <= 0)) {
          return "supplier_invoice_line_bad_unit_multiplier";
        }
      }
      const payments = p.payments;
      if (payments !== undefined) {
        if (!Array.isArray(payments)) return "supplier_invoice_payments_invalid";
        for (const payment of payments as Record<string, unknown>[]) {
          const method = payment.method;
          if (typeof method !== "string" || !["CASH", "BANK", "CARD", "CLIQ", "WALLET"].includes(method)) {
            return "supplier_invoice_payment_method_invalid";
          }
          if (typeof payment.amount !== "number" || !Number.isFinite(payment.amount) || payment.amount < 0) {
            return "supplier_invoice_payment_amount_invalid";
          }
        }
      }
      const dd = p.drawerDeduction as Record<string, unknown> | undefined;
      if (dd !== undefined) {
        if (typeof dd !== "object" || dd === null) return "drawer_deduction_invalid";
        if (typeof dd.amount !== "number" || !Number.isFinite(dd.amount) || dd.amount <= 0) {
          return "drawer_deduction_amount_invalid";
        }
        if (typeof dd.shiftId !== "string" || dd.shiftId.length === 0) {
          return "drawer_deduction_missing_shift";
        }
      }
      const newProducts = p.newProducts;
      if (newProducts !== undefined) {
        if (!Array.isArray(newProducts)) return "supplier_invoice_new_products_invalid";
        for (const np of newProducts as Record<string, unknown>[]) {
          if (typeof np.sku !== "string" || (np.sku as string).trim().length === 0) {
            return "supplier_invoice_new_product_sku_missing";
          }
          if (typeof np.name !== "string" || (np.name as string).trim().length === 0) {
            return "supplier_invoice_new_product_name_missing";
          }
          const parentId = np.parentId;
          const parentName = np.parentName;
          if (parentId !== undefined && parentId !== null && typeof parentId !== "string") {
            return "supplier_invoice_new_product_bad_parent_id";
          }
          if (parentName !== undefined && (typeof parentName !== "string" || (parentName as string).trim().length === 0)) {
            return "supplier_invoice_new_product_bad_parent_name";
          }
          if (typeof parentName === "string" && parentName.trim().length > 255) {
            return "supplier_invoice_new_product_parent_name_too_long";
          }
          if (
            typeof parentId === "string" &&
            parentId.trim().length > 0 &&
            typeof parentName === "string" &&
            parentName.trim().length > 0
          ) {
            return "supplier_invoice_new_product_conflicting_parent";
          }
        }
      }
      return null;
    }
    case "SHORTAGE_FLAGGED": {
      if (typeof p.productId !== "string" || p.productId.trim().length === 0) {
        return "shortage_product_id_missing";
      }
      if (typeof p.productName !== "string" || p.productName.trim().length === 0) {
        return "shortage_product_name_missing";
      }
      if (!finite("currentStock") || typeof p.currentStock !== "number" || p.currentStock < 0) {
        return "shortage_current_stock_invalid";
      }
      if (typeof p.created_at !== "string" || p.created_at.length === 0) {
        return "shortage_created_at_missing";
      }
      return null;
    }
    case "SUPPLIER_CREATE": {
      if (typeof p.id !== "string" || p.id.trim().length === 0 || !UUID_RE.test(p.id)) {
        return "supplier_create_missing_id";
      }
      if (typeof p.name !== "string" || p.name.trim().length === 0) {
        return "supplier_create_missing_name";
      }
      if (p.name.length > 150) return "supplier_create_name_too_long";
      if (p.phone !== undefined && (typeof p.phone !== "string" || p.phone.length > 20)) {
        return "supplier_create_bad_phone";
      }
      if (typeof p.created_at !== "string" || p.created_at.length === 0) {
        return "supplier_create_missing_created_at";
      }
      return null;
    }
    case "BARCODE_LABEL_PRINT": {
      if (typeof p.barcode !== "string" || p.barcode.trim().length === 0) {
        return "label_print_missing_barcode";
      }
      if (typeof p.name !== "string" || p.name.trim().length === 0) {
        return "label_print_missing_name";
      }
      if (typeof p.price !== "number" || !Number.isFinite(p.price) || p.price < 0) {
        return "label_print_bad_price";
      }
      if (typeof p.quantity !== "number" || !Number.isFinite(p.quantity) || p.quantity < 1) {
        return "label_print_bad_quantity";
      }
      const size = p.templateSize as Record<string, unknown> | undefined;
      if (
        !size ||
        typeof size !== "object" ||
        typeof size.widthMm !== "number" ||
        !Number.isFinite(size.widthMm) ||
        size.widthMm <= 0 ||
        typeof size.heightMm !== "number" ||
        !Number.isFinite(size.heightMm) ||
        size.heightMm <= 0
      ) {
        return "label_print_bad_template_size";
      }
      return null;
    }
    case "SHIFT_OPENED":
      if (!finite("startingCash")) return "shift_starting_cash_invalid";
      return null;
    case "SHIFT_CLOSED":
      if (
        !finite(
          "startingCash",
          "cashSales",
          "visaSales",
          "cliqSales",
          "debtSales",
          "debtCollections",
          "totalSales",
          "discounts",
          "returns",
          "expenses",
          "expectedCashInDrawer",
          "actualCash",
          "variance",
        )
      ) {
        return "shift_has_non_finite_money";
      }
      return null;
    default:
      return null;
  }
}

async function recordSalesInvoiceLedger(
  db: SupabaseClient,
  event: SyncQueueRecord,
  storeId: string,
): Promise<{ recorded: boolean; error?: string }> {
  if (event.action_type !== "INVOICE_CREATED") return { recorded: false };

  const payload = event.payload as InvoiceCreatedPayload;
  const items = Array.isArray(payload.items) ? payload.items : [];
  const barcodeKeys = Array.from(new Set(items.map((item) => item.barcode?.trim()).filter(Boolean) as string[]));
  const barcodeMeta = new Map<string, { cost: number; multiplier: number; variantLabel: string }>();
  if (barcodeKeys.length > 0) {
    const { data: variantRows, error: varErr } = await db
      .from("product_variants")
      .select("barcode,product_id,variant_label")
      .eq("store_id", storeId)
      .in("barcode", barcodeKeys);
    if (varErr) return { recorded: false, error: varErr.message };
    const productIds = [...new Set((variantRows ?? []).map((r) => r.product_id).filter(Boolean))];
    const priceMap = new Map<string, number>();
    if (productIds.length > 0) {
      const { data: prodRows } = await db
        .from("products")
        .select("id,cost_price")
        .eq("store_id", storeId)
        .in("id", productIds);
      for (const p of prodRows ?? []) priceMap.set(p.id, money(p.cost_price));
    }
    for (const row of variantRows ?? []) {
      barcodeMeta.set(row.barcode, {
        cost: priceMap.get(row.product_id) ?? 0,
        multiplier: 1,
        variantLabel: text(row.variant_label),
      });
    }
  }

  const subtotal = money(payload.subtotal);
  const tax = money(payload.tax);
  const discount = money(payload.discount);
  const deliveryFee = money(payload.deliveryFee);
  const total = money(payload.total);
  const amountPaid = money(payload.amountPaid);
  const paymentMethod = text(payload.paymentMethod) || "UNKNOWN";

  // Authoritative payment buckets. The POS stamps the exact signed drawer
  // movement on every invoice (and reversal) so the ledger can never
  // re-derive a return into the wrong bucket — e.g. a SPLIT 60/40 sale being
  // reversed 100% into cash. When absent (legacy events) we derive them, and
  // the derivation honors negative totals for returns.
  const buckets = derivePaymentBuckets(paymentMethod, total, amountPaid);
  let cashAmount = money(payload.cashAmount);
  let visaAmount = money(payload.visaAmount);
  let cliqAmount = money(payload.cliqAmount);
  let debtAmount = money(payload.debtAmount);
  const hasExplicitBuckets = [payload.cashAmount, payload.visaAmount, payload.cliqAmount, payload.debtAmount].some(
    (v) => typeof v === "number",
  );
  if (!hasExplicitBuckets) {
    cashAmount = buckets.cash;
    visaAmount = buckets.visa;
    cliqAmount = buckets.cliq;
    debtAmount = buckets.debt;
  }

  const itemDiscount = round2(items.reduce((sum, item) => sum + money(item.discount), 0));
  const invoiceDiscount = round2(Math.max(0, discount - itemDiscount));
  const fiscal = computeFiscalBreakdown(items, invoiceDiscount, 16);
  const itemRows = [];
  let grossProfit = 0;
  let itemCount = 0;
  for (const [index, item] of items.entries()) {
    const barcode = text(item.barcode);
    const meta = barcodeMeta.get(barcode);
    const qty = Number.isFinite(item.qty) ? item.qty : 0;
    const unitPrice = money(item.unitPrice);
    const lineSubtotal = round2(qty * unitPrice);
    const fiscalLine = fiscal.lines[index];
    const lineDiscount = round2(money(item.discount) + (fiscalLine?.invoiceDiscount ?? 0));
    const lineTotal = fiscalLine?.gross ?? money(item.lineTotal);
    const netTotal = fiscalLine?.net ?? lineTotal;
    const taxAmount = fiscalLine?.tax ?? 0;
    const costPrice = meta?.cost ?? 0;
    const costTotal = round2(qty * costPrice);
    const lineProfit = round2(netTotal - costTotal);
    grossProfit = round2(grossProfit + lineProfit);
    itemCount = round2(itemCount + Math.abs(qty));
    itemRows.push({
      store_id: storeId,
      line_no: index + 1,
      product_id: uuidOrNull(item.productId),
      product_name: text(item.name),
      barcode,
      variant_label: text(item.variantLabel) || meta?.variantLabel || "",
      unit_name: text(item.unitName),
      qty,
      multiplier: meta?.multiplier ?? 1,
      unit_price: unitPrice,
      line_subtotal: lineSubtotal,
      line_discount: lineDiscount,
      line_total: lineTotal,
      net_total: netTotal,
      tax_percent: fiscalLine?.taxPercent ?? 0,
      tax_included: fiscalLine?.taxIncluded ?? false,
      tax_amount: taxAmount,
      cost_price: costPrice,
      cost_total: costTotal,
      gross_profit: lineProfit,
    });
  }

  const payments = [
    { method: "CASH", amount: cashAmount },
    { method: "VISA", amount: visaAmount },
    { method: "CLIQ", amount: cliqAmount },
    { method: "DEBT", amount: debtAmount },
  ].filter((payment) => payment.amount !== 0);
  if (payments.length === 0) {
    payments.push({ method: "UNKNOWN", amount: total });
  }

  // The row may already exist (retry after a failed ack, or a batch retry
  // racing us): verify the child rows and backfill whatever the earlier
  // attempt left behind so the ledger never holds a bare invoice.
  const existing = await db
    .from("sales_invoices")
    .select("id")
    .eq("sync_id", event.sync_id)
    .eq("store_id", storeId)
    .maybeSingle();
  if (existing.error) return { recorded: false, error: existing.error.message };

  if (existing.data?.id) {
    const backfillError = await ensureInvoiceChildren(db, existing.data.id, itemRows, payments, storeId);
    if (backfillError) return { recorded: false, error: backfillError };
    return { recorded: true };
  }

  const inserted = await db
    .from("sales_invoices")
    .insert({
      sync_id: event.sync_id,
      store_id: storeId,
      branch_id: uuidOrNull(payload.branchId),
      terminal_id: uuidOrNull(payload.terminalId),
      shift_id: uuidOrNull(payload.shiftId),
      cashier_id: uuidOrNull(payload.cashierId),
      cashier_name: text(payload.cashierName ?? event.cashierName),
      customer_id: uuidOrNull(payload.customerId),
      customer_name: text(payload.customerName),
      customer_phone: text(payload.customerPhone),
      payment_method: ["CASH", "VISA", "SPLIT", "DEBT", "CLIQ"].includes(paymentMethod) ? paymentMethod : "UNKNOWN",
      subtotal,
      tax,
      discount,
      delivery_fee: deliveryFee,
      total,
      amount_paid: amountPaid,
      change_amount: money(payload.change),
      cash_amount: cashAmount,
      visa_amount: visaAmount,
      cliq_amount: cliqAmount,
      debt_amount: debtAmount,
      item_count: itemCount,
      // Delivery fees are revenue with no product cost: included in profit.
      gross_profit: round2(grossProfit + deliveryFee),
      is_return: total < 0,
      is_cancellation: Boolean(payload.isCancellation),
      original_invoice_sync_id: uuidOrNull(payload.originalInvoiceId),
      completed_at: text(payload.completed_at) || new Date().toISOString(),
      payload,
    })
    .select("id")
    .single();

  if (inserted.error) {
    if (inserted.error.code === "23505") {
      // Insert raced with another retry — the row exists; backfill children.
      const { data, error } = await db
        .from("sales_invoices")
        .select("id")
        .eq("sync_id", event.sync_id)
        .eq("store_id", storeId)
        .maybeSingle();
      if (error || !data) {
        return { recorded: false, error: error?.message ?? "invoice_missing_after_unique_violation" };
      }
      const backfillError = await ensureInvoiceChildren(db, data.id, itemRows, payments, storeId);
      if (backfillError) return { recorded: false, error: backfillError };
      return { recorded: true };
    }
    return { recorded: false, error: inserted.error.message };
  }

  const invoiceId = inserted.data.id;
  const childrenError = await ensureInvoiceChildren(db, invoiceId, itemRows, payments, storeId);
  if (childrenError) return { recorded: false, error: childrenError };

  return { recorded: true };
}

/**
 * Stamp a fast-path ISTD result carried on the queued payload onto the
 * ledger row. The invoice was already cleared online when possible; this
 * only backfills the columns the mirror insert could not have known about.
 */
async function stampCarriedIstd(
  db: SupabaseClient,
  event: SyncQueueRecord,
  storeId: string,
): Promise<void> {
  if (event.action_type !== "INVOICE_CREATED") return;
  const payload = event.payload as InvoiceCreatedPayload;
  if (!payload.istd_uuid) return;
  await db
    .from("sales_invoices")
    .update({
      istd_uuid: payload.istd_uuid,
      istd_qr: payload.istd_qr ?? null,
      istd_submitted_at: new Date().toISOString(),
    })
    .eq("sync_id", event.sync_id)
    .eq("store_id", storeId);
}

/**
 * Ensure an invoice's line items and payment rows exist. Retries after a
 * partial mirror (invoice row saved but items/payments failed) backfill only
 * the missing children — never duplicating rows that already landed.
 */
async function ensureInvoiceChildren(
  db: SupabaseClient,
  invoiceId: string,
  itemRows: Array<Record<string, unknown>>,
  payments: Array<{ method: string; amount: number }>,
  storeId: string,
): Promise<string | null> {
  const [itemRes, paymentRes] = await Promise.all([
    db.from("sales_invoice_items").select("id").eq("invoice_id", invoiceId).limit(1),
    db.from("sales_payments").select("id").eq("invoice_id", invoiceId).limit(1),
  ]);
  if (itemRes.error) return itemRes.error.message;
  if (paymentRes.error) return paymentRes.error.message;

  if ((itemRes.data?.length ?? 0) === 0 && itemRows.length > 0) {
    const { error } = await db
      .from("sales_invoice_items")
      .insert(itemRows.map((row) => ({ ...row, invoice_id: invoiceId })));
    if (error) return error.message;
  }

  if ((paymentRes.data?.length ?? 0) === 0 && payments.length > 0) {
    const { error } = await db
      .from("sales_payments")
      .insert(
        payments.map((payment) => ({
          invoice_id: invoiceId,
          store_id: storeId,
          method: payment.method,
          amount: payment.amount,
        })),
      );
    if (error) return error.message;
  }

  return null;
}

/**
 * Mirror a DEBT event into the customer ledger (customers +
 * customer_transactions). INVOICE_CREATED on credit raises the balance;
 * DEBT_SETTLEMENT (a cash payment) lowers it.
 */
async function recordDebtLedger(
  db: SupabaseClient,
  event: SyncQueueRecord,
  storeId: string,
): Promise<{ recorded: boolean; error?: string }> {
  const payload = event.payload as {
    paymentMethod?: string;
    customerName?: string;
    customerId?: string;
    customerPhone?: string;
    total?: number;
    amount?: number;
    shiftId?: string;
  };

  const isDebtSale = event.action_type === "INVOICE_CREATED" && payload.paymentMethod === "DEBT";
  const isSettlement = event.action_type === "DEBT_SETTLEMENT";
  if (!isDebtSale && !isSettlement) return { recorded: false };

  const customerName = (payload.customerName ?? "").trim();
  const amount = round2(isDebtSale ? payload.total ?? 0 : payload.amount ?? 0);
  // Negative totals are returns on credit: they must reverse the balance.
  if (!customerName || amount === 0) return { recorded: false };

  // Resolve the customer: by id when known, else upsert by name.
  let customerId: string | null = payload.customerId?.trim() || null;
  if (customerId) {
    const { data, error } = await db
      .from("customers")
      .select("id,balance")
      .eq("id", customerId)
      .eq("store_id", storeId)
      .maybeSingle();
    if (error) return { recorded: false, error: error.message };
    if (!data) customerId = null;
    else customerId = data.id;
  }
  if (!customerId) {
    const { data, error } = await db
      .from("customers")
      .select("id,balance")
      .eq("name", customerName)
      .eq("store_id", storeId)
      .maybeSingle();
    if (error) return { recorded: false, error: error.message };
    customerId = data?.id ?? null;
    if (!customerId) {
      const ins = await db
        .from("customers")
        .insert({
          name: customerName,
          phone: typeof payload.customerPhone === "string" ? payload.customerPhone.trim() : "",
          balance: 0,
          store_id: storeId,
        })
        .select("id,balance")
        .single();
      if (ins.error) return { recorded: false, error: ins.error.message };
      customerId = ins.data.id;
    }
  }

  // Atomic, idempotent ledger append. The RPC serializes concurrent
  // terminals on a row lock, clamps settlements to the live balance and
  // rolls the balance forward RELATIVELY (never an absolute overwrite), so
  // two queues draining at the same millisecond cannot lose an update — and
  // a retried event replays as the original ledger effect via its key.
  // A customer deleted mid-queue surfaces as P0002 (deterministic failure).
  const marker = `sync:${event.sync_id}`;
  const description = isDebtSale
    ? amount < 0
      ? "مرتجع ذمة"
      : "فاتورة آجلة"
    : "سداد ذمة";
  const { error: ledgerError } = await db.rpc("apply_customer_ledger_event", {
    p_store_id: storeId,
    p_customer_id: customerId,
    p_type: isDebtSale ? "SALE_DEBT" : "SETTLEMENT",
    p_amount: amount,
    p_description: `${description} • ${marker}`,
    p_shift_id: payload.shiftId ?? null,
    p_idempotency_key: marker,
  });
  if (ledgerError) return { recorded: false, error: ledgerError.message };
  return { recorded: true };
}

/** Mirror a drawer expense into the expenses ledger. */
async function recordExpenseLedger(
  db: SupabaseClient,
  event: SyncQueueRecord,
  storeId: string,
): Promise<{ recorded: boolean; error?: string }> {
  if (event.action_type !== "EXPENSE_RECORDED") return { recorded: false };

  const payload = event.payload as {
    expenseId?: string;
    cashierId?: string | null;
    category?: string;
    amount?: number;
    notes?: string;
    shiftId?: string;
    created_at?: string;
  };
  const expenseId = (payload.expenseId ?? "").trim();
  const amount = round2(payload.amount ?? 0);
  const category = (payload.category ?? "").trim();
  if (!expenseId || !Number.isFinite(amount) || amount <= 0 || !category) return { recorded: false };

  // Deterministic id: retries after a failed ack simply hit the existing row.
  const { error } = await db
    .from("expenses")
    .upsert(
      {
        id: expenseId,
        store_id: storeId,
        cashier_id: payload.cashierId ?? null,
        category,
        amount,
        notes: payload.notes ?? null,
        shift_id: payload.shiftId ?? null,
        created_at: payload.created_at ?? new Date().toISOString(),
      },
      { onConflict: "id", ignoreDuplicates: true },
    );
  if (error) return { recorded: false, error: error.message };
  return { recorded: true };
}

/** Mirror a manual cash drawer movement (deposit/withdrawal) into cash_movements. */
async function recordCashMovementLedger(
  db: SupabaseClient,
  event: SyncQueueRecord,
  storeId: string,
): Promise<{ recorded: boolean; error?: string }> {
  if (event.action_type !== "CASH_MOVEMENT") return { recorded: false };

  const payload = event.payload as {
    movementId?: string;
    shiftId?: string;
    type?: string;
    amount?: number;
    reason?: string;
    notes?: string;
    cashierId?: string | null;
    cashierName?: string;
    created_at?: string;
    branchId?: string;
    terminalId?: string;
  };
  const movementId = (payload.movementId ?? "").trim();
  const shiftId = (payload.shiftId ?? "").trim();
  const type = (payload.type ?? "").trim();
  const amount = round2(payload.amount ?? 0);
  if (!movementId || !shiftId || !type || !Number.isFinite(amount) || amount <= 0) return { recorded: false };
  if (type !== "CASH_IN" && type !== "CASH_OUT") return { recorded: false };

  const { error } = await db
    .from("cash_movements")
    .upsert(
      {
        id: movementId,
        store_id: storeId,
        shift_id: shiftId,
        type,
        amount,
        reason: payload.reason ?? "",
        notes: payload.notes ?? "",
        cashier_id: payload.cashierId ?? null,
        cashier_name: payload.cashierName ?? "",
        branch_id: payload.branchId ?? null,
        terminal_id: payload.terminalId ?? null,
        created_at: payload.created_at ?? new Date().toISOString(),
      },
      { onConflict: "id", ignoreDuplicates: true },
    );
  if (error) return { recorded: false, error: error.message };
  return { recorded: true };
}

/**
 * Mirror an inline vendor creation (goods-in picker) into the suppliers
 * ledger. Idempotent on the client-generated id: a retry after a failed ack
 * simply hits the existing row, and the SUPPLIER_INVOICE_CREATED queued right
 * after it (same offline batch) always finds its vendor row — even when the
 * invoice event drains first, this runs in queue order because FIFO holds.
 */
async function mirrorSupplierUpsert(
  db: SupabaseClient,
  event: SyncQueueRecord,
  storeId: string,
): Promise<{ recorded: boolean; error?: string }> {
  if (event.action_type !== "SUPPLIER_CREATE") return { recorded: false };

  const payload = event.payload as SupplierCreatePayload;
  const id = text(payload.id);
  const name = text(payload.name);
  if (!id || !name) return { recorded: false, error: "supplier_create_invalid" };

  const { error } = await db.from("suppliers").upsert(
    {
      id,
      store_id: storeId,
      name,
      phone: text(payload.phone),
      balance: 0,
      created_at: payload.created_at || new Date().toISOString(),
    },
    { onConflict: "id", ignoreDuplicates: true },
  );
  if (error) return { recorded: false, error: error.message };
  return { recorded: true };
}

/**
 * Mirror a committed goods-in draft (Smart Receiving) into the supplier
 * accounting + inventory ledgers. The event carries everything the device
 * captured offline; every step is idempotent so retries after a failed ack
 * can never double-post stock, balances, or drawer deductions.
 *
 * Order matters: (1) Quick-Add products must exist before the invoice rows
 * reference them, (2) the invoice + items + supplier balance land before the
 * cash payment, (3) the cash payment precedes the drawer-deduction expense
 * and the PURCHASE_RECEIPT stock so a mid-mirror retry only ever backfills.
 */
async function mirrorSupplierReceiving(
  db: SupabaseClient,
  event: SyncQueueRecord,
  storeId: string,
): Promise<{ recorded: boolean; error?: string }> {
  if (event.action_type !== "SUPPLIER_INVOICE_CREATED") return { recorded: false };

  const payload = event.payload as SupplierInvoiceCreatedPayload;
  const supplierId = text(payload.supplierId);
  const invoiceNumber = text(payload.invoiceNumber);
  if (!supplierId || !invoiceNumber) {
    return { recorded: false, error: "supplier_invoice_missing_identity" };
  }

  const { data: supplier, error: supplierError } = await db
    .from("suppliers")
    .select("id")
    .eq("id", supplierId)
    .eq("store_id", storeId)
    .maybeSingle();
  if (supplierError) return { recorded: false, error: supplierError.message };
  if (!supplier) return { recorded: false, error: "supplier_not_found" };

  const fallbackDate = new Date().toISOString().slice(0, 10);
  const invoiceDate = /^\d{4}-\d{2}-\d{2}$/.test(text(payload.invoiceDate)) ? text(payload.invoiceDate) : fallbackDate;
  const dueDate = /^\d{4}-\d{2}-\d{2}$/.test(text(payload.dueDate)) ? text(payload.dueDate) : invoiceDate;

  // 1. Quick-Add products (unknown barcodes). Deterministic: reuse an
  //    existing barcode row, otherwise create product + default barcode.
  const newProducts = Array.isArray(payload.newProducts) ? payload.newProducts : [];
  const createdBarcodeToProduct: Record<string, string> = {};
  if (newProducts.length > 0) {
    const skus = newProducts.map((np) => text(np.sku)).filter(Boolean);
    if (skus.length > 0) {
      const { data: existingVariants, error: bcError } = await db
        .from("product_variants")
        .select("barcode,product_id")
        .eq("store_id", storeId)
        .in("barcode", skus);
      if (bcError) return { recorded: false, error: bcError.message };
      for (const row of existingVariants ?? []) {
        createdBarcodeToProduct[text(row.barcode)] = text(row.product_id);
      }
    }

    // Phase A — on-the-fly parents (smart quick-add). A child references its
    // parent either by an existing catalog id (`parentId`) or by a brand-new
    // group name (`parentName`). Draft parents resolve ONCE per name: an
    // exact-name match reuses an existing non-variant product, otherwise a
    // new variant-root parent is created. The label seen-set is seeded from
    // the parent's existing children so a retry or a later invoice can never
    // collide on uq_products_store_parent_variant.
    type ResolvedParent = { parentId: string | null; parentName: string; usedLabels: Set<string> };
    const resolvedParents = new Map<string, ResolvedParent>();

    const nextLabel = (used: Set<string>, label: string): string => {
      let candidate = label;
      let suffix = 2;
      while (used.has(candidate)) {
        candidate = `${label} (${suffix})`;
        suffix += 1;
      }
      used.add(candidate);
      return candidate;
    };

    const resolveParent = async (
      np: (typeof newProducts)[number],
    ): Promise<ResolvedParent | { error: string }> => {
      const parentId = text(np.brandId) || null;
      const parentName = text(np.parentName);
      if (!parentId && !parentName) return { parentId: null, parentName: "", usedLabels: new Set() };

      const key = parentId ? `id:${parentId}` : `name:${parentName.toLowerCase()}`;
      const cached = resolvedParents.get(key);
      if (cached) return cached;

      let resolvedId: string;
      if (parentId) {
        const { data: parent, error: parentError } = await db
          .from("products")
          .select("id")
          .eq("id", parentId)
          .eq("store_id", storeId)
          .maybeSingle();
        if (parentError) return { error: parentError.message };
        if (!parent) return { error: "variant_parent_not_found" };
        resolvedId = parent.id;
      } else {
        // Smart reuse: a typed group name that already exists as a standalone
        // product becomes that product. Only non-variant rows are eligible.
        const { data: byName, error: nameError } = await db
          .from("products")
          .select("id,parent_id")
          .eq("store_id", storeId)
          .eq("name", parentName)
          .limit(5);
        if (nameError) return { error: nameError.message };
        const matched = (byName ?? []).find((row) => row.parent_id === null);
        if (matched) {
          resolvedId = text(matched.id);
        } else {
          const { data: created, error: createError } = await db
            .from("products")
            .insert({
              id: crypto.randomUUID(),
              store_id: storeId,
              category_id: null,
              name: parentName,
              base_unit: text(np.baseUnit) || "حبة",
              tax_percent: money(np.taxPercent),
              tax_included: true,
              total_stock: 0,
              default_supplier_id: supplierId,
              is_purchasable: true,
              show_in_pos: true,
              is_sellable: true,
              allow_price_change: false,
              reorder_level: 0,
              parent_id: null,
              variant_label: "",
              is_variant_root: true,
            })
            .select("id")
            .single();
          if (createError) return { error: createError.message };
          resolvedId = text(created.id);
        }
      }

      // Idempotent: mark the parent as a variant root (a reuse of an existing
      // standalone product must start grouping children).
      const { error: rootError } = await db
        .from("products")
        .update({ is_variant_root: true })
        .eq("id", resolvedId)
        .eq("store_id", storeId);
      if (rootError) return { error: rootError.message };

      // Seed the dedupe set from the parent's existing children.
      const usedLabels = new Set<string>();
      const { data: children, error: childrenError } = await db
        .from("products")
        .select("variant_label")
        .eq("store_id", storeId)
        .eq("parent_id", resolvedId);
      if (childrenError) return { error: childrenError.message };
      for (const child of children ?? []) {
        const label = text(child.variant_label);
        if (label) usedLabels.add(label);
      }

      const resolved: ResolvedParent = {
        parentId: resolvedId,
        parentName: parentName || parentId || "",
        usedLabels,
      };
      resolvedParents.set(key, resolved);
      return resolved;
    };

    for (const np of newProducts) {
      const sku = text(np.sku);
      const name = text(np.name);
      if (!sku || !name) return { recorded: false, error: "quick_add_invalid" };
      if (createdBarcodeToProduct[sku]) continue;

      const parentRef = await resolveParent(np);
      if ("error" in parentRef) return { recorded: false, error: parentRef.error };
      const parentId = parentRef.parentId;

      // Variant label: an explicit override wins, otherwise derive it from
      // the child name against the parent name (smart on-the-fly).
      const overrideLabel = text(np.variantLabel);
      const variantLabel = parentId
        ? nextLabel(
            parentRef.usedLabels,
            overrideLabel ? overrideLabel.slice(0, 112) : deriveVariantLabel(name, parentRef.parentName),
          )
        : "";

      const productId = crypto.randomUUID();
      const { error: productError } = await db.from("products").insert({
        id: productId,
        store_id: storeId,
        category_id: null,
        name,
        base_unit: text(np.baseUnit) || "حبة",
        tax_percent: money(np.taxPercent),
        tax_included: true,
        total_stock: 0,
        default_supplier_id: supplierId,
        is_purchasable: true,
        show_in_pos: true,
        is_sellable: true,
        allow_price_change: false,
        reorder_level: 0,
        parent_id: parentId,
        variant_label: variantLabel,
        is_variant_root: false,
      });
      if (productError) return { recorded: false, error: productError.message };

      const { error: variantError } = await db.from("product_variants").insert({
        barcode: sku,
        store_id: storeId,
        product_id: productId,
        variant_label: variantLabel,
      });
      if (variantError) return { recorded: false, error: variantError.message };

      const { error: priceError } = await db
        .from("products")
        .update({
          cost_price: money(np.unitCost),
          selling_price: money(np.retailPrice),
          wholesale_price: money(np.unitCost),
        })
        .eq("id", productId)
        .eq("store_id", storeId);
      if (priceError) return { recorded: false, error: priceError.message };
      createdBarcodeToProduct[sku] = productId;
    }
  }

  // 2. Invoice + items + supplier balance. The unique index on
  //    (store_id, supplier_id, invoice_number) makes this idempotent: a retry
  //    finds the row and only backfills children.
  const existing = await db
    .from("supplier_invoices")
    .select("id,status")
    .eq("store_id", storeId)
    .eq("supplier_id", supplierId)
    .eq("invoice_number", invoiceNumber)
    .maybeSingle();
  if (existing.error) return { recorded: false, error: existing.error.message };

  if (!existing.data) {
    const rpcResult = await db.rpc("create_supplier_invoice", {
      p_store_id: storeId,
      p_supplier_id: supplierId,
      p_invoice_number: invoiceNumber,
      p_invoice_date: invoiceDate,
      p_due_date: dueDate,
      p_notes: text(payload.notes) || null,
      p_purchase_order_id: null,
      p_items: payload.lines.map((line) => ({
        productId: line.productId ?? createdBarcodeToProduct[text(line.barcode)] ?? null,
        description: line.description,
        quantity: line.quantity,
        unitCost: line.unitCost,
        taxPercent: line.taxPercent,
      })),
    });
    if (rpcResult.error && rpcResult.error.code !== "23505") {
      return { recorded: false, error: rpcResult.error.message };
    }
  }

  const invoice = await db
    .from("supplier_invoices")
    .select("id")
    .eq("store_id", storeId)
    .eq("supplier_id", supplierId)
    .eq("invoice_number", invoiceNumber)
    .maybeSingle();
  if (invoice.error) return { recorded: false, error: invoice.error.message };
  if (!invoice.data) return { recorded: false, error: "supplier_invoice_missing" };
  const invoiceId = invoice.data.id;

  // 3. Items backfill (retry after the invoice landed but items did not).
  const itemCheck = await db
    .from("supplier_invoice_items")
    .select("id")
    .eq("invoice_id", invoiceId)
    .limit(1);
  if (itemCheck.error) return { recorded: false, error: itemCheck.error.message };
  if ((itemCheck.data?.length ?? 0) === 0) {
    const { error: itemError } = await db.from("supplier_invoice_items").insert(
      payload.lines.map((line, index) => ({
        invoice_id: invoiceId,
        store_id: storeId,
        line_no: index + 1,
        product_id: line.productId ?? createdBarcodeToProduct[text(line.barcode)] ?? null,
        description: line.description,
        quantity: line.quantity,
        unit_cost: line.unitCost,
        tax_percent: line.taxPercent,
        net_amount: money(line.netAmount),
        tax_amount: money(line.taxAmount),
        total_amount: money(line.totalAmount),
      })),
    );
    if (itemError) return { recorded: false, error: itemError.message };
  }

  // 4. Payment center: every method is recorded against the invoice, each
  //    capped at the remaining balance due. Marker references keep retries
  //    idempotent (CASH reuses `sync:<id>` so pre-Phase-3.5 events never
  //    double-record; every other entry is indexed by method).
  const cashPaid = money(payload.cashPaid);
  const paymentsToRecord = Array.isArray(payload.payments) && payload.payments.length > 0
    ? payload.payments
    : cashPaid > 0
      ? [{ method: "CASH" as const, amount: cashPaid }]
      : [];
  if (paymentsToRecord.length > 0) {
    const { data: invoiceRow, error: invoiceFetchError } = await db
      .from("supplier_invoices")
      .select("balance_due")
      .eq("store_id", storeId)
      .eq("id", invoiceId)
      .maybeSingle();
    if (invoiceFetchError) return { recorded: false, error: invoiceFetchError.message };
    let remainingBalance = money(invoiceRow?.balance_due);

    for (const [index, payment] of paymentsToRecord.entries()) {
      const method = text(payment.method) || "CASH";
      const amount = money(payment.amount);
      if (amount <= 0 || remainingBalance <= 0) continue;
      const payAmount = Math.min(amount, remainingBalance);
      const marker = method === "CASH" && index === 0
        ? `sync:${event.sync_id}`
        : `sync:${event.sync_id}:${method}:${index}`;
      const paymentCheck = await db
        .from("supplier_payments")
        .select("id")
        .eq("invoice_id", invoiceId)
        .eq("store_id", storeId)
        .ilike("reference", `%${marker}%`)
        .maybeSingle();
      if (paymentCheck.error) return { recorded: false, error: paymentCheck.error.message };
      if (!paymentCheck.data) {
        const paymentResult = await db.rpc("record_supplier_payment", {
          p_store_id: storeId,
          p_invoice_id: invoiceId,
          p_amount: payAmount,
          p_method: method,
          p_reference: marker,
          p_notes: null,
          p_paid_at: text(payload.created_at) || new Date().toISOString(),
        });
        if (paymentResult.error) return { recorded: false, error: paymentResult.error.message };
      }
      remainingBalance = round2(remainingBalance - payAmount);
    }
  }

  // 5. Cash Drawer Integration: the money paid out of the register is a
  //    shift-bound expense, so the cashier's Z-report counts it in `expenses`
  //    and the expected drawer drops — no reconciliation shortfall.
  const dd = payload.drawerDeduction;
  if (cashPaid > 0 && dd) {
    const drawerExpenseId = text(dd.expenseId);
    const shiftId = text(dd.shiftId);
    if (!drawerExpenseId || !shiftId) {
      return { recorded: false, error: "drawer_deduction_incomplete" };
    }
    const { error: drawerError } = await db.from("expenses").upsert(
      {
        id: drawerExpenseId,
        store_id: storeId,
        cashier_id: uuidOrNull(dd.cashierId),
        category: "مشتريات",
        amount: money(dd.amount),
        notes: text(dd.notes) || `دفعة نقدية للمورد • ${invoiceNumber}`,
        shift_id: uuidOrNull(shiftId),
        created_at: text(dd.created_at) || new Date().toISOString(),
      },
      { onConflict: "id", ignoreDuplicates: true },
    );
    if (drawerError) return { recorded: false, error: drawerError.message };
  }

  // 6. PURCHASE_RECEIPT stock, idempotent per line via the movement key.
  //    Quantity is converted to the base unit (pack lines carry unitMultiplier),
  //    so the stock ledger always moves in base units.
  for (const [index, line] of payload.lines.entries()) {
    const productId = line.productId ?? createdBarcodeToProduct[text(line.barcode)] ?? null;
    if (!productId) continue;
    const multiplier = typeof line.unitMultiplier === "number" && line.unitMultiplier > 0 ? line.unitMultiplier : 1;
    const baseQuantity = (line.quantity ?? 0) * multiplier;
    const movement = await db.rpc("record_inventory_movement", {
      p_store_id: storeId,
      p_product_id: productId,
      p_quantity_delta: baseQuantity,
      p_movement_type: "PURCHASE_RECEIPT",
      p_idempotency_key: `receiving:${event.sync_id}:${index + 1}`,
      p_unit_quantity: line.quantity,
      p_barcode: text(line.barcode) || null,
      p_reference_type: "SUPPLIER_INVOICE",
      p_reference_id: event.sync_id,
      p_branch_id: uuidOrNull(payload.branchId),
      p_terminal_id: uuidOrNull(payload.terminalId),
      p_actor_id: uuidOrNull(payload.cashierId),
      p_actor_name: text(payload.cashierName ?? event.cashierName),
      p_reason: "استلام بضاعة من مورد",
      p_occurred_at: text(payload.created_at) || new Date().toISOString(),
      p_metadata: { line: index + 1, supplierName: payload.supplierName, invoiceNumber },
      p_allow_negative: false,
    });
    if (movement.error) return { recorded: false, error: movement.error.message };
  }

  // 7. Cost/retail price sync on the received barcodes. Cost is converted to
  //    the base unit (pack cost ÷ pack size), and any change is mirrored into
  //    the immutable admin audit log as a RECEIVING_PRICE_UPDATE.
  for (const line of payload.lines) {
    if (!line.applyCost) continue;
    const barcode = text(line.barcode);
    const multiplier = typeof line.unitMultiplier === "number" && line.unitMultiplier > 0 ? line.unitMultiplier : 1;
    const baseCost = money((line.unitCost ?? 0) / multiplier);
    const newRetail = typeof line.newRetailPrice === "number" && line.newRetailPrice > 0
      ? money(line.newRetailPrice)
      : null;

    const { data: variantRow } = await db
      .from("product_variants")
      .select("product_id")
      .eq("store_id", storeId)
      .eq("barcode", barcode)
      .maybeSingle();
    const resolvedProductId = variantRow?.product_id ?? null;

    const { data: productRow } = resolvedProductId
      ? await db
          .from("products")
          .select("cost_price,selling_price")
          .eq("id", resolvedProductId)
          .eq("store_id", storeId)
          .maybeSingle()
      : { data: null };
    const oldCost = money(productRow?.cost_price);
    const oldRetail = money(productRow?.selling_price);
    if (newRetail !== null && newRetail === oldRetail && baseCost === oldCost) continue;

    if (resolvedProductId) {
      const patch: Record<string, number> = { cost_price: baseCost };
      if (newRetail !== null) patch.selling_price = newRetail;
      const { error: priceError } = await db
        .from("products")
        .update(patch)
        .eq("id", resolvedProductId)
        .eq("store_id", storeId);
      if (priceError) return { recorded: false, error: priceError.message };
    }

    try {
      const { error: auditError } = await db.from("admin_audit_logs").insert({
        store_id: storeId,
        admin_id: null,
        admin_name: text(payload.cashierName ?? event.cashierName) || null,
        action_type: "RECEIVING_PRICE_UPDATE",
        target_id: resolvedProductId || barcode,
        details: {
          barcode,
          oldCost,
          newCost: baseCost,
          oldRetail,
          newRetail,
          supplierName: text(payload.supplierName),
          invoiceNumber,
          syncId: event.sync_id,
          currency: "JOD",
        },
      });
      if (auditError) return { recorded: false, error: auditError.message };
    } catch {
      // The price mutation itself landed; a failed audit row must not fail the
      // whole receiving event.
    }
  }

  return { recorded: true };
}

/**
 * Write a cashier's SHORTAGE_FLAGGED event into the durable `shortage_flags`
 * radar. Idempotent on `source_event_id` so an offline re-sync of the same
 * event can never duplicate the flag; repeated flags on the same product from
 * different events stay as separate rows (the radar takes the latest).
 */
async function mirrorShortageFlag(
  db: SupabaseClient,
  event: SyncQueueRecord,
  storeId: string,
): Promise<{ recorded: boolean; error?: string }> {
  if (event.action_type !== "SHORTAGE_FLAGGED") return { recorded: false };

  const payload = event.payload as ShortageFlaggedPayload;
  const productId = text(payload.productId);
  if (!productId) return { recorded: false, error: "shortage_product_id_missing" };

  const created_at = text(payload.created_at) || new Date().toISOString();
  const cashierName = text(payload.cashierName) || text(event.cashierName);
  const { error } = await db.from("shortage_flags").upsert(
    {
      store_id: storeId,
      source_event_id: uuidOrNull(event.sync_id),
      product_id: productId,
      product_name: text(payload.productName),
      current_stock: Math.max(0, money(payload.currentStock)),
      reason: text(payload.reason) || null,
      cashier_id: uuidOrNull(payload.cashierId),
      cashier_name: cashierName,
      branch_id: uuidOrNull(payload.branchId),
      terminal_id: uuidOrNull(payload.terminalId),
      resolved: false,
      created_at,
    },
    { onConflict: "source_event_id", ignoreDuplicates: true },
  );
  if (error) return { recorded: false, error: error.message };
  return { recorded: true };
}

/**
 * Land a remote barcode-label print request into the `print_jobs` queue.
 * The event's payload is already self-contained (barcode, name, variant,
 * unit, price, qty, template size), so the /print-server kiosk renders it
 * without re-fetching the product. Idempotent on the event's sync_id: the
 * kiosk could re-claim on a network hiccup, but a re-mirrored event must
 * never double-queue labels.
 */
async function mirrorPrintJob(
  db: SupabaseClient,
  event: SyncQueueRecord,
  storeId: string,
): Promise<{ recorded: boolean; error?: string }> {
  if (event.action_type !== "BARCODE_LABEL_PRINT") return { recorded: false };

  const payload = event.payload as BarcodeLabelPrintPayload;
  const barcode = text(payload.barcode);
  const name = text(payload.name);
  if (!barcode || !name) return { recorded: false, error: "label_print_invalid" };

  const jobPayload = {
    barcode,
    name,
    variantLabel: text(payload.variantLabel) || undefined,
    unitName: text(payload.unitName) || "حبة",
    price: money(payload.price),
    quantity: Math.max(1, Math.floor(Number(payload.quantity) || 1)),
    templateSize: {
      widthMm: Math.max(1, money(payload.templateSize?.widthMm)),
      heightMm: Math.max(1, money(payload.templateSize?.heightMm)),
    },
  };

  const { error } = await db.from("print_jobs").upsert(
    {
      store_id: storeId,
      kind: "BARCODE_LABEL",
      status: "QUEUED",
      payload: jobPayload,
      priority: 0,
      attempts: 0,
      source_event_id: uuidOrNull(event.sync_id),
      created_at: text(payload.created_at) || new Date().toISOString(),
    },
    { onConflict: "source_event_id", ignoreDuplicates: true },
  );
  if (error) return { recorded: false, error: error.message };
  return { recorded: true };
}

interface ShiftLedgerSums {
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
  cashInTotal: number;
  cashOutTotal: number;
}

async function computeShiftLedgerSums(
  db: SupabaseClient,
  storeId: string,
  shiftId: string,
  fallbackStartingCash: number,
): Promise<ShiftLedgerSums | { error: string }> {
  const [invoices, expenses, settlements, opened, cashMovements] = await Promise.all([
    db.from("sales_invoices").select("cash_amount,visa_amount,cliq_amount,debt_amount,total,discount,is_return")
      .eq("store_id", storeId).eq("shift_id", shiftId),
    db.from("expenses").select("amount")
      .eq("store_id", storeId).eq("shift_id", shiftId),
    db.from("customer_transactions").select("amount")
      .eq("store_id", storeId).eq("shift_id", shiftId).eq("type", "SETTLEMENT"),
    db.from("sync_events").select("payload")
      .eq("store_id", storeId).eq("action_type", "SHIFT_OPENED")
      .eq("payload->>shiftId", shiftId).maybeSingle(),
    db.from("cash_movements").select("type,amount")
      .eq("store_id", storeId).eq("shift_id", shiftId),
  ]);

  for (const result of [invoices, expenses, settlements, opened, cashMovements]) {
    if (result.error) return { error: result.error.message };
  }

  const invoiceRows = (invoices.data ?? []) as Array<{ cash_amount?: number; visa_amount?: number; cliq_amount?: number; debt_amount?: number; total?: number; discount?: number; is_return?: boolean }>;
  const expenseRows = (expenses.data ?? []) as Array<{ amount?: number }>;
  const settlementRows = (settlements.data ?? []) as Array<{ amount?: number }>;
  const cashMovementRows = (cashMovements.data ?? []) as Array<{ type?: string; amount?: number }>;

  const startingCash = money(
    (opened.data?.payload as { startingCash?: number } | undefined)?.startingCash ?? fallbackStartingCash,
  );

  return {
    startingCash,
    cashSales: round2(invoiceRows.reduce((sum, row) => sum + money(row.cash_amount), 0)),
    visaSales: round2(invoiceRows.reduce((sum, row) => sum + money(row.visa_amount), 0)),
    cliqSales: round2(invoiceRows.reduce((sum, row) => sum + money(row.cliq_amount), 0)),
    debtSales: round2(invoiceRows.reduce((sum, row) => sum + money(row.debt_amount), 0)),
    debtCollections: round2(settlementRows.reduce((sum, row) => sum + money(row.amount), 0)),
    totalSales: round2(invoiceRows.reduce((sum, row) => sum + money(row.total), 0)),
    discounts: round2(invoiceRows.reduce((sum, row) => sum + Math.abs(money(row.discount)), 0)),
    returns: round2(invoiceRows.reduce(
      (sum, row) => sum + (row.is_return || money(row.total) < 0 ? Math.abs(money(row.total)) : 0),
      0,
    )),
    expenses: round2(expenseRows.reduce((sum, row) => sum + money(row.amount), 0)),
    cashInTotal: round2(cashMovementRows.filter((r) => r.type === "CASH_IN").reduce((sum, r) => sum + money(r.amount), 0)),
    cashOutTotal: round2(cashMovementRows.filter((r) => r.type === "CASH_OUT").reduce((sum, r) => sum + money(r.amount), 0)),
  };
}

/**
 * A SHIFT_CLOSED event must never finalize a Z-report while the shift's own
 * ledger events are still missing from the mirrored tables. If a close races
 * ahead of its invoices/settlements/expenses (batches re-ordered after a
 * network hiccup), finalizing now would freeze a partial report: the drawer
 * is recomputed from whatever happened to arrive first and the admin report
 * is permanently wrong. When incomplete, the caller defers (returns
 * `shift_ledger_incomplete`) so the event stays PENDING on the POS and is
 * retried once the FIFO queue drains. Mirrors are idempotent by sync_id (or
 * deterministic id), so each event is only "complete" once its mirror row
 * exists.
 */
async function assessShiftLedgerCompleteness(
  db: SupabaseClient,
  storeId: string,
  shiftId: string,
  closeEvent: SyncQueueRecord,
): Promise<{ complete: boolean; pendingEvents: string[] }> {
  const closeTime =
    clientCreatedAt(closeEvent) ??
    text((closeEvent.payload as unknown as Record<string, unknown>).closeTime) ??
    new Date().toISOString();

  const { data, error } = await db
    .from("sync_events")
    .select("sync_id, action_type, payload, client_created_at")
    .eq("store_id", storeId)
    .in("action_type", ["INVOICE_CREATED", "DEBT_SETTLEMENT", "EXPENSE_RECORDED", "CASH_MOVEMENT"])
    .lte("client_created_at", closeTime);

  if (error) return { complete: false, pendingEvents: [`assess_error:${error.message}`] };

  const rows = (data ?? []).filter(
    (row: { payload?: unknown }) =>
      text((row.payload as Record<string, unknown> | undefined)?.shiftId) === shiftId,
  );
  if (rows.length === 0) return { complete: true, pendingEvents: [] };

  const invoiceIds = rows.filter((r) => r.action_type === "INVOICE_CREATED").map((r) => r.sync_id);
  const settlementIds = rows.filter((r) => r.action_type === "DEBT_SETTLEMENT").map((r) => r.sync_id);
  const expenseIds = rows
    .filter((r) => r.action_type === "EXPENSE_RECORDED")
    .map((r) => text((r.payload as Record<string, unknown> | undefined)?.expenseId))
    .filter(Boolean);
  const cashMovementIds = rows
    .filter((r) => r.action_type === "CASH_MOVEMENT")
    .map((r) => text((r.payload as Record<string, unknown> | undefined)?.movementId))
    .filter(Boolean);

  const [invoices, settlements, expenses, cashMovements] = await Promise.all([
    invoiceIds.length > 0
      ? db.from("sales_invoices").select("sync_id").in("sync_id", invoiceIds)
      : Promise.resolve({ data: [] as Array<{ sync_id: string }>, error: null }),
    settlementIds.length > 0
      ? db
          .from("customer_transactions")
          .select("id, description")
          .eq("store_id", storeId)
          .in("type", ["SETTLEMENT"])
      : Promise.resolve({ data: [] as Array<{ id: string; description?: string }>, error: null }),
    expenseIds.length > 0
      ? db.from("expenses").select("id").eq("store_id", storeId).in("id", expenseIds)
      : Promise.resolve({ data: [] as Array<{ id: string }>, error: null }),
    cashMovementIds.length > 0
      ? db.from("cash_movements").select("id").eq("store_id", storeId).in("id", cashMovementIds)
      : Promise.resolve({ data: [] as Array<{ id: string }>, error: null }),
  ]);

  const mirrored = new Set<string>();
  for (const row of invoices.data ?? []) mirrored.add(row.sync_id);
  const settlementRows = (settlements.data ?? []) as Array<{ description?: string }>;
  for (const id of settlementIds) {
    if (settlementRows.some((s) => (s.description ?? "").includes(`sync:${id}`))) mirrored.add(id);
  }
  for (const row of expenses.data ?? []) mirrored.add(row.id);
  for (const row of cashMovements.data ?? []) mirrored.add(row.id);

  const pendingEvents = rows.filter((r) => !mirrored.has(r.sync_id)).map((r) => r.sync_id);
  return { complete: pendingEvents.length === 0, pendingEvents };
}

async function finalizeShiftClose(
  db: SupabaseClient,
  event: SyncQueueRecord,
  storeId: string,
): Promise<{ recorded: boolean; error?: string }> {
  if (event.action_type !== "SHIFT_CLOSED") return { recorded: false };

  const payload = event.payload as unknown as Record<string, unknown>;
  const shiftId = text(payload.shiftId);
  if (!shiftId) return { recorded: false, error: "shift_close_missing_shift_id" };

  // Never freeze a partial Z-report: if the shift's ledger events have not
  // reached their mirror tables yet, defer and let the FIFO queue drain.
  const completeness = await assessShiftLedgerCompleteness(db, storeId, shiftId, event);
  if (!completeness.complete) return { recorded: false, error: "shift_ledger_incomplete" };

  const sums = await computeShiftLedgerSums(db, storeId, shiftId, money(payload.startingCash));
  if ("error" in sums) return { recorded: false, error: sums.error };

  const actualCash = money(payload.actualCash);
  const expectedCashInDrawer = round2(
    sums.startingCash + sums.cashSales - sums.expenses + sums.debtCollections + sums.cashInTotal - sums.cashOutTotal,
  );
  const variance = round2(actualCash - expectedCashInDrawer);
  const expectedCard = sums.visaSales;
  const actualCard = money(payload.actualCard);
  const cardVariance = round2(actualCard - expectedCard);

  const expectedCliq = sums.cliqSales;
  const actualCliq = money(payload.actualCliq);
  const cliqVariance = round2(actualCliq - expectedCliq);
  const drawerOpenCount = typeof payload.drawerOpenCount === "number" ? Math.max(0, Math.floor(payload.drawerOpenCount)) : 0;

  const discrepancyReason = text(payload.discrepancyReason);
  const discrepancyNote = text(payload.discrepancyNote);

  const recomputedPayload = {
    ...payload,
    startingCash: sums.startingCash,
    cashSales: sums.cashSales,
    visaSales: sums.visaSales,
    cliqSales: sums.cliqSales,
    debtSales: sums.debtSales,
    debtCollections: sums.debtCollections,
    totalSales: sums.totalSales,
    discounts: sums.discounts,
    returns: sums.returns,
    expenses: sums.expenses,
    cashInTotal: sums.cashInTotal,
    cashOutTotal: sums.cashOutTotal,
    expectedCashInDrawer,
    variance,
    expectedCard,
    actualCard,
    cardVariance,
    expectedCliq,
    actualCliq,
    cliqVariance,
    drawerOpenCount,
    discrepancyReason,
    discrepancyNote,
  };

  // Overwrite the stored event so the admin Z-report reflects the ledger.
  const { error: updateError } = await db
    .from("sync_events")
    .update({ payload: recomputedPayload })
    .eq("sync_id", event.sync_id)
    .eq("store_id", storeId);
  if (updateError) return { recorded: false, error: updateError.message };

  const openedAt = text(payload.startTime) || text(payload.openedAt) || text(payload.closeTime);
  const closedAt = text(payload.closeTime) || new Date().toISOString();
  const cashierId = uuidOrNull(payload.cashierId);
  const cashierName = text(payload.cashierName) || text(event.cashierName);
  const branchId = uuidOrNull(payload.branchId);
  const terminalId = uuidOrNull(payload.terminalId);
  const { error: reportError } = await db
    .from("shift_reports")
    .upsert({
      store_id: storeId,
      shift_id: shiftId,
      close_event_id: event.sync_id,
      branch_id: branchId,
      terminal_id: terminalId,
      cashier_id: cashierId,
      cashier_name: cashierName,
      opened_at: openedAt,
      closed_at: closedAt,
      starting_cash: sums.startingCash,
      cash_sales: sums.cashSales,
      visa_sales: sums.visaSales,
      cliq_sales: sums.cliqSales,
      debt_sales: sums.debtSales,
      debt_collections: sums.debtCollections,
      discounts: sums.discounts,
      returns: sums.returns,
      expenses: sums.expenses,
      total_sales: sums.totalSales,
      expected_cash: expectedCashInDrawer,
      actual_cash: actualCash,
      variance,
      expected_card: expectedCard,
      actual_card: actualCard,
      card_variance: cardVariance,
      expected_cliq: expectedCliq,
      actual_cliq: actualCliq,
      cliq_variance: cliqVariance,
      drawer_open_count: drawerOpenCount,
      cash_in: sums.cashInTotal,
      cash_out: sums.cashOutTotal,
      discrepancy_reason: discrepancyReason || null,
      discrepancy_note: discrepancyNote || null,
      approval_status: variance === 0 ? "NOT_REQUIRED" : "PENDING",
    }, { onConflict: "store_id,shift_id", ignoreDuplicates: true });
  if (reportError) return { recorded: false, error: reportError.message };

  if (variance !== 0) {
    try {
      await recordRiskSignal({
        db,
        storeId,
        eventKey: `shift-variance:${shiftId}`,
        eventType: "SHIFT_VARIANCE",
        score: Math.min(100, 20 + Math.floor(Math.abs(variance) * 2)),
        amount: variance,
        actorId: cashierId,
        actorName: cashierName,
        branchId,
        terminalId,
        shiftId,
        targetId: shiftId,
        occurredAt: closedAt,
        details: { expectedCash: expectedCashInDrawer, actualCash, variance },
      });
    } catch (error) {
      console.error(`Risk signal error for shift ${shiftId}:`, error);
    }
  }

  if (variance !== 0) {
    const existing = await db
      .from("admin_audit_logs")
      .select("id")
      .eq("store_id", storeId)
      .eq("action_type", "SHIFT_VARIANCE")
      .eq("details->>shiftId", shiftId)
      .maybeSingle();
    if (existing.error) return { recorded: false, error: existing.error.message };

    if (!existing.data?.id) {
      const { error: insertError } = await db.from("admin_audit_logs").insert({
        store_id: storeId,
        admin_id: null,
        admin_name: text(event.cashierName) || null,
        action_type: "SHIFT_VARIANCE",
        target_id: shiftId,
        details: {
          shiftId,
          expectedCashInDrawer,
          actualCash,
          variance,
          currency: "JOD",
        },
      });
      if (insertError) return { recorded: false, error: insertError.message };
    }
  }

  return { recorded: true };
}

/** Award loyalty points for a settled invoice with a linked customer. */
async function recordLoyaltyEarn(
  db: SupabaseClient,
  event: SyncQueueRecord,
  storeId: string,
): Promise<{ recorded: boolean; error?: string }> {
  if (event.action_type !== "INVOICE_CREATED") return { recorded: false };
  const payload = event.payload as {
    customerId?: string;
    customerName?: string;
    total?: number;
    originalInvoiceId?: string | null;
    isCancellation?: boolean;
  };
  let customerId = (payload.customerId ?? "").trim();
  const customerName = (payload.customerName ?? "").trim();
  const amount = round2(payload.total ?? 0);

  // A return or admin cancellation referencing an original invoice must claw
  // back the exact points that invoice earned — never award new ones.
  if (isLoyaltyClawback({
    total: amount,
    originalInvoiceId: payload.originalInvoiceId,
    isCancellation: payload.isCancellation,
  })) {
    if (!payload.originalInvoiceId) return { recorded: false };
    if (!customerId) {
      if (!customerName) return { recorded: false };
      const { data, error } = await db
        .from("customers")
        .select("id")
        .eq("name", customerName)
        .eq("store_id", storeId)
        .maybeSingle();
      if (error) return { recorded: false, error: error.message };
      if (!data) return { recorded: false };
      customerId = data.id;
    }
    const clawback = await clawBackLoyaltyPoints({
      db,
      storeId,
      customerId,
      originalInvoiceSyncId: payload.originalInvoiceId,
      reversalSyncId: event.sync_id,
      description: "استرداد نقاط ولاء",
    });
    if (clawback.error) return { recorded: false, error: clawback.error };
    return { recorded: clawback.reversed };
  }

  if (amount <= 0) return { recorded: false };

  // Points need an identified customer. Prefer the resolved id (selected from
  // the ledger); fall back to resolving the typed name within this store.
  if (!customerId) {
    if (!customerName) return { recorded: false };
    const { data, error } = await db
      .from("customers")
      .select("id")
      .eq("name", customerName)
      .eq("store_id", storeId)
      .maybeSingle();
    if (error) return { recorded: false, error: error.message };
    if (!data) return { recorded: false };
    customerId = data.id;
  }

  const result = await awardLoyaltyPoints({
    db,
    storeId,
    customerId,
    amount,
    reference: event.sync_id,
    description: "نقاط ولاء",
  });
  if (result.error) return { recorded: false, error: result.error };
  return { recorded: result.awarded };
}

/**
 * Apply the stock effect of a settled invoice. Invoice items carry POSITIVE
 * qty for a sale (stock consumed) and NEGATIVE qty for a return (stock
 * restored), so the delta is the negated qty·multiplier. Sales are never
 * blocked by insufficient stock: balances may decrement into negative values.
 */
async function applyInvoiceStock(
  db: SupabaseClient,
  event: SyncQueueRecord,
  storeId: string,
): Promise<{ applied: boolean; error?: string }> {
  if (event.action_type !== "INVOICE_CREATED") return { applied: false };
  const payload = event.payload as {
    items?: Array<{ productId?: string; barcode?: string; qty?: number; unitName?: string; variantLabel?: string }>;
    branchId?: string;
    terminalId?: string;
    cashierId?: string;
    cashierName?: string;
    completed_at?: string;
  };
  const items = Array.isArray(payload?.items) ? payload.items : [];

  const posting = await db
    .from("inventory_postings")
    .select("sync_id")
    .eq("sync_id", event.sync_id)
    .eq("store_id", storeId)
    .maybeSingle();
  if (posting.error) return { applied: false, error: posting.error.message };
  if (posting.data) return { applied: true };

  for (const [index, item] of items.entries()) {
    const productId = (item.productId ?? "").trim();
    const qty =
      typeof item.qty === "number" && Number.isFinite(item.qty) ? item.qty : 0;
    if (qty === 0 || !productId) continue;

    let multiplier = 1;
    const barcode = (item.barcode ?? "").trim();
    if (barcode) {
      const { data, error } = await db
        .from("product_variants")
        .select("barcode")
        .eq("barcode", barcode)
        .eq("store_id", storeId)
        .maybeSingle();
      if (error) return { applied: false, error: error.message };
      multiplier = data ? 1 : 1;
    }

    const delta = Number((-qty * multiplier).toFixed(3));
    if (delta === 0) continue;

    const movementType = qty > 0 ? "SALE" : "RETURN";
    const movement = await db.rpc("record_inventory_movement", {
      p_store_id: storeId,
      p_product_id: productId,
      p_quantity_delta: delta,
      p_movement_type: movementType,
      p_idempotency_key: `invoice:${event.sync_id}:${index + 1}`,
      p_unit_quantity: Number((-qty).toFixed(3)),
      p_barcode: barcode || null,
      p_reference_type: "INVOICE",
      p_reference_id: event.sync_id,
      p_branch_id: uuidOrNull(payload.branchId),
      p_terminal_id: uuidOrNull(payload.terminalId),
      p_actor_id: uuidOrNull(payload.cashierId),
      p_actor_name: text(payload.cashierName ?? event.cashierName),
      p_reason: movementType === "SALE" ? "بيع" : "مرتجع بيع",
      p_occurred_at: text(payload.completed_at) || new Date().toISOString(),
      p_metadata: { line: index + 1, unitName: item.unitName, variantLabel: item.variantLabel },
      // A sale must never be blocked by 0/negative stock: allow total_stock
      // to decrement into negative integers (e.g. -5).
      p_allow_negative: true,
    });
    if (movement.error) {
      // Deterministic data/config failures (unknown product P0002, barcode or
      // unit mismatch 22023) cannot be fixed by retrying. Skip the line and
      // keep the sale: the invoice must never be hidden from the accounting
      // ledger because its stock config is broken. Transient errors still
      // fail the event so the queue retries them.
      if (movement.error.code === "P0002" || movement.error.code === "22023") {
        console.warn(
          `Skipping stock line ${index + 1} for ${event.sync_id} (${movement.error.message})`,
        );
        continue;
      }
      return { applied: false, error: movement.error.message };
    }
  }

  const marked = await db.from("inventory_postings").upsert(
    { sync_id: event.sync_id, store_id: storeId },
    { onConflict: "sync_id", ignoreDuplicates: true },
  );
  if (marked.error) return { applied: false, error: marked.error.message };
  return { applied: true };
}

/** When the event actually happened on the device, per action type. */
export function clientCreatedAt(event: SyncQueueRecord): string | null {
  switch (event.action_type) {
    case "INVOICE_CREATED":
    case "DEBT_SETTLEMENT":
      return event.payload.completed_at ?? null;
    case "EXPENSE_RECORDED":
    case "CASH_MOVEMENT":
      return event.payload.created_at ?? null;
    case "SHIFT_OPENED":
      return event.payload.openedAt ?? event.payload.startTime ?? null;
    case "SHIFT_CLOSED":
      return event.payload.closeTime ?? event.payload.startTime ?? null;
    case "SUPPLIER_INVOICE_CREATED":
      return event.payload.created_at ?? null;
    case "SHORTAGE_FLAGGED":
      return event.payload.created_at ?? null;
    case "SUPPLIER_CREATE":
      return event.payload.created_at ?? null;
    case "BARCODE_LABEL_PRINT":
      return event.payload.created_at ?? null;
  }
}

export interface MirrorBatchResult {
  /** Events fully mirrored (safe to mark SYNCED / clear from IndexedDB). */
  syncedIds: string[];
  /** Corrupt events refused locally — park these in the quarantine. */
  rejected: Array<{ sync_id: string; reason: string }>;
}

/**
 * Mirror one drain batch. Phases match the legacy route exactly:
 *
 *   0. Validate shapes/payloads; refuse corrupt events as `rejected`.
 *   1. Upsert every valid event into `sync_events` (idempotent on sync_id).
 *   2. Prepass: SUPPLIER_CREATE mirrors first — queue order is keyed by
 *      sync_id (a UUID), so a receiving event can drain before the vendor
 *      create its guard depends on.
 *   3. Main pass (every non-SHIFT_CLOSED event): accounting ledger first so a
 *      completed sale is never invisible in reports, then debt/loyalty/
 *      expense/cash mirrors, stock last (best-effort per line), receiving,
 *      shortage and print mirrors, risk signals. An event whose mirror fails
 *      is NOT acked — it stays PENDING and the queue retries it.
 *   4. Second pass: SHIFT_CLOSED finalization recomputes the Z-report from
 *      the now-complete ledger.
 */
export async function mirrorSyncBatch(
  db: SupabaseClient,
  events: SyncQueueRecord[],
  storeId: string,
): Promise<MirrorBatchResult> {
  const result: MirrorBatchResult = { syncedIds: [], rejected: [] };
  const valid: SyncQueueRecord[] = [];

  for (const raw of events) {
    const event = raw as SyncQueueRecord;
    const shapeValid =
      event !== null &&
      typeof event === "object" &&
      typeof event.sync_id === "string" &&
      event.sync_id.length > 0 &&
      typeof event.action_type === "string" &&
      VALID_ACTION_TYPES.has(event.action_type) &&
      (event.payload === undefined ||
        (typeof event.payload === "object" && event.payload !== null));

    if (!shapeValid) {
      const id =
        typeof raw?.sync_id === "string" && raw.sync_id ? raw.sync_id : "(unknown)";
      result.rejected.push({ sync_id: id, reason: "invalid_shape" });
      continue;
    }

    const badField = payloadValidationError(event);
    if (badField) {
      result.rejected.push({ sync_id: event.sync_id, reason: badField });
      continue;
    }

    valid.push(event);
  }

  if (valid.length === 0) return result;

  // Phase 1: durable inbox upsert, ignoring duplicates (retries replay safe).
  const rows = valid.map((event) => {
    const p = event.payload as { branchId?: unknown; terminalId?: unknown };
    const branchId = typeof p?.branchId === "string" && p.branchId ? p.branchId : null;
    const terminalId =
      typeof p?.terminalId === "string" && p.terminalId ? p.terminalId : null;
    return {
      sync_id: event.sync_id,
      store_id: storeId,
      action_type: event.action_type,
      payload: event.payload,
      client_created_at: clientCreatedAt(event),
      branch_id: branchId,
      terminal_id: terminalId,
      cashier_name: text(event.cashierName),
    };
  });

  const { error: inboxError } = await db
    .from("sync_events")
    .upsert(rows, { onConflict: "sync_id", ignoreDuplicates: true })
    .select("sync_id");
  if (inboxError) throw new Error(inboxError.message);

  // Phase 2: vendor-create prepass.
  for (const event of valid) {
    if (event.action_type !== "SUPPLIER_CREATE") continue;
    const prepassResult = await mirrorSupplierUpsert(db, event, storeId);
    if (prepassResult.error) {
      console.error(`Supplier create sync error (prepass) for ${event.sync_id}:`, prepassResult.error);
      continue;
    }
  }

  // Phase 3: main mirror pass.
  for (const event of valid) {
    if (event.action_type === "SHIFT_CLOSED") continue;
    const salesLedgerResult = await recordSalesInvoiceLedger(db, event, storeId);
    if (salesLedgerResult.error) {
      console.error(`Sales ledger sync error for ${event.sync_id}:`, salesLedgerResult.error);
      continue;
    }
    await stampCarriedIstd(db, event, storeId);
    const debtResult = await recordDebtLedger(db, event, storeId);
    if (debtResult.error) {
      console.error(`Ledger sync error for ${event.sync_id}:`, debtResult.error);
      continue;
    }
    const loyaltyResult = await recordLoyaltyEarn(db, event, storeId);
    if (loyaltyResult.error) {
      console.error(`Loyalty sync error for ${event.sync_id}:`, loyaltyResult.error);
      continue;
    }
    const expenseResult = await recordExpenseLedger(db, event, storeId);
    if (expenseResult.error) {
      console.error(`Ledger sync error for ${event.sync_id}:`, expenseResult.error);
      continue;
    }
    const cashMovementResult = await recordCashMovementLedger(db, event, storeId);
    if (cashMovementResult.error) {
      console.error(`Cash movement sync error for ${event.sync_id}:`, cashMovementResult.error);
      continue;
    }
    const stockResult = await applyInvoiceStock(db, event, storeId);
    if (stockResult.error) {
      console.error(`Stock sync error for ${event.sync_id}:`, stockResult.error);
      continue;
    }
    const receivingResult = await mirrorSupplierReceiving(db, event, storeId);
    if (receivingResult.error) {
      console.error(`Receiving sync error for ${event.sync_id}:`, receivingResult.error);
      continue;
    }
    const supplierCreateResult = await mirrorSupplierUpsert(db, event, storeId);
    if (supplierCreateResult.error) {
      console.error(`Supplier create sync error for ${event.sync_id}:`, supplierCreateResult.error);
      continue;
    }
    const shortageResult = await mirrorShortageFlag(db, event, storeId);
    if (shortageResult.error) {
      console.error(`Shortage sync error for ${event.sync_id}:`, shortageResult.error);
      continue;
    }
    const printResult = await mirrorPrintJob(db, event, storeId);
    if (printResult.error) {
      console.error(`Print sync error for ${event.sync_id}:`, printResult.error);
      continue;
    }
    if (event.action_type === "INVOICE_CREATED") {
      try {
        await recordInvoiceRiskSignals(storeId, event.sync_id, event.payload, text(event.cashierName), db);
      } catch (error) {
        console.error(`Risk signal error for invoice ${event.sync_id}:`, error);
      }
    }
    result.syncedIds.push(event.sync_id);
  }

  // Phase 4: finalize closed shifts from the now-complete ledger.
  for (const event of valid) {
    if (event.action_type !== "SHIFT_CLOSED") continue;
    const shiftCloseResult = await finalizeShiftClose(db, event, storeId);
    if (shiftCloseResult.error) {
      console.error(`Shift close sync error for ${event.sync_id}:`, shiftCloseResult.error);
      continue;
    }
    result.syncedIds.push(event.sync_id);
  }

  return result;
}
