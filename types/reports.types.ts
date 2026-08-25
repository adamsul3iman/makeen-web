export interface ReportsRange {
  from: string;
  to: string;
  days: number;
}

export interface ReportsSummary {
  invoiceCount: number;
  itemCount: number;
  grossSales: number;
  returns: number;
  netSales: number;
  subtotal: number;
  tax: number;
  discounts: number;
  deliveryFee: number;
  profitCandidate: number;
  profit: number | null;
  profitMargin: number | null;
  profitReliable: boolean;
  averageTicket: number;
  cash: number;
  visa: number;
  cliq: number;
  debt: number;
  debtCollections: number;
  expenses: number;
  netCashMovement: number;
}

export interface ReportsTrendPoint {
  date: string;
  invoices: number;
  sales: number;
  tax: number;
  profitCandidate: number;
  profit: number | null;
  profitReliable: boolean;
}

export interface ReportsPaymentBreakdown {
  method: string;
  label: string;
  count: number;
  amount: number;
  share: number;
}

export interface ReportsTopProduct {
  productId: string;
  name: string;
  barcode: string;
  quantity: number;
  sales: number;
  profitCandidate: number;
  profit: number | null;
  margin: number | null;
  profitReliable: boolean;
  stock: number | null;
}

export interface ReportsStockAlert {
  productId: string;
  name: string;
  stock: number;
  soldQuantity: number;
  daysOfStockLeft: number | null;
  severity: "critical" | "warning";
}

/** Product whose current stock is below zero (نواقص المخزون). */
export interface ReportsNegativeStock {
  productId: string;
  name: string;
  stock: number;
  /** First variant barcode, so the stock manager can scan-verify the item. */
  barcode?: string;
  variantLabel?: string;
}

export interface ReportsDataQualityIssue {
  id: string;
  label: string;
  severity: "high" | "medium" | "low";
  count: number;
  amount?: number;
  description: string;
}

export interface ReportsOverview {
  range: ReportsRange;
  summary: ReportsSummary;
  trend: ReportsTrendPoint[];
  paymentBreakdown: ReportsPaymentBreakdown[];
  topProducts: ReportsTopProduct[];
  stockAlerts: ReportsStockAlert[];
  dataQuality: ReportsDataQualityIssue[];
  negativeStock: ReportsNegativeStock[];
  generatedAt: string;
}
