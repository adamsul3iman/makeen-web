import type {
  ProfitabilityDelta,
  ProfitabilityExpenseGroup,
  ProfitabilityPeriod,
  ProfitabilityPurchases,
  ProfitabilityQuality,
  ProfitabilitySnapshot,
  ProfitabilityStatementValues,
  ProfitabilityTrendPoint,
} from "@/types/profitability.types";

function numberValue(value: unknown): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableNumber(value: unknown): number | null {
  if (value == null) return null;
  const parsed = numberValue(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function emptyProfitabilitySnapshot(period: ProfitabilityPeriod): ProfitabilitySnapshot {
  return {
    period,
    statement: {
      invoiceCount: 0,
      saleCount: 0,
      returnCount: 0,
      netRevenue: 0,
      outputTax: 0,
      receiptsIncludingTax: 0,
      discounts: 0,
      returnsExcludingTax: 0,
      returnsIncludingTax: 0,
      knownCogs: 0,
      grossProfitCandidate: 0,
      grossProfit: 0,
      operatingExpenses: 0,
      expenseCount: 0,
      operatingProfitCandidate: 0,
      operatingProfit: 0,
      operatingMargin: 0,
    },
    purchases: { receivedCount: 0, receivedValue: 0, pendingCount: 0, pendingValue: 0 },
    taxPosition: { outputTax: 0, deductibleInputTax: 0, netPayable: 0, tracked: false },
    quality: {
      profitReliable: true,
      zeroCostLineCount: 0,
      zeroCostNetSales: 0,
      missingBarcodeLineCount: 0,
      unknownProductLineCount: 0,
      inputTaxTracked: false,
    },
    expenseBreakdown: [],
    trend: [],
  };
}

export function mapProfitabilitySnapshot(value: unknown, period: ProfitabilityPeriod): ProfitabilitySnapshot {
  const root = objectValue(value);
  const rawStatement = objectValue(root.statement);
  const statement: ProfitabilityStatementValues = {
    invoiceCount: numberValue(rawStatement.invoiceCount),
    saleCount: numberValue(rawStatement.saleCount),
    returnCount: numberValue(rawStatement.returnCount),
    netRevenue: numberValue(rawStatement.netRevenue),
    outputTax: numberValue(rawStatement.outputTax),
    receiptsIncludingTax: numberValue(rawStatement.receiptsIncludingTax),
    discounts: numberValue(rawStatement.discounts),
    returnsExcludingTax: numberValue(rawStatement.returnsExcludingTax),
    returnsIncludingTax: numberValue(rawStatement.returnsIncludingTax),
    knownCogs: numberValue(rawStatement.knownCogs),
    grossProfitCandidate: numberValue(rawStatement.grossProfitCandidate),
    grossProfit: nullableNumber(rawStatement.grossProfit),
    operatingExpenses: numberValue(rawStatement.operatingExpenses),
    expenseCount: numberValue(rawStatement.expenseCount),
    operatingProfitCandidate: numberValue(rawStatement.operatingProfitCandidate),
    operatingProfit: nullableNumber(rawStatement.operatingProfit),
    operatingMargin: nullableNumber(rawStatement.operatingMargin),
  };
  const rawPurchases = objectValue(root.purchases);
  const purchases: ProfitabilityPurchases = {
    receivedCount: numberValue(rawPurchases.receivedCount),
    receivedValue: numberValue(rawPurchases.receivedValue),
    pendingCount: numberValue(rawPurchases.pendingCount),
    pendingValue: numberValue(rawPurchases.pendingValue),
  };
  const rawQuality = objectValue(root.quality);
  const quality: ProfitabilityQuality = {
    profitReliable: rawQuality.profitReliable === true,
    zeroCostLineCount: numberValue(rawQuality.zeroCostLineCount),
    zeroCostNetSales: numberValue(rawQuality.zeroCostNetSales),
    missingBarcodeLineCount: numberValue(rawQuality.missingBarcodeLineCount),
    unknownProductLineCount: numberValue(rawQuality.unknownProductLineCount),
    inputTaxTracked: rawQuality.inputTaxTracked === true,
  };
  const expenseBreakdown: ProfitabilityExpenseGroup[] = Array.isArray(root.expenseBreakdown)
    ? root.expenseBreakdown.map((entry) => {
        const row = objectValue(entry);
        return {
          category: typeof row.category === "string" ? row.category : "general",
          entryCount: numberValue(row.entryCount),
          amount: numberValue(row.amount),
        };
      })
    : [];
  const trend: ProfitabilityTrendPoint[] = Array.isArray(root.trend)
    ? root.trend.map((entry) => {
        const row = objectValue(entry);
        return {
          date: typeof row.date === "string" ? row.date : "",
          revenue: numberValue(row.revenue),
          cogs: numberValue(row.cogs),
          tax: numberValue(row.tax),
          expenses: numberValue(row.expenses),
          profitReliable: row.profitReliable === true,
          operatingProfit: nullableNumber(row.operatingProfit),
        };
      })
    : [];
  return {
    period,
    statement,
    purchases,
    taxPosition: {
      outputTax: statement.outputTax,
      deductibleInputTax: 0,
      netPayable: statement.outputTax,
      tracked: false,
    },
    quality,
    expenseBreakdown,
    trend,
  };
}

export function attachInputTax(
  snapshot: ProfitabilitySnapshot,
  deductibleInputTax: number,
): ProfitabilitySnapshot {
  const inputTax = Math.round((Math.max(0, deductibleInputTax) + Number.EPSILON) * 100) / 100;
  const netPayable =
    Math.round((snapshot.statement.outputTax - inputTax + Number.EPSILON) * 100) / 100;
  return {
    ...snapshot,
    taxPosition: {
      outputTax: snapshot.statement.outputTax,
      deductibleInputTax: inputTax,
      netPayable,
      tracked: true,
    },
    quality: { ...snapshot.quality, inputTaxTracked: true },
  };
}

function percentageDelta(current: number | null, previous: number | null): number | null {
  if (current == null || previous == null || previous === 0) return null;
  return Math.round((((current - previous) / Math.abs(previous)) * 100 + Number.EPSILON) * 100) / 100;
}

export function profitabilityDelta(
  current: ProfitabilitySnapshot,
  previous: ProfitabilitySnapshot,
): ProfitabilityDelta {
  return {
    netRevenue: percentageDelta(current.statement.netRevenue, previous.statement.netRevenue),
    knownCogs: percentageDelta(current.statement.knownCogs, previous.statement.knownCogs),
    operatingExpenses: percentageDelta(
      current.statement.operatingExpenses,
      previous.statement.operatingExpenses,
    ),
    operatingProfit: percentageDelta(
      current.statement.operatingProfit,
      previous.statement.operatingProfit,
    ),
  };
}
