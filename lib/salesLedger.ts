import type {
  SalesInvoiceItemDetail,
  SalesLedgerInvoice,
  SalesLedgerSummary,
  SalesPaymentMethod,
  SalesTaxBreakdown,
} from "@/types/salesLedger.types";
import { recognizedRevenue, resolveGrossProfit } from "@/lib/accounting";

export function ledgerNumber(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function ledgerText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function invoiceReference(syncId: string): string {
  return syncId.replaceAll("-", "").slice(0, 10).toUpperCase();
}

function paymentMethod(value: unknown): SalesPaymentMethod {
  const method = ledgerText(value);
  return ["CASH", "VISA", "SPLIT", "DEBT", "CLIQ"].includes(method)
    ? (method as SalesPaymentMethod)
    : "UNKNOWN";
}

export function mapSalesLedgerInvoice(row: Record<string, unknown>): SalesLedgerInvoice {
  const syncId = ledgerText(row.sync_id);
  const subtotal = ledgerNumber(row.subtotal);
  const deliveryFee = ledgerNumber(row.delivery_fee);
  const profit = resolveGrossProfit(
    ledgerNumber(row.gross_profit),
    recognizedRevenue(subtotal, deliveryFee),
    row.profit_reliable === false ? 1 : 0,
  );
  return {
    id: ledgerText(row.id),
    syncId,
    reference: invoiceReference(syncId),
    branchId: ledgerText(row.branch_id) || null,
    branchName: ledgerText(row.branch_name),
    terminalId: ledgerText(row.terminal_id) || null,
    terminalName: ledgerText(row.terminal_name),
    shiftId: ledgerText(row.shift_id) || null,
    cashierId: ledgerText(row.cashier_id) || null,
    cashierName: ledgerText(row.cashier_name),
    customerId: ledgerText(row.customer_id) || null,
    customerName: ledgerText(row.customer_name),
    customerPhone: ledgerText(row.customer_phone),
    paymentMethod: paymentMethod(row.payment_method),
    subtotal,
    tax: ledgerNumber(row.tax),
    discount: ledgerNumber(row.discount),
    deliveryFee,
    total: ledgerNumber(row.total),
    cashAmount: ledgerNumber(row.cash_amount),
    visaAmount: ledgerNumber(row.visa_amount),
    cliqAmount: ledgerNumber(row.cliq_amount),
    debtAmount: ledgerNumber(row.debt_amount),
    itemCount: ledgerNumber(row.item_count),
    grossProfitCandidate: profit.candidate,
    grossProfit: profit.value,
    profitMargin: profit.margin,
    profitReliable: profit.reliable,
    isReturn: row.is_return === true || ledgerNumber(row.total) < 0,
    isCancellation: row.is_cancellation === true,
    originalInvoiceSyncId: ledgerText(row.original_invoice_sync_id) || null,
    completedAt: ledgerText(row.completed_at),
    istdUuid: ledgerText(row.istd_uuid) || undefined,
    istdQr: ledgerText(row.istd_qr) || undefined,
  };
}

export function mapSalesInvoiceItem(row: Record<string, unknown>): SalesInvoiceItemDetail {
  const costPrice = ledgerNumber(row.cost_price);
  const quantity = ledgerNumber(row.qty);
  const profit = ledgerNumber(row.gross_profit);
  const profitReliable = quantity === 0 || costPrice > 0;
  return {
    id: ledgerText(row.id),
    lineNo: ledgerNumber(row.line_no),
    productId: ledgerText(row.product_id) || null,
    productName: ledgerText(row.product_name),
    barcode: ledgerText(row.barcode),
    variantLabel: ledgerText(row.variant_label),
    unitName: ledgerText(row.unit_name),
    quantity,
    multiplier: ledgerNumber(row.multiplier, 1),
    unitPrice: ledgerNumber(row.unit_price),
    lineSubtotal: ledgerNumber(row.line_subtotal),
    lineDiscount: ledgerNumber(row.line_discount),
    netTotal: ledgerNumber(row.net_total),
    taxPercent: ledgerNumber(row.tax_percent),
    taxIncluded: row.tax_included === true,
    taxAmount: ledgerNumber(row.tax_amount),
    lineTotal: ledgerNumber(row.line_total),
    costPrice,
    costTotal: ledgerNumber(row.cost_total),
    grossProfitCandidate: profit,
    grossProfit: profitReliable ? profit : null,
    profitReliable,
  };
}

export function mapSalesLedgerSummary(value: unknown): { summary: SalesLedgerSummary; taxBreakdown: SalesTaxBreakdown[] } {
  const root = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const raw = root.summary && typeof root.summary === "object" ? (root.summary as Record<string, unknown>) : {};
  const grossProfitCandidate = ledgerNumber(raw.grossProfitCandidate, ledgerNumber(raw.grossProfit));
  const profitReliable = raw.profitReliable !== false;
  const summary: SalesLedgerSummary = {
    invoiceCount: ledgerNumber(raw.invoiceCount),
    saleCount: ledgerNumber(raw.saleCount),
    returnCount: ledgerNumber(raw.returnCount),
    grossSales: ledgerNumber(raw.grossSales),
    returns: ledgerNumber(raw.returns),
    netSales: ledgerNumber(raw.netSales),
    subtotal: ledgerNumber(raw.subtotal),
    tax: ledgerNumber(raw.tax),
    discounts: ledgerNumber(raw.discounts),
    deliveryFee: ledgerNumber(raw.deliveryFee),
    grossProfitCandidate,
    grossProfit: profitReliable ? grossProfitCandidate : null,
    profitMargin: profitReliable ? ledgerNumber(raw.profitMargin) : null,
    profitReliable,
    cash: ledgerNumber(raw.cash),
    visa: ledgerNumber(raw.visa),
    cliq: ledgerNumber(raw.cliq),
    debt: ledgerNumber(raw.debt),
    itemCount: ledgerNumber(raw.itemCount),
    averageTicket: ledgerNumber(raw.averageTicket),
  };
  const taxBreakdown = Array.isArray(root.taxBreakdown)
    ? root.taxBreakdown.map((entry) => {
      const row = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
      const groupCandidate = ledgerNumber(row.grossProfitCandidate, ledgerNumber(row.grossProfit));
      const profitReliable = row.profitReliable !== false;
      return {
        taxPercent: ledgerNumber(row.taxPercent),
        taxIncluded: row.taxIncluded === true,
        lineCount: ledgerNumber(row.lineCount),
        quantity: ledgerNumber(row.quantity),
        netSales: ledgerNumber(row.netSales),
        tax: ledgerNumber(row.tax),
        grossSales: ledgerNumber(row.grossSales),
        cost: ledgerNumber(row.cost),
        grossProfitCandidate: groupCandidate,
        grossProfit: profitReliable ? groupCandidate : null,
        profitReliable,
      } satisfies SalesTaxBreakdown;
    })
    : [];
  return { summary, taxBreakdown };
}

export function buildTaxBreakdown(items: SalesInvoiceItemDetail[]): SalesTaxBreakdown[] {
  const groups = new Map<string, SalesTaxBreakdown>();
  for (const item of items) {
    const key = `${item.taxPercent}:${item.taxIncluded ? "included" : "added"}`;
    const current = groups.get(key) ?? {
      taxPercent: item.taxPercent,
      taxIncluded: item.taxIncluded,
      lineCount: 0,
      quantity: 0,
      netSales: 0,
      tax: 0,
      grossSales: 0,
      cost: 0,
      grossProfitCandidate: 0,
      grossProfit: 0,
      profitReliable: true,
    };
    current.lineCount += 1;
    current.quantity += item.quantity;
    current.netSales += item.netTotal;
    current.tax += item.taxAmount;
    current.grossSales += item.lineTotal;
    current.cost += item.costTotal;
    current.grossProfitCandidate += item.grossProfitCandidate;
    current.profitReliable = current.profitReliable && item.profitReliable;
    current.grossProfit = current.profitReliable ? current.grossProfitCandidate : null;
    groups.set(key, current);
  }
  return Array.from(groups.values())
    .map((group) => ({
      ...group,
      quantity: Math.round(group.quantity * 1000) / 1000,
      netSales: Math.round(group.netSales * 100) / 100,
      tax: Math.round(group.tax * 100) / 100,
      grossSales: Math.round(group.grossSales * 100) / 100,
      cost: Math.round(group.cost * 100) / 100,
      grossProfitCandidate: Math.round(group.grossProfitCandidate * 100) / 100,
      grossProfit: group.profitReliable
        ? Math.round(group.grossProfitCandidate * 100) / 100
        : null,
    }))
    .sort((a, b) => a.taxPercent - b.taxPercent || Number(a.taxIncluded) - Number(b.taxIncluded));
}
