/** One closed shift session, flattened from a SHIFT_CLOSED sync event. */
export interface ShiftAudit {
  /** sync_events primary key. */
  id: string;
  /** Stable shift id shared by the shift's invoices and the close event. */
  shiftId: string;
  /** ISO timestamp when the cashier opened the shift. */
  openedAt: string | null;
  /** ISO timestamp when the shift was closed. */
  closedAt: string | null;
  /** Human-readable close date (dd/MM/yyyy). */
  date: string;
  /** Cashier who opened/closed the shift. */
  cashier: string;
  branchId: string | null;
  branch: string;
  terminalId: string | null;
  terminal: string;
  startingCash: number;
  cashSales: number;
  visaSales: number;
  cliqSales: number;
  debtSales: number;
  debtCollections: number;
  discounts: number;
  returns: number;
  expenses: number;
  totalSales: number;
  expectedCashInDrawer: number;
  actualCash: number;
  variance: number;
  /** Card reconciliation fields. */
  expectedCard: number;
  actualCard: number;
  cardVariance: number;
  /** CliQ reconciliation fields. */
  expectedCliq: number;
  actualCliq: number;
  cliqVariance: number;
  /** Cash In/Out totals. */
  cashIn: number;
  cashOut: number;
  /** Drawer open count during the shift. */
  drawerOpenCount: number;
  /** Discrepancy explanation. */
  discrepancyReason: string;
  discrepancyNote: string;
  approvalStatus: "NOT_REQUIRED" | "PENDING" | "APPROVED";
  approvedByName: string;
  approvedAt: string | null;
  approvalNote: string;
  closeSource: "DEVICE" | "ADMIN_RECOVERY";
  resolvedByName: string;
  resolutionNote: string;
  status: "CLOSED";
}

/** Server-ledger snapshot for an open shift. This is the non-closing X report. */
export interface OpenShiftAudit {
  shiftId: string;
  openedAt: string;
  cashier: string;
  branchId: string | null;
  branch: string;
  terminalId: string | null;
  terminal: string;
  startingCash: number;
  cashSales: number;
  visaSales: number;
  cliqSales: number;
  debtSales: number;
  debtCollections: number;
  expenses: number;
  totalSales: number;
  expectedCashInDrawer: number;
  invoiceCount: number;
  ageMinutes: number;
  /** STALE means the terminal has no matching Z close after 24 hours. */
  status: "OPEN" | "STALE";
}

export interface OpenShiftResponse {
  shifts: OpenShiftAudit[];
  generatedAt: string;
}

/** Aggregates over the whole filtered range (not just the current page). */
export interface ShiftAuditSummary {
  shiftCount: number;
  totalSales: number;
  cash: number;
  visa: number;
  cliq: number;
  debt: number;
  debtCollections: number;
  discounts: number;
  returns: number;
  expenses: number;
  expectedCashInDrawer: number;
  actualCash: number;
  variance: number;
  expectedCard: number;
  actualCard: number;
  cardVariance: number;
  expectedCliq: number;
  actualCliq: number;
  cliqVariance: number;
  cashIn: number;
  cashOut: number;
  drawerOpenCount: number;
  cashierCount: number;
  topCashiers: Array<{ name: string; count: number; totalSales: number }>;
}

export interface ShiftAuditResponse {
  shifts: ShiftAudit[];
  total: number;
  page: number;
  pageSize: number;
  summary: ShiftAuditSummary;
}

export function emptyShiftAuditResponse(page = 1, pageSize = 25): ShiftAuditResponse {
  return {
    shifts: [],
    total: 0,
    page,
    pageSize,
    summary: {
      shiftCount: 0,
      totalSales: 0,
      cash: 0,
      visa: 0,
      cliq: 0,
      debt: 0,
      debtCollections: 0,
      discounts: 0,
      returns: 0,
      expenses: 0,
      expectedCashInDrawer: 0,
      actualCash: 0,
      variance: 0,
      expectedCard: 0,
      actualCard: 0,
      cardVariance: 0,
      expectedCliq: 0,
      actualCliq: 0,
      cliqVariance: 0,
      cashIn: 0,
      cashOut: 0,
      drawerOpenCount: 0,
      cashierCount: 0,
      topCashiers: [],
    },
  };
}
