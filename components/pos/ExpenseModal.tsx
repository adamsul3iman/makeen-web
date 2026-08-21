"use client";

import { useState } from "react";
import { CheckCircle2, ReceiptText, X } from "lucide-react";
import { usePosStore } from "@/store/usePosStore";
import { EXPENSE_CATEGORY_LABELS } from "@/lib/mock-admin-data";
import { useModalEscape } from "@/hooks/useModalEscape";

/** مصروفات: record petty cash paid out of the register drawer. */
export default function ExpenseModal() {
  const isOpen = usePosStore((s) => s.isExpenseModalOpen);
  const closeExpenseModal = usePosStore((s) => s.closeExpenseModal);
  const recordExpense = usePosStore((s) => s.recordExpense);
  const [category, setCategory] = useState("general");
  const [amount, setAmount] = useState("");
  const [notes, setNotes] = useState("");

  useModalEscape(closeExpenseModal, isOpen);

  if (!isOpen) return null;

  const amountValue = parseFloat(amount) || 0;
  const canSubmit = amountValue > 0;

  const handleSubmit = () => {
    if (!canSubmit) return;
    void recordExpense(category, amountValue, notes);
    setCategory("general");
    setAmount("");
    setNotes("");
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      dir="rtl"
      onClick={closeExpenseModal}
    >
      <div
        className="flex w-full max-w-sm flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-border px-5 py-4">
          <div className="flex items-center gap-2">
            <ReceiptText className="h-5 w-5 text-destructive" />
            <h2 className="text-lg font-bold">تسجيل مصروف</h2>
          </div>
          <button
            type="button"
            aria-label="إلغاء"
            onClick={closeExpenseModal}
            className="relative z-50 grid h-11 w-11 cursor-pointer place-items-center rounded-lg text-muted transition hover:bg-surface-muted"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="px-5 py-4">
          <div className="space-y-4">
            <label htmlFor="expense-category" className="block text-sm font-bold text-muted">
              فئة المصروف
            </label>
            <select
              id="expense-category"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="w-full rounded-xl border border-border bg-white px-4 py-3 text-base font-bold outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
            >
              {(Object.keys(EXPENSE_CATEGORY_LABELS) as (keyof typeof EXPENSE_CATEGORY_LABELS)[]).map(
                (key) => (
                  <option key={key} value={key}>
                    {EXPENSE_CATEGORY_LABELS[key]}
                  </option>
                ),
              )}
            </select>

            <label htmlFor="expense-amount" className="block text-sm font-bold text-muted">
              المبلغ
            </label>
            <input
              id="expense-amount"
              autoFocus
              inputMode="decimal"
              dir="ltr"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="w-full rounded-xl border border-border bg-white px-4 py-3 text-left text-2xl font-bold tabular-nums outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
            />

            <label htmlFor="expense-notes" className="block text-sm font-bold text-muted">
              ملاحظات <span className="font-normal text-muted-foreground">(اختياري)</span>
            </label>
            <input
              id="expense-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="مثال: توصيل طلبيات"
              className="w-full rounded-xl border border-border bg-white px-4 py-3 text-base font-bold outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
            />
          </div>
        </div>

        <footer className="border-t border-border px-5 py-4">
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="flex h-14 w-full items-center justify-center gap-2 rounded-xl bg-destructive text-lg font-black text-destructive-foreground shadow-sm transition hover:bg-destructive-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            <CheckCircle2 className="h-5 w-5" />
            تسجيل المصروف
          </button>
        </footer>
      </div>
    </div>
  );
}
