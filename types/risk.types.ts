export type RiskSeverity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type RiskStatus = "OPEN" | "REVIEWED" | "DISMISSED" | "ESCALATED";

export interface RiskEvent {
  id: string;
  eventType: string;
  severity: RiskSeverity;
  score: number;
  amount: number;
  actorId: string | null;
  actorName: string;
  branchId: string | null;
  terminalId: string | null;
  shiftId: string | null;
  targetId: string | null;
  details: Record<string, unknown>;
  status: RiskStatus;
  reviewedByName: string;
  reviewedAt: string | null;
  reviewNote: string;
  occurredAt: string;
}

export interface RiskSummary {
  total: number;
  open: number;
  escalated: number;
  highAndCritical: number;
  critical: number;
  amountAtRisk: number;
  averageScore: number;
  topActors: Array<{ name: string; count: number; averageScore: number }>;
}

export interface RiskResponse {
  events: RiskEvent[];
  total: number;
  page: number;
  pageSize: number;
  summary: RiskSummary;
  truncated: boolean;
}
