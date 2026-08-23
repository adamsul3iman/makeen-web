import { getSupabaseBrowser } from "./supabaseBrowser";
import { getTenantStoreId } from "./tenantClient";
import { usePosStore } from "@/store/usePosStore";
import type {
  RiskEvent,
  RiskResponse,
  RiskSeverity,
  RiskStatus,
  RiskSummary,
} from "@/types/risk.types";

const DAY_MS = 24 * 60 * 60 * 1000;
const PAGE_SIZE = 1000;
const MAX_ROWS = 20_000;
const PAGE_SIZE_DEFAULT = 30;
const PAGE_SIZE_MAX = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const RISK_EVENT_COLUMNS =
  "id,event_type,severity,score,amount,actor_id,actor_name,branch_id,terminal_id,shift_id,target_id,details,status,reviewed_by_name,reviewed_at,review_note,occurred_at";

const SEVERITIES = new Set<RiskSeverity>(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
const STATUSES = new Set<RiskStatus>(["OPEN", "REVIEWED", "DISMISSED", "ESCALATED"]);
const REVIEW_STATUSES = new Set<RiskStatus>(["REVIEWED", "DISMISSED", "ESCALATED"]);

interface RiskEventRow {
  id: string;
  event_type: string | null;
  severity: string | null;
  score: number | string | null;
  amount: number | string | null;
  actor_id: string | null;
  actor_name: string | null;
  branch_id: string | null;
  terminal_id: string | null;
  shift_id: string | null;
  target_id: string | null;
  details: unknown;
  status: string | null;
  reviewed_by_name: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  occurred_at: string | null;
}

export interface FetchRiskEventsParams {
  status?: RiskStatus;
  severity?: RiskSeverity;
  /** Exact event_type filter (e.g. SHIFT_VARIANCE). */
  eventType?: string;
  /** Free-text search over actor_name. */
  q?: string;
  /** ISO date/datetime lower bound on occurred_at (default: last 30 days). */
  from?: string;
  /** ISO date/datetime upper bound on occurred_at (default: now). */
  to?: string;
  page?: number;
  pageSize?: number;
}

function numberValue(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? Math.round((n + Number.EPSILON) * 100) / 100 : 0;
}

function mapEvent(row: RiskEventRow): RiskEvent {
  return {
    id: row.id,
    eventType: row.event_type ?? "",
    severity: (row.severity ?? "LOW") as RiskSeverity,
    score: numberValue(row.score),
    amount: numberValue(row.amount),
    actorId: row.actor_id ?? null,
    actorName: row.actor_name ?? "",
    branchId: row.branch_id ?? null,
    terminalId: row.terminal_id ?? null,
    shiftId: row.shift_id ?? null,
    targetId: row.target_id ?? null,
    details:
      row.details && typeof row.details === "object" && !Array.isArray(row.details)
        ? (row.details as Record<string, unknown>)
        : {},
    status: (row.status ?? "OPEN") as RiskStatus,
    reviewedByName: row.reviewed_by_name ?? "",
    reviewedAt: row.reviewed_at ?? null,
    reviewNote: row.review_note ?? "",
    occurredAt: row.occurred_at ?? "",
  };
}

function buildSummary(events: RiskEvent[]): RiskSummary {
  const actors = new Map<string, { count: number; score: number }>();
  for (const event of events) {
    const name = event.actorName || "غير معروف";
    const current = actors.get(name) ?? { count: 0, score: 0 };
    current.count += 1;
    current.score += event.score;
    actors.set(name, current);
  }
  return {
    total: events.length,
    open: events.filter((event) => event.status === "OPEN").length,
    escalated: events.filter((event) => event.status === "ESCALATED").length,
    highAndCritical: events.filter(
      (event) => event.severity === "HIGH" || event.severity === "CRITICAL",
    ).length,
    critical: events.filter((event) => event.severity === "CRITICAL").length,
    amountAtRisk: numberValue(events.reduce((sum, event) => sum + event.amount, 0)),
    averageScore:
      events.length > 0
        ? numberValue(events.reduce((sum, event) => sum + event.score, 0) / events.length)
        : 0,
    topActors: Array.from(actors.entries())
      .map(([name, value]) => ({
        name,
        count: value.count,
        averageScore: numberValue(value.score / value.count),
      }))
      .sort((left, right) => right.averageScore - left.averageScore || right.count - left.count)
      .slice(0, 5),
  };
}

/**
 * Store risk ledger (`risk_events`) with severity/status/event-type filters
 * and free-text actor search. All matching rows are fetched with range
 * paging; the summary covers the whole filtered set while only the requested
 * page slice is returned.
 */
export async function fetchRiskEvents(
  params: FetchRiskEventsParams = {},
): Promise<RiskResponse> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  const fromMs = params.from
    ? new Date(params.from).getTime()
    : Date.now() - 30 * DAY_MS;
  const toMs = params.to ? new Date(params.to).getTime() : Date.now();
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs > toMs) {
    throw new Error("نطاق التواريخ غير صالح");
  }

  const status = params.status && STATUSES.has(params.status) ? params.status : undefined;
  const severity = params.severity && SEVERITIES.has(params.severity) ? params.severity : undefined;
  const eventType = params.eventType?.trim().toUpperCase() ?? "";
  const query = params.q?.trim() ?? "";

  const allEvents: RiskEvent[] = [];
  for (let offset = 0; offset < MAX_ROWS; offset += PAGE_SIZE) {
    let dbQuery = sb
      .from("risk_events")
      .select(RISK_EVENT_COLUMNS)
      .eq("store_id", storeId)
      .gte("occurred_at", new Date(fromMs).toISOString())
      .lte("occurred_at", new Date(toMs).toISOString())
      .order("occurred_at", { ascending: false })
      .range(offset, offset + PAGE_SIZE - 1);
    if (status) dbQuery = dbQuery.eq("status", status);
    if (severity) dbQuery = dbQuery.eq("severity", severity);
    if (eventType) dbQuery = dbQuery.eq("event_type", eventType);
    if (query) dbQuery = dbQuery.ilike("actor_name", `%${query.replaceAll("%", "")}%`);

    const { data, error } = await dbQuery;
    if (error) throw new Error(error.message);
    const pageRows = ((data ?? []) as unknown[]) as RiskEventRow[];
    allEvents.push(...pageRows.map(mapEvent));
    if (pageRows.length < PAGE_SIZE) break;
  }

  const pageSize = Math.min(PAGE_SIZE_MAX, Math.max(1, params.pageSize ?? PAGE_SIZE_DEFAULT));
  const total = allEvents.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, params.page ?? 1), totalPages);
  const start = (page - 1) * pageSize;

  return {
    events: allEvents.slice(start, start + pageSize),
    total,
    page,
    pageSize,
    truncated: total >= MAX_ROWS,
    summary: buildSummary(allEvents),
  };
}

/**
 * Review (approve/dismiss/escalate) a risk event through the privileged
 * `review_risk_event` RPC and returns the updated event row.
 */
export async function reviewRiskEvent(
  eventId: string,
  status: RiskStatus,
  note: string,
): Promise<RiskEvent> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  const trimmedId = eventId.trim();
  if (!UUID_RE.test(trimmedId)) throw new Error("معرّف الحدث غير صالح");
  if (!REVIEW_STATUSES.has(status)) {
    throw new Error("حالة المراجعة غير صالحة (المسموح: REVIEWED / DISMISSED / ESCALATED)");
  }
  const trimmedNote = note.trim();
  if (trimmedNote.length < 3 || trimmedNote.length > 500) {
    throw new Error("ملاحظة المراجعة مطلوبة (3 أحرف على الأقل و500 كحد أقصى)");
  }

  const session = usePosStore.getState().adminSession;
  const reviewerName = session?.name?.trim() || "مدير";

  const { data, error } = await sb.rpc("review_risk_event", {
    p_store_id: storeId,
    p_event_id: trimmedId,
    p_status: status,
    p_reviewer_id: null,
    p_reviewer_name: reviewerName,
    p_note: trimmedNote,
  });
  if (error) {
    const message = error.message;
    if (error.code === "P0002" || message.includes("risk_event_not_found")) {
      throw new Error("حدث المخاطر غير موجود");
    }
    if (message.includes("invalid_risk_status")) throw new Error("حالة المراجعة غير صالحة");
    if (message.includes("review_note_required")) throw new Error("ملاحظة المراجعة مطلوبة");
    throw new Error(message);
  }

  const reviewed = (Array.isArray(data) ? data[0] : data) as RiskEventRow | undefined;
  if (!reviewed) throw new Error("حدث المخاطر غير موجود");
  return mapEvent(reviewed);
}
