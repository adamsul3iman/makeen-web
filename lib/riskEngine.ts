import { supabase } from "@/lib/supabase";

export type RiskSeverity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type RiskEventType =
  | "SHIFT_VARIANCE"
  | "STALE_SHIFT"
  | "INVOICE_RETURN"
  | "INVOICE_VOID"
  | "HIGH_DISCOUNT"
  | "OPEN_DRAWER"
  | "PRICE_OVERRIDE"
  | "RETURN_MODE"
  | "FAILED_APPROVAL";

export interface RiskSignalInput {
  storeId: string;
  eventKey: string;
  eventType: RiskEventType;
  score: number;
  amount?: number;
  actorId?: string | null;
  actorName?: string | null;
  branchId?: string | null;
  terminalId?: string | null;
  shiftId?: string | null;
  targetId?: string | null;
  details?: Record<string, unknown>;
  occurredAt?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function round3(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.round((numeric + Number.EPSILON) * 1000) / 1000 : 0;
}

function optionalUuid(value: unknown): string | null {
  return typeof value === "string" && UUID_RE.test(value) ? value : null;
}

export function severityForScore(score: number): RiskSeverity {
  if (score >= 80) return "CRITICAL";
  if (score >= 55) return "HIGH";
  if (score >= 30) return "MEDIUM";
  return "LOW";
}

/** Idempotently append one server-derived risk signal. */
export async function recordRiskSignal(input: RiskSignalInput): Promise<string | null> {
  if (!supabase) return null;
  const score = Math.max(0, Math.min(100, Math.round(input.score)));
  const { data, error } = await supabase
    .from("risk_events")
    .upsert({
      store_id: input.storeId,
      event_key: input.eventKey,
      actor_id: optionalUuid(input.actorId),
      actor_name: input.actorName?.trim() ?? "",
      branch_id: optionalUuid(input.branchId),
      terminal_id: optionalUuid(input.terminalId),
      shift_id: optionalUuid(input.shiftId),
      event_type: input.eventType,
      severity: severityForScore(score),
      score,
      amount: Math.abs(round3(input.amount)),
      target_id: input.targetId || null,
      details: input.details ?? {},
      occurred_at: input.occurredAt ?? new Date().toISOString(),
    }, { onConflict: "store_id,event_key", ignoreDuplicates: true })
    .select("id")
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data?.id ?? null;
}

interface InvoiceRiskPayload {
  subtotal?: number;
  discount?: number;
  total?: number;
  originalInvoiceId?: string;
  isCancellation?: boolean;
  cashierId?: string;
  cashierName?: string;
  shiftId?: string;
  branchId?: string;
  terminalId?: string;
  completed_at?: string;
}

/** Derive return, void and unusually large discount signals from a settled invoice. */
export async function recordInvoiceRiskSignals(
  storeId: string,
  syncId: string,
  payload: InvoiceRiskPayload,
  fallbackActorName = "",
): Promise<void> {
  if (!supabase) return;

  const total = round3(payload.total);
  const discount = Math.abs(round3(payload.discount));
  const subtotal = Math.abs(round3(payload.subtotal));
  const discountRatio = subtotal > 0 ? (discount / subtotal) * 100 : 0;
  const base = {
    storeId,
    actorId: payload.cashierId,
    actorName: payload.cashierName || fallbackActorName,
    branchId: payload.branchId,
    terminalId: payload.terminalId,
    shiftId: payload.shiftId,
    occurredAt: payload.completed_at,
  };

  if (payload.isCancellation) {
    const originalId = payload.originalInvoiceId ?? syncId;
    await recordRiskSignal({
      ...base,
      eventKey: `invoice-void:${originalId}`,
      eventType: "INVOICE_VOID",
      score: 72,
      amount: total,
      targetId: originalId,
      details: { reversalSyncId: syncId, originalInvoiceId: payload.originalInvoiceId ?? null },
    });
  } else if (payload.originalInvoiceId || total < 0) {
    const amount = Math.abs(total);
    await recordRiskSignal({
      ...base,
      eventKey: `invoice-return:${syncId}`,
      eventType: "INVOICE_RETURN",
      score: Math.min(85, 35 + Math.floor(amount / 5)),
      amount,
      targetId: payload.originalInvoiceId ?? syncId,
      details: { returnSyncId: syncId, originalInvoiceId: payload.originalInvoiceId ?? null },
    });
  }

  if (discount > 0 && (discountRatio >= 10 || discount >= 5)) {
    await recordRiskSignal({
      ...base,
      eventKey: `high-discount:${syncId}`,
      eventType: "HIGH_DISCOUNT",
      score: Math.min(90, 20 + Math.floor(discountRatio * 1.5) + Math.floor(discount / 5)),
      amount: discount,
      targetId: syncId,
      details: {
        subtotal,
        discount,
        discountPercent: Math.round(discountRatio * 100) / 100,
        invoiceTotal: total,
      },
    });
  }
}

const AUDIT_RISK: Record<string, { type: RiskEventType; score: number }> = {
  OPEN_DRAWER: { type: "OPEN_DRAWER", score: 42 },
  CANCEL_INVOICE: { type: "INVOICE_VOID", score: 72 },
  OVERRIDE_PRICE: { type: "PRICE_OVERRIDE", score: 38 },
  ENTER_RETURN_MODE: { type: "RETURN_MODE", score: 24 },
};

export async function recordAuditRiskSignal(input: {
  auditId: string;
  storeId: string;
  actionType: string;
  actorId?: string | null;
  actorName?: string | null;
  targetId?: string | null;
  details?: Record<string, unknown>;
  occurredAt?: string;
}): Promise<void> {
  const meta = AUDIT_RISK[input.actionType];
  if (!meta) return;
  const details = input.details ?? {};
  const eventKey = input.actionType === "CANCEL_INVOICE" && input.targetId
    ? `invoice-void:${input.targetId}`
    : `audit:${input.auditId}`;
  await recordRiskSignal({
    storeId: input.storeId,
    eventKey,
    eventType: meta.type,
    score: meta.score,
    amount: Number(details.amount ?? details.total ?? 0),
    actorId: typeof details.cashierId === "string" ? details.cashierId : input.actorId,
    actorName: typeof details.cashierName === "string" ? details.cashierName : input.actorName,
    branchId: typeof details.branchId === "string" ? details.branchId : null,
    terminalId: typeof details.terminalId === "string" ? details.terminalId : null,
    shiftId: typeof details.shiftId === "string" ? details.shiftId : null,
    targetId: input.targetId,
    details,
    occurredAt: input.occurredAt,
  });
}
