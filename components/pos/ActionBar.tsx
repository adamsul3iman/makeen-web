"use client";

import { HandCoins, ReceiptText, Undo2 } from "lucide-react";
import { usePosStore } from "@/store/usePosStore";
import { hasCapability } from "@/lib/permissions";

/**
 * Quick-action strip. Global status (online / shift open) and the close-shift
 * action live in the top header (PosLayout); this bar now holds only the three
 * contextual cashier actions, each expanding to fill the full width.
 */
export default function ActionBar() {
  const isReturnMode = usePosStore((s) => s.isReturnMode);
  const openDebtSettlementModal = usePosStore((s) => s.openDebtSettlementModal);
  const openExpenseModal = usePosStore((s) => s.openExpenseModal);
  const requestReturnModeToggle = usePosStore((s) => s.requestReturnModeToggle);
  const currentCashier = usePosStore((s) => s.currentCashier);

  return (
    <footer className="flex min-h-12 shrink-0 items-center gap-1 overflow-x-auto scrollbar-hidden whitespace-nowrap rounded-lg border border-border bg-surface px-1 py-0.5">
      {hasCapability(currentCashier, "pos.record_expense") && (
        <button
          type="button"
          onClick={openExpenseModal}
          className="flex h-11 flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 text-xs font-bold text-warning-strong transition hover:bg-warning-soft active:scale-[0.96]"
        >
          <ReceiptText className="h-3.5 w-3.5 shrink-0" />
          مصروف
        </button>
      )}

      {hasCapability(currentCashier, "pos.collect_debt") && (
        <button
          type="button"
          onClick={openDebtSettlementModal}
          className="flex h-11 flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 text-xs font-bold text-info-strong transition hover:bg-info-soft active:scale-[0.96]"
        >
          <HandCoins className="h-3.5 w-3.5 shrink-0" />
          سداد ذمة
        </button>
      )}

      {hasCapability(currentCashier, "pos.request_return") && (
        <button
          type="button"
          onClick={requestReturnModeToggle}
          className={`flex h-11 flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 text-xs font-bold transition active:scale-[0.96] ${
            isReturnMode
              ? "bg-destructive-soft text-destructive hover:bg-destructive/15"
              : "text-muted hover:bg-surface-muted"
          }`}
        >
          <Undo2 className="h-3.5 w-3.5 shrink-0" />
          مرتجع
        </button>
      )}
    </footer>
  );
}
