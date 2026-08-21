import { capabilityAuthorizationError, getCapabilityAccess, type CapabilityAccess } from "@/lib/requestAuth";
import { opsToken } from "@/lib/platformOps";
import {
  EMPTY_SUPPLIER_SUMMARY,
  mapSupplierInvoice,
  mapSupplierSummary,
  supplierNumber,
  supplierText,
} from "@/lib/supplierAccounts";
import { supabase } from "@/lib/supabase";
import type {
  SupplierAccountsResponse,
  SupplierInvoiceFilterStatus,
  SupplierPaymentMethod,
} from "@/types/supplierAccounts.types";

export const dynamic = "force-dynamic";

const DAY_MS = 24 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseDate(value: string | null, fallback: Date, endOfDay = false): Date {
  if (!value) return fallback;
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}+03:00`)
    : new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

function optionalUuid(value: unknown): string | null {
  const clean = supplierText(value);
  return UUID_RE.test(clean) ? clean : null;
}

function dateOnly(value: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Amman",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

async function audit(
  access: CapabilityAccess,
  actionType: "CREATE_SUPPLIER_INVOICE" | "RECORD_SUPPLIER_PAYMENT",
  targetId: string,
  details: Record<string, unknown>,
): Promise<void> {
  if (!supabase) return;
  await supabase.from("admin_audit_logs").insert({
    store_id: access.storeId,
    admin_id: access.role === "cashier" ? access.actorId : null,
    admin_name: access.actorName,
    action_type: actionType,
    target_id: targetId,
    details,
  });
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const now = new Date();
  const to = parseDate(url.searchParams.get("to"), now, true);
  const from = parseDate(url.searchParams.get("from"), new Date(to.getTime() - 89 * DAY_MS));
  if (from > to) return Response.json({ error: "تاريخ البداية يجب أن يسبق تاريخ النهاية" }, { status: 400 });
  if (to.getTime() - from.getTime() > 731 * DAY_MS) {
    return Response.json({ error: "الفترة القصوى سنتان" }, { status: 400 });
  }
  const page = Math.max(1, Math.trunc(supplierNumber(url.searchParams.get("page")) || 1));
  const pageSize = Math.min(100, Math.max(10, Math.trunc(supplierNumber(url.searchParams.get("pageSize")) || 50)));
  const supplierId = optionalUuid(url.searchParams.get("supplierId"));
  const statusCandidate = supplierText(url.searchParams.get("status"));
  const status: SupplierInvoiceFilterStatus = ["OPEN", "PARTIAL", "PAID", "OVERDUE"].includes(statusCandidate)
    ? (statusCandidate as SupplierInvoiceFilterStatus)
    : "ALL";
  const search = supplierText(url.searchParams.get("search")).slice(0, 80) || null;

  if (!supabase) {
    return Response.json({
      invoices: [],
      summary: EMPTY_SUPPLIER_SUMMARY,
      suppliers: [],
      products: [],
      pagination: { page, pageSize, total: 0, totalPages: 0 },
      generatedAt: new Date().toISOString(),
    } satisfies SupplierAccountsResponse);
  }

  const access = await getCapabilityAccess(request, "suppliers.manage");
  if (!access) return capabilityAuthorizationError(request, "suppliers.manage");

  try {
    const [listResult, summaryResult, suppliersResult, productsResult] = await Promise.all([
      supabase.rpc("secure_list_supplier_invoices", {
        p_store_id: access.storeId,
        p_from: dateOnly(from),
        p_to: dateOnly(to),
        p_supplier_id: supplierId,
        p_status: status,
        p_search: search,
        p_limit: pageSize,
        p_offset: (page - 1) * pageSize,
        p_token: opsToken(),
      }),
      supabase.rpc("secure_supplier_accounting_summary", {
        p_store_id: access.storeId,
        p_from: from.toISOString(),
        p_to: to.toISOString(),
        p_token: opsToken(),
      }),
      supabase.from("suppliers").select("id,name,balance").eq("store_id", access.storeId).order("name"),
      supabase
        .from("products")
        .select("id,name,base_unit,tax_percent")
        .eq("store_id", access.storeId)
        .eq("is_purchasable", true)
        .order("name"),
    ]);
    if (listResult.error) throw listResult.error;
    if (summaryResult.error) throw summaryResult.error;
    if (suppliersResult.error) throw suppliersResult.error;
    if (productsResult.error) throw productsResult.error;
    const rows = Array.isArray(listResult.data) ? (listResult.data as Record<string, unknown>[]) : [];
    const total = rows.length > 0 ? supplierNumber(rows[0].total_count) : 0;
    return Response.json({
      invoices: rows.map(mapSupplierInvoice),
      summary: mapSupplierSummary(summaryResult.data),
      suppliers: (suppliersResult.data ?? []).map((supplier) => ({
        id: supplier.id,
        name: supplier.name,
        balance: supplierNumber(supplier.balance),
      })),
      products: (productsResult.data ?? []).map((product) => ({
        id: product.id,
        name: product.name,
        baseUnit: supplierText(product.base_unit) || "حبة",
        taxPercent: supplierNumber(product.tax_percent),
      })),
      pagination: { page, pageSize, total, totalPages: total === 0 ? 0 : Math.ceil(total / pageSize) },
      generatedAt: new Date().toISOString(),
    } satisfies SupplierAccountsResponse);
  } catch (error) {
    const message = error instanceof Error ? error.message : "supplier_accounts_failed";
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request): Promise<Response> {
  if (!supabase) return Response.json({ error: "Supabase غير مهيأة" }, { status: 503 });
  const access = await getCapabilityAccess(request, "suppliers.manage");
  if (!access) return capabilityAuthorizationError(request, "suppliers.manage");
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const input = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const supplierId = optionalUuid(input.supplierId);
  const purchaseOrderId = optionalUuid(input.purchaseOrderId);
  const invoiceNumber = supplierText(input.invoiceNumber).slice(0, 80);
  const invoiceDate = supplierText(input.invoiceDate);
  const dueDate = supplierText(input.dueDate);
  const notes = supplierText(input.notes).slice(0, 1000);
  if (!supplierId) return Response.json({ error: "المورد مطلوب" }, { status: 400 });
  if (!invoiceNumber) return Response.json({ error: "رقم فاتورة المورد مطلوب" }, { status: 400 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(invoiceDate) || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || dueDate < invoiceDate) {
    return Response.json({ error: "تواريخ الفاتورة والاستحقاق غير صالحة" }, { status: 400 });
  }
  const rawItems = Array.isArray(input.items) ? input.items : [];
  if (rawItems.length === 0 || rawItems.length > 100) {
    return Response.json({ error: "أضف بنداً واحداً على الأقل، وبحد أقصى 100 بند" }, { status: 400 });
  }
  const items: Array<{
    productId: string | null;
    description: string;
    quantity: number;
    unitCost: number;
    taxPercent: number;
  }> = [];
  for (const raw of rawItems) {
    const row = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const productId = optionalUuid(row.productId);
    const description = supplierText(row.description).slice(0, 255);
    const quantity = supplierNumber(row.quantity);
    const unitCost = supplierNumber(row.unitCost);
    const taxPercent = supplierNumber(row.taxPercent);
    if (!description || quantity <= 0 || unitCost < 0 || taxPercent < 0 || taxPercent > 100) {
      return Response.json({ error: "يوجد بند غير صالح في فاتورة المورد" }, { status: 400 });
    }
    items.push({ productId, description, quantity, unitCost, taxPercent });
  }

  const result = await supabase.rpc("secure_create_supplier_invoice", {
    p_store_id: access.storeId,
    p_supplier_id: supplierId,
    p_invoice_number: invoiceNumber,
    p_invoice_date: invoiceDate,
    p_due_date: dueDate,
    p_notes: notes || null,
    p_purchase_order_id: purchaseOrderId,
    p_items: items,
    p_token: opsToken(),
  });
  if (result.error) {
    const duplicate = result.error.code === "23505";
    return Response.json(
      { error: duplicate ? "رقم الفاتورة مسجل مسبقاً لهذا المورد" : result.error.message },
      { status: duplicate ? 409 : 400 },
    );
  }
  const created = result.data && typeof result.data === "object" ? (result.data as Record<string, unknown>) : {};
  const id = supplierText(created.id);
  await audit(access, "CREATE_SUPPLIER_INVOICE", id, {
    supplierId,
    invoiceNumber,
    totalAmount: supplierNumber(created.totalAmount),
    taxAmount: supplierNumber(created.taxAmount),
  }).catch(() => undefined);
  return Response.json({ invoice: created }, { status: 201 });
}

export async function PATCH(request: Request): Promise<Response> {
  if (!supabase) return Response.json({ error: "Supabase غير مهيأة" }, { status: 503 });
  const access = await getCapabilityAccess(request, "suppliers.manage");
  if (!access) return capabilityAuthorizationError(request, "suppliers.manage");
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const input = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const invoiceId = optionalUuid(input.invoiceId);
  const amount = supplierNumber(input.amount);
  const methodCandidate = supplierText(input.method);
  const method: SupplierPaymentMethod | null = ["CASH", "BANK", "CARD"].includes(methodCandidate)
    ? (methodCandidate as SupplierPaymentMethod)
    : null;
  const reference = supplierText(input.reference).slice(0, 120);
  const notes = supplierText(input.notes).slice(0, 1000);
  const paidAt = supplierText(input.paidAt);
  if (!invoiceId || amount <= 0 || !method) {
    return Response.json({ error: "بيانات دفعة المورد غير مكتملة" }, { status: 400 });
  }
  const parsedPaidAt = paidAt ? new Date(paidAt) : new Date();
  if (Number.isNaN(parsedPaidAt.getTime())) return Response.json({ error: "تاريخ الدفع غير صالح" }, { status: 400 });

  const result = await supabase.rpc("secure_record_supplier_payment", {
    p_store_id: access.storeId,
    p_invoice_id: invoiceId,
    p_amount: Math.round((amount + Number.EPSILON) * 100) / 100,
    p_method: method,
    p_reference: reference || null,
    p_notes: notes || null,
    p_paid_at: parsedPaidAt.toISOString(),
    p_token: opsToken(),
  });
  if (result.error) {
    const message = result.error.message.includes("payment_exceeds_balance")
      ? "المبلغ يتجاوز الرصيد المستحق"
      : result.error.message;
    return Response.json({ error: message }, { status: 400 });
  }
  const payment = result.data && typeof result.data === "object" ? (result.data as Record<string, unknown>) : {};
  await audit(access, "RECORD_SUPPLIER_PAYMENT", invoiceId, {
    amount,
    method,
    balanceDue: supplierNumber(payment.balanceDue),
  }).catch(() => undefined);
  return Response.json({ payment });
}
