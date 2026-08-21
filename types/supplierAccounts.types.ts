export type SupplierInvoiceStatus = "OPEN" | "PARTIAL" | "PAID" | "VOID";
export type SupplierInvoiceFilterStatus = "ALL" | SupplierInvoiceStatus | "OVERDUE";
export type SupplierPaymentMethod = "CASH" | "BANK" | "CARD";

export interface SupplierAccountSummary {
  invoiceCount: number;
  purchasesExcludingTax: number;
  inputTax: number;
  purchasesIncludingTax: number;
  paymentCount: number;
  payments: number;
  openInvoiceCount: number;
  outstandingBalance: number;
  overdueCount: number;
  overdueBalance: number;
  dueSoonBalance: number;
}

export interface SupplierInvoiceListItem {
  id: string;
  supplierId: string;
  supplierName: string;
  purchaseOrderId: string | null;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string;
  subtotal: number;
  taxAmount: number;
  totalAmount: number;
  paidAmount: number;
  balanceDue: number;
  status: SupplierInvoiceStatus;
  notes: string;
  itemCount: number;
  paymentCount: number;
  isOverdue: boolean;
  createdAt: string;
}

export interface SupplierInvoiceItem {
  id: string;
  lineNo: number;
  productId: string | null;
  description: string;
  quantity: number;
  unitCost: number;
  taxPercent: number;
  netAmount: number;
  taxAmount: number;
  totalAmount: number;
}

export interface SupplierPayment {
  id: string;
  amount: number;
  method: SupplierPaymentMethod;
  reference: string;
  notes: string;
  paidAt: string;
}

export interface SupplierAccountOption {
  id: string;
  name: string;
  balance?: number;
}

export interface SupplierProductOption {
  id: string;
  name: string;
  baseUnit: string;
  taxPercent: number;
}

export interface SupplierAccountsResponse {
  invoices: SupplierInvoiceListItem[];
  summary: SupplierAccountSummary;
  suppliers: SupplierAccountOption[];
  products: SupplierProductOption[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
  generatedAt: string;
}

export interface SupplierInvoiceDetail extends SupplierInvoiceListItem {
  items: SupplierInvoiceItem[];
  payments: SupplierPayment[];
}
