"use client";

import { useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Check, Layers, PackagePlus, Search, Sparkles, X } from "lucide-react";
import { useReceivingStore } from "@/store/useReceivingStore";
import { usePosStore } from "@/store/usePosStore";
import { normalizeArabicText } from "@/lib/arabic";
import { DEFAULT_TARGET_MARGIN } from "@/lib/receiving";
import type { LocalProduct } from "@/types/pos.types";

function parsePrice(value: string): number {
  const raw = value.trim().replace(/[،]/g, ".");
  const n = Number(raw);
  return Number.isFinite(n) ? n : Number.NaN;
}

function formatAmount(value: number): string {
  return (Number.isFinite(value) ? value : 0).toFixed(2);
}

/**
 * Quick-Add capture for an unknown barcode scan. Smart on-the-fly variants:
 * the worker may (optionally) type the parent product / group name. When the
 * typed name matches an existing catalog product it becomes a real
 * `parentId`; when it is brand new, the modal accepts it seamlessly as a
 * draft `parentName` and the sync mirror creates the parent (variant root)
 * before linking this child under it — no "parent not found" during drafting,
 * no admin round-trip.
 */
export default function QuickAddModal() {
  const target = useReceivingStore((s) => s.quickAddTarget);
  const defaultTax = useReceivingStore((s) => s.draft.taxPercent);
  const quickAdd = useReceivingStore((s) => s.quickAdd);
  const cancelQuickAdd = useReceivingStore((s) => s.cancelQuickAdd);
  const catalogProducts = usePosStore((s) => s.products);

  const [name, setName] = useState("");
  const [cost, setCost] = useState("");
  const [retail, setRetail] = useState("");
  const [baseUnit, setBaseUnit] = useState("حبة");
  const [parentText, setParentText] = useState("");
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [error, setError] = useState("");
  const parentInputRef = useRef<HTMLInputElement>(null);

  /** Catalog parents the combo-box suggests: top-level products only — a
   *  variant can never be a parent (it would break the shelf grouping). */
  const parentMatches = useMemo(() => {
    const q = normalizeArabicText(parentText.trim());
    if (!q) return [];
    return Object.values(catalogProducts)
      .filter((p) => normalizeArabicText(p.name).includes(q))
      .sort((a, b) => a.name.localeCompare(b.name, "ar"))
      .slice(0, 6);
  }, [catalogProducts, parentText]);

  /** Exact (normalized) catalog match → a real existing parent. */
  const selectedParent = useMemo<LocalProduct | null>(() => {
    const q = normalizeArabicText(parentText.trim());
    return q ? parentMatches.find((m) => normalizeArabicText(m.name) === q) ?? null : null;
  }, [parentMatches, parentText]);

  /** Non-empty text with no exact catalog match → a draft parent name. */
  const isDraftParent = !selectedParent && parentText.trim().length > 0;

  if (target === null) return null;

  const suggestedRetail = (() => {
    const costValue = parsePrice(cost);
    return Number.isFinite(costValue) && costValue > 0 ? costValue * (1 + DEFAULT_TARGET_MARGIN) : 0;
  })();

  const pickParent = (product: LocalProduct) => {
    setParentText(product.name);
    setSuggestOpen(false);
    setError("");
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");

    const productName = name.trim();
    if (!productName) {
      setError("أدخل اسم الصنف");
      return;
    }
    const costValue = parsePrice(cost);
    const retailValue = parsePrice(retail);
    if (!Number.isFinite(costValue) || costValue < 0) {
      setError("أدخل سعر التكلفة صحيحاً");
      return;
    }
    if (!Number.isFinite(retailValue) || retailValue < 0) {
      setError("أدخل سعر البيع صحيحاً");
      return;
    }
    const unit = baseUnit.trim() || "حبة";

    const parentName = parentText.trim();
    if (parentName.length > 255) {
      setError("اسم المجموعة طويل جداً");
      return;
    }

    quickAdd({
      name: productName,
      cost: costValue,
      retailPrice: retailValue,
      taxPercent: defaultTax,
      baseUnit: unit,
      ...(selectedParent ? { parentId: selectedParent.id } : {}),
      ...(isDraftParent ? { parentName: parentName } : {}),
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-6">
      <div className="max-h-[92vh] w-full max-w-md overflow-y-auto rounded-t-3xl bg-white p-5 shadow-2xl sm:rounded-3xl">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <PackagePlus className="h-5 w-5 text-primary" />
            <h3 className="text-base font-black text-foreground">إضافة صنف جديد</h3>
          </div>
          <button
            type="button"
            onClick={cancelQuickAdd}
            aria-label="إغلاق"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-xl text-muted transition hover:bg-surface-muted hover:text-foreground"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <p className="mb-4 rounded-xl border border-border bg-surface-muted px-3 py-2 text-xs font-bold text-muted-foreground">
          {target.length > 0 ? (
            <>
              الباركود الممسوح غير معروف في الكتالوج — سيُسجَّل كصنف جديد
              <span dir="ltr" className="mt-1 block font-mono text-sm font-black text-foreground">
                {target}
              </span>
            </>
          ) : (
            "لا يوجد باركود — سيتم توليد كود SKU داخلي للصنف"
          )}
        </p>

        {error && (
          <div className="mb-4 rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-sm font-bold text-destructive">
            {error}
          </div>
        )}

        <form onSubmit={submit} className="space-y-4">
          <div>
            <label htmlFor="quickadd-name" className="mb-1.5 block text-sm font-black text-foreground">
              اسم الصنف *
            </label>
            <input
              id="quickadd-name"
              type="text"
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="مثال: معطر جو ليمون"
              className="h-12 w-full rounded-xl border border-border bg-surface-muted px-3 text-base font-bold text-foreground outline-none transition focus:border-primary"
            />
          </div>

          <div>
            <label htmlFor="quickadd-parent" className="mb-1.5 block text-sm font-black text-foreground">
              الصنف الرئيسي / المجموعة <span className="text-xs font-bold text-muted">(اختياري)</span>
            </label>
            <div className="relative">
              <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
              <input
                id="quickadd-parent"
                ref={parentInputRef}
                type="text"
                value={parentText}
                onChange={(event) => {
                  setParentText(event.target.value);
                  setSuggestOpen(true);
                }}
                onFocus={() => setSuggestOpen(true)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setSuggestOpen(false);
                  if (event.key === "Enter" && suggestOpen && parentMatches.length > 0) {
                    event.preventDefault();
                    pickParent(parentMatches[0]!);
                  }
                }}
                placeholder="اكتب اسم مجموعة موجودة أو مجموعة جديدة..."
                className="h-12 w-full rounded-xl border border-border bg-surface-muted ps-10 pe-9 text-base font-bold text-foreground outline-none transition focus:border-primary"
              />
              {parentText && (
                <button
                  type="button"
                  aria-label="مسح المجموعة"
                  onClick={() => {
                    setParentText("");
                    setSuggestOpen(false);
                  }}
                  className="absolute end-2 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-lg text-muted transition hover:bg-surface-muted hover:text-foreground"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>

            {suggestOpen && parentMatches.length > 0 && (
              <ul className="mt-1.5 overflow-hidden rounded-xl border border-border bg-white shadow-lg">
                {parentMatches.map((match) => {
                  const active = selectedParent?.id === match.id;
                  return (
                    <li key={match.id}>
                      <button
                        type="button"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => pickParent(match)}
                        className={`flex w-full items-center justify-between gap-2 px-3 py-2.5 text-sm font-bold transition hover:bg-surface-muted ${
                          active ? "bg-primary/10 text-primary" : "text-foreground"
                        }`}
                      >
                        <span className="min-w-0 truncate">{match.name}</span>
                        {active ? (
                          <Check className="h-4 w-4 shrink-0" />
                        ) : (
                          <span className="shrink-0 text-[10px] font-black text-muted">في الكتالوج</span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}

            {selectedParent && (
              <p className="mt-2 flex items-start gap-1.5 rounded-xl border border-success/30 bg-success/10 px-3 py-2 text-xs font-bold text-success">
                <Check className="mt-0.5 h-4 w-4 shrink-0" />
                سيربط هذا الصنف تحت «{selectedParent.name}» الموجود في الكتالوج
              </p>
            )}
            {isDraftParent && (
              <p className="mt-2 flex items-start gap-1.5 rounded-xl border border-primary/30 bg-primary/5 px-3 py-2 text-xs font-bold text-primary">
                <Sparkles className="mt-0.5 h-4 w-4 shrink-0" />
                مجموعة جديدة — سيُنشأ «{parentText.trim()}» كصنف أم تلقائياً عند حفظ الفاتورة
              </p>
            )}
            {!selectedParent && !isDraftParent && (
              <p className="mt-2 flex items-start gap-1.5 rounded-xl border border-border bg-surface-muted px-3 py-2 text-xs font-bold text-muted">
                <Layers className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                اتركها فارغة لصنف مستقل، أو اختر مجموعة لربط الصنف بها كمتغير
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="quickadd-cost" className="mb-1.5 block text-sm font-black text-foreground">
                سعر التكلفة *
              </label>
              <input
                id="quickadd-cost"
                type="text"
                inputMode="decimal"
                dir="ltr"
                value={cost}
                onChange={(event) => setCost(event.target.value)}
                placeholder="0.00"
                className="h-12 w-full rounded-xl border border-border bg-surface-muted px-3 text-right font-mono text-base font-bold text-foreground outline-none transition focus:border-primary"
              />
            </div>
            <div>
              <label htmlFor="quickadd-retail" className="mb-1.5 block text-sm font-black text-foreground">
                سعر البيع *
              </label>
              <input
                id="quickadd-retail"
                type="text"
                inputMode="decimal"
                dir="ltr"
                value={retail}
                onChange={(event) => setRetail(event.target.value)}
                placeholder="0.00"
                className="h-12 w-full rounded-xl border border-border bg-surface-muted px-3 text-right font-mono text-base font-bold text-foreground outline-none transition focus:border-primary"
              />
            </div>
          </div>

          {Number.isFinite(suggestedRetail) && suggestedRetail > 0 && (
            <button
              type="button"
              onClick={() => setRetail(formatAmount(suggestedRetail))}
              className="flex h-10 w-full items-center justify-center gap-1 rounded-xl border border-primary/30 bg-primary/5 text-xs font-black text-primary transition hover:bg-primary/10"
            >
              اقتراح سعر البيع: {formatAmount(suggestedRetail)}
            </button>
          )}

          <div>
            <label htmlFor="quickadd-unit" className="mb-1.5 block text-sm font-black text-foreground">
              الوحدة *
            </label>
            <input
              id="quickadd-unit"
              type="text"
              value={baseUnit}
              onChange={(event) => setBaseUnit(event.target.value)}
              placeholder="حبة"
              className="h-12 w-full rounded-xl border border-border bg-surface-muted px-3 text-base font-bold text-foreground outline-none transition focus:border-primary"
            />
          </div>

          <button
            type="submit"
            className="flex h-14 w-full items-center justify-center gap-2 rounded-xl bg-success text-base font-black text-success-foreground shadow-sm transition hover:bg-success-hover active:scale-[0.98]"
          >
            <PackagePlus className="h-5 w-5" />
            إضافة الصنف للفاتورة
          </button>
        </form>
      </div>
    </div>
  );
}
