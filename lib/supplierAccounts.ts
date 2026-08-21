import type {
  SupplierAccountSummary,
  SupplierInvoiceListItem,
  SupplierInvoiceStatus,
} from "@/types/supplierAccounts.types";

export function supplierNumber(value: unknown): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

export function supplierText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function supplierObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export const EMPTY_SUPPLIER_SUMMARY: SupplierAccountSummary = {
  invoiceCount: 0,
  purchasesExcludingTax: 0,
  inputTax: 0,
  purchasesIncludingTax: 0,
  paymentCount: 0,
  payments: 0,
  openInvoiceCount: 0,
  outstandingBalance: 0,
  overdueCount: 0,
  overdueBalance: 0,
  dueSoonBalance: 0,
};

export function mapSupplierSummary(value: unknown): SupplierAccountSummary {
  const row = supplierObject(value);
  return {
    invoiceCount: supplierNumber(row.invoiceCount),
    purchasesExcludingTax: supplierNumber(row.purchasesExcludingTax),
    inputTax: supplierNumber(row.inputTax),
    purchasesIncludingTax: supplierNumber(row.purchasesIncludingTax),
    paymentCount: supplierNumber(row.paymentCount),
    payments: supplierNumber(row.payments),
    openInvoiceCount: supplierNumber(row.openInvoiceCount),
    outstandingBalance: supplierNumber(row.outstandingBalance),
    overdueCount: supplierNumber(row.overdueCount),
    overdueBalance: supplierNumber(row.overdueBalance),
    dueSoonBalance: supplierNumber(row.dueSoonBalance),
  };
}

function status(value: unknown): SupplierInvoiceStatus {
  const clean = supplierText(value);
  return ["OPEN", "PARTIAL", "PAID", "VOID"].includes(clean)
    ? (clean as SupplierInvoiceStatus)
    : "OPEN";
}

export function mapSupplierInvoice(row: Record<string, unknown>): SupplierInvoiceListItem {
  return {
    id: supplierText(row.id),
    supplierId: supplierText(row.supplier_id),
    supplierName: supplierText(row.supplier_name),
    purchaseOrderId: supplierText(row.purchase_order_id) || null,
    invoiceNumber: supplierText(row.invoice_number),
    invoiceDate: supplierText(row.invoice_date),
    dueDate: supplierText(row.due_date),
    subtotal: supplierNumber(row.subtotal),
    taxAmount: supplierNumber(row.tax_amount),
    totalAmount: supplierNumber(row.total_amount),
    paidAmount: supplierNumber(row.paid_amount),
    balanceDue: supplierNumber(row.balance_due),
    status: status(row.status),
    notes: supplierText(row.notes),
    itemCount: supplierNumber(row.item_count),
    paymentCount: supplierNumber(row.payment_count),
    isOverdue: row.is_overdue === true,
    createdAt: supplierText(row.created_at),
  };
}
