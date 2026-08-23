import { getSupabaseBrowser } from "./supabaseBrowser";
import { getTenantStoreId } from "./tenantClient";
import { fetchAllRows } from "./supabase";
import {
  buildTaxBreakdown,
  invoiceReference,
  ledgerNumber,
  ledgerText,
  mapSalesInvoiceItem,
  mapSalesLedgerInvoice,
} from "./salesLedger";
import { attachInputTax, profitabilityDelta } from "./profitability";
import type {
  ProfitabilityPeriod,
  ProfitabilityPurchases,
  ProfitabilityResponse,
  ProfitabilitySnapshot,
  ProfitabilityStatementValues,
} from "@/types/profitability.types";
import type {
  SalesInvoiceDetail,
  SalesInvoicePaymentDetail,
  SalesLedgerOption,
  SalesLedgerResponse,
  SalesLedgerSummary,
  SalesTaxBreakdown,
} from "@/types/salesLedger.types";
import type {
  ReportsDataQualityIssue,
  ReportsNegativeStock,
  ReportsOverview,
  ReportsPaymentBreakdown,
  ReportsStockAlert,
  ReportsSummary,
  ReportsTopProduct,
  ReportsTrendPoint,
} from "@/types/reports.types";

const DAY_MS = 24 * 60 * 60 * 1000;
const PAGE_SIZE = 1000;
const IN_BATCH_SIZE = 200;

interface SyncEventRow {
  sync_id: string;
  action_type: "INVOICE_CREATED" | "DEBT_SETTLEMENT" | "EXPENSE_RECORDED";
  payload: unknown;
  created_at: string;
  client_created_at: string | null;
  branch_id: string | null;
  terminal_id: string | null;
}

interface ProductRow {
  id: string;
  name: string;
  total_stock: number;
}

interface ProductCostRow {
  id: string;
  cost_price: number | string | null;
}

interface VariantRow {
  barcode: string;
  product_id: string;
}

interface SalesInvoiceRow {
  id: string;
  sync_id: string;
  payment_method: string;
  subtotal: number | string;
  tax: number | string;
  discount: number | string;
  delivery_fee: number | string;
  total: number | string;
  cash_amount: number | string;
  visa_amount: number | string;
  cliq_amount: number | string;
  debt_amount: number | string;
  item_count: number | string;
  gross_profit: number | string;
  cashier_name: string | null;
  completed_at: string;
}

interface SalesInvoiceItemRow {
  invoice_id: string;
  product_id: string | null;
  product_name: string;
  barcode: string;
  qty: number | string;
  line_total: number | string;
  cost_price: number | string;
  gross_profit: number | string;
}

interface ProductAccumulator {
  productId: string;
  name: string;
  barcode: string;
  quantity: number;
  sales: number;
  cost: number;
  profitCandidate: number;
  profitReliable: boolean;
  stock: number | null;
}

interface LedgerInvoiceRow {
  id: string;
  sync_id: string;
  branch_id: string | null;
  terminal_id: string | null;
  shift_id: string | null;
  cashier_id: string | null;
  cashier_name: string | null;
  customer_id: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  payment_method: string;
  subtotal: number | string;
  tax: number | string;
  discount: number | string;
  delivery_fee: number | string;
  total: number | string;
  cash_amount: number | string;
  visa_amount: number | string;
  cliq_amount: number | string;
  debt_amount: number | string;
  item_count: number | string;
  gross_profit: number | string;
  is_return: boolean | null;
  is_cancellation: boolean | null;
  original_invoice_sync_id: string | null;
  completed_at: string;
  istd_uuid?: string | null;
  istd_qr?: string | null;
}

interface LedgerDetailInvoiceRow extends LedgerInvoiceRow {
  amount_paid: number | string | null;
  change_amount: number | string | null;
}

interface LedgerItemRow {
  id: string;
  invoice_id: string;
  line_no: number | string | null;
  product_id: string | null;
  product_name: string;
  barcode: string;
  variant_label: string;
  unit_name: string;
  qty: number | string;
  multiplier: number | string | null;
  unit_price: number | string;
  line_subtotal: number | string;
  line_discount: number | string;
  net_total: number | string;
  tax_percent: number | string;
  tax_included: boolean | null;
  tax_amount: number | string;
  line_total: number | string;
  cost_price: number | string;
  cost_total: number | string;
  gross_profit: number | string;
}

interface ProfitInvoiceRow {
  id: string;
  subtotal: number | string;
  tax: number | string;
  discount: number | string;
  delivery_fee: number | string;
  total: number | string;
  is_return: boolean | null;
  is_cancellation: boolean | null;
  completed_at: string;
}

interface ProfitItemRow {
  invoice_id: string;
  qty: number | string;
  net_total: number | string;
  barcode: string;
  product_id: string | null;
  cost_price: number | string;
  cost_total: number | string;
}

interface ProfitExpenseRow {
  category: string;
  amount: number | string;
  created_at: string;
}

interface PurchaseValueRow {
  total_amount: number | string | null;
}

const LEDGER_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const LEDGER_PAYMENT_METHODS = new Set(["CASH", "VISA", "SPLIT", "DEBT", "CLIQ", "UNKNOWN"]);

const LEDGER_INVOICE_SELECT =
  "id,sync_id,branch_id,terminal_id,shift_id,cashier_id,cashier_name,customer_id,customer_name,customer_phone,payment_method,subtotal,tax,discount,delivery_fee,total,cash_amount,visa_amount,cliq_amount,debt_amount,item_count,gross_profit,is_return,is_cancellation,original_invoice_sync_id,completed_at,istd_uuid,istd_qr";

const LEDGER_ITEM_SELECT =
  "id,invoice_id,line_no,product_id,product_name,barcode,variant_label,unit_name,qty,multiplier,unit_price,line_subtotal,line_discount,net_total,tax_percent,tax_included,tax_amount,line_total,cost_price,cost_total,gross_profit";

function round3(value: number): number {
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}

/**
 * Parses a report date parameter. Plain YYYY-MM-DD values are interpreted as
 * Amman wall-clock business days (+03:00), matching the legacy SQL reports.
 */
function parseReportDate(value: string | null | undefined, fallback: Date, endOfDay = false): Date {
  if (!value) return fallback;
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}+03:00`)
    : new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

function optionalLedgerUuid(value: string | null | undefined): string | null {
  const clean = value?.trim() ?? "";
  return LEDGER_UUID_RE.test(clean) ? clean : null;
}

/** Amman calendar date (YYYY-MM-DD) of an instant — the reports' day bucket. */
function ammanDayKey(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Amman" }).format(date);
}

/** A sales-ledger line whose recorded cost is missing or zero blocks profit. */
function isZeroCostLine(qty: unknown, costPrice: unknown): boolean {
  return ledgerNumber(qty) !== 0 && ledgerNumber(costPrice) <= 0;
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function asNumber(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function objectPayload(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function buildNegativeStock(products: ProductRow[]): ReportsNegativeStock[] {
  return products
    .filter((p) => p.total_stock < 0)
    .map((p) => ({ productId: p.id, name: p.name, stock: round2(p.total_stock) }))
    .sort((a, b) => a.stock - b.stock);
}

function dayKey(value: string | null | undefined): string {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function paymentLabel(method: string): string {
  switch (method) {
    case "CASH": return "نقدي";
    case "VISA": return "بطاقة";
    case "CLIQ": return "كليك";
    case "SPLIT": return "مختلط";
    case "DEBT": return "ذمم";
    default: return "غير محدد";
  }
}

function emptySummary(): ReportsSummary {
  return {
    invoiceCount: 0, itemCount: 0, grossSales: 0, returns: 0, netSales: 0,
    subtotal: 0, tax: 0, discounts: 0, deliveryFee: 0, profitCandidate: 0,
    profit: 0, profitMargin: 0, profitReliable: true, averageTicket: 0,
    cash: 0, visa: 0, cliq: 0, debt: 0, debtCollections: 0, expenses: 0, netCashMovement: 0,
  };
}

function addPayment(
  payment: Map<string, { count: number; amount: number }>,
  method: string,
  amount: number,
): void {
  const current = payment.get(method) ?? { count: 0, amount: 0 };
  current.count += 1;
  current.amount = round2(current.amount + amount);
  payment.set(method, current);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyBuilder = any;

async function fetchPage<T>(
  table: string,
  select: string,
  storeId: string,
  extra?: (q: AnyBuilder) => AnyBuilder,
): Promise<T[]> {
  const sb = getSupabaseBrowser();
  if (!sb) return [];
  const rows: T[] = [];
  for (let start = 0; ; start += PAGE_SIZE) {
    let q: AnyBuilder = sb.from(table).select(select).eq("store_id", storeId).range(start, start + PAGE_SIZE - 1);
    if (extra) q = extra(q);
    const { data, error } = await q.returns();
    if (error) throw error;
    rows.push(...((data ?? []) as T[]));
    if (!data || data.length < PAGE_SIZE) break;
  }
  return rows;
}

async function fetchEvents(storeId: string, from: Date, to: Date): Promise<SyncEventRow[]> {
  return fetchPage<SyncEventRow>(
    "sync_events",
    "sync_id,action_type,payload,created_at,client_created_at,branch_id,terminal_id",
    storeId,
    (q) =>
      q
        .in("action_type", ["INVOICE_CREATED", "DEBT_SETTLEMENT", "EXPENSE_RECORDED"])
        .gte("client_created_at", from.toISOString())
        .lte("client_created_at", to.toISOString())
        .order("client_created_at", { ascending: true }),
  );
}

async function fetchProducts(storeId: string): Promise<ProductRow[]> {
  return fetchPage<ProductRow>("products", "id,name,total_stock", storeId, (q) => q.order("name"));
}

async function fetchBarcodes(storeId: string) {
  const variants = await fetchPage<VariantRow>("product_variants", "barcode,product_id", storeId);
  if (variants.length === 0) return [];

  const sb = getSupabaseBrowser();
  if (!sb) return [];

  const costMap = new Map<string, number | string | null>();
  for (let start = 0; ; start += PAGE_SIZE) {
    const { data } = await sb
      .from("products")
      .select("id,cost_price")
      .eq("store_id", storeId)
      .range(start, start + PAGE_SIZE - 1);
    for (const row of (data ?? []) as ProductCostRow[]) costMap.set(row.id, row.cost_price);
    if (!data || data.length < PAGE_SIZE) break;
  }

  return variants.map((v) => ({
    barcode: v.barcode,
    product_id: v.product_id,
    cost_price: costMap.get(v.product_id) ?? null,
  }));
}

async function fetchSalesInvoices(storeId: string, from: Date, to: Date): Promise<SalesInvoiceRow[]> {
  return fetchPage<SalesInvoiceRow>(
    "sales_invoices",
    "id,sync_id,payment_method,subtotal,tax,discount,delivery_fee,total,cash_amount,visa_amount,cliq_amount,debt_amount,item_count,gross_profit,cashier_name,completed_at",
    storeId,
    (q) =>
      q
        .gte("completed_at", from.toISOString())
        .lte("completed_at", to.toISOString())
        .order("completed_at", { ascending: true }),
  );
}

async function fetchInBatches<T>(
  table: string,
  select: string,
  storeId: string,
  column: string,
  values: string[],
): Promise<T[]> {
  const sb = getSupabaseBrowser();
  if (!sb || values.length === 0) return [];
  const rows: T[] = [];
  for (let i = 0; i < values.length; i += IN_BATCH_SIZE) {
    const { data, error } = await sb
      .from(table)
      .select(select)
      .eq("store_id", storeId)
      .in(column, values.slice(i, i + IN_BATCH_SIZE));
    if (error) throw error;
    rows.push(...((data ?? []) as T[]));
  }
  return rows;
}

async function fetchSalesInvoiceItems(storeId: string, invoiceIds: string[]): Promise<SalesInvoiceItemRow[]> {
  return fetchInBatches<SalesInvoiceItemRow>(
    "sales_invoice_items",
    "invoice_id,product_id,product_name,barcode,qty,line_total,cost_price,gross_profit",
    storeId,
    "invoice_id",
    invoiceIds,
  );
}

function buildOverviewFromLedger(params: {
  invoices: SalesInvoiceRow[];
  items: SalesInvoiceItemRow[];
  events: SyncEventRow[];
  products: ProductRow[];
  barcodes: { barcode: string; product_id: string; cost_price: number | string | null }[];
  from: Date;
  to: Date;
}): ReportsOverview {
  const summary = emptySummary();
  const trend = new Map<string, ReportsTrendPoint>();
  const payment = new Map<string, { count: number; amount: number }>();
  const productMap = new Map(params.products.map((p) => [p.id, p]));
  const productBarcodeCount = new Map<string, number>();
  for (const barcode of params.barcodes) {
    productBarcodeCount.set(barcode.product_id, (productBarcodeCount.get(barcode.product_id) ?? 0) + 1);
  }

  let missingCashier = 0;
  const invoiceDay = new Map<string, string>();
  for (const invoice of params.invoices) {
    const total = round2(asNumber(invoice.total));
    const tax = round2(asNumber(invoice.tax));
    const profit = round2(asNumber(invoice.gross_profit));
    const key = dayKey(invoice.completed_at);
    const point = trend.get(key) ?? { date: key, invoices: 0, sales: 0, tax: 0, profitCandidate: 0, profit: 0, profitReliable: true as boolean };
    invoiceDay.set(invoice.id, key);

    summary.invoiceCount += 1;
    summary.itemCount = round2(summary.itemCount + asNumber(invoice.item_count));
    summary.subtotal = round2(summary.subtotal + asNumber(invoice.subtotal));
    summary.tax = round2(summary.tax + tax);
    summary.discounts = round2(summary.discounts + asNumber(invoice.discount));
    summary.deliveryFee = round2(summary.deliveryFee + asNumber(invoice.delivery_fee));
    summary.netSales = round2(summary.netSales + total);
    summary.profitCandidate = round2(summary.profitCandidate + profit);
    summary.cash = round2(summary.cash + asNumber(invoice.cash_amount));
    summary.visa = round2(summary.visa + asNumber(invoice.visa_amount));
    summary.cliq = round2(summary.cliq + asNumber(invoice.cliq_amount));
    summary.debt = round2(summary.debt + asNumber(invoice.debt_amount));
    if (total >= 0) summary.grossSales = round2(summary.grossSales + total);
    else summary.returns = round2(summary.returns + Math.abs(total));
    if (!asText(invoice.cashier_name)) missingCashier += 1;

    addPayment(payment, "CASH", asNumber(invoice.cash_amount));
    addPayment(payment, "VISA", asNumber(invoice.visa_amount));
    addPayment(payment, "CLIQ", asNumber(invoice.cliq_amount));
    addPayment(payment, "DEBT", asNumber(invoice.debt_amount));

    point.invoices += 1;
    point.sales = round2(point.sales + total);
    point.tax = round2(point.tax + tax);
    point.profitCandidate = round2(point.profitCandidate + profit);
    point.profit = point.profitCandidate;
    trend.set(key, point);
  }

  for (const event of params.events) {
    const payload = objectPayload(event.payload);
    if (event.action_type === "DEBT_SETTLEMENT") {
      summary.debtCollections = round2(summary.debtCollections + asNumber(payload.amount));
    } else if (event.action_type === "EXPENSE_RECORDED") {
      summary.expenses = round2(summary.expenses + asNumber(payload.amount));
    }
  }

  summary.averageTicket = summary.invoiceCount > 0 ? round2(summary.netSales / summary.invoiceCount) : 0;
  summary.netCashMovement = round2(summary.cash + summary.debtCollections - summary.expenses);

  const paymentBreakdownRaw = Array.from(payment.entries()).filter(([, item]) => item.amount !== 0);
  const paymentDenominator = paymentBreakdownRaw.reduce((sum, [, item]) => sum + Math.abs(item.amount), 0);
  const paymentBreakdown: ReportsPaymentBreakdown[] = paymentBreakdownRaw
    .map(([method, item]) => ({
      method,
      label: paymentLabel(method),
      count: item.count,
      amount: round2(item.amount),
      share: paymentDenominator > 0 ? round2((Math.abs(item.amount) / paymentDenominator) * 100) : 0,
    }))
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));

  const productSales = new Map<string, ProductAccumulator>();
  let missingBarcodeLines = 0;
  let unknownProductLines = 0;
  const zeroCostInvoiceIds = new Set<string>();
  for (const item of params.items) {
    const productId = asText(item.product_id);
    const product = productMap.get(productId);
    const key = productId || `barcode:${item.barcode || item.product_name}`;
    const current =
      productSales.get(key) ??
      ({
        productId: productId || key,
        name: asText(item.product_name) || product?.name || "صنف غير معروف",
        barcode: asText(item.barcode),
        quantity: 0, sales: 0, cost: 0, profitCandidate: 0,
        profitReliable: true, stock: product?.total_stock ?? null,
      } as ProductAccumulator);
    current.quantity = round2(current.quantity + asNumber(item.qty));
    current.sales = round2(current.sales + asNumber(item.line_total));
    current.profitCandidate = round2(current.profitCandidate + asNumber(item.gross_profit));
    const lineProfitReliable = asNumber(item.qty) === 0 || asNumber(item.cost_price) > 0;
    current.profitReliable = current.profitReliable && lineProfitReliable;
    if (!current.barcode && item.barcode) current.barcode = item.barcode;
    productSales.set(key, current);
    if (!asText(item.barcode)) missingBarcodeLines += 1;
    if (productId && !product) unknownProductLines += 1;
    if (!lineProfitReliable) zeroCostInvoiceIds.add(item.invoice_id);
  }

  summary.profitReliable = zeroCostInvoiceIds.size === 0;
  summary.profit = summary.profitReliable ? summary.profitCandidate : null;
  const profitBasis = round2(summary.subtotal + summary.deliveryFee);
  summary.profitMargin = summary.profitReliable && profitBasis !== 0
    ? round2((summary.profitCandidate / profitBasis) * 100)
    : null;
  for (const invoiceId of zeroCostInvoiceIds) {
    const key = invoiceDay.get(invoiceId);
    const point = key ? trend.get(key) : null;
    if (point) { point.profitReliable = false; point.profit = null; }
  }

  const topProducts: ReportsTopProduct[] = Array.from(productSales.values())
    .map((p) => ({
      productId: p.productId, name: p.name, barcode: p.barcode,
      quantity: round2(p.quantity), sales: round2(p.sales),
      profitCandidate: round2(p.profitCandidate),
      profit: p.profitReliable ? round2(p.profitCandidate) : null,
      margin: p.profitReliable && p.sales !== 0 ? round2((p.profitCandidate / p.sales) * 100) : null,
      profitReliable: p.profitReliable, stock: p.stock,
    }))
    .sort((a, b) => b.sales - a.sales)
    .slice(0, 15);

  const days = Math.max(1, Math.ceil((params.to.getTime() - params.from.getTime()) / DAY_MS));
  const stockAlerts: ReportsStockAlert[] = params.products
    .map((product) => {
      const sold = Math.max(0, productSales.get(product.id)?.quantity ?? 0);
      const dailyVelocity = sold / days;
      const daysOfStockLeft = product.total_stock <= 0 ? 0 : dailyVelocity > 0 ? Math.floor(product.total_stock / dailyVelocity) : null;
      const severity: ReportsStockAlert["severity"] = product.total_stock <= 0 || (daysOfStockLeft !== null && daysOfStockLeft <= 7) ? "critical" : "warning";
      return { productId: product.id, name: product.name, stock: product.total_stock, soldQuantity: round2(sold), daysOfStockLeft, severity };
    })
    .filter((a) => a.stock <= 5 || (a.daysOfStockLeft !== null && a.daysOfStockLeft <= 14))
    .sort((a, b) => {
      if (a.daysOfStockLeft === b.daysOfStockLeft) return a.stock - b.stock;
      if (a.daysOfStockLeft === null) return 1;
      if (b.daysOfStockLeft === null) return -1;
      return a.daysOfStockLeft - b.daysOfStockLeft;
    })
    .slice(0, 20);

  const negativeStock = params.products.filter((p) => p.total_stock < 0);
  const missingBarcodeProducts = params.products.filter((p) => !productBarcodeCount.has(p.id));
  const zeroCostBarcodes = params.barcodes.filter((b) => asNumber(b.cost_price) <= 0);
  const dataQuality: ReportsDataQualityIssue[] = [];
  if (missingCashier > 0) {
    dataQuality.push({ id: "missing-cashier", label: "فواتير بلا كاشير", severity: "medium", count: missingCashier, description: "هذه غالباً فواتير قديمة قبل تثبيت ختم cashierName داخل payload." });
  }
  if (negativeStock.length > 0) {
    dataQuality.push({ id: "negative-stock", label: "منتجات بمخزون سالب", severity: "high", count: negativeStock.length, amount: round2(negativeStock.reduce((sum, p) => sum + p.total_stock, 0)), description: "يجب عمل جرد افتتاحي أو منع البيع عند نفاد الرصيد لهذه الأصناف." });
  }
  if (missingBarcodeProducts.length > 0) {
    dataQuality.push({ id: "products-without-barcodes", label: "منتجات بلا باركود", severity: "medium", count: missingBarcodeProducts.length, description: "أي منتج بلا باركود يصعب تتبعه في البيع السريع والتقارير التفصيلية." });
  }
  if (zeroCostBarcodes.length > 0) {
    dataQuality.push({ id: "zero-cost-barcodes", label: "باركودات بلا تكلفة", severity: "medium", count: zeroCostBarcodes.length, description: "الربح يصبح تقديرياً وغير محاسبي عندما تكون تكلفة الصنف صفراً." });
  }
  if (missingBarcodeLines > 0) {
    dataQuality.push({ id: "invoice-lines-without-barcode", label: "أسطر بيع بلا باركود", severity: "low", count: missingBarcodeLines, description: "غالباً من أزرار سريعة أو بحث يدوي؛ الأفضل ربط كل صنف بمعرف قابل للتتبع." });
  }
  if (unknownProductLines > 0) {
    dataQuality.push({ id: "unknown-product-lines", label: "أسطر بيع لمنتجات غير موجودة", severity: "high", count: unknownProductLines, description: "يوجد فرق بين سجل الفواتير والكتالوج الحالي، وقد يؤثر على الربح والمخزون." });
  }

  return {
    range: { from: params.from.toISOString(), to: params.to.toISOString(), days },
    summary,
    trend: Array.from(trend.values()).sort((a, b) => a.date.localeCompare(b.date)),
    paymentBreakdown,
    topProducts,
    stockAlerts,
    dataQuality,
    negativeStock: buildNegativeStock(params.products),
    generatedAt: new Date().toISOString(),
  };
}

export interface ReportsOverviewRange {
  /** Inclusive lower bound: YYYY-MM-DD (start of Amman day) or ISO timestamp. */
  from?: string;
  /** Inclusive upper bound: YYYY-MM-DD (end of Amman day) or ISO timestamp. */
  to?: string;
}

/**
 * Client-side reports engine (replaces the former /api/reports/overview call).
 * Reads the store's invoice ledger straight from Supabase and computes the
 * overview in the browser, falling back to sync-event payloads when the
 * ledger tables are unavailable. Defaults to the trailing 30 days.
 */
export async function fetchReportsOverview(
  storeId: string,
  range?: ReportsOverviewRange,
): Promise<ReportsOverview> {
  const fallbackTo = new Date();
  const to = parseReportDate(range?.to, fallbackTo, true);
  const from = parseReportDate(range?.from, new Date(to.getTime() - 29 * DAY_MS));

  let products: ProductRow[];
  let barcodes: { barcode: string; product_id: string; cost_price: number | string | null }[];
  try {
    [products, barcodes] = await Promise.all([fetchProducts(storeId), fetchBarcodes(storeId)]);
  } catch {
    throw new Error("تعذر الاتصال بالبيانات — تحقق من صلاحيات الجدول (RLS)");
  }

  try {
    const invoices = await fetchSalesInvoices(storeId, from, to);
    if (invoices.length > 0) {
      const [items, events] = await Promise.all([
        fetchSalesInvoiceItems(storeId, invoices.map((inv) => inv.id)),
        fetchEvents(storeId, from, to),
      ]);
      return buildOverviewFromLedger({ invoices, items, events, products, barcodes, from, to });
    }
  } catch {
    const sb = getSupabaseBrowser();
    if (sb) {
      const { error } = await sb.from("sales_invoices").select("id").limit(1);
      if (error && (error.code === "42P01" || error.code === "42703" || error.code === "42501")) {
        const events = await fetchEvents(storeId, from, to);
        return buildOverviewFromEvents({ events, products, barcodes, from, to });
      }
    }
    throw new Error("تعذر تحميل بيانات المبيعات");
  }

  const events = await fetchEvents(storeId, from, to);
  return buildOverviewFromEvents({ events, products, barcodes, from, to });
}

function buildOverviewFromEvents(params: {
  events: SyncEventRow[];
  products: ProductRow[];
  barcodes: { barcode: string; product_id: string; cost_price: number | string | null }[];
  from: Date;
  to: Date;
}): ReportsOverview {
  const summary = emptySummary();
  const trend = new Map<string, ReportsTrendPoint>();
  const payment = new Map<string, { count: number; amount: number }>();
  const productMap = new Map(params.products.map((p) => [p.id, p]));
  const costByBarcode = new Map<string, number>();
  const fallbackCostByProduct = new Map<string, number>();
  for (const b of params.barcodes) {
    const cost = asNumber(b.cost_price);
    costByBarcode.set(b.barcode, cost);
    if (!fallbackCostByProduct.has(b.product_id) && cost > 0) fallbackCostByProduct.set(b.product_id, cost);
  }

  const productSales = new Map<string, ProductAccumulator>();
  for (const event of params.events) {
    const payload = objectPayload(event.payload);
    const occurredAt = asText(payload.completed_at) || asText(payload.created_at) || event.client_created_at || event.created_at;
    const key = dayKey(occurredAt);
    const point = trend.get(key) ?? { date: key, invoices: 0, sales: 0, tax: 0, profitCandidate: 0, profit: 0, profitReliable: true as boolean };

    if (event.action_type === "DEBT_SETTLEMENT") { summary.debtCollections = round2(summary.debtCollections + asNumber(payload.amount)); continue; }
    if (event.action_type === "EXPENSE_RECORDED") { summary.expenses = round2(summary.expenses + asNumber(payload.amount)); continue; }

    const total = round2(asNumber(payload.total));
    const subtotal = round2(asNumber(payload.subtotal));
    const discount = round2(asNumber(payload.discount));
    const deliveryFee = round2(asNumber(payload.deliveryFee));
    const tax = round2(asNumber(payload.tax));
    const method = asText(payload.paymentMethod) || "UNKNOWN";
    const amountPaid = round2(asNumber(payload.amountPaid));
    const items = Array.isArray(payload.items) ? payload.items : [];

    summary.invoiceCount += 1;
    summary.subtotal = round2(summary.subtotal + subtotal);
    summary.tax = round2(summary.tax + tax);
    summary.discounts = round2(summary.discounts + discount);
    summary.deliveryFee = round2(summary.deliveryFee + deliveryFee);
    summary.netSales = round2(summary.netSales + total);
    if (total >= 0) summary.grossSales = round2(summary.grossSales + total);
    else summary.returns = round2(summary.returns + Math.abs(total));

    if (method === "CASH") { summary.cash = round2(summary.cash + total); addPayment(payment, "CASH", total); }
    else if (method === "VISA") { summary.visa = round2(summary.visa + total); addPayment(payment, "VISA", total); }
    else if (method === "CLIQ") { summary.cliq = round2(summary.cliq + total); addPayment(payment, "CLIQ", total); }
    else if (method === "DEBT") { summary.debt = round2(summary.debt + total); addPayment(payment, "DEBT", total); }
    else if (method === "SPLIT") {
      const cashPart = total >= 0 ? Math.min(amountPaid, total) : total;
      summary.cash = round2(summary.cash + cashPart);
      summary.visa = round2(summary.visa + round2(total - cashPart));
      addPayment(payment, "SPLIT", total);
    }

    const discountRatio = subtotal > 0 ? Math.max(0, Math.min(1, discount / subtotal)) : 0;
    let invoiceProfit = deliveryFee;
    let invoiceReliable = true;
    for (const rawItem of items) {
      const item = objectPayload(rawItem);
      const productId = asText(item.productId) || asText(item.product_id) || asText(item.id);
      const barcode = asText(item.barcode);
      const name = asText(item.name) || productMap.get(productId)?.name || "صنف غير معروف";
      const quantity = asNumber(item.qty);
      const unitPrice = asNumber(item.unitPrice);
      const lineGross = round2(asNumber(item.lineTotal, round2(quantity * unitPrice)));
      const lineDiscount = round2(lineGross * discountRatio);
      const lineSales = round2(lineGross - lineDiscount);
      const unitCost = barcode ? costByBarcode.get(barcode) ?? fallbackCostByProduct.get(productId) ?? 0 : fallbackCostByProduct.get(productId) ?? 0;
      const cost = round2(quantity * unitCost);
      const lineProfit = round2(lineSales - cost);
      invoiceProfit = round2(invoiceProfit + lineProfit);
      invoiceReliable = invoiceReliable && (quantity === 0 || unitCost > 0);
      summary.itemCount = round2(summary.itemCount + Math.abs(quantity));

      const pKey = productId || `barcode:${barcode || name}`;
      const cur = productSales.get(pKey) ?? ({ productId: productId || pKey, name, barcode, quantity: 0, sales: 0, cost: 0, profitCandidate: 0, profitReliable: true, stock: productMap.get(productId)?.total_stock ?? null } as ProductAccumulator);
      cur.quantity = round2(cur.quantity + quantity);
      cur.sales = round2(cur.sales + lineSales);
      cur.cost = round2(cur.cost + cost);
      cur.profitCandidate = round2(cur.profitCandidate + lineProfit);
      cur.profitReliable = cur.profitReliable && (quantity === 0 || unitCost > 0);
      if (!cur.barcode && barcode) cur.barcode = barcode;
      productSales.set(pKey, cur);
    }

    summary.profitCandidate = round2(summary.profitCandidate + invoiceProfit);
    summary.profitReliable = summary.profitReliable && invoiceReliable;
    point.invoices += 1;
    point.sales = round2(point.sales + total);
    point.tax = round2(point.tax + tax);
    point.profitCandidate = round2(point.profitCandidate + invoiceProfit);
    point.profitReliable = point.profitReliable && invoiceReliable;
    point.profit = point.profitReliable ? point.profitCandidate : null;
    trend.set(key, point);
  }

  summary.averageTicket = summary.invoiceCount > 0 ? round2(summary.netSales / summary.invoiceCount) : 0;
  const revenue = round2(summary.subtotal + summary.deliveryFee);
  summary.profit = summary.profitReliable ? summary.profitCandidate : null;
  summary.profitMargin = summary.profitReliable && revenue !== 0 ? round2((summary.profitCandidate / revenue) * 100) : null;
  summary.netCashMovement = round2(summary.cash + summary.debtCollections - summary.expenses);

  const paymentDenominator = Array.from(payment.values()).reduce((sum, i) => sum + Math.abs(i.amount), 0);
  const paymentBreakdown: ReportsPaymentBreakdown[] = Array.from(payment.entries())
    .map(([method, item]) => ({ method, label: paymentLabel(method), count: item.count, amount: round2(item.amount), share: paymentDenominator > 0 ? round2((Math.abs(item.amount) / paymentDenominator) * 100) : 0 }))
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));

  const topProducts: ReportsTopProduct[] = Array.from(productSales.values())
    .map((p) => ({ productId: p.productId, name: p.name, barcode: p.barcode, quantity: round2(p.quantity), sales: round2(p.sales), profitCandidate: round2(p.profitCandidate), profit: p.profitReliable ? round2(p.profitCandidate) : null, margin: p.profitReliable && p.sales !== 0 ? round2((p.profitCandidate / p.sales) * 100) : null, profitReliable: p.profitReliable, stock: p.stock }))
    .sort((a, b) => b.sales - a.sales)
    .slice(0, 15);

  const days = Math.max(1, Math.ceil((params.to.getTime() - params.from.getTime()) / DAY_MS));
  const stockAlerts: ReportsStockAlert[] = params.products
    .map((product) => {
      const sold = Math.max(0, productSales.get(product.id)?.quantity ?? 0);
      const dailyVelocity = sold / days;
      const daysOfStockLeft = product.total_stock <= 0 ? 0 : dailyVelocity > 0 ? Math.floor(product.total_stock / dailyVelocity) : null;
      const severity: ReportsStockAlert["severity"] = product.total_stock <= 0 || (daysOfStockLeft !== null && daysOfStockLeft <= 7) ? "critical" : "warning";
      return { productId: product.id, name: product.name, stock: product.total_stock, soldQuantity: round2(sold), daysOfStockLeft, severity };
    })
    .filter((a) => a.stock <= 5 || (a.daysOfStockLeft !== null && a.daysOfStockLeft <= 14))
    .sort((a, b) => {
      if (a.daysOfStockLeft === b.daysOfStockLeft) return a.stock - b.stock;
      if (a.daysOfStockLeft === null) return 1;
      if (b.daysOfStockLeft === null) return -1;
      return a.daysOfStockLeft - b.daysOfStockLeft;
    })
    .slice(0, 20);

  const negStock = params.products.filter((p) => p.total_stock < 0);
  const dataQuality: ReportsDataQualityIssue[] = [];
  if (negStock.length > 0) {
    dataQuality.push({ id: "negative-stock", label: "منتجات بمخزون سالب", severity: "high", count: negStock.length, amount: round2(negStock.reduce((sum, p) => sum + p.total_stock, 0)), description: "يجب عمل جرد افتتاحي أو منع البيع عند نفاد الرصيد لهذه الأصناف." });
  }

  return {
    range: { from: params.from.toISOString(), to: params.to.toISOString(), days },
    summary,
    trend: Array.from(trend.values()).sort((a, b) => a.date.localeCompare(b.date)),
    paymentBreakdown,
    topProducts,
    stockAlerts,
    dataQuality,
    negativeStock: buildNegativeStock(params.products),
    generatedAt: new Date().toISOString(),
  };
}

export async function submitInventoryCount(opts: {
  storeId: string;
  productId: string;
  quantity: number;
  reason: string;
  actorName: string;
}): Promise<void> {
  const sb = getSupabaseBrowser();
  if (!sb) throw new Error("Supabase غير مهيأة");

  const idempotencyKey = `adjustment:${crypto.randomUUID()}`;

  const { error } = await sb.rpc("record_inventory_movement", {
    p_store_id: opts.storeId,
    p_product_id: opts.productId,
    p_quantity_delta: 0,
    p_movement_type: "STOCKTAKE",
    p_idempotency_key: idempotencyKey,
    p_unit_quantity: null,
    p_barcode: null,
    p_reference_type: "MANUAL_ADJUSTMENT",
    p_reference_id: idempotencyKey,
    p_actor_name: opts.actorName,
    p_reason: opts.reason,
    p_metadata: { mode: "COUNT", requestedQuantity: opts.quantity },
    p_target_balance: Number(opts.quantity.toFixed(3)),
  });
  if (error) {
    const msg = error.message.includes("insufficient_stock")
      ? "الرصيد لا يكفي لتنفيذ هذه الحركة"
      : error.message.includes("no_stock_change")
        ? "الكمية الفعلية مطابقة للرصيد ولا توجد حركة لتسجيلها"
        : error.message;
    throw new Error(msg);
  }
}

/* ─── Sales Ledger (client-side aggregation) ─────────────────────── */

export async function fetchSalesReport(params: {
  from: string;
  to: string;
  page?: number;
  pageSize?: number;
  kind?: string;
  branchId?: string;
  terminalId?: string;
  cashierId?: string;
  paymentMethod?: string;
  search?: string;
}): Promise<Record<string, unknown>> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  const { from, to, page = 1, pageSize = 50, kind = "all", branchId, terminalId, cashierId, paymentMethod, search } = params;

  let q = sb
    .from("sales_invoices")
    .select("*", { count: "exact" })
    .eq("store_id", storeId)
    .gte("created_at", from)
    .lte("created_at", to + "T23:59:59.999+03:00");

  if (branchId) q = q.eq("branch_id", branchId);
  if (terminalId) q = q.eq("terminal_id", terminalId);
  if (cashierId) q = q.eq("cashier_id", cashierId);
  if (kind === "sales") q = q.eq("is_return", false);
  if (kind === "returns") q = q.eq("is_return", true);
  if (search) q = q.ilike("cashier_name", `%${search}%`);

  const offset = (page - 1) * pageSize;
  const { data: invoices, count, error } = await q.order("created_at", { ascending: false }).range(offset, offset + pageSize - 1);
  if (error) throw new Error(error.message);

  const rows = (invoices ?? []) as Record<string, unknown>[];
  let cash = 0, visa = 0, cliq = 0, debt = 0, gross = 0, tax = 0, discounts = 0, returns = 0, profit = 0;
  for (const r of rows) {
    cash += Number(r.cash_amount) || 0;
    visa += Number(r.visa_amount) || 0;
    cliq += Number(r.cliq_amount) || 0;
    debt += Number(r.debt_amount) || 0;
    gross += Number(r.total) || 0;
    tax += Number(r.tax_amount) || 0;
    discounts += Number(r.discount_amount) || 0;
    if (r.is_return) returns += Math.abs(Number(r.total) || 0);
    profit += Number(r.gross_profit) || 0;
  }

  return {
    invoices: rows,
    total: count ?? 0,
    page,
    pageSize,
    summary: {
      grossSales: gross,
      returns,
      netSales: gross - returns,
      cash, visa, cliq, debt,
      discounts,
      tax,
      grossProfit: profit,
      invoiceCount: count ?? 0,
    },
  };
}

export async function fetchSalesInvoiceDetail(invoiceId: string): Promise<Record<string, unknown>> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  const { data: invoice, error } = await sb
    .from("sales_invoices")
    .select("*")
    .eq("id", invoiceId)
    .eq("store_id", storeId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!invoice) throw new Error("الفاتورة غير موجودة");

  const { data: items } = await sb
    .from("sales_invoice_items")
    .select("*")
    .eq("invoice_id", invoiceId)
    .eq("store_id", storeId);

  return { invoice: { ...invoice, items: items ?? [] } };
}

export async function fetchProfitabilityReport(params: {
  from: string;
  to: string;
}): Promise<Record<string, unknown>> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  const { from, to } = params;

  const { data: invoices, error } = await sb
    .from("sales_invoices")
    .select("id,total,gross_profit,tax,discount,is_return,created_at")
    .eq("store_id", storeId)
    .gte("created_at", from)
    .lte("created_at", to + "T23:59:59.999+03:00");
  if (error) throw new Error(error.message);

  const rows = (invoices ?? []) as Record<string, unknown>[];
  let totalRevenue = 0, totalCost = 0, totalProfit = 0, totalTax = 0, totalDiscounts = 0, totalReturns = 0;
  for (const r of rows) {
    const amt = Number(r.total) || 0;
    if (r.is_return) {
      totalReturns += Math.abs(amt);
    } else {
      totalRevenue += amt;
    }
    const profit = Number(r.gross_profit) || 0;
    totalProfit += profit;
    totalCost += (Number(r.total) || 0) - profit;
    totalTax += Number(r.tax) || 0;
    totalDiscounts += Number(r.discount) || 0;
  }

  const netRevenue = totalRevenue - totalReturns;
  return {
    current: {
      summary: { totalRevenue, totalCost, totalProfit, totalTax, totalDiscounts, totalReturns, netRevenue },
      statement: { grossMargin: totalRevenue > 0 ? (totalProfit / totalRevenue * 100) : 0 },
      quality: { profitReliable: totalCost > 0 },
    },
    previous: null,
    generatedAt: new Date().toISOString(),
  };
}

/* ─── Sales ledger CSV export (client-side, formerly /api/reports/sales/export) ── */

const MAX_EXPORT_ROWS = 50_000;
const EXPORT_PAGE_SIZE = 1000;

function csvCell(value: unknown): string {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

/**
 * Walks the full filtered sales ledger (up to MAX_EXPORT_ROWS) and builds the
 * same UTF-8 BOM CSV the legacy export endpoint produced.
 */
export async function exportSalesLedgerCsv(params: {
  from: string;
  to: string;
  kind?: string;
  branchId?: string;
  terminalId?: string;
  cashierId?: string;
  paymentMethod?: string;
  search?: string;
}): Promise<{ filename: string; csv: string }> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  const { from, to } = params;
  if (!from || !to) throw new Error("حدد تاريخ البداية والنهاية");
  const fromDate = new Date(`${from}T00:00:00.000+03:00`);
  const toDate = new Date(`${to}T23:59:59.999+03:00`);
  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
    throw new Error("تاريخ غير صالح");
  }
  if (fromDate > toDate) throw new Error("تاريخ البداية يجب أن يكون قبل تاريخ النهاية");
  if (toDate.getTime() - fromDate.getTime() > 731 * DAY_MS) {
    throw new Error("المدة المطلوبة أطول من سنتين — قسّم التصدير");
  }

  const paymentMethod = ["CASH", "VISA", "SPLIT", "DEBT", "CLIQ"].includes(params.paymentMethod ?? "")
    ? params.paymentMethod!
    : null;
  const kind = params.kind === "SALE" || params.kind === "RETURN" ? params.kind : "ALL";

  let q = sb
    .from("sales_invoices")
    .select(
      "id,sync_id,branch_id,terminal_id,cashier_name,customer_id,customer_name,customer_phone,payment_method,subtotal,tax,discount,delivery_fee,total,cash_amount,visa_amount,cliq_amount,debt_amount,item_count,gross_profit,is_return,is_cancellation,completed_at",
    )
    .eq("store_id", storeId)
    .gte("created_at", from)
    .lte("created_at", to + "T23:59:59.999+03:00");
  if (params.branchId) q = q.eq("branch_id", params.branchId);
  if (params.terminalId) q = q.eq("terminal_id", params.terminalId);
  if (params.cashierId) q = q.eq("cashier_id", params.cashierId);
  if (paymentMethod) q = q.eq("payment_method", paymentMethod);
  if (kind === "SALE") q = q.eq("is_return", false);
  if (kind === "RETURN") q = q.eq("is_return", true);
  if (params.search?.trim()) q = q.ilike("cashier_name", `%${params.search.trim()}%`);

  const [branchRows, terminalRows] = await Promise.all([
    fetchAllRows<{ id: string; name: string }>(sb, "branches", "id,name", storeId),
    fetchAllRows<{ id: string; name: string }>(sb, "terminals", "id,name", storeId),
  ]);
  const branchNames = new Map(branchRows.map((b) => [b.id, b.name]));
  const terminalNames = new Map(terminalRows.map((t) => [t.id, t.name]));

  const rawRows: Record<string, unknown>[] = [];
  for (let offset = 0; offset < MAX_EXPORT_ROWS; offset += EXPORT_PAGE_SIZE) {
    const { data, error } = await q
      .order("created_at", { ascending: false })
      .range(offset, offset + EXPORT_PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    const batch = (data ?? []) as Record<string, unknown>[];
    rawRows.push(...batch);
    if (batch.length < EXPORT_PAGE_SIZE) break;
  }
  if (rawRows.length >= MAX_EXPORT_ROWS) {
    throw new Error("حجم التصدير يتجاوز 50 ألف فاتورة. قسّم الفترة إلى نطاقات أصغر");
  }

  const invoices = rawRows.map((row) => ({
    ...row,
    branch_name: branchNames.get(String(row.branch_id ?? "")) ?? "",
    terminal_name: terminalNames.get(String(row.terminal_id ?? "")) ?? "",
  })).map(mapSalesLedgerInvoice);

  const header = [
    "المرجع", "نوع المستند", "التاريخ", "الفرع", "الجهاز", "الكاشير", "العميل", "هاتف العميل", "طريقة الدفع",
    "ما قبل الخصم", "الضريبة", "الخصم", "رسوم التوصيل", "الإجمالي", "النقدي", "البطاقة", "كليك", "الذمم", "عدد الأصناف",
    "الربح الإجمالي", "هامش الربح %", "موثوقية الربح",
  ];
  const lines = [header, ...invoices.map((invoice) => [
    invoice.reference,
    invoice.isReturn ? "مرتجع" : "مبيعات",
    invoice.completedAt,
    invoice.branchName,
    invoice.terminalName,
    invoice.cashierName,
    invoice.customerName,
    invoice.customerPhone,
    invoice.paymentMethod,
    invoice.subtotal,
    invoice.tax,
    invoice.discount,
    invoice.deliveryFee,
    invoice.total,
    invoice.cashAmount,
    invoice.visaAmount,
    invoice.cliqAmount,
    invoice.debtAmount,
    invoice.itemCount,
    invoice.grossProfit ?? "غير محسوم",
    invoice.profitMargin ?? "",
    invoice.profitReliable ? "موثوق" : "غير موثوق",
  ])].map((row) => row.map(csvCell).join(","));

  return {
    filename: `sales-ledger-${from}-${to}.csv`,
    csv: "\uFEFF" + lines.join("\r\n"),
  };
}
