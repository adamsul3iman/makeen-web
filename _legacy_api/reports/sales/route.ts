import { capabilityAuthorizationError, getCapabilityAccess } from "@/lib/requestAuth";
import { ledgerNumber, ledgerText, mapSalesLedgerInvoice } from "@/lib/salesLedger";
import { supabase } from "@/lib/supabase";
import type {
  SalesLedgerOption,
  SalesLedgerResponse,
  SalesLedgerSummary,
  SalesTaxBreakdown,
} from "@/types/salesLedger.types";

export const dynamic = "force-dynamic";

const DAY_MS = 24 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const EMPTY_SUMMARY: SalesLedgerSummary = {
  invoiceCount: 0,
  saleCount: 0,
  returnCount: 0,
  grossSales: 0,
  returns: 0,
  netSales: 0,
  subtotal: 0,
  tax: 0,
  discounts: 0,
  deliveryFee: 0,
  grossProfitCandidate: 0,
  grossProfit: 0,
  profitMargin: 0,
  profitReliable: true,
  cash: 0,
  visa: 0,
  cliq: 0,
  debt: 0,
  itemCount: 0,
  averageTicket: 0,
};

function parseDate(value: string | null, fallback: Date, endOfDay = false): Date {
  if (!value) return fallback;
  const exactDate = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}+03:00`)
    : new Date(value);
  return Number.isNaN(exactDate.getTime()) ? fallback : exactDate;
}

function optionalUuid(value: string | null): string | null {
  const clean = value?.trim() ?? "";
  return UUID_RE.test(clean) ? clean : null;
}

function mapSummary(value: unknown): { summary: SalesLedgerSummary; taxBreakdown: SalesTaxBreakdown[] } {
  const root = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const raw = root.summary && typeof root.summary === "object" ? (root.summary as Record<string, unknown>) : {};
  const grossProfitCandidate = ledgerNumber(raw.grossProfitCandidate, ledgerNumber(raw.grossProfit));
  const profitReliable = raw.profitReliable !== false;
  const summary: SalesLedgerSummary = {
    invoiceCount: ledgerNumber(raw.invoiceCount),
    saleCount: ledgerNumber(raw.saleCount),
    returnCount: ledgerNumber(raw.returnCount),
    grossSales: ledgerNumber(raw.grossSales),
    returns: ledgerNumber(raw.returns),
    netSales: ledgerNumber(raw.netSales),
    subtotal: ledgerNumber(raw.subtotal),
    tax: ledgerNumber(raw.tax),
    discounts: ledgerNumber(raw.discounts),
    deliveryFee: ledgerNumber(raw.deliveryFee),
    grossProfitCandidate,
    grossProfit: profitReliable ? grossProfitCandidate : null,
    profitMargin: profitReliable ? ledgerNumber(raw.profitMargin) : null,
    profitReliable,
    cash: ledgerNumber(raw.cash),
    visa: ledgerNumber(raw.visa),
    cliq: ledgerNumber(raw.cliq),
    debt: ledgerNumber(raw.debt),
    itemCount: ledgerNumber(raw.itemCount),
    averageTicket: ledgerNumber(raw.averageTicket),
  };
  const taxBreakdown = Array.isArray(root.taxBreakdown)
    ? root.taxBreakdown.map((entry) => {
      const row = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
        const grossProfitCandidate = ledgerNumber(row.grossProfitCandidate, ledgerNumber(row.grossProfit));
        const profitReliable = row.profitReliable !== false;
        return {
          taxPercent: ledgerNumber(row.taxPercent),
          taxIncluded: row.taxIncluded === true,
          lineCount: ledgerNumber(row.lineCount),
          quantity: ledgerNumber(row.quantity),
          netSales: ledgerNumber(row.netSales),
          tax: ledgerNumber(row.tax),
          grossSales: ledgerNumber(row.grossSales),
          cost: ledgerNumber(row.cost),
          grossProfitCandidate,
          grossProfit: profitReliable ? grossProfitCandidate : null,
          profitReliable,
        } satisfies SalesTaxBreakdown;
      })
    : [];
  return { summary, taxBreakdown };
}

async function loadFilterOptions(storeId: string): Promise<SalesLedgerResponse["filters"]> {
  if (!supabase) return { branches: [], terminals: [], cashiers: [] };
  const [branchResult, cashierResult] = await Promise.all([
    supabase.from("branches").select("id,name").eq("store_id", storeId).order("name"),
    supabase.from("cashiers").select("id,name").eq("store_id", storeId).order("name"),
  ]);
  if (branchResult.error) throw branchResult.error;
  if (cashierResult.error) throw cashierResult.error;
  const branches: SalesLedgerOption[] = (branchResult.data ?? []).map((row) => ({ id: row.id, name: row.name }));
  const branchIds = branches.map((branch) => branch.id);
  const terminalResult = branchIds.length
    ? await supabase.from("terminals").select("id,name,branch_id").in("branch_id", branchIds).order("name")
    : { data: [], error: null };
  if (terminalResult.error) throw terminalResult.error;
  return {
    branches,
    terminals: (terminalResult.data ?? []).map((row) => ({ id: row.id, name: row.name, branchId: row.branch_id })),
    cashiers: (cashierResult.data ?? []).map((row) => ({ id: row.id, name: row.name })),
  };
}

export async function GET(request: Request): Promise<Response> {
  if (!supabase) {
    return Response.json({
      invoices: [],
      summary: EMPTY_SUMMARY,
      taxBreakdown: [],
      dataQuality: { zeroCostLineCount: 0, zeroCostNetSales: 0, missingBarcodeLineCount: 0, unknownProductLineCount: 0 },
      filters: { branches: [], terminals: [], cashiers: [] },
      pagination: { page: 1, pageSize: 50, total: 0, totalPages: 0 },
      generatedAt: new Date().toISOString(),
    } satisfies SalesLedgerResponse);
  }

  const access = await getCapabilityAccess(request, "reports.view");
  if (!access) return capabilityAuthorizationError(request, "reports.view");

  const url = new URL(request.url);
  const now = new Date();
  const to = parseDate(url.searchParams.get("to"), now, true);
  const from = parseDate(url.searchParams.get("from"), new Date(to.getTime() - 29 * DAY_MS));
  if (from > to) return Response.json({ error: "تاريخ البداية يجب أن يسبق تاريخ النهاية" }, { status: 400 });
  if (to.getTime() - from.getTime() > 731 * DAY_MS) {
    return Response.json({ error: "الفترة القصوى للتقرير سنتان" }, { status: 400 });
  }

  const page = Math.max(1, Math.trunc(ledgerNumber(url.searchParams.get("page"), 1)));
  const pageSize = Math.min(100, Math.max(10, Math.trunc(ledgerNumber(url.searchParams.get("pageSize"), 50))));
  const branchId = optionalUuid(url.searchParams.get("branchId"));
  const terminalId = optionalUuid(url.searchParams.get("terminalId"));
  const cashierId = optionalUuid(url.searchParams.get("cashierId"));
  const paymentCandidate = ledgerText(url.searchParams.get("paymentMethod"));
  const paymentMethod = ["CASH", "VISA", "SPLIT", "DEBT", "CLIQ", "UNKNOWN"].includes(paymentCandidate)
    ? paymentCandidate
    : null;
  const kindCandidate = ledgerText(url.searchParams.get("kind"));
  const kind = ["SALE", "RETURN"].includes(kindCandidate) ? kindCandidate : "ALL";
  const search = ledgerText(url.searchParams.get("search")).slice(0, 80) || null;
  const rpcParams = {
    p_store_id: access.storeId,
    p_from: from.toISOString(),
    p_to: to.toISOString(),
    p_branch_id: branchId,
    p_terminal_id: terminalId,
    p_cashier_id: cashierId,
    p_payment_method: paymentMethod,
    p_kind: kind,
    p_search: search,
  };

  try {
    const [listResult, summaryResult, qualityResult, filters] = await Promise.all([
      supabase.rpc("list_sales_ledger", {
        ...rpcParams,
        p_limit: pageSize,
        p_offset: (page - 1) * pageSize,
      }),
      supabase.rpc("sales_ledger_summary", rpcParams),
      supabase.rpc("sales_ledger_quality", rpcParams),
      loadFilterOptions(access.storeId),
    ]);
    if (listResult.error) throw listResult.error;
    if (summaryResult.error) throw summaryResult.error;
    if (qualityResult.error) throw qualityResult.error;
    const rows = Array.isArray(listResult.data) ? (listResult.data as Record<string, unknown>[]) : [];
    const total = rows.length > 0 ? ledgerNumber(rows[0].total_count) : 0;
    const report = mapSummary(summaryResult.data);
    const quality = qualityResult.data && typeof qualityResult.data === "object"
      ? (qualityResult.data as Record<string, unknown>)
      : {};
    return Response.json({
      invoices: rows.map(mapSalesLedgerInvoice),
      summary: report.summary,
      taxBreakdown: report.taxBreakdown,
      dataQuality: {
        zeroCostLineCount: ledgerNumber(quality.zeroCostLineCount),
        zeroCostNetSales: ledgerNumber(quality.zeroCostNetSales),
        missingBarcodeLineCount: ledgerNumber(quality.missingBarcodeLineCount),
        unknownProductLineCount: ledgerNumber(quality.unknownProductLineCount),
      },
      filters,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: total === 0 ? 0 : Math.ceil(total / pageSize),
      },
      generatedAt: new Date().toISOString(),
    } satisfies SalesLedgerResponse);
  } catch (error) {
    const message = error instanceof Error ? error.message : "sales_ledger_failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
