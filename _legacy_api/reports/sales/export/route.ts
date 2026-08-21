import { capabilityAuthorizationError, getCapabilityAccess } from "@/lib/requestAuth";
import { ledgerNumber, ledgerText, mapSalesLedgerInvoice } from "@/lib/salesLedger";
import { supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const DAY_MS = 24 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PAGE_SIZE = 100;
const MAX_EXPORT_ROWS = 50_000;

function parseDate(value: string | null, fallback: Date, endOfDay = false): Date {
  if (!value) return fallback;
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}+03:00`)
    : new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

function optionalUuid(value: string | null): string | null {
  const clean = value?.trim() ?? "";
  return UUID_RE.test(clean) ? clean : null;
}

function csvCell(value: unknown): string {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

export async function GET(request: Request): Promise<Response> {
  if (!supabase) return Response.json({ error: "Supabase غير مهيأة" }, { status: 503 });
  const access = await getCapabilityAccess(request, "reports.view");
  if (!access) return capabilityAuthorizationError(request, "reports.view");

  const url = new URL(request.url);
  const now = new Date();
  const to = parseDate(url.searchParams.get("to"), now, true);
  const from = parseDate(url.searchParams.get("from"), new Date(to.getTime() - 29 * DAY_MS));
  if (from > to) return Response.json({ error: "تاريخ البداية يجب أن يسبق تاريخ النهاية" }, { status: 400 });
  if (to.getTime() - from.getTime() > 731 * DAY_MS) return Response.json({ error: "الفترة القصوى للتقرير سنتان" }, { status: 400 });

  const paymentCandidate = ledgerText(url.searchParams.get("paymentMethod"));
  const paymentMethod = ["CASH", "VISA", "SPLIT", "DEBT", "CLIQ", "UNKNOWN"].includes(paymentCandidate) ? paymentCandidate : null;
  const kindCandidate = ledgerText(url.searchParams.get("kind"));
  const kind = ["SALE", "RETURN"].includes(kindCandidate) ? kindCandidate : "ALL";
  const rpcParams = {
    p_store_id: access.storeId,
    p_from: from.toISOString(),
    p_to: to.toISOString(),
    p_branch_id: optionalUuid(url.searchParams.get("branchId")),
    p_terminal_id: optionalUuid(url.searchParams.get("terminalId")),
    p_cashier_id: optionalUuid(url.searchParams.get("cashierId")),
    p_payment_method: paymentMethod,
    p_kind: kind,
    p_search: ledgerText(url.searchParams.get("search")).slice(0, 80) || null,
  };

  const rows: ReturnType<typeof mapSalesLedgerInvoice>[] = [];
  for (let offset = 0; offset < MAX_EXPORT_ROWS; offset += PAGE_SIZE) {
    const result = await supabase.rpc("list_sales_ledger", {
      ...rpcParams,
      p_limit: PAGE_SIZE,
      p_offset: offset,
    });
    if (result.error) return Response.json({ error: result.error.message }, { status: 500 });
    const batch = Array.isArray(result.data) ? (result.data as Record<string, unknown>[]) : [];
    if (offset === 0 && batch.length > 0 && ledgerNumber(batch[0].total_count) > MAX_EXPORT_ROWS) {
      return Response.json({ error: "نتيجة التصدير تتجاوز 50 ألف فاتورة؛ ضيّق الفترة أو اختر فرعاً" }, { status: 413 });
    }
    rows.push(...batch.map(mapSalesLedgerInvoice));
    if (batch.length < PAGE_SIZE) break;
  }

  const header = [
    "المرجع", "نوع المستند", "التاريخ", "الفرع", "الجهاز", "الكاشير", "العميل", "هاتف العميل", "طريقة الدفع",
    "الصافي قبل الضريبة", "الضريبة", "الخصم", "رسوم التوصيل", "الإجمالي", "نقدي", "بطاقة", "كليك", "ذمم", "عدد القطع", "الربح الإجمالي", "هامش الربح %", "حالة الربح",
  ];
  const lines = [header, ...rows.map((invoice) => [
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
    invoice.profitReliable ? "مؤكد" : "ناقص تكلفة",
  ])].map((row) => row.map(csvCell).join(","));

  const filename = `sales-ledger-${url.searchParams.get("from") || "from"}-${url.searchParams.get("to") || "to"}.csv`;
  return new Response(`\uFEFF${lines.join("\r\n")}`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
