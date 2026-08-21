import { authorizedCapabilityStoreId } from "@/lib/requestAuth";
import { supabase } from "@/lib/supabase";
import type { OpenShiftAudit, OpenShiftResponse } from "@/types/shifts.types";

export const dynamic = "force-dynamic";

const MAX_OPEN_SHIFTS = 500;
const PAGE_SIZE = 1000;
const MAX_LEDGER_ROWS = 20_000;
const STALE_SHIFT_MINUTES = 24 * 60;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function money(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.round((numeric + Number.EPSILON) * 100) / 100 : 0;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

async function fetchShiftRows(
  table: string,
  select: string,
  storeId: string,
  shiftIds: string[],
): Promise<Record<string, unknown>[]> {
  if (!supabase || shiftIds.length === 0) return [];
  const rows: Record<string, unknown>[] = [];
  for (let offset = 0; offset < MAX_LEDGER_ROWS; offset += PAGE_SIZE) {
    const { data, error } = await supabase
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

/** Live, non-closing X reports. Expected drawer is restricted to supervisors. */
export async function GET(request: Request): Promise<Response> {
  const storeId = await authorizedCapabilityStoreId(request, "shifts.x_report");
  if (storeId instanceof Response) return storeId;

  if (!supabase) {
    const response: OpenShiftResponse = { shifts: [], generatedAt: new Date().toISOString() };
    return Response.json(response);
  }

  const { data: openedRows, error: openedError } = await supabase
    .from("sync_events")
    .select("sync_id,payload,cashier_name,branch_id,terminal_id,client_created_at,created_at")
    .eq("store_id", storeId)
    .eq("action_type", "SHIFT_OPENED")
    .order("client_created_at", { ascending: false })
    .limit(MAX_OPEN_SHIFTS);
  if (openedError) return Response.json({ error: openedError.message }, { status: 500 });

  const candidates = (openedRows ?? [])
    .map((row) => {
      const payload = row.payload && typeof row.payload === "object"
        ? row.payload as Record<string, unknown>
        : {};
      const shiftId = text(payload.shiftId);
      if (!UUID_RE.test(shiftId)) return null;
      return { row, payload, shiftId };
    })
    .filter((value): value is NonNullable<typeof value> => Boolean(value));

  const candidateIds = [...new Set(candidates.map((entry) => entry.shiftId))];
  if (candidateIds.length === 0) {
    return Response.json({ shifts: [], generatedAt: new Date().toISOString() } satisfies OpenShiftResponse);
  }

  const { data: closedRows, error: closedError } = await supabase
    .from("shift_reports")
    .select("shift_id")
    .eq("store_id", storeId)
    .in("shift_id", candidateIds);
  if (closedError) return Response.json({ error: closedError.message }, { status: 500 });
  const closedIds = new Set((closedRows ?? []).map((row) => row.shift_id as string));
  const unresolved = candidates.filter((entry) => !closedIds.has(entry.shiftId));
  // A physical terminal cannot run concurrent shifts. Legacy clients could
  // leave unmatched SHIFT_OPENED events behind, so keep only the newest event
  // per terminal and classify an old survivor as stale instead of inflating X.
  const activeByTerminal = new Map<string, (typeof unresolved)[number]>();
  for (const entry of unresolved) {
    const terminalId = text(entry.payload.terminalId) || text(entry.row.terminal_id);
    const key = terminalId ? `terminal:${terminalId}` : `shift:${entry.shiftId}`;
    if (!activeByTerminal.has(key)) activeByTerminal.set(key, entry);
  }
  const active = Array.from(activeByTerminal.values());
  const activeIds = active.map((entry) => entry.shiftId);

  try {
    const [invoiceRows, expenseRows, settlementRows, branchesResult] = await Promise.all([
      fetchShiftRows("sales_invoices", "shift_id,cash_amount,visa_amount,cliq_amount,debt_amount,total", storeId, activeIds),
      fetchShiftRows("expenses", "shift_id,amount", storeId, activeIds),
      fetchShiftRows("customer_transactions", "shift_id,amount,type", storeId, activeIds),
      supabase.from("branches").select("id,name").eq("store_id", storeId),
    ]);
    if (branchesResult.error) throw new Error(branchesResult.error.message);

    const branchRows = branchesResult.data ?? [];
    const branchIds = branchRows.map((branch) => branch.id as string);
    const terminalResult = branchIds.length > 0
      ? await supabase.from("terminals").select("id,name,branch_id").in("branch_id", branchIds)
      : { data: [], error: null };
    if (terminalResult.error) throw new Error(terminalResult.error.message);

    const branchNames = new Map(branchRows.map((branch) => [branch.id as string, branch.name as string]));
    const terminalNames = new Map((terminalResult.data ?? []).map((terminal) => [terminal.id as string, terminal.name as string]));
    const invoicesByShift = new Map<string, Record<string, unknown>[]>();
    const expensesByShift = new Map<string, Record<string, unknown>[]>();
    const settlementsByShift = new Map<string, Record<string, unknown>[]>();
    for (const row of invoiceRows) {
      const id = text(row.shift_id);
      invoicesByShift.set(id, [...(invoicesByShift.get(id) ?? []), row]);
    }
    for (const row of expenseRows) {
      const id = text(row.shift_id);
      expensesByShift.set(id, [...(expensesByShift.get(id) ?? []), row]);
    }
    for (const row of settlementRows) {
      if (row.type !== "SETTLEMENT") continue;
      const id = text(row.shift_id);
      settlementsByShift.set(id, [...(settlementsByShift.get(id) ?? []), row]);
    }

    const generatedAt = new Date();
    const shifts: OpenShiftAudit[] = active.map(({ row, payload, shiftId }) => {
      const invoices = invoicesByShift.get(shiftId) ?? [];
      const expenses = expensesByShift.get(shiftId) ?? [];
      const settlements = settlementsByShift.get(shiftId) ?? [];
      const startingCash = money(payload.startingCash);
      const cashSales = money(invoices.reduce((sum, invoice) => sum + money(invoice.cash_amount), 0));
      const expenseTotal = money(expenses.reduce((sum, expense) => sum + money(expense.amount), 0));
      const debtCollections = money(settlements.reduce((sum, settlement) => sum + money(settlement.amount), 0));
      const openedAt = text(payload.startTime) || text(payload.openedAt) || row.client_created_at || row.created_at;
      const openedTime = new Date(openedAt).getTime();
      const branchId = text(payload.branchId) || row.branch_id || null;
      const terminalId = text(payload.terminalId) || row.terminal_id || null;
      return {
        shiftId,
        openedAt,
        cashier: text(payload.cashierName) || text(row.cashier_name),
        branchId,
        branch: branchId ? branchNames.get(branchId) ?? "" : "",
        terminalId,
        terminal: terminalId ? terminalNames.get(terminalId) ?? "" : "",
        startingCash,
        cashSales,
        visaSales: money(invoices.reduce((sum, invoice) => sum + money(invoice.visa_amount), 0)),
        cliqSales: money(invoices.reduce((sum, invoice) => sum + money(invoice.cliq_amount), 0)),
        debtSales: money(invoices.reduce((sum, invoice) => sum + money(invoice.debt_amount), 0)),
        debtCollections,
        expenses: expenseTotal,
        totalSales: money(invoices.reduce((sum, invoice) => sum + money(invoice.total), 0)),
        expectedCashInDrawer: money(startingCash + cashSales + debtCollections - expenseTotal),
        invoiceCount: invoices.length,
        ageMinutes: Number.isFinite(openedTime)
          ? Math.max(0, Math.floor((generatedAt.getTime() - openedTime) / 60_000))
          : 0,
        status: Number.isFinite(openedTime) && (generatedAt.getTime() - openedTime) / 60_000 >= STALE_SHIFT_MINUTES
          ? "STALE"
          : "OPEN",
      };
    });

    const response: OpenShiftResponse = { shifts, generatedAt: generatedAt.toISOString() };
    return Response.json(response);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "open_shift_report_failed" }, { status: 500 });
  }
}
