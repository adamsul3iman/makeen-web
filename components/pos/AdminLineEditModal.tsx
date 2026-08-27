"use client";

import { useEffect, useRef, useState } from "react";
import { Pencil } from "lucide-react";
import { usePosStore } from "@/store/usePosStore";
import { formatMoney } from "@/lib/format";
import { ModalShell } from "@/components/ui/ModalShell";
import { formatProductDisplayName } from "@/lib/productDisplayName";

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
  const displayUnitPrice = item ? item.unitPrice : 0;
  const [value, setValue] = useState(item ? String(displayUnitPrice) : "");
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
    <ModalShell
      title="تعديل سعر الصنف"
      description={formatProductDisplayName(item.name, item.variantLabel)}
      icon={
        <div className="grid h-10 w-10 place-items-center rounded-xl bg-sky-500/15 text-sky-600">
          <Pencil className="h-5 w-5" />
        </div>
      }
      size="sm"
      onClose={() => setLineEditTarget(null)}
      closeLabel="إغلاق"
      footer={
        <div className="flex gap-2">
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
      }
    >
      <p className="text-sm font-semibold text-muted">
        السعر الحالي: {formatMoney(displayUnitPrice)} • الكمية: {Math.round(item.qty / (item.unitMultiplier || 1))}
      </p>

      <div className="mt-3 flex items-center gap-2 rounded-xl border border-border bg-surface-muted/60 px-3 py-2.5 focus-within:ring-2 focus-within:ring-primary/30">
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
    </ModalShell>
  );
}
