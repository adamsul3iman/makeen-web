import { supabase } from "@/lib/supabase";
import { normalizeArabicText } from "@/lib/arabic";
import { authorizedCapabilityStoreId } from "@/lib/requestAuth";
import {
  emptyShiftAuditResponse,
  type ShiftAudit,
  type ShiftAuditResponse,
  type ShiftAuditSummary,
} from "@/types/shifts.types";

export const dynamic = "force-dynamic";

const DAY_MS = 24 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Safety cap on how many canonical Z reports are pulled into memory. */
const MAX_FETCH_ROWS = 20_000;
const PAGE_SIZE_DEFAULT = 25;
const PAGE_SIZE_MAX = 200;

interface ClosedShiftRow {
  sync_id: string;
  payload: {
    shiftId?: string;
    startTime?: string;
    closeTime?: string;
    startingCash?: number;
    cashSales?: number;
    visaSales?: number;
    cliqSales?: number;
    debtSales?: number;
    debtCollections?: number;
    discounts?: number;
    returns?: number;
    expenses?: number;
    totalSales?: number;
    expectedCashInDrawer?: number;
    actualCash?: number;
    variance?: number;
    cashInTotal?: number;
    cashOutTotal?: number;
    expectedCard?: number;
    actualCard?: number;
    cardVariance?: number;
    expectedCliq?: number;
    actualCliq?: number;
    cliqVariance?: number;
    drawerOpenCount?: number;
    discrepancyReason?: string;
    discrepancyNote?: string;
    branchId?: string;
    terminalId?: string;
  };
  cashier_name?: string | null;
  branch_id?: string | null;
  terminal_id?: string | null;
  client_created_at?: string | null;
  approval_status?: "NOT_REQUIRED" | "PENDING" | "APPROVED";
  approved_by_name?: string | null;
  approved_at?: string | null;
  approval_note?: string | null;
  close_source?: "DEVICE" | "ADMIN_RECOVERY";
  resolved_by_name?: string | null;
  resolution_note?: string | null;
  cash_in?: number | null;
  cash_out?: number | null;
  expected_card?: number | null;
  actual_card?: number | null;
  card_variance?: number | null;
  expected_cliq?: number | null;
  actual_cliq?: number | null;
  cliq_variance?: number | null;
  drawer_open_count?: number | null;
  discrepancy_reason?: string | null;
  discrepancy_note?: string | null;
}

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

function num(value: unknown): number {
  const n = typeof value === "string" ? Number(value.trim()) : Number(value);
  return Number.isFinite(n) ? Math.round((n + Number.EPSILON) * 100) / 100 : 0;
}

function formatShiftDate(raw: unknown): string {
  if (typeof raw !== "string" || !raw) return "";
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "Asia/Riyadh",
  }).format(date);
  return parts;
}

/** Pull every SHIFT_CLOSED row in range with range paging (bypasses the
 * default 1000-row cap) and a defensive overall bound. */
async function fetchClosedShifts(
  storeId: string,
  fromIso: string,
  toIso: string,
  terminalId: string | null,
  branchId: string | null,
): Promise<ClosedShiftRow[]> {
  if (!supabase) return [];
  const client = supabase;

  const base = () =>
    client
      .from("shift_reports")
      .select("id,close_event_id,shift_id,branch_id,terminal_id,cashier_name,opened_at,closed_at,starting_cash,cash_sales,visa_sales,cliq_sales,debt_sales,debt_collections,discounts,returns,expenses,total_sales,expected_cash,actual_cash,variance,cash_in,cash_out,expected_card,actual_card,card_variance,expected_cliq,actual_cliq,cliq_variance,drawer_open_count,discrepancy_reason,discrepancy_note,approval_status,approved_by_name,approved_at,approval_note,close_source,resolved_by_name,resolution_note")
      .eq("store_id", storeId)
      .gte("closed_at", fromIso)
      .lte("closed_at", toIso)
      .order("closed_at", { ascending: false });

  const rows: ClosedShiftRow[] = [];
  const step = 1000;
  for (let offset = 0; offset < MAX_FETCH_ROWS; offset += step) {
    let query = base().range(offset, offset + step - 1);
    if (terminalId) query = query.eq("terminal_id", terminalId);
    if (branchId) query = query.eq("branch_id", branchId);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    const page = (data ?? []).map((report) => ({
      sync_id: report.close_event_id,
      payload: {
        shiftId: report.shift_id,
        startTime: report.opened_at,
        closeTime: report.closed_at,
        startingCash: report.starting_cash,
        cashSales: report.cash_sales,
        visaSales: report.visa_sales,
        cliqSales: report.cliq_sales,
        debtSales: report.debt_sales,
        debtCollections: report.debt_collections,
        discounts: report.discounts,
        returns: report.returns,
        expenses: report.expenses,
        totalSales: report.total_sales,
        expectedCashInDrawer: report.expected_cash,
        actualCash: report.actual_cash,
        variance: report.variance,
        cashInTotal: report.cash_in ?? 0,
        cashOutTotal: report.cash_out ?? 0,
        expectedCard: report.expected_card ?? 0,
        actualCard: report.actual_card ?? 0,
        cardVariance: report.card_variance ?? 0,
        expectedCliq: report.expected_cliq ?? 0,
        actualCliq: report.actual_cliq ?? 0,
        cliqVariance: report.cliq_variance ?? 0,
        drawerOpenCount: report.drawer_open_count ?? 0,
        discrepancyReason: report.discrepancy_reason ?? "",
        discrepancyNote: report.discrepancy_note ?? "",
        branchId: report.branch_id,
        terminalId: report.terminal_id,
      },
      cashier_name: report.cashier_name,
      branch_id: report.branch_id,
      terminal_id: report.terminal_id,
      client_created_at: report.closed_at,
      approval_status: report.approval_status,
      approved_by_name: report.approved_by_name,
      approved_at: report.approved_at,
      approval_note: report.approval_note,
      close_source: report.close_source,
      resolved_by_name: report.resolved_by_name,
      resolution_note: report.resolution_note,
      cash_in: report.cash_in,
      cash_out: report.cash_out,
      expected_card: report.expected_card,
      actual_card: report.actual_card,
      card_variance: report.card_variance,
      discrepancy_reason: report.discrepancy_reason,
      discrepancy_note: report.discrepancy_note,
    })) as ClosedShiftRow[];
    rows.push(...page);
    if (page.length < step) break;
  }
  return rows;
}

/** For shifts without a cashier_name stamp, fall back to the cashier recorded
 * on the shift's own sales invoices. */
async function enrichCashiers(
  storeId: string,
  rows: ClosedShiftRow[],
  cashierById: Map<string, string>,
): Promise<void> {
  const unnamed = rows.filter((row) => !cashierById.get(row.sync_id));
  if (unnamed.length === 0 || !supabase) return;

  const shiftIds = unnamed
    .map((row) => row.payload?.shiftId || row.sync_id)
    .filter(Boolean);
  if (shiftIds.length === 0) return;

  for (let i = 0; i < shiftIds.length; i += 500) {
    const chunk = shiftIds.slice(i, i + 500);
    const { data, error } = await supabase
      .from("sales_invoices")
      .select("shift_id,cashier_name")
      .in("shift_id", chunk)
      .eq("store_id", storeId);
    if (error) continue;
    const byShift = new Map<string, string>();
    for (const invoice of data ?? []) {
      const name = typeof invoice.cashier_name === "string" ? invoice.cashier_name.trim() : "";
      if (name && !byShift.has(invoice.shift_id)) byShift.set(invoice.shift_id, name);
    }
    for (const row of unnamed) {
      const shiftId = row.payload?.shiftId || row.sync_id;
      if (!cashierById.has(row.sync_id)) {
        const name = byShift.get(shiftId);
        if (name) cashierById.set(row.sync_id, name);
      }
    }
  }
}

function buildSummary(rows: ShiftAudit[]): ShiftAuditSummary {
  const sum = (field: "totalSales" | "cashSales" | "visaSales" | "cliqSales" | "debtSales" | "debtCollections" | "discounts" | "returns" | "expenses" | "expectedCashInDrawer" | "actualCash" | "variance" | "expectedCard" | "actualCard" | "cardVariance" | "expectedCliq" | "actualCliq" | "cliqVariance" | "cashIn" | "cashOut"): number =>
    Math.round(rows.reduce((acc, row) => acc + row[field], 0) * 100) / 100;

  const byCashier = new Map<string, { count: number; totalSales: number }>();
  for (const row of rows) {
    const key = row.cashier || "—";
    const entry = byCashier.get(key) ?? { count: 0, totalSales: 0 };
    entry.count += 1;
    entry.totalSales += row.totalSales;
    byCashier.set(key, entry);
  }
  const topCashiers = Array.from(byCashier.entries())
    .map(([name, stats]) => ({
      name,
      count: stats.count,
      totalSales: Math.round(stats.totalSales * 100) / 100,
    }))
    .sort((a, b) => b.totalSales - a.totalSales)
    .slice(0, 5);

  return {
    shiftCount: rows.length,
    totalSales: sum("totalSales"),
    cash: sum("cashSales"),
    visa: sum("visaSales"),
    cliq: sum("cliqSales"),
    debt: sum("debtSales"),
    debtCollections: sum("debtCollections"),
    discounts: sum("discounts"),
    returns: sum("returns"),
    expenses: sum("expenses"),
    expectedCashInDrawer: sum("expectedCashInDrawer"),
    actualCash: sum("actualCash"),
    variance: sum("variance"),
    expectedCard: sum("expectedCard"),
    actualCard: sum("actualCard"),
    cardVariance: sum("cardVariance"),
    expectedCliq: sum("expectedCliq"),
    actualCliq: sum("actualCliq"),
    cliqVariance: sum("cliqVariance"),
    cashIn: sum("cashIn"),
    cashOut: sum("cashOut"),
    drawerOpenCount: rows.reduce((acc, row) => acc + row.drawerOpenCount, 0),
    cashierCount: byCashier.size,
    topCashiers,
  };
}

/**
 * Shift Audit API. Reads immutable Z reports from the shift_reports ledger and
 * returns paged sessions with date-range/cashier/branch/terminal filters plus
 * an aggregate summary over the whole filtered range. Falls back to an empty
 * response offline (there is no server ledger without Supabase).
 */
export async function GET(request: Request): Promise<Response> {
  const pageSizeDefault = PAGE_SIZE_DEFAULT;
  if (!supabase) {
    return Response.json(emptyShiftAuditResponse());
  }

  const storeId = await authorizedCapabilityStoreId(request, "shifts.view");
  if (storeId instanceof Response) return storeId;

  const url = new URL(request.url);
  const terminalId = optionalUuid(url.searchParams.get("terminalId"));
  const branchId = optionalUuid(url.searchParams.get("branchId"));
  const query = url.searchParams.get("q")?.trim() ?? "";
  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
  const pageSize = Math.min(
    PAGE_SIZE_MAX,
    Math.max(1, Number(url.searchParams.get("pageSize")) || pageSizeDefault),
  );

  const now = new Date();
  const from = parseDate(url.searchParams.get("from"), new Date(now.getTime() - 30 * DAY_MS));
  const to = parseDate(url.searchParams.get("to"), now, true);
  if (from.getTime() > to.getTime()) {
    return Response.json({ error: "نطاق التواريخ غير صالح" }, { status: 400 });
  }

  let rows: ClosedShiftRow[];
  try {
    rows = await fetchClosedShifts(storeId, from.toISOString(), to.toISOString(), terminalId, branchId);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "خطأ في قراءة الورديات" }, { status: 500 });
  }

  const { data: branches } = await supabase.from("branches").select("id,name").eq("store_id", storeId);
  const branchIds = (branches ?? []).map((branch) => branch.id as string);
  const terminalsResult = branchIds.length > 0
    ? await supabase.from("terminals").select("id,branch_id,name").in("branch_id", branchIds)
    : { data: [], error: null };
  if (terminalsResult.error) {
    return Response.json({ error: terminalsResult.error.message }, { status: 500 });
  }
  const terminals = terminalsResult.data;
  const branchName = new Map((branches ?? []).map((b) => [b.id as string, b.name as string]));
  const terminalName = new Map((terminals ?? []).map((t) => [t.id as string, t.name as string]));

  const cashierById = new Map<string, string>();
  for (const row of rows) {
    const name = typeof row.cashier_name === "string" ? row.cashier_name.trim() : "";
    if (name) cashierById.set(row.sync_id, name);
  }
  await enrichCashiers(storeId, rows, cashierById);

  const normalizedQuery = normalizeArabicText(query);
  const rawShifts: ShiftAudit[] = rows.map((row) => {
    const p = row.payload ?? {};
    const openedAt = typeof p.startTime === "string" && p.startTime ? p.startTime : (row.client_created_at ?? null);
    const closedAt = typeof p.closeTime === "string" && p.closeTime ? p.closeTime : (row.client_created_at ?? null);
    const effectiveTerminalId = (typeof p.terminalId === "string" && p.terminalId) || row.terminal_id || "";
    return {
      id: row.sync_id,
      shiftId: p.shiftId ?? row.sync_id,
      openedAt,
      closedAt,
      date: formatShiftDate(closedAt ?? openedAt),
      cashier: cashierById.get(row.sync_id) ?? "",
      branchId: (typeof p.branchId === "string" && p.branchId) || row.branch_id || null,
      branch: branchName.get((typeof p.branchId === "string" && p.branchId) || row.branch_id || "") ?? "",
      terminalId: effectiveTerminalId || null,
      terminal: terminalName.get(effectiveTerminalId) ?? "",
      startingCash: num(p.startingCash),
      cashSales: num(p.cashSales),
      visaSales: num(p.visaSales),
      cliqSales: num(p.cliqSales),
      debtSales: num(p.debtSales),
      debtCollections: num(p.debtCollections),
      discounts: num(p.discounts),
      returns: num(p.returns),
      expenses: num(p.expenses),
      totalSales: num(p.totalSales),
      expectedCashInDrawer: num(p.expectedCashInDrawer),
      actualCash: num(p.actualCash),
      variance: num(p.variance),
      expectedCard: num(p.expectedCard),
      actualCard: num(p.actualCard),
      cardVariance: num(p.cardVariance),
      expectedCliq: num(p.expectedCliq),
      actualCliq: num(p.actualCliq),
      cliqVariance: num(p.cliqVariance),
      cashIn: num(p.cashInTotal),
      cashOut: num(p.cashOutTotal),
      drawerOpenCount: typeof p.drawerOpenCount === "number" ? p.drawerOpenCount : 0,
      discrepancyReason: typeof p.discrepancyReason === "string" ? p.discrepancyReason : "",
      discrepancyNote: typeof p.discrepancyNote === "string" ? p.discrepancyNote : "",
      approvalStatus: row.approval_status ?? (num(p.variance) === 0 ? "NOT_REQUIRED" : "PENDING"),
      approvedByName: row.approved_by_name ?? "",
      approvedAt: row.approved_at ?? null,
      approvalNote: row.approval_note ?? "",
      closeSource: row.close_source ?? "DEVICE",
      resolvedByName: row.resolved_by_name ?? "",
      resolutionNote: row.resolution_note ?? "",
      status: "CLOSED",
    };
  });

  const filtered = normalizedQuery
    ? rawShifts.filter((shift) => normalizeArabicText(shift.cashier).includes(normalizedQuery))
    : rawShifts;

  const summary = buildSummary(filtered);
  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * pageSize;
  const shifts = filtered.slice(start, start + pageSize);

  const response: ShiftAuditResponse = {
    shifts,
    total,
    page: safePage,
    pageSize,
    summary,
  };
  return Response.json(response);
}
