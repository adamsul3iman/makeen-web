"use client";

import { useMemo } from "react";
import { History, RotateCcw, X, XCircle } from "lucide-react";
import { usePosStore } from "@/store/usePosStore";
import { useOrdersStore } from "@/store/useOrdersStore";
import { formatMoney } from "@/lib/format";
import { computeSaleTotals } from "@/lib/saleMath";
import { useModalEscape } from "@/hooks/useModalEscape";

/**
 * Parked-orders board v1 (Phase 2). Lists OPEN orders — the device-local
 * held carts of before, now cross-device and mirrored to pos_orders. Restore
 * pulls an order back into the cart; cancel retires it with a reason.
 * Phase 3 replaces this with the full Orders page (cards UI + filters).
 */
export default function HeldInvoicesModal() {
  const isOpen = usePosStore((s) => s.isHoldModalOpen);
  const closeHoldModal = usePosStore((s) => s.closeHoldModal);
  const restoreInvoice = usePosStore((s) => s.restoreInvoice);
  const activeOrderId = usePosStore((s) => s.activeOrderId);
  // Select stable references only — a filter() inside the selector allocates
  // a fresh array every render, which React 19's getSnapshot caching treats
  // as a change and loops forever (max update depth). Derive below instead.
  const orders = useOrdersStore((s) => s.orders);
  const cancelOrder = useOrdersStore((s) => s.cancelOrder);

  const openOrders = useMemo(
    () =>
      orders.filter(
        (o) => o.status === "OPEN" && (!activeOrderId || o.id !== activeOrderId),
      ),
    [orders, activeOrderId],
  );

  useModalEscape(closeHoldModal, isOpen);

  if (!isOpen) return null;

  const fmtDate = (iso: string) =>
    new Date(iso).toLocaleDateString("ar", { day: "2-digit", month: "2-digit" });
  const fmtTime = (iso: string) =>
    new Date(iso).toLocaleTimeString("ar", { hour: "2-digit", minute: "2-digit" });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      dir="rtl"
      onClick={closeHoldModal}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-lg flex-col rounded-2xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-border px-5 py-4">
          <div className="flex items-center gap-2">
            <History className="h-5 w-5 text-primary" />
            <h2 className="text-lg font-bold">الفاتورات المعلقة</h2>
          </div>
          <button
            type="button"
            aria-label="إغلاق"
            onClick={closeHoldModal}
            className="relative z-50 grid h-11 w-11 cursor-pointer place-items-center rounded-lg text-muted transition hover:bg-surface-muted"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-hidden p-3">
          {openOrders.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-16 text-center">
              <History className="h-12 w-12 text-muted-foreground/40" />
              <p className="text-base font-semibold text-muted">لا توجد فواتير معلقة</p>
              <p className="text-sm text-muted-foreground">
                علّق فاتورة بالضغط على F4 لإرجاعها لاحقاً
              </p>
            </div>
          ) : (
            <ul className="space-y-2">
              {openOrders.map((order) => {
                // Re-derive the payable total exactly like checkout would
                // (line discounts, invoice discount, delivery fee, tax).
                const total = computeSaleTotals(
                  order.items,
                  order.invoiceDiscount,
                  0,
                  order.deliveryFee,
                ).total;
                return (
                  <li
                    key={order.id}
                    className="flex items-center justify-between gap-3 rounded-xl border border-border px-4 py-3"
                  >
                    <div className="min-w-0">
                      <p className="text-base font-bold tabular-nums">
                        {formatMoney(total)}
                      </p>
                      <p className="truncate text-xs text-muted">
                        {order.items.reduce((n, it) => n + it.qty, 0)} صنف •{" "}
                        {fmtDate(order.createdAt)} {fmtTime(order.createdAt)}
                        {order.cashierName ? ` • ${order.cashierName}` : ""}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => restoreInvoice(order.id)}
                        className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-bold text-primary-foreground transition hover:bg-primary-hover"
                      >
                        <RotateCcw className="h-4 w-4" />
                        استعادة
                      </button>
                      <button
                        type="button"
                        aria-label="إلغاء الفاتورة المعلقة"
                        onClick={() => cancelOrder(order.id, "أُلغيت من لوحة التعليق")}
                        className="grid h-9 w-9 place-items-center rounded-lg text-slate-300 transition hover:bg-rose-50 hover:text-rose-500"
                      >
                        <XCircle className="h-4 w-4" />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
