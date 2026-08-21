import { capabilityAuthorizationError, getCapabilityAccess } from "@/lib/requestAuth";
import { supabase } from "@/lib/supabase";
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

export const dynamic = "force-dynamic";

const DAY_MS = 24 * 60 * 60 * 1000;
const PAGE_SIZE = 1000;
/** PostgREST rejects `.in()` with very long URL query strings; keep batches small. */
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

interface BarcodeRow {
  barcode: string;
  product_id: string;
  cost_price: number | string | null;
}

interface VariantRow {
  barcode: string;
  product_id: string;
}

interface ProductCostRow {
  id: string;
  cost_price: number | string | null;
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

/** Products currently below zero stock, worst balance first. */
function buildNegativeStock(products: ProductRow[]): ReportsNegativeStock[] {
  return products
    .filter((product) => product.total_stock < 0)
    .map((product) => ({
      productId: product.id,
      name: product.name,
      stock: round2(product.total_stock),
    }))
    .sort((a, b) => a.stock - b.stock);
}

function parseDateParam(value: string | null, fallback: Date, endOfDay = false): Date {
  if (!value) return fallback;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return fallback;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    parsed.setHours(endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0);
  }
  return parsed;
}

function dayKey(value: string | null | undefined): string {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function paymentLabel(method: string): string {
  switch (method) {
    case "CASH":
      return "نقدي";
    case "VISA":
      return "بطاقة";
    case "CLIQ":
      return "كليك";
    case "SPLIT":
      return "مختلط";
    case "DEBT":
      return "ذمم";
    default:
      return "غير محدد";
  }
}

function emptySummary(): ReportsSummary {
  return {
    invoiceCount: 0,
    itemCount: 0,
    grossSales: 0,
    returns: 0,
    netSales: 0,
    subtotal: 0,
    tax: 0,
    discounts: 0,
    deliveryFee: 0,
    profitCandidate: 0,
    profit: 0,
    profitMargin: 0,
    profitReliable: true,
    averageTicket: 0,
    cash: 0,
    visa: 0,
    cliq: 0,
    debt: 0,
    debtCollections: 0,
    expenses: 0,
    netCashMovement: 0,
  };
}

function mockOverview(): ReportsOverview {
  const now = new Date();
  const from = new Date(now.getTime() - 29 * DAY_MS);
  return {
    range: { from: from.toISOString(), to: now.toISOString(), days: 30 },
    summary: {
      invoiceCount: 27144,
      itemCount: 211651,
      grossSales: 479619.03,
      returns: 0,
      netSales: 479619.03,
      subtotal: 413920.43,
      tax: 65799.76,
      discounts: 117.35,
      deliveryFee: 0,
      profitCandidate: 193526.48,
      profit: 193526.48,
      profitMargin: 46.8,
      profitReliable: true,
      averageTicket: 17.67,
      cash: 331026.92,
      visa: 148592.14,
      cliq: 21476.55,
      debt: 0,
      debtCollections: 0,
      expenses: 0,
      netCashMovement: 331026.92,
    },
    trend: [
      { date: "2026-06", invoices: 4362, sales: 77440.13, tax: 10673.47, profitCandidate: 29507.43, profit: 29507.43, profitReliable: true },
      { date: "2026-07", invoices: 8546, sales: 132132.55, tax: 18183.87, profitCandidate: 53304.15, profit: 53304.15, profitReliable: true },
      { date: "2026-08", invoices: 2356, sales: 36586.79, tax: 5039.08, profitCandidate: 13887.18, profit: 13887.18, profitReliable: true },
    ],
    paymentBreakdown: [
      { method: "CASH", label: "نقدي", count: 19899, amount: 331026.92, share: 66.1 },
      { method: "VISA", label: "بطاقة", count: 7210, amount: 148592.14, share: 29.7 },
      { method: "CLIQ", label: "كليك", count: 1024, amount: 21476.55, share: 4.2 },
      { method: "DEBT", label: "ذمم", count: 1, amount: 0, share: 0 },
    ],
    topProducts: [
      { productId: "misc", name: "متفرقات", barcode: "", quantity: 33468.05, sales: 97541.22, profitCandidate: 84094.6, profit: 84094.6, margin: 86.2, profitReliable: true, stock: 0 },
      { productId: "gloves", name: "كفوف طبي 100 كفه", barcode: "9555256605444", quantity: 1766, sales: 5230.39, profitCandidate: 4508.96, profit: 4508.96, margin: 86.2, profitReliable: true, stock: -3816 },
      { productId: "foil", name: "علب مايكرويف", barcode: "100000645", quantity: 203, sales: 3804.5, profitCandidate: 234.74, profit: 234.74, margin: 6.2, profitReliable: true, stock: -326 },
    ],
    stockAlerts: [
      { productId: "gloves", name: "كفوف طبي 100 كفه", stock: -3816, soldQuantity: 1766, daysOfStockLeft: 0, severity: "critical" },
      { productId: "paper", name: "مناديل مبللة", stock: -7320, soldQuantity: 1881, daysOfStockLeft: 0, severity: "critical" },
    ],
    dataQuality: [
      {
        id: "historical-open-orders",
        label: "طلبات مفتوحة تاريخية",
        severity: "high",
        count: 23631,
        description: "الملف المرجعي يحتوي طلبات opened كثيرة؛ التقارير يجب أن تفصل الطلبات عن الفواتير المغلقة.",
      },
      {
        id: "negative-stock",
        label: "مخزون سالب",
        severity: "high",
        count: 4427,
        amount: -495648.32,
        description: "مؤشر خطر على الجرد أو الاستيراد أو البيع بدون رصيد.",
      },
    ],
    negativeStock: [
      { productId: "paper", name: "مناديل مبللة", stock: -7320 },
      { productId: "gloves", name: "كفوف طبي 100 كفه", stock: -3816 },
      { productId: "foil", name: "علب مايكرويف", stock: -326 },
    ],
    generatedAt: now.toISOString(),
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

async function fetchEvents(
  storeId: string,
  from: Date,
  to: Date,
  branchId: string,
  terminalId: string,
): Promise<SyncEventRow[]> {
  if (!supabase) return [];
  const rows: SyncEventRow[] = [];
  for (let start = 0; ; start += PAGE_SIZE) {
    let query = supabase
      .from("sync_events")
      .select("sync_id,action_type,payload,created_at,client_created_at,branch_id,terminal_id")
      .eq("store_id", storeId)
      .in("action_type", ["INVOICE_CREATED", "DEBT_SETTLEMENT", "EXPENSE_RECORDED"])
      .gte("client_created_at", from.toISOString())
      .lte("client_created_at", to.toISOString())
      .order("client_created_at", { ascending: true })
      .range(start, start + PAGE_SIZE - 1);
    if (branchId) query = query.eq("branch_id", branchId);
    if (terminalId) query = query.eq("terminal_id", terminalId);
    const { data, error } = await query.returns<SyncEventRow[]>();
    if (error) throw error;
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE_SIZE) break;
  }
  return rows;
}

async function fetchProducts(storeId: string): Promise<ProductRow[]> {
  if (!supabase) return [];
  const rows: ProductRow[] = [];
  for (let start = 0; ; start += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("products")
      .select("id,name,total_stock")
      .eq("store_id", storeId)
      .order("name", { ascending: true })
      .range(start, start + PAGE_SIZE - 1)
      .returns<ProductRow[]>();
    if (error) throw error;
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE_SIZE) break;
  }
  return rows;
}

async function fetchBarcodes(storeId: string): Promise<BarcodeRow[]> {
  if (!supabase) return [];
  const variants: VariantRow[] = [];
  for (let start = 0; ; start += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("product_variants")
      .select("barcode,product_id")
      .eq("store_id", storeId)
      .range(start, start + PAGE_SIZE - 1)
      .returns<VariantRow[]>();
    if (error) throw error;
    variants.push(...(data ?? []));
    if (!data || data.length < PAGE_SIZE) break;
  }
  if (variants.length === 0) return [];

  const costMap = new Map<string, number | string | null>();
  for (let start = 0; ; start += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("products")
      .select("id,cost_price")
      .eq("store_id", storeId)
      .range(start, start + PAGE_SIZE - 1)
      .returns<ProductCostRow[]>();
    if (error) throw error;
    for (const row of data ?? []) costMap.set(row.id, row.cost_price);
    if (!data || data.length < PAGE_SIZE) break;
  }

  return variants.map((v) => ({
    barcode: v.barcode,
    product_id: v.product_id,
    cost_price: costMap.get(v.product_id) ?? null,
  }));
}

async function fetchSalesInvoices(
  storeId: string,
  from: Date,
  to: Date,
  branchId: string,
  terminalId: string,
): Promise<SalesInvoiceRow[]> {
  if (!supabase) return [];
  const rows: SalesInvoiceRow[] = [];
  for (let start = 0; ; start += PAGE_SIZE) {
    let query = supabase
      .from("sales_invoices")
      .select("id,sync_id,payment_method,subtotal,tax,discount,delivery_fee,total,cash_amount,visa_amount,cliq_amount,debt_amount,item_count,gross_profit,cashier_name,completed_at")
      .eq("store_id", storeId)
      .gte("completed_at", from.toISOString())
      .lte("completed_at", to.toISOString())
      .order("completed_at", { ascending: true })
      .range(start, start + PAGE_SIZE - 1);
    if (branchId) query = query.eq("branch_id", branchId);
    if (terminalId) query = query.eq("terminal_id", terminalId);
    const { data, error } = await query.returns<SalesInvoiceRow[]>();
    if (error) throw error;
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE_SIZE) break;
  }
  return rows;
}

async function fetchSalesInvoiceItems(storeId: string, invoiceIds: string[]): Promise<SalesInvoiceItemRow[]> {
  if (!supabase || invoiceIds.length === 0) return [];
  const rows: SalesInvoiceItemRow[] = [];
  for (let i = 0; i < invoiceIds.length; i += IN_BATCH_SIZE) {
    const batch = invoiceIds.slice(i, i + IN_BATCH_SIZE);
    const { data, error } = await supabase
      .from("sales_invoice_items")
      .select("invoice_id,product_id,product_name,barcode,qty,line_total,cost_price,gross_profit")
      .eq("store_id", storeId)
      .in("invoice_id", batch)
      .returns<SalesInvoiceItemRow[]>();
    if (error) throw error;
    rows.push(...(data ?? []));
  }
  return rows;
}

function buildOverview(params: {
  events: SyncEventRow[];
  products: ProductRow[];
  barcodes: BarcodeRow[];
  from: Date;
  to: Date;
}): ReportsOverview {
  const summary = emptySummary();
  const trend = new Map<string, ReportsTrendPoint>();
  const payment = new Map<string, { count: number; amount: number }>();
  const productMap = new Map(params.products.map((p) => [p.id, p]));
  const productBarcodeCount = new Map<string, number>();
  const costByBarcode = new Map<string, number>();
  const fallbackCostByProduct = new Map<string, number>();
  for (const barcode of params.barcodes) {
    const cost = asNumber(barcode.cost_price);
    productBarcodeCount.set(barcode.product_id, (productBarcodeCount.get(barcode.product_id) ?? 0) + 1);
    costByBarcode.set(barcode.barcode, cost);
    if (!fallbackCostByProduct.has(barcode.product_id) && cost > 0) {
      fallbackCostByProduct.set(barcode.product_id, cost);
    }
  }

  const productSales = new Map<string, ProductAccumulator>();
  let missingCashier = 0;
  let missingBarcodeLines = 0;
  let unknownProductLines = 0;

  for (const event of params.events) {
    const payload = objectPayload(event.payload);
    const occurredAt = asText(payload.completed_at) || asText(payload.created_at) || event.client_created_at || event.created_at;
    const key = dayKey(occurredAt);
    const point = trend.get(key) ?? { date: key, invoices: 0, sales: 0, tax: 0, profitCandidate: 0, profit: 0, profitReliable: true };

    if (event.action_type === "DEBT_SETTLEMENT") {
      const amount = round2(asNumber(payload.amount));
      summary.debtCollections = round2(summary.debtCollections + amount);
      continue;
    }
    if (event.action_type === "EXPENSE_RECORDED") {
      const amount = round2(asNumber(payload.amount));
      summary.expenses = round2(summary.expenses + amount);
      continue;
    }

    const total = round2(asNumber(payload.total));
    const subtotal = round2(asNumber(payload.subtotal));
    const discount = round2(asNumber(payload.discount));
    const deliveryFee = round2(asNumber(payload.deliveryFee));
    const tax = round2(asNumber(payload.tax));
    const method = asText(payload.paymentMethod) || "UNKNOWN";
    const amountPaid = round2(asNumber(payload.amountPaid));
    const items = Array.isArray(payload.items) ? payload.items : [];
    const cashierName = asText(payload.cashierName);
    if (!cashierName) missingCashier += 1;

    summary.invoiceCount += 1;
    summary.subtotal = round2(summary.subtotal + subtotal);
    summary.tax = round2(summary.tax + tax);
    summary.discounts = round2(summary.discounts + discount);
    summary.deliveryFee = round2(summary.deliveryFee + deliveryFee);
    summary.netSales = round2(summary.netSales + total);
    if (total >= 0) summary.grossSales = round2(summary.grossSales + total);
    else summary.returns = round2(summary.returns + Math.abs(total));

    if (method === "CASH") {
      summary.cash = round2(summary.cash + total);
      addPayment(payment, "CASH", total);
    } else if (method === "VISA") {
      summary.visa = round2(summary.visa + total);
      addPayment(payment, "VISA", total);
    } else if (method === "CLIQ") {
      summary.cliq = round2(summary.cliq + total);
      addPayment(payment, "CLIQ", total);
    } else if (method === "DEBT") {
      summary.debt = round2(summary.debt + total);
      addPayment(payment, "DEBT", total);
    } else if (method === "SPLIT") {
      const cashPart = total >= 0 ? Math.min(amountPaid, total) : total;
      const visaPart = round2(total - cashPart);
      summary.cash = round2(summary.cash + cashPart);
      summary.visa = round2(summary.visa + visaPart);
      addPayment(payment, "SPLIT", total);
    } else {
      addPayment(payment, "UNKNOWN", total);
    }

    const discountRatio = subtotal > 0 ? Math.max(0, Math.min(1, discount / subtotal)) : 0;
    let invoiceProfitCandidate = deliveryFee;
    let invoiceProfitReliable = true;
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
      invoiceProfitCandidate = round2(invoiceProfitCandidate + lineProfit);
      invoiceProfitReliable = invoiceProfitReliable && (quantity === 0 || unitCost > 0);
      summary.itemCount = round2(summary.itemCount + Math.abs(quantity));
      if (!barcode) missingBarcodeLines += 1;
      if (productId && !productMap.has(productId)) unknownProductLines += 1;

      const keyForProduct = productId || `barcode:${barcode || name}`;
      const current =
        productSales.get(keyForProduct) ??
        {
          productId: productId || keyForProduct,
          name,
          barcode,
          quantity: 0,
          sales: 0,
          cost: 0,
          profitCandidate: 0,
          profitReliable: true,
          stock: productMap.get(productId)?.total_stock ?? null,
        };
      current.quantity = round2(current.quantity + quantity);
      current.sales = round2(current.sales + lineSales);
      current.cost = round2(current.cost + cost);
      current.profitCandidate = round2(current.profitCandidate + lineProfit);
      current.profitReliable = current.profitReliable && (quantity === 0 || unitCost > 0);
      if (!current.barcode && barcode) current.barcode = barcode;
      productSales.set(keyForProduct, current);
    }

    summary.profitCandidate = round2(summary.profitCandidate + invoiceProfitCandidate);
    summary.profitReliable = summary.profitReliable && invoiceProfitReliable;
    point.invoices += 1;
    point.sales = round2(point.sales + total);
    point.tax = round2(point.tax + tax);
    point.profitCandidate = round2(point.profitCandidate + invoiceProfitCandidate);
    point.profitReliable = point.profitReliable && invoiceProfitReliable;
    point.profit = point.profitReliable ? point.profitCandidate : null;
    trend.set(key, point);
  }

  summary.averageTicket = summary.invoiceCount > 0 ? round2(summary.netSales / summary.invoiceCount) : 0;
  const revenue = round2(summary.subtotal + summary.deliveryFee);
  summary.profit = summary.profitReliable ? summary.profitCandidate : null;
  summary.profitMargin = summary.profitReliable && revenue !== 0 ? round2((summary.profitCandidate / revenue) * 100) : null;
  summary.netCashMovement = round2(summary.cash + summary.debtCollections - summary.expenses);

  const paymentDenominator = Array.from(payment.values()).reduce((sum, item) => sum + Math.abs(item.amount), 0);
  const paymentBreakdown: ReportsPaymentBreakdown[] = Array.from(payment.entries())
    .map(([method, item]) => ({
      method,
      label: paymentLabel(method),
      count: item.count,
      amount: round2(item.amount),
      share: paymentDenominator > 0 ? round2((Math.abs(item.amount) / paymentDenominator) * 100) : 0,
    }))
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));

  const topProducts: ReportsTopProduct[] = Array.from(productSales.values())
    .map((p) => ({
      productId: p.productId,
      name: p.name,
      barcode: p.barcode,
      quantity: round2(p.quantity),
      sales: round2(p.sales),
      profitCandidate: round2(p.profitCandidate),
      profit: p.profitReliable ? round2(p.profitCandidate) : null,
      margin: p.profitReliable && p.sales !== 0 ? round2((p.profitCandidate / p.sales) * 100) : null,
      profitReliable: p.profitReliable,
      stock: p.stock,
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
      return {
        productId: product.id,
        name: product.name,
        stock: product.total_stock,
        soldQuantity: round2(sold),
        daysOfStockLeft,
        severity,
      };
    })
    .filter((alert) => alert.stock <= 5 || (alert.daysOfStockLeft !== null && alert.daysOfStockLeft <= 14))
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
    dataQuality.push({
      id: "missing-cashier",
      label: "فواتير بلا كاشير",
      severity: "medium",
      count: missingCashier,
      description: "هذه غالباً فواتير قديمة قبل تثبيت ختم cashierName داخل payload.",
    });
  }
  if (negativeStock.length > 0) {
    dataQuality.push({
      id: "negative-stock",
      label: "منتجات بمخزون سالب",
      severity: "high",
      count: negativeStock.length,
      amount: round2(negativeStock.reduce((sum, p) => sum + p.total_stock, 0)),
      description: "يجب عمل جرد افتتاحي أو منع البيع عند نفاد الرصيد لهذه الأصناف.",
    });
  }
  if (missingBarcodeProducts.length > 0) {
    dataQuality.push({
      id: "products-without-barcodes",
      label: "منتجات بلا باركود",
      severity: "medium",
      count: missingBarcodeProducts.length,
      description: "أي منتج بلا باركود يصعب تتبعه في البيع السريع والتقارير التفصيلية.",
    });
  }
  if (zeroCostBarcodes.length > 0) {
    dataQuality.push({
      id: "zero-cost-barcodes",
      label: "باركودات بلا تكلفة",
      severity: "medium",
      count: zeroCostBarcodes.length,
      description: "الربح يصبح تقديرياً وغير محاسبي عندما تكون تكلفة الصنف صفراً.",
    });
  }
  if (missingBarcodeLines > 0) {
    dataQuality.push({
      id: "invoice-lines-without-barcode",
      label: "أسطر بيع بلا باركود",
      severity: "low",
      count: missingBarcodeLines,
      description: "غالباً من أزرار سريعة أو بحث يدوي؛ الأفضل ربط كل صنف بمعرف قابل للتتبع.",
    });
  }
  if (unknownProductLines > 0) {
    dataQuality.push({
      id: "unknown-product-lines",
      label: "أسطر بيع لمنتجات غير موجودة",
      severity: "high",
      count: unknownProductLines,
      description: "يوجد فرق بين سجل الفواتير والكتالوج الحالي، وقد يؤثر على الربح والمخزون.",
    });
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

function buildOverviewFromLedger(params: {
  invoices: SalesInvoiceRow[];
  items: SalesInvoiceItemRow[];
  events: SyncEventRow[];
  products: ProductRow[];
  barcodes: BarcodeRow[];
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
    const point = trend.get(key) ?? { date: key, invoices: 0, sales: 0, tax: 0, profitCandidate: 0, profit: 0, profitReliable: true };
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
      {
        productId: productId || key,
        name: asText(item.product_name) || product?.name || "صنف غير معروف",
        barcode: asText(item.barcode),
        quantity: 0,
        sales: 0,
        cost: 0,
        profitCandidate: 0,
        profitReliable: true,
        stock: product?.total_stock ?? null,
      };
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
    if (point) {
      point.profitReliable = false;
      point.profit = null;
    }
  }

  const topProducts: ReportsTopProduct[] = Array.from(productSales.values())
    .map((p) => ({
      productId: p.productId,
      name: p.name,
      barcode: p.barcode,
      quantity: round2(p.quantity),
      sales: round2(p.sales),
      profitCandidate: round2(p.profitCandidate),
      profit: p.profitReliable ? round2(p.profitCandidate) : null,
      margin: p.profitReliable && p.sales !== 0 ? round2((p.profitCandidate / p.sales) * 100) : null,
      profitReliable: p.profitReliable,
      stock: p.stock,
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
      return {
        productId: product.id,
        name: product.name,
        stock: product.total_stock,
        soldQuantity: round2(sold),
        daysOfStockLeft,
        severity,
      };
    })
    .filter((alert) => alert.stock <= 5 || (alert.daysOfStockLeft !== null && alert.daysOfStockLeft <= 14))
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
    dataQuality.push({
      id: "missing-cashier",
      label: "فواتير بلا كاشير",
      severity: "medium",
      count: missingCashier,
      description: "هذه غالباً فواتير قديمة قبل تثبيت ختم cashierName داخل payload.",
    });
  }
  if (negativeStock.length > 0) {
    dataQuality.push({
      id: "negative-stock",
      label: "منتجات بمخزون سالب",
      severity: "high",
      count: negativeStock.length,
      amount: round2(negativeStock.reduce((sum, p) => sum + p.total_stock, 0)),
      description: "يجب عمل جرد افتتاحي أو منع البيع عند نفاد الرصيد لهذه الأصناف.",
    });
  }
  if (missingBarcodeProducts.length > 0) {
    dataQuality.push({
      id: "products-without-barcodes",
      label: "منتجات بلا باركود",
      severity: "medium",
      count: missingBarcodeProducts.length,
      description: "أي منتج بلا باركود يصعب تتبعه في البيع السريع والتقارير التفصيلية.",
    });
  }
  if (zeroCostBarcodes.length > 0) {
    dataQuality.push({
      id: "zero-cost-barcodes",
      label: "باركودات بلا تكلفة",
      severity: "medium",
      count: zeroCostBarcodes.length,
      description: "الربح يصبح تقديرياً وغير محاسبي عندما تكون تكلفة الصنف صفراً.",
    });
  }
  if (missingBarcodeLines > 0) {
    dataQuality.push({
      id: "invoice-lines-without-barcode",
      label: "أسطر بيع بلا باركود",
      severity: "low",
      count: missingBarcodeLines,
      description: "غالباً من أزرار سريعة أو بحث يدوي؛ الأفضل ربط كل صنف بمعرف قابل للتتبع.",
    });
  }
  if (unknownProductLines > 0) {
    dataQuality.push({
      id: "unknown-product-lines",
      label: "أسطر بيع لمنتجات غير موجودة",
      severity: "high",
      count: unknownProductLines,
      description: "يوجد فرق بين سجل الفواتير والكتالوج الحالي، وقد يؤثر على الربح والمخزون.",
    });
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

export async function GET(request: Request): Promise<Response> {
  if (!supabase) {
    return Response.json({ overview: mockOverview() });
  }

  const access = await getCapabilityAccess(request, "reports.view");
  if (!access) {
    return capabilityAuthorizationError(request, "reports.view");
  }

  const url = new URL(request.url);
  const now = new Date();
  const to = parseDateParam(url.searchParams.get("to"), now, true);
  const fromFallback = new Date(to.getTime() - 29 * DAY_MS);
  const from = parseDateParam(url.searchParams.get("from"), fromFallback);
  const branchId = url.searchParams.get("branchId")?.trim() ?? "";
  const terminalId = url.searchParams.get("terminalId")?.trim() ?? "";

  try {
    const [products, barcodes] = await Promise.all([
      fetchProducts(access.storeId),
      fetchBarcodes(access.storeId),
    ]);
    try {
      const invoices = await fetchSalesInvoices(access.storeId, from, to, branchId, terminalId);
      if (invoices.length > 0) {
        const [items, events] = await Promise.all([
          fetchSalesInvoiceItems(access.storeId, invoices.map((invoice) => invoice.id)),
          fetchEvents(access.storeId, from, to, branchId, terminalId),
        ]);
        return Response.json({
          overview: buildOverviewFromLedger({ invoices, items, events, products, barcodes, from, to }),
        });
      }
    } catch (ledgerError) {
      const code = typeof ledgerError === "object" && ledgerError && "code" in ledgerError ? String(ledgerError.code) : "";
      if (code !== "42P01" && code !== "42703") throw ledgerError;
    }
    const events = await fetchEvents(access.storeId, from, to, branchId, terminalId);
    return Response.json({ overview: buildOverview({ events, products, barcodes, from, to }) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "reports_overview_failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
