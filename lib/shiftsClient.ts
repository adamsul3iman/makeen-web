import { getSupabaseBrowser } from "./supabaseBrowser";
import { getTenantStoreId } from "./tenantClient";
import { normalizeArabicText } from "./arabic";
import { usePosStore } from "@/store/usePosStore";
import type {
  OpenShiftAudit,
  OpenShiftResponse,
  ShiftAudit,
  ShiftAuditResponse,
  ShiftAuditSummary,
} from "@/types/shifts.types";

const DAY_MS = 24 * 60 * 60 * 1000;
const PAGE_SIZE = 1000;
const MAX_FETCH_ROWS = 20_000;
const MAX_OPEN_SHIFTS = 500;
const PAGE_SIZE_DEFAULT = 25;
const PAGE_SIZE_MAX = 200;
const STALE_SHIFT_MINUTES = 24 * 60;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const SHIFT_REPORT_COLUMNS =
  "id,close_event_id,shift_id,branch_id,terminal_id,cashier_name,opened_at,closed_at,starting_cash,cash_sales,visa_sales,cliq_sales,debt_sales,debt_collections,discounts,returns,expenses,total_sales,expected_cash,actual_cash,variance,cash_in,cash_out,expected_card,actual_card,card_variance,expected_cliq,actual_cliq,cliq_variance,drawer_open_count,discrepancy_reason,discrepancy_note,approval_status,approved_by_name,approved_at,approval_note,close_source,resolved_by_name,resolution_note";

interface ShiftReportRow {
  id: string;
  close_event_id: string | null;
  shift_id: string;
  branch_id: string | null;
  terminal_id: string | null;
  cashier_name: string | null;
  opened_at: string | null;
  closed_at: string | null;
  starting_cash: number | string | null;
  cash_sales: number | string | null;
  visa_sales: number | string | null;
  cliq_sales: number | string | null;
  debt_sales: number | string | null;
  debt_collections: number | string | null;
  discounts: number | string | null;
  returns: number | string | null;
  expenses: number | string | null;
  total_sales: number | string | null;
  expected_cash: number | string | null;
  actual_cash: number | string | null;
  variance: number | string | null;
  cash_in: number | string | null;
  cash_out: number | string | null;
  expected_card: number | string | null;
  actual_card: number | string | null;
  card_variance: number | string | null;
  expected_cliq: number | string | null;
  actual_cliq: number | string | null;
  cliq_variance: number | string | null;
  drawer_open_count: number | string | null;
  discrepancy_reason: string | null;
  discrepancy_note: string | null;
  approval_status: "NOT_REQUIRED" | "PENDING" | "APPROVED" | null;
  approved_by_name: string | null;
  approved_at: string | null;
  approval_note: string | null;
  close_source: "DEVICE" | "ADMIN_RECOVERY" | null;
  resolved_by_name: string | null;
  resolution_note: string | null;
}

interface SyncEventRow {
  sync_id: string;
  payload: unknown;
  cashier_name: string | null;
  branch_id: string | null;
  terminal_id: string | null;
  client_created_at: string | null;
  created_at: string;
}

export interface FetchShiftsParams {
  /** ISO date/datetime lower bound on closed_at (default: last 30 days). */
  from?: string;
  /** ISO date/datetime upper bound on closed_at (default: now). */
  to?: string;
  terminalId?: string | null;
  branchId?: string | null;
  /** Free-text search over cashier / branch / terminal names (JS-side). */
  q?: string;
  page?: number;
  pageSize?: number;
}

export interface ApproveShiftResult {
  ok: true;
  shiftId: string;
  approvalStatus: "NOT_REQUIRED" | "PENDING" | "APPROVED";
  approvedAt: string | null;
  approvedByName: string;
}

export interface ResolveShiftResult {
  ok: true;
  shiftId: string;
  closeSource: "DEVICE" | "ADMIN_RECOVERY";
  variance: number;
  approvalStatus: "NOT_REQUIRED" | "PENDING" | "APPROVED";
}

function asNumber(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? Math.round((n + Number.EPSILON) * 100) / 100 : fallback;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function objectPayload(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function formatShiftDate(raw: unknown): string {
  if (typeof raw !== "string" || !raw) return "";
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "Asia/Riyadh",
  }).format(date);
}

function optionalUuid(value: string | null | undefined): string | null {
  const clean = value?.trim() ?? "";
  return UUID_RE.test(clean) ? clean : null;
}

async function fetchClosedShiftRows(
  storeId: string,
  fromIso: string,
  toIso: string,
  terminalId: string | null,
  branchId: string | null,
): Promise<ShiftReportRow[]> {
  const sb = getSupabaseBrowser();
  if (!sb) throw new Error("Supabase غير مهيأة");

  const rows: ShiftReportRow[] = [];
  for (let offset = 0; offset < MAX_FETCH_ROWS; offset += PAGE_SIZE) {
    let query = sb
      .from("shift_reports")
      .select(SHIFT_REPORT_COLUMNS)
      .eq("store_id", storeId)
      .gte("closed_at", fromIso)
      .lte("closed_at", toIso)
      .order("closed_at", { ascending: false })
      .range(offset, offset + PAGE_SIZE - 1);
    if (terminalId) query = query.eq("terminal_id", terminalId);
    if (branchId) query = query.eq("branch_id", branchId);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    const page = (data ?? []) as unknown as ShiftReportRow[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

async function fetchBranchTerminalNames(
  storeId: string,
): Promise<{ branchNames: Map<string, string>; terminalNames: Map<string, string> }> {
  const sb = getSupabaseBrowser();
  if (!sb) return { branchNames: new Map(), terminalNames: new Map() };

  const branchNames = new Map<string, string>();
  const terminalNames = new Map<string, string>();

  const { data: branches, error } = await sb
    .from("branches")
    .select("id,name")
    .eq("store_id", storeId);
  if (error) throw new Error(error.message);
  const branchRows = (branches ?? []) as Array<{ id: string; name: string }>;
  for (const b of branchRows) branchNames.set(b.id, b.name);

  const branchIds = branchRows.map((b) => b.id);
  if (branchIds.length === 0) return { branchNames, terminalNames };

  const { data: terminals, error: terminalsError } = await sb
    .from("terminals")
    .select("id,name")
    .in("branch_id", branchIds);
  if (terminalsError) throw new Error(terminalsError.message);
  for (const t of ((terminals ?? []) as Array<{ id: string; name: string }>)) {
    terminalNames.set(t.id, t.name);
  }

  return { branchNames, terminalNames };
}

function mapShiftReport(
  row: ShiftReportRow,
  branchNames: Map<string, string>,
  terminalNames: Map<string, string>,
): ShiftAudit {
  const variance = asNumber(row.variance);
  return {
    id: row.close_event_id || row.shift_id || row.id,
    shiftId: row.shift_id,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    date: formatShiftDate(row.closed_at ?? row.opened_at),
    cashier: asText(row.cashier_name),
    branchId: row.branch_id,
    branch: row.branch_id ? branchNames.get(row.branch_id) ?? "" : "",
    terminalId: row.terminal_id,
    terminal: row.terminal_id ? terminalNames.get(row.terminal_id) ?? "" : "",
    startingCash: asNumber(row.starting_cash),
    cashSales: asNumber(row.cash_sales),
    visaSales: asNumber(row.visa_sales),
    cliqSales: asNumber(row.cliq_sales),
    debtSales: asNumber(row.debt_sales),
    debtCollections: asNumber(row.debt_collections),
    discounts: asNumber(row.discounts),
    returns: asNumber(row.returns),
    expenses: asNumber(row.expenses),
    totalSales: asNumber(row.total_sales),
    expectedCashInDrawer: asNumber(row.expected_cash),
    actualCash: asNumber(row.actual_cash),
    variance,
    expectedCard: asNumber(row.expected_card),
    actualCard: asNumber(row.actual_card),
    cardVariance: asNumber(row.card_variance),
    expectedCliq: asNumber(row.expected_cliq),
    actualCliq: asNumber(row.actual_cliq),
    cliqVariance: asNumber(row.cliq_variance),
    cashIn: asNumber(row.cash_in),
    cashOut: asNumber(row.cash_out),
    drawerOpenCount: asNumber(row.drawer_open_count),
    discrepancyReason: asText(row.discrepancy_reason),
    discrepancyNote: asText(row.discrepancy_note),
    approvalStatus: row.approval_status ?? (variance === 0 ? "NOT_REQUIRED" : "PENDING"),
    approvedByName: asText(row.approved_by_name),
    approvedAt: row.approved_at,
    approvalNote: asText(row.approval_note),
    closeSource: row.close_source ?? "DEVICE",
    resolvedByName: asText(row.resolved_by_name),
    resolutionNote: asText(row.resolution_note),
    status: "CLOSED",
  };
}

/** Aggregates over the whole filtered range (not just the current page). */
function buildSummary(rows: ShiftAudit[]): ShiftAuditSummary {
  const sum = (
    field: keyof Pick<
      ShiftAudit,
      | "totalSales" | "cashSales" | "visaSales" | "cliqSales" | "debtSales"
      | "debtCollections" | "discounts" | "returns" | "expenses"
      | "expectedCashInDrawer" | "actualCash" | "variance" | "expectedCard"
      | "actualCard" | "cardVariance" | "expectedCliq" | "actualCliq"
      | "cliqVariance" | "cashIn" | "cashOut"
    >,
  ): number => Math.round(rows.reduce((acc, row) => acc + row[field], 0) * 100) / 100;

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
 * Immutable Z-report audit straight from the store-ledger `shift_reports`
 * table. Rows are enriched with branch/terminal names, filtered in the
 * browser by free text and paged client-side; the summary covers the whole
 * filtered range rather than only the returned page.
 */
export async function fetchShifts(params: FetchShiftsParams = {}): Promise<ShiftAuditResponse> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  const now = new Date();
  const defaultFrom = new Date(now.getTime() - 30 * DAY_MS);
  const fromMs = params.from ? new Date(params.from).getTime() : defaultFrom.getTime();
  const toMs = params.to ? new Date(params.to).getTime() : now.getTime();
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs > toMs) {
    throw new Error("نطاق التواريخ غير صالح");
  }

  const terminalId = optionalUuid(params.terminalId);
  const branchId = optionalUuid(params.branchId);

  const [rows, names] = await Promise.all([
    fetchClosedShiftRows(storeId, new Date(fromMs).toISOString(), new Date(toMs).toISOString(), terminalId, branchId),
    fetchBranchTerminalNames(storeId),
  ]);

  const rawShifts = rows.map((row) => mapShiftReport(row, names.branchNames, names.terminalNames));

  const normalizedQuery = normalizeArabicText(params.q?.trim() ?? "");
  const filtered = normalizedQuery
    ? rawShifts.filter(
        (shift) =>
          normalizeArabicText(shift.cashier).includes(normalizedQuery) ||
          normalizeArabicText(shift.branch).includes(normalizedQuery) ||
          normalizeArabicText(shift.terminal).includes(normalizedQuery),
      )
    : rawShifts;

  const pageSize = Math.min(PAGE_SIZE_MAX, Math.max(1, params.pageSize ?? PAGE_SIZE_DEFAULT));
  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, params.page ?? 1), totalPages);
  const start = (page - 1) * pageSize;

  return {
    shifts: filtered.slice(start, start + pageSize),
    total,
    page,
    pageSize,
    summary: buildSummary(filtered),
  };
}

async function fetchLedgerRows(
  table: string,
  select: string,
  storeId: string,
  shiftIds: string[],
): Promise<Record<string, unknown>[]> {
  const sb = getSupabaseBrowser();
  if (!sb || shiftIds.length === 0) return [];

  const rows: Record<string, unknown>[] = [];
  for (let offset = 0; offset < MAX_FETCH_ROWS; offset += PAGE_SIZE) {
    const { data, error } = await sb
      .from(table)
      .select(select)
      .eq("store_id", storeId)
      .in("shift_id", shiftIds)
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    const page = (data ?? []) as unknown as Record<string, unknown>[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

/**
 * Live X reports: every SHIFT_OPENED event that has no matching Z close yet,
 * deduped per physical terminal (newest wins) and aggregated from the
 * sales/expenses/customer-transactions ledgers.
 */
export async function fetchOpenShifts(): Promise<OpenShiftResponse> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  const { data: openedRows, error } = await sb
    .from("sync_events")
    .select("sync_id,payload,cashier_name,branch_id,terminal_id,client_created_at,created_at")
    .eq("store_id", storeId)
    .eq("action_type", "SHIFT_OPENED")
    .order("client_created_at", { ascending: false })
    .limit(MAX_OPEN_SHIFTS);
  if (error) throw new Error(error.message);

  const candidates = ((openedRows ?? []) as unknown as SyncEventRow[])
    .map((row) => {
      const payload = objectPayload(row.payload);
      const shiftId = asText(payload.shiftId);
      if (!UUID_RE.test(shiftId)) return null;
      return { row, payload, shiftId };
    })
    .filter((value): value is NonNullable<typeof value> => Boolean(value));

  const candidateIds = [...new Set(candidates.map((entry) => entry.shiftId))];
  if (candidateIds.length === 0) {
    return { shifts: [], generatedAt: new Date().toISOString() };
  }

  const { data: closedRows, error: closedError } = await sb
    .from("shift_reports")
    .select("shift_id")
    .eq("store_id", storeId)
    .in("shift_id", candidateIds);
  if (closedError) throw new Error(closedError.message);
  const closedIds = new Set(((closedRows ?? []) as Array<{ shift_id: string }>).map((r) => r.shift_id));
  const unresolved = candidates.filter((entry) => !closedIds.has(entry.shiftId));

  // A physical terminal cannot run concurrent shifts: keep only the newest
  // open event per terminal so stale leftovers never inflate the X report.
  const activeByTerminal = new Map<string, (typeof unresolved)[number]>();
  for (const entry of unresolved) {
    const terminalId = asText(entry.payload.terminalId) || asText(entry.row.terminal_id);
    const key = terminalId ? `terminal:${terminalId}` : `shift:${entry.shiftId}`;
    if (!activeByTerminal.has(key)) activeByTerminal.set(key, entry);
  }
  const active = Array.from(activeByTerminal.values());
  const activeIds = active.map((entry) => entry.shiftId);

  const [invoiceRows, expenseRows, settlementRows, names] = await Promise.all([
    fetchLedgerRows("sales_invoices", "shift_id,cash_amount,visa_amount,cliq_amount,debt_amount,total", storeId, activeIds),
    fetchLedgerRows("expenses", "shift_id,amount", storeId, activeIds),
    fetchLedgerRows("customer_transactions", "shift_id,amount,type", storeId, activeIds),
    fetchBranchTerminalNames(storeId),
  ]);

  const invoicesByShift = new Map<string, Record<string, unknown>[]>();
  for (const row of invoiceRows) {
    const id = asText(row.shift_id);
    invoicesByShift.set(id, [...(invoicesByShift.get(id) ?? []), row]);
  }
  const expensesByShift = new Map<string, Record<string, unknown>[]>();
  for (const row of expenseRows) {
    const id = asText(row.shift_id);
    expensesByShift.set(id, [...(expensesByShift.get(id) ?? []), row]);
  }
  const settlementsByShift = new Map<string, Record<string, unknown>[]>();
  for (const row of settlementRows) {
    if (row.type !== "SETTLEMENT") continue;
    const id = asText(row.shift_id);
    settlementsByShift.set(id, [...(settlementsByShift.get(id) ?? []), row]);
  }

  const generatedAt = new Date();
  const shifts: OpenShiftAudit[] = active.map(({ row, payload, shiftId }) => {
    const invoices = invoicesByShift.get(shiftId) ?? [];
    const expenses = expensesByShift.get(shiftId) ?? [];
    const settlements = settlementsByShift.get(shiftId) ?? [];
    const startingCash = asNumber(payload.startingCash);
    const cashSales = asNumber(invoices.reduce((sum, invoice) => sum + asNumber(invoice.cash_amount), 0));
    const debtCollections = asNumber(settlements.reduce((sum, settlement) => sum + asNumber(settlement.amount), 0));
    const expenseTotal = asNumber(expenses.reduce((sum, expense) => sum + asNumber(expense.amount), 0));
    const openedAt =
      asText(payload.startTime) || asText(payload.openedAt) || asText(row.client_created_at) || row.created_at;
    const openedTime = new Date(openedAt).getTime();
    const branchId = asText(payload.branchId) || asText(row.branch_id) || null;
    const terminalId = asText(payload.terminalId) || asText(row.terminal_id) || null;
    const ageMinutes = Number.isFinite(openedTime)
      ? Math.max(0, Math.floor((generatedAt.getTime() - openedTime) / 60_000))
      : 0;
    return {
      shiftId,
      openedAt,
      cashier: asText(payload.cashierName) || asText(row.cashier_name),
      branchId,
      branch: branchId ? names.branchNames.get(branchId) ?? "" : "",
      terminalId,
      terminal: terminalId ? names.terminalNames.get(terminalId) ?? "" : "",
      startingCash,
      cashSales,
      visaSales: asNumber(invoices.reduce((sum, invoice) => sum + asNumber(invoice.visa_amount), 0)),
      cliqSales: asNumber(invoices.reduce((sum, invoice) => sum + asNumber(invoice.cliq_amount), 0)),
      debtSales: asNumber(invoices.reduce((sum, invoice) => sum + asNumber(invoice.debt_amount), 0)),
      debtCollections,
      expenses: expenseTotal,
      totalSales: asNumber(invoices.reduce((sum, invoice) => sum + asNumber(invoice.total), 0)),
      expectedCashInDrawer: asNumber(startingCash + cashSales + debtCollections - expenseTotal),
      invoiceCount: invoices.length,
      ageMinutes,
      status: ageMinutes >= STALE_SHIFT_MINUTES ? "STALE" : "OPEN",
    };
  });

  return { shifts, generatedAt: generatedAt.toISOString() };
}

/**
 * Owner-only acknowledgement of an immutable Z-report cash variance. The
 * owner password is verified through the admin-auth RPC before the privileged
 * `approve_shift_variance` runs, mirroring the server-side approval flow.
 */
export async function approveShift(
  shiftId: string,
  password: string,
  note: string,
): Promise<ApproveShiftResult> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");
  if (!UUID_RE.test(shiftId.trim())) throw new Error("معرّف الوردية غير صالح");

  const trimmedNote = note.trim();
  if (!password) throw new Error("كلمة مرور المدير مطلوبة");
  if (trimmedNote.length < 3 || trimmedNote.length > 500) {
    throw new Error("ملاحظة الموافقة مطلوبة (3 أحرف على الأقل و500 كحد أقصى)");
  }

  const session = usePosStore.getState().adminSession;
  if (!session?.email) throw new Error("جلسة المدير مطلوبة");

  const { data: auth, error: authError } = await sb.rpc("authenticate_admin_client", {
    p_email: session.email,
    p_password: password,
  });
  if (authError) throw new Error(authError.message);
  if (!auth || typeof auth !== "object") throw new Error("كلمة مرور المدير غير صحيحة");

  const authPayload = auth as { store?: { id?: string }; cashier?: { id?: string; name?: string } };
  if (authPayload.store?.id !== storeId) throw new Error("جلسة المدير لا تطابق المتجر الحالي");

  const { data: report, error: approvalError } = await sb.rpc("approve_shift_variance", {
    p_store_id: storeId,
    p_shift_id: shiftId.trim(),
    p_approved_by: authPayload.cashier?.id ?? null,
    p_approved_by_name: authPayload.cashier?.name || session.name,
    p_note: trimmedNote,
  });
  if (approvalError) {
    const message = approvalError.message;
    if (message.includes("shift_report_not_found")) throw new Error("تقرير الوردية غير موجود");
    if (message.includes("variance_approval_not_required")) throw new Error("لا توجد فروقات تحتاج موافقة");
    if (message.includes("approval_note_required")) throw new Error("ملاحظة الموافقة مطلوبة");
    throw new Error(message);
  }

  const approved = (Array.isArray(report) ? report[0] : report) as
    | { approval_status?: ApproveShiftResult["approvalStatus"]; approved_at?: string | null; approved_by_name?: string | null }
    | undefined;
  return {
    ok: true,
    shiftId,
    approvalStatus: approved?.approval_status ?? "APPROVED",
    approvedAt: approved?.approved_at ?? null,
    approvedByName: approved?.approved_by_name || authPayload.cashier?.name || session.name,
  };
}

/**
 * Owner-only atomic recovery of a stale SHIFT_OPENED event (no Z close after
 * 24h). Verifies the owner password via the admin-auth RPC, then creates a
 * synthetic ADMIN_RECOVERY close through `resolve_stale_shift`.
 */
export async function resolveShift(
  shiftId: string,
  actualCash: number,
  password: string,
  note: string,
): Promise<ResolveShiftResult> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");
  if (!UUID_RE.test(shiftId.trim())) throw new Error("معرّف الوردية غير صالح");
  if (!Number.isFinite(actualCash) || actualCash < 0 || actualCash > 99_999_999_999) {
    throw new Error("المبلغ الفعلي غير صالح");
  }
  if (!password) throw new Error("كلمة مرور المدير مطلوبة");
  const trimmedNote = note.trim();
  if (trimmedNote.length < 3 || trimmedNote.length > 500) {
    throw new Error("ملاحظة المعالجة مطلوبة (3 أحرف على الأقل و500 كحد أقصى)");
  }

  const session = usePosStore.getState().adminSession;
  if (!session?.email) throw new Error("جلسة المدير مطلوبة");

  const { data: auth, error: authError } = await sb.rpc("authenticate_admin_client", {
    p_email: session.email,
    p_password: password,
  });
  if (authError) throw new Error(authError.message);
  if (!auth || typeof auth !== "object") throw new Error("كلمة مرور المدير غير صحيحة");

  const authPayload = auth as { store?: { id?: string }; cashier?: { id?: string; name?: string } };
  if (authPayload.store?.id !== storeId) throw new Error("جلسة المدير لا تطابق المتجر الحالي");

  const { data: report, error: resolveError } = await sb.rpc("resolve_stale_shift", {
    p_store_id: storeId,
    p_shift_id: shiftId.trim(),
    p_actual_cash: actualCash,
    p_resolved_by: authPayload.cashier?.id ?? null,
    p_resolved_by_name: authPayload.cashier?.name || session.name,
    p_note: trimmedNote,
  });
  if (resolveError) {
    const message = resolveError.message;
    if (resolveError.code === "P0002" || message.includes("shift_open_event_not_found")) {
      throw new Error("حدث فتح الوردية غير موجود");
    }
    if (resolveError.code === "55000" || message.includes("shift_is_not_stale")) {
      throw new Error("الوردية ليست معلّقة — يمكن إغلاقها من الكاشير بشكل طبيعي");
    }
    if (message.includes("resolution_note_required")) throw new Error("ملاحظة المعالجة مطلوبة");
    throw new Error(message);
  }

  const resolved = (Array.isArray(report) ? report[0] : report) as
    | {
        close_source?: ResolveShiftResult["closeSource"];
        variance?: number | string | null;
        approval_status?: ResolveShiftResult["approvalStatus"];
      }
    | undefined;
  return {
    ok: true,
    shiftId,
    closeSource: resolved?.close_source ?? "ADMIN_RECOVERY",
    variance: asNumber(resolved?.variance),
    approvalStatus: resolved?.approval_status ?? "NOT_REQUIRED",
  };
}
