"use client";

import { History, RotateCcw, X } from "lucide-react";
import { usePosStore } from "@/store/usePosStore";
import { formatMoney } from "@/lib/format";
import { useModalEscape } from "@/hooks/useModalEscape";

export default function HeldInvoicesModal() {
  const isOpen = usePosStore((s) => s.isHoldModalOpen);
  const heldInvoices = usePosStore((s) => s.heldInvoices);
  const closeHoldModal = usePosStore((s) => s.closeHoldModal);
  const restoreInvoice = usePosStore((s) => s.restoreInvoice);

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
          {heldInvoices.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-16 text-center">
              <History className="h-12 w-12 text-muted-foreground/40" />
              <p className="text-base font-semibold text-muted">لا توجد فواتير معلقة</p>
              <p className="text-sm text-muted-foreground">
                علّق فاتورة بالضغط على F4 لإرجاعها لاحقاً
              </p>
            </div>
          ) : (
            <ul className="space-y-2">
              {heldInvoices.map((held) => (
                <li
                  key={held.id}
                  className="flex items-center justify-between gap-3 rounded-xl border border-border px-4 py-3"
                >
                  <div>
                    <p className="text-base font-bold tabular-nums">
                      {formatMoney(held.total)}
                    </p>
                    <p className="text-xs text-muted">
                      {held.items.reduce((n, it) => n + it.qty, 0)} صنف • {fmtDate(held.created_at)}{" "}
                      {fmtTime(held.created_at)}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => restoreInvoice(held.id)}
                    className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-bold text-primary-foreground transition hover:bg-primary-hover"
                  >
                    <RotateCcw className="h-4 w-4" />
                    استعادة
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
