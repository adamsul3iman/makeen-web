"use client";

import type { CompletedInvoice, PaymentMethod, SaleItem } from "@/types/pos.types";
import type { SalesInvoiceDetail, SalesPaymentMethod } from "@/types/salesLedger.types";
import ThermalReceipt from "@/components/pos/ThermalReceipt";

const PAYMENT_METHOD: Record<SalesPaymentMethod, PaymentMethod> = {
  CASH: "CASH",
  VISA: "VISA",
  CLIQ: "CLIQ",
  SPLIT: "SPLIT",
  DEBT: "DEBT",
  UNKNOWN: "CASH",
};

function toSaleItem(item: SalesInvoiceDetail["items"][number]): SaleItem {
  return {
    productId: item.productId ?? item.id,
    name: item.productName,
    barcode: item.barcode,
    variantLabel: item.variantLabel,
    unitName: item.unitName,
    qty: item.quantity,
    unitPrice: item.unitPrice,
    discount: item.lineDiscount,
    taxPercent: item.taxPercent,
    taxIncluded: item.taxIncluded,
    lineTotal: item.lineTotal,
  };
}

function toCompletedInvoice(invoice: SalesInvoiceDetail): CompletedInvoice {
  return {
    syncId: invoice.syncId,
    shiftId: invoice.shiftId ?? "historical",
    items: invoice.items.map(toSaleItem),
    subtotal: invoice.subtotal,
    tax: invoice.tax,
    discount: invoice.discount,
    deliveryFee: invoice.deliveryFee,
    total: invoice.total,
    paymentMethod: PAYMENT_METHOD[invoice.paymentMethod],
    amountPaid: invoice.amountPaid,
    change: invoice.changeAmount,
    customerId: invoice.customerId ?? undefined,
    customerName: invoice.customerName || undefined,
    customerPhone: invoice.customerPhone || undefined,
    cashierName: invoice.cashierName || undefined,
    originalInvoiceId: invoice.originalInvoiceSyncId ?? undefined,
    branchId: invoice.branchId ?? undefined,
    terminalId: invoice.terminalId ?? undefined,
    completed_at: invoice.completedAt,
  };
}

/** Historical reprints intentionally use the exact live receipt renderer. */
export default function SalesInvoiceDocument({ invoice }: { invoice: SalesInvoiceDetail }) {
  return (
    <div className="mx-auto w-full max-w-xl rounded-lg border border-border bg-white p-4 shadow-sm print:contents">
      <ThermalReceipt invoice={toCompletedInvoice(invoice)} screenVisible />
    </div>
  );
}
