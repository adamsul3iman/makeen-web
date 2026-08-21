"use client";

import { useEffect, useRef, useState } from "react";
import { Pencil, X } from "lucide-react";
import { usePosStore } from "@/store/usePosStore";
import { formatMoney } from "@/lib/format";

/**
 * Inline unit-price override for a cart line (Admin Mode only).
 * The owner clicks the line's price and types a new value; it is applied
 * immediately, keeping any active line discount (percent re-derives, fixed
 * clamps to the new gross). Rendered with `key={lineEditTarget}` so it
 * remounts per line and the input starts from the current price.
 */
export default function AdminLineEditModal() {
  const index = usePosStore((s) => s.lineEditTarget);
  const items = usePosStore((s) => s.items);
  const adminSetLinePrice = usePosStore((s) => s.adminSetLinePrice);
  const setLineEditTarget = usePosStore((s) => s.setLineEditTarget);

  const item = typeof index === "number" ? items[index] : undefined;
  const [value, setValue] = useState(item ? String(item.unitPrice) : "");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [index]);

  if (!item || typeof index !== "number") return null;

  const commit = () => {
    const price = Number(value);
    adminSetLinePrice(index, price);
    setLineEditTarget(null);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      dir="rtl"
      onClick={() => setLineEditTarget(null)}
    >
      <div
        className="w-full max-w-xs overflow-hidden rounded-2xl bg-white p-6 shadow-2xl max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-sky-500/15 text-sky-600">
              <Pencil className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-base font-black">تعديل سعر الصنف</h2>
              <p className="max-w-[220px] truncate text-xs font-semibold text-muted">
                {item.name}
              </p>
            </div>
          </div>
          <button
            type="button"
            aria-label="إغلاق"
            onClick={() => setLineEditTarget(null)}
            className="grid h-11 w-11 cursor-pointer place-items-center rounded-lg text-muted transition hover:bg-surface-muted"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        <p className="mt-4 text-sm font-semibold text-muted">
          السعر الحالي: {formatMoney(item.unitPrice)} • الكمية: {item.qty}
        </p>

        <div className="mt-2 flex items-center gap-2 rounded-xl border border-border bg-surface-muted/60 px-3 py-2.5 focus-within:ring-2 focus-within:ring-primary/30">
          <span className="text-sm font-black text-muted">د.أ</span>
          <input
            ref={inputRef}
            type="number"
            inputMode="decimal"
            min={0}
            step="0.01"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") setLineEditTarget(null);
            }}
            className="w-full bg-transparent text-xl font-black tabular-nums outline-none"
          />
        </div>

        <div className="mt-4 flex gap-2">
          <button
            type="button"
            onClick={() => setLineEditTarget(null)}
            className="h-12 flex-1 rounded-xl border border-border text-sm font-black text-muted transition hover:bg-surface-muted"
          >
            إلغاء
          </button>
          <button
            type="button"
            onClick={commit}
            disabled={!Number.isFinite(Number(value)) || Number(value) < 0}
            className="h-12 flex-1 rounded-xl bg-sky-600 text-sm font-black text-white transition hover:bg-sky-500 disabled:opacity-50"
          >
            تطبيق
          </button>
        </div>
      </div>
    </div>
  );
}
