"use client";

import { useState } from "react";
import { Loader2, Printer } from "lucide-react";
import { usePosStore } from "@/store/usePosStore";
import { useDeviceHardware } from "@/hooks/useDeviceHardware";
import { loadHardwareHubConfig } from "@/lib/hardware/config";
import { dispatchPrintJob } from "@/lib/hardware/dispatch";
import { renderReceiptPrintHtml } from "@/lib/printRenderer";
import { resolveReceiptTemplateForPrint } from "@/lib/clientPrintTemplates";
import { computeSaleTotals } from "@/lib/saleMath";
import type { CompletedInvoice } from "@/types/pos.types";
import type { LocalOrder } from "@/types/orders.types";

/**
 * Build a `CompletedInvoice` from a `pos_orders` row so the centralized
 * receipt renderer can print it. Both open (parked) and closed orders share
 * the same item/total derivation the orders page uses, so the printed slip
 * matches what the cashier sees on the card.
 *
 * `pos_orders` does not persist the payment method, so reprints render as a
 * neutral (CASH) document — item lines and totals are authoritative.
 */
function orderToInvoice(order: LocalOrder): CompletedInvoice {
  const totals = computeSaleTotals(order.items, order.invoiceDiscount, 0, order.deliveryFee);
  const isClosed = order.status === "CLOSED";
  return {
    syncId: order.invoiceSyncId ?? order.id,
    shiftId: "",
    items: order.items,
    subtotal: totals.subtotal,
    tax: totals.tax,
    discount: totals.discount,
    deliveryFee: totals.deliveryFee,
    total: totals.total,
    // Parked/reprint documents print as a neutral cash journal; the line
    // items and totals are the source of truth.
    paymentMethod: "CASH",
    amountPaid: totals.total,
    change: 0,
    customerName: order.customerName,
    customerId: order.customerId,
    customerPhone: order.customerPhone,
    cashierName: order.cashierName,
    // A parked (OPEN) order is NOT a finalized sale — it has no invoice_sync_id
    // and must never print a fiscal ISTD QR. Only CLOSED orders that settled
    // through checkout carry the finalized flag, so the receipt renderer shows
    // the proforma header and suppresses the tax QR for open documents.
    isFinalized: isClosed,
    invoiceNumber: !isClosed ? order.orderNumber : undefined,
    branchId: order.branchId ?? undefined,
    terminalId: order.terminalId ?? undefined,
    completed_at: (isClosed ? order.closedAt : order.updatedAt) ?? new Date().toISOString(),
  };
}

interface OrderPrintButtonProps {
  order: LocalOrder;
  /** Compact modifier for fitting inside the card actions row. */
  onDone?: () => void;
}

/** Quick silent-print of an order's receipt (closed) or ticket (open). */
export default function OrderPrintButton({ order, onDone }: OrderPrintButtonProps) {
  const currentStore = usePosStore((s) => s.currentStore);
  const branches = usePosStore((s) => s.branches);
  const terminals = usePosStore((s) => s.terminals);
  const activeBranchId = usePosStore((s) => s.activeBranchId);
  const activeTerminalId = usePosStore((s) => s.activeTerminalId);
  const { settings: hardwareSettings } = useDeviceHardware(activeTerminalId);
  const [busy, setBusy] = useState(false);

  const handlePrint = async () => {
    if (busy) return;
    setBusy(true);
    setNotice("جارٍ إرسال الطلب إلى الطابعة…", "success");
    try {
      const invoice = orderToInvoice(order);
      // Resolve the Print Studio template at click time — never rely on the
      // hook's snapshot, which may still be the generic fallback while the
      // store's custom template is being fetched/hydrated on a fresh register.
      const receiptConfig = await resolveReceiptTemplateForPrint(currentStore?.id);
      const html = await renderReceiptPrintHtml(invoice, {
        config: receiptConfig,
        paperWidth: hardwareSettings.receiptWidth === 58 ? 58 : 80,
        store: currentStore
          ? {
              name: currentStore.name,
              logoUrl: currentStore.logoUrl,
              address: currentStore.address,
              phone: currentStore.phone,
              receiptHeader: currentStore.receiptHeader,
              receiptFooter: currentStore.receiptFooter,
              taxNumber: currentStore.taxNumber,
            }
          : undefined,
        branchName:
          branches.find((b) => b.id === (order.branchId ?? activeBranchId))?.name ?? "",
        terminalName:
          (terminals ?? []).find((t) => t.id === (order.terminalId ?? activeTerminalId))?.name ??
          "",
      });
      const config = loadHardwareHubConfig(activeTerminalId);
      // RECEIPT_REPRINT with NO paymentMethod so the dispatcher never pulses
      // the cash drawer for a reprint of an already-settled (or parked) order.
      const result = await dispatchPrintJob(
        "RECEIPT_REPRINT",
        { html, terminalId: activeTerminalId ?? "", jobType: "RECEIPT" },
        { config },
      );
      if (result?.printed) {
        setNotice("تمت الطباعة", "success");
      } else {
        setNotice(
          result?.error === "print_failed" || !result?.attempted
            ? "تعذّرت الطباعة — تحقق من الطابعة ثم أعد المحاولة"
            : "لم تكتمل الطباعة — تحقق من الطابعة ثم أعد المحاولة",
          "error",
        );
      }
    } catch {
      setNotice("تعذّرت الطباعة", "error");
    } finally {
      setBusy(false);
      onDone?.();
    }
  };

  return (
    <button
      type="button"
      aria-label="طباعة الإيصال"
      title="طباعة الإيصال"
      onClick={() => void handlePrint()}
      disabled={busy}
      className="grid h-9 w-9 place-items-center rounded-lg border border-border text-muted transition hover:bg-surface-muted hover:text-foreground disabled:opacity-50"
    >
      {busy ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <Printer className="h-4 w-4" />
      )}
    </button>
  );
}

function setNotice(message: string, tone: "error" | "success"): void {
  usePosStore.setState({ notice: { message, tone } });
}
