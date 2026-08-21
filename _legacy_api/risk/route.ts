import { capabilityAuthorizationError, getCapabilityAccess } from "@/lib/requestAuth";
import { supabase } from "@/lib/supabase";
import type { RiskEvent, RiskResponse, RiskSeverity, RiskStatus } from "@/types/risk.types";

export const dynamic = "force-dynamic";

const DAY_MS = 24 * 60 * 60 * 1000;
const PAGE_SIZE_DEFAULT = 30;
const PAGE_SIZE_MAX = 200;
const MAX_ROWS = 20_000;
const DB_PAGE_SIZE = 1_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SEVERITIES = new Set<RiskSeverity>(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
const STATUSES = new Set<RiskStatus>(["OPEN", "REVIEWED", "DISMISSED", "ESCALATED"]);

function numberValue(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round((number + Number.EPSILON) * 100) / 100 : 0;
}

function mapEvent(row: Record<string, unknown>): RiskEvent {
  return {
    id: String(row.id ?? ""),
    eventType: String(row.event_type ?? ""),
    severity: String(row.severity ?? "LOW") as RiskSeverity,
    score: numberValue(row.score),
    amount: numberValue(row.amount),
    actorId: typeof row.actor_id === "string" ? row.actor_id : null,
    actorName: typeof row.actor_name === "string" ? row.actor_name : "",
    branchId: typeof row.branch_id === "string" ? row.branch_id : null,
    terminalId: typeof row.terminal_id === "string" ? row.terminal_id : null,
    shiftId: typeof row.shift_id === "string" ? row.shift_id : null,
    targetId: typeof row.target_id === "string" ? row.target_id : null,
    details: row.details && typeof row.details === "object" && !Array.isArray(row.details)
      ? row.details as Record<string, unknown>
      : {},
    status: String(row.status ?? "OPEN") as RiskStatus,
    reviewedByName: typeof row.reviewed_by_name === "string" ? row.reviewed_by_name : "",
    reviewedAt: typeof row.reviewed_at === "string" ? row.reviewed_at : null,
    reviewNote: typeof row.review_note === "string" ? row.review_note : "",
    occurredAt: typeof row.occurred_at === "string" ? row.occurred_at : "",
  };
}

function buildSummary(events: RiskEvent[]): RiskResponse["summary"] {
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
    highAndCritical: events.filter((event) => event.severity === "HIGH" || event.severity === "CRITICAL").length,
    critical: events.filter((event) => event.severity === "CRITICAL").length,
    amountAtRisk: numberValue(events.reduce((sum, event) => sum + event.amount, 0)),
    averageScore: events.length > 0
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

export async function GET(request: Request): Promise<Response> {
  const access = await getCapabilityAccess(request, "risk.view");
  if (!access) return capabilityAuthorizationError(request, "risk.view");

  if (!supabase) {
    const empty: RiskResponse = {
      events: [], total: 0, page: 1, pageSize: PAGE_SIZE_DEFAULT, truncated: false, summary: buildSummary([]),
    };
    return Response.json(empty);
  }

  const url = new URL(request.url);
  const requestedStatus = url.searchParams.get("status")?.toUpperCase() as RiskStatus | undefined;
  const requestedSeverity = url.searchParams.get("severity")?.toUpperCase() as RiskSeverity | undefined;
  const eventType = url.searchParams.get("eventType")?.trim().toUpperCase() ?? "";
  const query = url.searchParams.get("q")?.trim() ?? "";
  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
  const pageSize = Math.min(PAGE_SIZE_MAX, Math.max(1, Number(url.searchParams.get("pageSize")) || PAGE_SIZE_DEFAULT));
  const fromRaw = url.searchParams.get("from");
  const toRaw = url.searchParams.get("to");
  const from = fromRaw ? new Date(`${fromRaw}T00:00:00+03:00`) : new Date(Date.now() - 30 * DAY_MS);
  const to = toRaw ? new Date(`${toRaw}T23:59:59.999+03:00`) : new Date();
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) {
    return Response.json({ error: "invalid_date_range" }, { status: 400 });
  }

  const allEvents: RiskEvent[] = [];
  for (let offset = 0; offset < MAX_ROWS; offset += DB_PAGE_SIZE) {
    let dbQuery = supabase
      .from("risk_events")
      .select("id,event_type,severity,score,amount,actor_id,actor_name,branch_id,terminal_id,shift_id,target_id,details,status,reviewed_by_name,reviewed_at,review_note,occurred_at")
      .eq("store_id", access.storeId)
      .gte("occurred_at", from.toISOString())
      .lte("occurred_at", to.toISOString())
      .order("occurred_at", { ascending: false })
      .range(offset, offset + DB_PAGE_SIZE - 1);
    if (requestedStatus && STATUSES.has(requestedStatus)) dbQuery = dbQuery.eq("status", requestedStatus);
    if (requestedSeverity && SEVERITIES.has(requestedSeverity)) dbQuery = dbQuery.eq("severity", requestedSeverity);
    if (eventType) dbQuery = dbQuery.eq("event_type", eventType);
    if (query) dbQuery = dbQuery.ilike("actor_name", `%${query.replaceAll("%", "")}%`);

    const { data, error } = await dbQuery;
    if (error) return Response.json({ error: error.message }, { status: 500 });
    const pageRows = (data ?? []) as unknown as Record<string, unknown>[];
    allEvents.push(...pageRows.map(mapEvent));
    if (pageRows.length < DB_PAGE_SIZE) break;
  }
  const truncated = allEvents.length >= MAX_ROWS;
  const total = allEvents.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * pageSize;
  const response: RiskResponse = {
    events: allEvents.slice(start, start + pageSize),
    total,
    page: safePage,
    pageSize,
    truncated,
    summary: buildSummary(allEvents),
  };
  return Response.json(response);
}

export async function PATCH(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const input = body as { id?: unknown; status?: unknown; note?: unknown };
  const id = typeof input.id === "string" ? input.id : "";
  const status = typeof input.status === "string" ? input.status.toUpperCase() as RiskStatus : "OPEN";
  const note = typeof input.note === "string" ? input.note.trim() : "";
  if (!UUID_RE.test(id)) return Response.json({ error: "invalid_risk_event_id" }, { status: 400 });
  if (!new Set<RiskStatus>(["REVIEWED", "DISMISSED", "ESCALATED"]).has(status)) {
    return Response.json({ error: "invalid_risk_status" }, { status: 400 });
  }
  if (note.length < 3 || note.length > 500) {
    return Response.json({ error: "review_note_required" }, { status: 400 });
  }
  const access = await getCapabilityAccess(request, "risk.review");
  if (!access) return capabilityAuthorizationError(request, "risk.review");
  if (!supabase) return Response.json({ ok: true, id, status });
  const reviewerId = access.role === "admin" ? null : access.actorId;
  const { data, error } = await supabase.rpc("review_risk_event", {
    p_store_id: access.storeId,
    p_event_id: id,
    p_status: status,
    p_reviewer_id: reviewerId,
    p_reviewer_name: access.actorName,
    p_note: note,
  });
  if (error) {
    if (error.code === "P0002") return Response.json({ error: "risk_event_not_found" }, { status: 404 });
    return Response.json({ error: error.message }, { status: 500 });
  }
  const reviewed = Array.isArray(data) ? data[0] : data;
  return Response.json({ event: reviewed ? mapEvent(reviewed as Record<string, unknown>) : null });
}
