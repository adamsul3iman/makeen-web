export interface ProfitabilityStatementValues {
  invoiceCount: number;
  saleCount: number;
  returnCount: number;
  netRevenue: number;
  outputTax: number;
  receiptsIncludingTax: number;
  discounts: number;
  returnsExcludingTax: number;
  returnsIncludingTax: number;
  knownCogs: number;
  grossProfitCandidate: number;
  grossProfit: number | null;
  operatingExpenses: number;
  expenseCount: number;
  operatingProfitCandidate: number;
  operatingProfit: number | null;
  operatingMargin: number | null;
}

export interface ProfitabilityPurchases {
  receivedCount: number;
  receivedValue: number;
  pendingCount: number;
  pendingValue: number;
}

export interface ProfitabilityQuality {
  profitReliable: boolean;
  zeroCostLineCount: number;
  zeroCostNetSales: number;
  missingBarcodeLineCount: number;
  unknownProductLineCount: number;
  inputTaxTracked: boolean;
}

export interface ProfitabilityTaxPosition {
  outputTax: number;
  deductibleInputTax: number;
  netPayable: number;
  tracked: boolean;
}

export interface ProfitabilityExpenseGroup {
  category: string;
  entryCount: number;
  amount: number;
}

export interface ProfitabilityTrendPoint {
  date: string;
  revenue: number;
  cogs: number;
  tax: number;
  expenses: number;
  profitReliable: boolean;
  operatingProfit: number | null;
}

export interface ProfitabilityPeriod {
  from: string;
  to: string;
  days: number;
}

export interface ProfitabilitySnapshot {
  period: ProfitabilityPeriod;
  statement: ProfitabilityStatementValues;
  purchases: ProfitabilityPurchases;
  taxPosition: ProfitabilityTaxPosition;
  quality: ProfitabilityQuality;
  expenseBreakdown: ProfitabilityExpenseGroup[];
  trend: ProfitabilityTrendPoint[];
}

export interface ProfitabilityDelta {
  netRevenue: number | null;
  knownCogs: number | null;
  operatingExpenses: number | null;
  operatingProfit: number | null;
}

export interface ProfitabilityResponse {
  current: ProfitabilitySnapshot;
  previous: ProfitabilitySnapshot;
  deltaPercent: ProfitabilityDelta;
  generatedAt: string;
}
