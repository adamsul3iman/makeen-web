"use client";

import { useState } from "react";
import { Percent, BadgeDollarSign, ShieldAlert } from "lucide-react";
import { ModalShell } from "@/components/ui/ModalShell";
import { usePosStore } from "@/store/usePosStore";
import { formatMoney } from "@/lib/format";
import { isValidMoneyInput, parseMoneyInput } from "@/lib/moneyInput";
import { formatProductDisplayName } from "@/lib/productDisplayName";
import type { DiscountScope, DiscountType } from "@/types/pos.types";

const PRESETS: Record<DiscountType, number[]> = {
  PERCENT: [5, 10, 15],
  FIXED: [5, 10, 25],
};

export default function DiscountModal({
  scope,
  index,
  onClose,
}: {
  scope: DiscountScope;
  index?: number;
  onClose: () => void;
}) {
  const items = usePosStore((s) => s.items);
  const applyDiscount = usePosStore((s) => s.applyDiscount);

  const [type, setType] = useState<DiscountType>("PERCENT");
  const [value, setValue] = useState("");

  const item = scope === "ITEM" ? items[index ?? -1] : null;
  const gross =
    scope === "ITEM" && item
      ? item.qty * item.unitPrice
      : items.reduce((s, it) => s + it.qty * it.unitPrice, 0);

  const submit = (val?: number) => {
    const parsed = val ?? parseMoneyInput(value);
    if (parsed === null || !Number.isFinite(parsed) || parsed <= 0) return;
    applyDiscount({ scope, index, type, value: parsed });
    onClose();
  };

  return (
    <ModalShell
      title={scope === "ITEM" ? "خصم على الصنف" : "خصم على الفاتورة"}
      onClose={onClose}
      size="sm"
      height="sm"
      bodyClassName="space-y-4"
      footer={
        <button
          type="button"
          onClick={() => submit()}
          disabled={(() => {
            const parsed = parseMoneyInput(value);
            return parsed === null || parsed <= 0;
          })()}
          className="flex h-12 w-full items-center justify-center rounded-xl bg-primary text-base font-black text-primary-foreground transition hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
        >
          تطبيق الخصم
        </button>
      }
    >
      {scope === "ITEM" && item && (
            <div className="rounded-xl bg-surface-muted px-4 py-3">
              <p className="truncate text-sm font-bold">{formatProductDisplayName(item.name, item.variantLabel)}</p>
              <p className="text-xs text-muted">
                الإجمالي قبل الخصم:{" "}
                <span className="tabular-nums font-bold">{formatMoney(gross)}</span>
              </p>
            </div>
      )}
      {scope === "TOTAL" && (
            <div className="rounded-xl bg-surface-muted px-4 py-3">
              <p className="text-sm font-semibold text-muted">الإجمالي قبل الخصم</p>
              <p className="text-2xl font-black tabular-nums">{formatMoney(gross)}</p>
            </div>
      )}

          <div>
            <p className="mb-2 text-sm font-bold text-muted">نوع الخصم</p>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setType("PERCENT")}
                className={`flex items-center justify-center gap-2 rounded-xl border px-3 py-2.5 text-sm font-black transition ${
                  type === "PERCENT"
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-surface text-muted hover:bg-surface-muted"
                }`}
              >
                <Percent className="h-4 w-4" />
                نسبة %
              </button>
              <button
                type="button"
                onClick={() => setType("FIXED")}
                className={`flex items-center justify-center gap-2 rounded-xl border px-3 py-2.5 text-sm font-black transition ${
                  type === "FIXED"
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-surface text-muted hover:bg-surface-muted"
                }`}
              >
                <BadgeDollarSign className="h-4 w-4" />
                مبلغ ثابت
              </button>
            </div>
          </div>

          <div>
            <p className="mb-2 text-sm font-bold text-muted">
              القيمة ({type === "PERCENT" ? "%" : "د.أ"})
            </p>
            <input
              type="number"
              inputMode="decimal"
              dir="ltr"
              min={0}
              value={value}
              onChange={(e) => {
                // Reject keystrokes that don't form valid money (digits +
                // one decimal separator); a wedge scan can never type a
                // 13-digit barcode into the discount field.
                if (isValidMoneyInput(e.target.value)) setValue(e.target.value);
              }}
              onFocus={(e) => e.currentTarget.select()}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
              placeholder="0.00"
              autoFocus
              className="min-h-14 w-full rounded-xl border border-border bg-surface px-4 py-3 text-left text-2xl font-bold tabular-nums outline-none transition focus:border-primary focus-visible:focus-ring"
            />
            <div className="mt-2 flex flex-wrap gap-2">
              {PRESETS[type].map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => submit(p)}
                  className="min-h-11 rounded-lg border border-border bg-surface-muted px-3 py-2 text-sm font-bold tabular-nums transition hover:bg-surface"
                >
                  {p}
                  {type === "PERCENT" ? "%" : " د.أ"}
                </button>
              ))}
            </div>
          </div>

          <p className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
            <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
            الخصم الأكبر من 10% أو 50 د.أ يتطلب إدخال كلمة مرور المالك
          </p>

    </ModalShell>
  );
}
