import { getSupabaseBrowser } from "./supabaseBrowser";
import { getTenantStoreId } from "./tenantClient";
import type { SupplierInvoiceDetail, SupplierInvoiceItem, SupplierPayment } from "@/types/supplierAccounts.types";

/**
 * Store-scoped supplier registry and accounts-payable ledger, queried directly
 * from Supabase in the browser (RLS-enforced). Replaces the former posFetch
 * calls to /api/suppliers and /api/supplier-accounts.
 */

export interface Supplier {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  balance: number;
  createdAt: string | null;
}

export interface SupplierInvoice {
  id: string;
  supplierId: string;
  supplierName: string;
  invoiceNumber: string;
  invoiceDate: string;
  subtotal: number;
  taxAmount: number;
  totalAmount: number;
  paidAmount: number;
  balanceDue: number;
  status: string;
  dueDate: string | null;
  notes: string | null;
  createdAt: string | null;
}

export interface SupplierInvoiceItemInput {
  productId?: string | null;
  description: string;
  quantity: number;
  unitCost: number;
  taxPercent?: number;
}

interface SupplierRow {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  balance: number | string | null;
  created_at: string | null;
}

interface SupplierInvoiceRow {
  id: string;
  supplier_id: string;
  invoice_number: string;
  invoice_date: string | null;
  subtotal: number | string | null;
  tax_amount: number | string | null;
  total_amount: number | string | null;
  paid_amount: number | string | null;
  balance_due: number | string | null;
  status: string;
  due_date: string | null;
  notes: string | null;
  created_at: string | null;
}

const SUPPLIER_SELECT = "id,name,phone,email,address,balance,created_at";
const INVOICE_SELECT =
  "id,supplier_id,invoice_number,invoice_date,due_date,subtotal,tax_amount,total_amount,paid_amount,balance_due,status,notes,created_at";
const INVOICE_LIST_SELECT =
  "id,supplier_id,invoice_number,invoice_date,subtotal,tax_amount,total_amount,paid_amount,balance_due,status,due_date,notes,created_at";

const INVOICE_STATUSES = new Set(["OPEN", "PARTIAL", "PAID", "VOID"]);
const PAYMENT_METHODS = new Set(["CASH", "BANK", "CARD", "CLIQ", "WALLET"]);
const NULL_UUID = "00000000-0000-0000-0000-000000000000";

function asNum(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function round3(n: number): number {
  return Math.round((n + Number.EPSILON) * 1000) / 1000;
}

/** Today's date (YYYY-MM-DD) in the store's Asia/Amman business timezone. */
function ammanToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Amman" }).format(new Date());
}

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function toSupplier(row: SupplierRow): Supplier {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone ?? null,
    email: row.email ?? null,
    address: row.address ?? null,
    balance: asNum(row.balance),
    createdAt: row.created_at ?? null,
  };
}

function toInvoice(row: SupplierInvoiceRow, supplierNames: Map<string, string>): SupplierInvoice {
  return {
    id: row.id,
    supplierId: row.supplier_id,
    supplierName: supplierNames.get(row.supplier_id) ?? "",
    invoiceNumber: row.invoice_number,
    invoiceDate: row.invoice_date ?? "",
    subtotal: round2(asNum(row.subtotal)),
    taxAmount: round2(asNum(row.tax_amount)),
    totalAmount: asNum(row.total_amount),
    paidAmount: asNum(row.paid_amount),
    balanceDue: asNum(row.balance_due),
    status: row.status,
    dueDate: row.due_date ?? "",
    notes: row.notes,
    createdAt: row.created_at ?? null,
  };
}

async function getSupplierNames(sb: NonNullable<ReturnType<typeof getSupabaseBrowser>>, storeId: string): Promise<Map<string, string>> {
  const { data } = await sb.from("suppliers").select("id,name").eq("store_id", storeId);
  const map = new Map<string, string>();
  for (const row of (data ?? []) as Array<{ id: string; name: string }>) map.set(row.id, row.name);
  return map;
}

/** List the store's suppliers ordered by name. */
export async function fetchSuppliers(): Promise<Supplier[]> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  const { data, error } = await sb
    .from("suppliers")
    .select(SUPPLIER_SELECT)
    .eq("store_id", storeId)
    .order("name", { ascending: true });
  if (error) throw new Error(error.message);

  return ((data ?? []) as SupplierRow[]).map(toSupplier);
}

/** Create a supplier (admin role enforced by RLS) starting from a zero balance. */
export async function createSupplier(data: {
  name: string;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
}): Promise<Supplier> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  const name = typeof data.name === "string" ? data.name.trim() : "";
  if (!name) throw new Error("اسم المورد مطلوب");
  if (name.length > 80) throw new Error("اسم المورد طويل جداً");

  const { data: supplier, error } = await sb
    .from("suppliers")
    .insert({
      store_id: storeId,
      name,
      phone: cleanText(data.phone),
      email: cleanText(data.email),
      address: cleanText(data.address),
      balance: 0,
    })
    .select(SUPPLIER_SELECT)
    .single();
  if (error || !supplier) throw new Error(error?.message ?? "تعذر إضافة المورد");

  return toSupplier(supplier as SupplierRow);
}

/** Update a supplier's contact details; the row must belong to the active store. */
export async function updateSupplier(
  id: string,
  data: { name?: string; phone?: string | null; email?: string | null; address?: string | null },
): Promise<Supplier> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  const patch: Record<string, unknown> = {};
  if (data.name !== undefined) {
    const name = typeof data.name === "string" ? data.name.trim() : "";
    if (!name) throw new Error("اسم المورد مطلوب");
    if (name.length > 80) throw new Error("اسم المورد طويل جداً");
    patch.name = name;
  }
  if (data.phone !== undefined) patch.phone = cleanText(data.phone);
  if (data.email !== undefined) patch.email = cleanText(data.email);
  if (data.address !== undefined) patch.address = cleanText(data.address);

  const { data: supplier, error } = await sb
    .from("suppliers")
    .update(patch)
    .eq("id", id)
    .eq("store_id", storeId)
    .select(SUPPLIER_SELECT)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!supplier) throw new Error("المورد غير موجود");

  return toSupplier(supplier as SupplierRow);
}

/**
 * Paged supplier-invoice listing with the payable summary fields. Supplier
 * names are resolved with a separate lightweight lookup instead of an embed.
 */
export async function fetchSupplierInvoices(params: {
  status?: string;
  page?: number;
  pageSize?: number;
}): Promise<{ invoices: SupplierInvoice[]; total: number; page: number; pageSize: number }> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  const page = Math.max(1, Math.floor(asNum(params.page, 1)));
  const pageSize = Math.max(1, Math.floor(asNum(params.pageSize, 50)));
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  let query = sb
    .from("supplier_invoices")
    .select(INVOICE_LIST_SELECT)
    .eq("store_id", storeId)
    .order("created_at", { ascending: false })
    .range(from, to);
  let countQuery = sb.from("supplier_invoices").select("id", { count: "exact", head: true }).eq("store_id", storeId);
  if (params.status && INVOICE_STATUSES.has(params.status)) {
    query = query.eq("status", params.status);
    countQuery = countQuery.eq("status", params.status);
  }

  const { data: invoices, error } = await query;
  if (error) throw new Error(error.message);

  const { count, error: countError } = await countQuery;
  if (countError) throw new Error(countError.message);

  const supplierNames = await getSupplierNames(sb, storeId);

  return {
    invoices: ((invoices ?? []) as SupplierInvoiceRow[]).map((row) => toInvoice(row, supplierNames)),
    total: count ?? 0,
    page,
    pageSize,
  };
}

/**
 * Create a supplier invoice (accounts-payable recognition). When line items
 * are supplied they are inserted into supplier_invoice_items and the header
 * subtotal/tax must match the declared total; otherwise the full amount is
 * booked as an untaxed subtotal.
 */
export async function createSupplierInvoice(data: {
  supplier_id: string;
  invoice_number: string;
  total_amount: number;
  paid_amount?: number;
  status?: string;
  due_date?: string;
  notes?: string | null;
  items?: SupplierInvoiceItemInput[];
}): Promise<SupplierInvoice> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  const supplierId = typeof data.supplier_id === "string" ? data.supplier_id.trim() : "";
  const invoiceNumber = typeof data.invoice_number === "string" ? data.invoice_number.trim() : "";
  if (!supplierId) throw new Error("المورد مطلوب");
  if (!invoiceNumber) throw new Error("رقم الفاتورة مطلوب");

  const total = round2(asNum(data.total_amount));
  if (total < 0) throw new Error("إجمالي الفاتورة غير صالح");

  const { data: supplier, error: supplierError } = await sb
    .from("suppliers")
    .select("id")
    .eq("id", supplierId)
    .eq("store_id", storeId)
    .maybeSingle();
  if (supplierError) throw new Error(supplierError.message);
  if (!supplier) throw new Error("المورد غير موجود");

  const invoiceDate = ammanToday();
  const dueDate = data.due_date && data.due_date.trim() !== "" ? data.due_date.trim() : invoiceDate;
  if (dueDate < invoiceDate) throw new Error("تاريخ الاستحقاق يجب أن يساوي أو يلي تاريخ الفاتورة");

  let subtotal = 0;
  let taxAmount = 0;
  let itemRows: Array<{
    line_no: number;
    product_id: string | null;
    description: string;
    quantity: number;
    unit_cost: number;
    tax_percent: number;
    net_amount: number;
    tax_amount: number;
    total_amount: number;
  }> | null = null;

  if (data.items && data.items.length > 0) {
    itemRows = data.items.map((item, index) => {
      const description = typeof item.description === "string" ? item.description.trim() : "";
      if (!description) throw new Error("وصف البند مطلوب");
      const quantity = round3(asNum(item.quantity));
      const unitCost = asNum(item.unitCost);
      const taxPercent = asNum(item.taxPercent);
      if (!(quantity > 0)) throw new Error("كمية البند يجب أن تكون أكبر من صفر");
      if (unitCost < 0) throw new Error("تكلفة البند يجب أن تكون صفر أو أكثر");
      if (taxPercent < 0 || taxPercent > 100) throw new Error("نسبة ضريبة البند يجب أن تكون بين 0 و 100");
      const netAmount = round2(quantity * unitCost);
      const itemTax = round2(netAmount * (taxPercent / 100));
      const itemTotal = round2(netAmount + itemTax);
      subtotal = round2(subtotal + netAmount);
      taxAmount = round2(taxAmount + itemTax);
      return {
        line_no: index + 1,
        product_id: item.productId || null,
        description,
        quantity,
        unit_cost: unitCost,
        tax_percent: taxPercent,
        net_amount: netAmount,
        tax_amount: itemTax,
        total_amount: itemTotal,
      };
    });
    const itemsTotal = round2(subtotal + taxAmount);
    if (Math.abs(itemsTotal - total) > 0.01) {
      throw new Error("الإجمالي لا يطابق مجموع البنود");
    }
  } else {
    subtotal = total;
    taxAmount = 0;
  }

  const paidAmount = Math.min(Math.max(round2(asNum(data.paid_amount)), 0), total);
  const balanceDue = round2(total - paidAmount);
  const status =
    data.status && INVOICE_STATUSES.has(data.status)
      ? data.status
      : balanceDue === 0
        ? "PAID"
        : paidAmount > 0
          ? "PARTIAL"
          : "OPEN";

  const { data: invoice, error: invoiceError } = await sb
    .from("supplier_invoices")
    .insert({
      store_id: storeId,
      supplier_id: supplierId,
      invoice_number: invoiceNumber,
      invoice_date: invoiceDate,
      due_date: dueDate,
      subtotal,
      tax_amount: taxAmount,
      total_amount: total,
      paid_amount: paidAmount,
      balance_due: balanceDue,
      status,
      notes: cleanText(data.notes),
    })
    .select(INVOICE_SELECT)
    .single();
  if (invoiceError || !invoice) throw new Error(invoiceError?.message ?? "تعذر إنشاء فاتورة المورد");

  if (itemRows) {
    const { error: itemsError } = await sb
      .from("supplier_invoice_items")
      .insert(itemRows.map((row) => ({ ...row, invoice_id: invoice.id, store_id: storeId })));
    if (itemsError) throw new Error(itemsError.message);
  }

  const supplierNames = new Map<string, string>([[supplierId, (await getSupplierNames(sb, storeId)).get(supplierId) ?? ""]]);
  return toInvoice(invoice as SupplierInvoiceRow, supplierNames);
}

/**
 * Record a payment against an open supplier invoice: advances paid_amount /
 * balance_due / status and appends a supplier_payments ledger entry when that
 * table exists (ledger failures never block the invoice settlement itself).
 */
export async function recordSupplierPayment(
  invoiceId: string,
  data: { amount: number; method?: string; reference?: string | null; notes?: string | null },
): Promise<SupplierInvoice> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  const amount = round2(asNum(data.amount));
  if (!(amount > 0)) throw new Error("قيمة الدفعة يجب أن تكون أكبر من صفر");

  const { data: invoice, error: readError } = await sb
    .from("supplier_invoices")
    .select("id,supplier_id,status,total_amount,paid_amount")
    .eq("id", invoiceId)
    .eq("store_id", storeId)
    .maybeSingle();
  if (readError) throw new Error(readError.message);
  if (!invoice) throw new Error("فاتورة المورد غير موجودة");

  const row = invoice as { id: string; supplier_id: string; status: string; total_amount: number | string | null; paid_amount: number | string | null };
  if (row.status === "VOID") throw new Error("لا يمكن الدفع على فاتورة ملغاة");
  if (row.status === "PAID") throw new Error("الفاتورة مدفوعة بالكامل");

  const total = round2(asNum(row.total_amount));
  const paidSoFar = round2(asNum(row.paid_amount));
  const balanceDue = round2(total - paidSoFar);
  if (amount > balanceDue + 0.001) throw new Error("المبلغ يتجاوز المتبقي على الفاتورة");

  const method = data.method && PAYMENT_METHODS.has(data.method) ? data.method : "CASH";

  try {
    const { error: paymentError } = await sb.from("supplier_payments").insert({
      store_id: storeId,
      supplier_id: row.supplier_id,
      invoice_id: invoiceId,
      amount,
      method,
      reference: cleanText(data.reference),
      notes: cleanText(data.notes),
    });
    void paymentError;
  } catch {
    // Ledger write is best-effort; settlement below still proceeds.
  }

  const newPaid = round2(paidSoFar + amount);
  const newDue = round2(total - newPaid);
  const newStatus = newDue === 0 ? "PAID" : "PARTIAL";

  const { data: updated, error: updateError } = await sb
    .from("supplier_invoices")
    .update({ paid_amount: newPaid, balance_due: newDue, status: newStatus })
    .eq("id", invoiceId)
    .eq("store_id", storeId)
    .select(INVOICE_SELECT)
    .maybeSingle();
  if (updateError) throw new Error(updateError.message);
  if (!updated) throw new Error("فاتورة المورد غير موجودة");

  const supplierNames = new Map<string, string>([[row.supplier_id, (await getSupplierNames(sb, storeId)).get(row.supplier_id) ?? ""]]);
  return toInvoice(updated as SupplierInvoiceRow, supplierNames);
}

interface SupplierInvoiceItemRow {
  id: string;
  line_no: number | string | null;
  product_id: string | null;
  description: string;
  quantity: number | string | null;
  unit_cost: number | string | null;
  tax_percent: number | string | null;
  net_amount: number | string | null;
  tax_amount: number | string | null;
  total_amount: number | string | null;
}

interface SupplierPaymentRow {
  id: string;
  amount: number | string | null;
  method: string;
  reference: string | null;
  notes: string | null;
  paid_at: string | null;
}

/**
 * Full invoice for the detail view, with line items and the payment ledger
 * (payments are optional — a missing ledger table yields an empty list).
 */
export async function fetchSupplierInvoiceDetail(invoiceId: string): Promise<SupplierInvoiceDetail> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  const { data: invoice, error } = await sb
    .from("supplier_invoices")
    .select(INVOICE_SELECT)
    .eq("id", invoiceId)
    .eq("store_id", storeId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!invoice) throw new Error("فاتورة المورد غير موجودة");

  const { data: items, error: itemsError } = await sb
    .from("supplier_invoice_items")
    .select("id,line_no,product_id,description,quantity,unit_cost,tax_percent,net_amount,tax_amount,total_amount")
    .eq("invoice_id", invoiceId)
    .eq("store_id", storeId)
    .order("line_no", { ascending: true });
  if (itemsError) throw new Error(itemsError.message);

  let paymentRows: SupplierPaymentRow[] = [];
  const { data: payments, error: paymentsError } = await sb
    .from("supplier_payments")
    .select("id,amount,method,reference,notes,paid_at")
    .eq("invoice_id", invoiceId)
    .eq("store_id", storeId)
    .order("paid_at", { ascending: true });
  if (!paymentsError) paymentRows = (payments ?? []) as SupplierPaymentRow[];

  const row = invoice as SupplierInvoiceRow;
  const base = toInvoice(row, await getSupplierNames(sb, storeId));

  const itemList: SupplierInvoiceItem[] = ((items ?? []) as SupplierInvoiceItemRow[]).map((item) => ({
    id: item.id,
    lineNo: Math.max(1, Math.floor(asNum(item.line_no, 1))),
    productId: item.product_id,
    description: item.description,
    quantity: asNum(item.quantity),
    unitCost: round2(asNum(item.unit_cost)),
    taxPercent: asNum(item.tax_percent),
    netAmount: round2(asNum(item.net_amount)),
    taxAmount: round2(asNum(item.tax_amount)),
    totalAmount: round2(asNum(item.total_amount)),
  }));

  const paymentList: SupplierPayment[] = paymentRows.map((payment) => ({
    id: payment.id,
    amount: round2(asNum(payment.amount)),
    method: (PAYMENT_METHODS.has(payment.method) ? payment.method : "CASH") as SupplierPayment["method"],
    reference: payment.reference ?? "",
    notes: payment.notes ?? "",
    paidAt: payment.paid_at ?? "",
  }));

  return {
    ...base,
    status: base.status as SupplierInvoiceDetail["status"],
    notes: base.notes ?? "",
    createdAt: base.createdAt ?? "",
    purchaseOrderId: null,
    dueDate: base.dueDate ?? "",
    itemCount: itemList.length,
    paymentCount: paymentList.length,
    isOverdue:
      base.balanceDue > 0 &&
      base.status !== "PAID" &&
      base.status !== "VOID" &&
      base.dueDate !== null &&
      base.dueDate < ammanToday(),
    items: itemList,
    payments: paymentList,
  };
}
