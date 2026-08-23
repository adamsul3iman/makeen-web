"use client";

import { useState } from "react";
import { ArrowDownCircle, ArrowUpCircle, Banknote, X } from "lucide-react";
import { usePosStore } from "@/store/usePosStore";
import { useModalEscape } from "@/hooks/useModalEscape";
import type { CashMovementType } from "@/types/pos.types";

const CASH_IN_REASONS = [
  { value: "debt_collection", label: "تحصيل ذمم" },
  { value: "extra_change", label: "عهدة إضافية" },
  { value: "supplier_refund", label: "مرتجع مورد" },
  { value: "cashback", label: "استرداد نقدي" },
  { value: "other", label: "أخرى" },
] as const;

const CASH_OUT_REASONS = [
  { value: "petty_cash", label: "نفقات صغيرة" },
  { value: "bank_deposit", label: "إيداع بنكي" },
  { value: "change_replenish", label: "تغيير فئات" },
  { value: "refund", label: "مرتجع عميل" },
  { value: "other", label: "أخرى" },
] as const;

export default function CashMovementModal() {
  const isOpen = usePosStore((s) => s.isCashMovementModalOpen);
  const modalType = usePosStore((s) => s.cashMovementModalType);
  const closeCashMovementModal = usePosStore((s) => s.closeCashMovementModal);
  const recordCashMovement = usePosStore((s) => s.recordCashMovement);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  useModalEscape(closeCashMovementModal, isOpen);

  if (!isOpen || !modalType) return null;

  const isCashIn = modalType === "CASH_IN";
  const reasons = isCashIn ? CASH_IN_REASONS : CASH_OUT_REASONS;
  const accentColor = isCashIn ? "text-green-600" : "text-rose-600";
  const bgColor = isCashIn ? "bg-green-600" : "bg-rose-600";
  const hoverBg = isCashIn ? "hover:bg-green-700" : "hover:bg-rose-700";
  const Icon = isCashIn ? ArrowDownCircle : ArrowUpCircle;

  const amountValue = parseFloat(amount) || 0;
  const canSubmit = amountValue > 0 && reason.length > 0 && !saving;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    try {
      await recordCashMovement(modalType, amountValue, reason, notes);
      setAmount("");
      setReason("");
      setNotes("");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
      dir="rtl"
      onClick={closeCashMovementModal}
    >
      <div
        className="flex w-full max-w-sm flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-border px-5 py-4">
          <div className="flex items-center gap-2">
            <Banknote className={`h-5 w-5 ${accentColor}`} />
            <h2 className="text-lg font-bold">
              {isCashIn ? "إيداع نقدي" : "سحب نقدي"}
            </h2>
          </div>
          <button
            type="button"
            aria-label="إلغاء"
            onClick={closeCashMovementModal}
            className="relative z-50 grid h-11 w-11 cursor-pointer place-items-center rounded-lg text-muted transition hover:bg-surface-muted"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="px-5 py-4">
          <div className="space-y-4">
            <label htmlFor="cash-amount" className="block text-sm font-bold text-muted">
              المبلغ
            </label>
            <input
              id="cash-amount"
              autoFocus
              inputMode="decimal"
              dir="ltr"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canSubmit) void handleSubmit();
              }}
              className="w-full rounded-xl border border-border bg-white px-4 py-3 text-left text-2xl font-bold tabular-nums outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
            />

            <label htmlFor="cash-reason" className="block text-sm font-bold text-muted">
              السبب
            </label>
            <select
              id="cash-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="w-full rounded-xl border border-border bg-white px-4 py-3 text-base font-bold outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
            >
              <option value="">اختر السبب…</option>
              {reasons.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>

            <label htmlFor="cash-notes" className="block text-sm font-bold text-muted">
              ملاحظات <span className="font-normal text-muted-foreground">(اختياري)</span>
            </label>
            <input
              id="cash-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canSubmit) void handleSubmit();
              }}
              placeholder="تفاصيل إضافية…"
              className="w-full rounded-xl border border-border bg-white px-4 py-3 text-base font-bold outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
            />
          </div>
        </div>

        <footer className="border-t border-border px-5 py-4">
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className={`flex h-14 w-full items-center justify-center gap-2 rounded-xl ${bgColor} text-lg font-black text-white shadow-sm transition ${hoverBg} disabled:cursor-not-allowed disabled:opacity-40`}
          >
            <Icon className="h-5 w-5" />
            {saving ? "جارٍ الحفظ…" : isCashIn ? "تسجيل الإيداع" : "تسجيل السحب"}
          </button>
        </footer>
      </div>
    </div>
  );
}
