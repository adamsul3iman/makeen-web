import type { ShiftAudit } from "@/types/shifts.types";

/**
 * Build a printable shift payload from live POS store state.
 *
 * Used by the X report (open shift) and the Z report (closed-shift success
 * screen) so both share one field mapping. Fields that only exist after
 * close (actual counts, approvals) are zeroed — the renderer skips them.
 */
export function buildLiveShiftAudit(input: {
  shiftId: string | null;
  startTime: string | null;
  startingCash: number;
  totals: {
    cashSales: number;
    visaSales: number;
    cliqSales: number;
    debtSales: number;
    debtCollections: number;
    totalSales: number;
    discounts: number;
    returns: number;
    expenses: number;
    expectedCashInDrawer: number;
    cashInTotal: number;
    cashOutTotal: number;
    expectedCard: number;
    actualCard: number;
    cardVariance: number;
    expectedCliq: number;
    actualCliq: number;
    cliqVariance: number;
    /** Not tracked on the closed-shift snapshot; defaults to 0. */
    drawerOpenCount?: number;
  };
  invoiceCount?: number;
  cashierName?: string;
  branchName?: string | null;
  terminalName?: string | null;
  /** Closed-shift snapshot overrides (Z report). */
  closedAt?: string | null;
  actualCash?: number;
  variance?: number;
  discrepancyReason?: string;
  discrepancyNote?: string;
}): ShiftAudit {
  const { totals } = input;
  return {
    id: input.shiftId ?? "",
    shiftId: input.shiftId ?? "",
    openedAt: input.startTime,
    closedAt: input.closedAt ?? null,
    date: "",
    cashier: input.cashierName ?? "",
    branchId: null,
    branch: input.branchName ?? "",
    terminalId: null,
    terminal: input.terminalName ?? "",
    startingCash: input.startingCash,
    cashSales: totals.cashSales,
    visaSales: totals.visaSales,
    cliqSales: totals.cliqSales,
    debtSales: totals.debtSales,
    debtCollections: totals.debtCollections,
    discounts: totals.discounts,
    returns: totals.returns,
    expenses: totals.expenses,
    totalSales: totals.totalSales,
    expectedCashInDrawer: totals.expectedCashInDrawer,
    actualCash: input.actualCash ?? 0,
    variance: input.variance ?? 0,
    expectedCard: totals.expectedCard,
    actualCard: totals.actualCard,
    cardVariance: totals.cardVariance,
    expectedCliq: totals.expectedCliq,
    actualCliq: totals.actualCliq,
    cliqVariance: totals.cliqVariance,
    cashIn: totals.cashInTotal,
    cashOut: totals.cashOutTotal,
    drawerOpenCount: totals.drawerOpenCount ?? 0,
    discrepancyReason: input.discrepancyReason ?? "",
    discrepancyNote: input.discrepancyNote ?? "",
    approvalStatus: "NOT_REQUIRED",
    approvedByName: "",
    approvedAt: null,
    approvalNote: "",
    closeSource: "DEVICE",
    resolvedByName: "",
    resolutionNote: "",
    status: "CLOSED",
  };
}
