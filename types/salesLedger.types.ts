export type SalesLedgerKind = "ALL" | "SALE" | "RETURN";
export type SalesPaymentMethod = "CASH" | "VISA" | "SPLIT" | "DEBT" | "CLIQ" | "UNKNOWN";

export interface SalesLedgerSummary {
  invoiceCount: number;
  saleCount: number;
  returnCount: number;
  grossSales: number;
  returns: number;
  netSales: number;
  subtotal: number;
  tax: number;
  discounts: number;
  deliveryFee: number;
  grossProfitCandidate: number;
  grossProfit: number | null;
  profitMargin: number | null;
  profitReliable: boolean;
  cash: number;
  visa: number;
  cliq: number;
  debt: number;
  itemCount: number;
  averageTicket: number;
}

export interface SalesTaxBreakdown {
  taxPercent: number;
  taxIncluded: boolean;
  lineCount: number;
  quantity: number;
  netSales: number;
  tax: number;
  grossSales: number;
  cost: number;
  grossProfitCandidate: number;
  grossProfit: number | null;
  profitReliable: boolean;
}

export interface SalesLedgerInvoice {
  id: string;
  syncId: string;
  reference: string;
  /** Terminal-scoped receipt number minted at checkout (e.g. T1-0007). */
  invoiceNumber?: string;
  branchId: string | null;
  branchName: string;
  terminalId: string | null;
  terminalName: string;
  shiftId: string | null;
  cashierId: string | null;
  cashierName: string;
  customerId: string | null;
  customerName: string;
  customerPhone: string;
  paymentMethod: SalesPaymentMethod;
  subtotal: number;
  tax: number;
  discount: number;
  deliveryFee: number;
  total: number;
  cashAmount: number;
  visaAmount: number;
  cliqAmount: number;
  debtAmount: number;
  itemCount: number;
  grossProfitCandidate: number;
  grossProfit: number | null;
  profitMargin: number | null;
  profitReliable: boolean;
  isReturn: boolean;
  isCancellation: boolean;
  originalInvoiceSyncId: string | null;
  completedAt: string;
  /** Official ISTD/JoFotara clearance UUID, when the invoice was cleared. */
  istdUuid?: string;
  /** Official ISTD/JoFotara QR payload, when the invoice was cleared. */
  istdQr?: string;
}

export interface SalesLedgerOption {
  id: string;
  name: string;
  branchId?: string;
}

export interface SalesLedgerResponse {
  invoices: SalesLedgerInvoice[];
  summary: SalesLedgerSummary;
  taxBreakdown: SalesTaxBreakdown[];
  dataQuality: {
    zeroCostLineCount: number;
    zeroCostNetSales: number;
    missingBarcodeLineCount: number;
    unknownProductLineCount: number;
  };
  filters: {
    branches: SalesLedgerOption[];
    terminals: SalesLedgerOption[];
    cashiers: SalesLedgerOption[];
  };
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
  generatedAt: string;
}

export interface SalesInvoiceItemDetail {
  id: string;
  lineNo: number;
  productId: string | null;
  productName: string;
  barcode: string;
  variantLabel: string;
  unitName: string;
  quantity: number;
  multiplier: number;
  unitPrice: number;
  lineSubtotal: number;
  lineDiscount: number;
  netTotal: number;
  taxPercent: number;
  taxIncluded: boolean;
  taxAmount: number;
  lineTotal: number;
  costPrice: number;
  costTotal: number;
  grossProfitCandidate: number;
  grossProfit: number | null;
  profitReliable: boolean;
}

export interface SalesInvoicePaymentDetail {
  method: Exclude<SalesPaymentMethod, "SPLIT">;
  amount: number;
}

export interface SalesInvoiceDetail extends SalesLedgerInvoice {
  amountPaid: number;
  changeAmount: number;
  items: SalesInvoiceItemDetail[];
  payments: SalesInvoicePaymentDetail[];
  taxBreakdown: SalesTaxBreakdown[];
  linkedReturns: Array<Pick<SalesLedgerInvoice, "id" | "syncId" | "reference" | "total" | "completedAt">>;
}
