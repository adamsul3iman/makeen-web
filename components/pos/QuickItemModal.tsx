"use client";

import { useState } from "react";
import { PackagePlus, X, Zap } from "lucide-react";
import { usePosStore } from "@/store/usePosStore";
import { formatMoney } from "@/lib/format";
import { useModalEscape } from "@/hooks/useModalEscape";

/**
 * Ad-hoc item that skips the catalog and inventory entirely (الصنف السريع).
 * The cashier enters only a name + price (barcode optional). The line gets a
 * deterministic temp barcode so it behaves like any other cart line without
 * ever touching products/product_barcodes.
 */
export default function QuickItemModal({ onClose }: { onClose: () => void }) {
  const addQuickItem = usePosStore((s) => s.addQuickItem);
  const isReturnMode = usePosStore((s) => s.isReturnMode);

  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [barcode, setBarcode] = useState("");

  const priceValue = parseFloat(price);
  const canSubmit = name.trim().length > 0 && Number.isFinite(priceValue) && priceValue > 0;

  useModalEscape(onClose);

  const submit = () => {
    if (!canSubmit) return;
    addQuickItem(name.trim(), priceValue, barcode.trim() || undefined);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      dir="rtl"
      onClick={onClose}
    >
      <div className="w-full max-w-sm overflow-hidden rounded-2xl bg-white shadow-2xl max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center justify-between border-b border-border px-5 py-4">
          <div className="flex items-center gap-2">
            <Zap className="h-5 w-5 text-primary" />
            <h2 className="text-lg font-bold">صنف سريع</h2>
          </div>
          <button
            type="button"
            aria-label="إغلاق"
            onClick={onClose}
            className="relative z-50 grid h-11 w-11 cursor-pointer place-items-center rounded-lg text-muted transition hover:bg-surface-muted"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="space-y-4 px-5 py-4">
          <div className="rounded-xl bg-surface-muted px-4 py-3 text-xs font-semibold text-muted-foreground">
            صنف يُضاف مباشرة باسم وسعر فقط — دون تسجيل في المخزون أو الكتالوج.
            {isReturnMode ? " سيُضاف كبند مرتجع." : " يمكن تعبئة الباركود يدوياً أو ترك فارغاً."}
          </div>

          <div>
            <p className="mb-2 text-sm font-bold text-muted">اسم الصنف *</p>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canSubmit) submit();
              }}
              placeholder="مثال: طبق بلاستيك مقاس 24"
              autoFocus
              className="w-full rounded-xl border border-border bg-white px-4 py-3 text-base font-bold outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
            />
          </div>

          <div>
            <p className="mb-2 text-sm font-bold text-muted">السعر * (د.أ)</p>
            <input
              type="number"
              inputMode="decimal"
              dir="ltr"
              min={0}
              step="0.01"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canSubmit) submit();
              }}
              placeholder="0.00"
              className="w-full rounded-xl border border-border bg-white px-4 py-3 text-left text-2xl font-bold tabular-nums outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
            />
          </div>

          <div>
            <p className="mb-2 text-sm font-bold text-muted">باركود (اختياري)</p>
            <input
              type="text"
              dir="ltr"
              value={barcode}
              onChange={(e) => setBarcode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canSubmit) submit();
              }}
              placeholder="إمسح أو أدخل باركود الصنف..."
              className="w-full rounded-xl border border-border bg-white px-4 py-3 text-left text-base font-bold tracking-wider outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
            />
          </div>

          {Number.isFinite(priceValue) && priceValue > 0 && (
            <p className="text-center text-sm font-semibold text-muted-foreground">
              سيُضاف للفاتورة بقيمة{" "}
              <span className="tabular-nums font-black text-primary">
                {formatMoney(priceValue)}
              </span>
            </p>
          )}

          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-primary text-base font-black text-primary-foreground transition hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            <PackagePlus className="h-5 w-5 shrink-0" />
            إضافة الصنف السريع
          </button>
        </div>
      </div>
    </div>
  );
}
