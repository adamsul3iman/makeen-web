"use client";

import { useMemo, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight, Layers, PackagePlus, Search, Sparkles, Tag, X } from "lucide-react";
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

interface WizardState {
  categoryId: string | null;
  categoryName: string;
  brandId: string | null;
  brandName: string;
  parentName: string;
  cost: string;
  retail: string;
  variantLabel: string;
  baseUnit: string;
}

const TOTAL_STEPS = 4;

export default function QuickAddWizard() {
  const target = useReceivingStore((s) => s.quickAddTarget);
  const defaultTax = useReceivingStore((s) => s.draft.taxPercent);
  const quickAdd = useReceivingStore((s) => s.quickAdd);
  const cancelQuickAdd = useReceivingStore((s) => s.cancelQuickAdd);
  const categories = usePosStore((s) => s.categories);
  const catalogProducts = usePosStore((s) => s.products);

  const [step, setStep] = useState(0);
  const [error, setError] = useState("");
  const [brandText, setBrandText] = useState("");
  const [brandSuggestOpen, setBrandSuggestOpen] = useState(false);
  const [newCategoryMode, setNewCategoryMode] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("");
  const brandInputRef = useRef<HTMLInputElement>(null);

  const [state, setState] = useState<WizardState>({
    categoryId: null,
    categoryName: "",
    brandId: null,
    brandName: "",
    parentName: "",
    cost: "",
    retail: "",
    variantLabel: "",
    baseUnit: "حبة",
  });

  const update = (patch: Partial<WizardState>) => setState((prev) => ({ ...prev, ...patch }));

  const categoryList = useMemo(
    () => Object.values(categories).sort((a, b) => a.sortOrder - b.sortOrder),
    [categories],
  );

  const brandMatches = useMemo(() => {
    const q = normalizeArabicText(brandText.trim());
    if (!q) return [];
    const seen = new Map<string, { id: string; name: string }>();
    for (const p of Object.values(catalogProducts)) {
      if (p.brandId && p.brandName && normalizeArabicText(p.brandName).includes(q)) {
        seen.set(p.brandId, { id: p.brandId, name: p.brandName });
      }
    }
    return Array.from(seen.values()).slice(0, 8);
  }, [catalogProducts, brandText]);

  const selectedBrand = useMemo(() => {
    const q = normalizeArabicText(brandText.trim());
    return q ? brandMatches.find((m) => normalizeArabicText(m.name) === q) ?? null : null;
  }, [brandMatches, brandText]);

  const isDraftBrand = !selectedBrand && brandText.trim().length > 0;

  const suggestedRetail = (() => {
    const costValue = parsePrice(state.cost);
    return Number.isFinite(costValue) && costValue > 0 ? costValue * (1 + DEFAULT_TARGET_MARGIN) : 0;
  })();

  if (target === null) return null;

  const validateStep = (): string => {
    switch (step) {
      case 0: {
        if (!newCategoryMode && !state.categoryId) return "اختر تصنيفاً أو أنشئ تصنيفاً جديداً";
        if (newCategoryMode && !newCategoryName.trim()) return "أدخل اسم التصنيف الجديد";
        return "";
      }
      case 1: {
        if (!state.brandId && !brandText.trim()) return "أدخل اسم العلامة التجارية";
        return "";
      }
      case 2: {
        if (!state.parentName.trim()) return "أدخل اسم المنتج الأساسي";
        const cv = parsePrice(state.cost);
        if (!Number.isFinite(cv) || cv < 0) return "أدخل سعر التكلفة صحيحاً";
        const rv = parsePrice(state.retail);
        if (!Number.isFinite(rv) || rv < 0) return "أدخل سعر البيع صحيحاً";
        if (state.parentName.trim().length > 255) return "اسم المنتج طويل جداً";
        return "";
      }
      default:
        return "";
    }
  };

  const advance = () => {
    const err = validateStep();
    if (err) {
      setError(err);
      return;
    }
    setError("");

    if (step === 0 && newCategoryMode) {
      update({ categoryName: newCategoryName.trim() });
    }
    if (step === 1 && brandText.trim()) {
      if (selectedBrand) {
        update({ brandId: selectedBrand.id, brandName: selectedBrand.name });
      } else {
        update({ brandName: brandText.trim() });
      }
    }

    if (step < TOTAL_STEPS - 1) {
      setStep(step + 1);
    }
  };

  const back = () => {
    setError("");
    if (step > 0) setStep(step - 1);
  };

  const submit = () => {
    const err = validateStep();
    if (err) {
      setError(err);
      return;
    }
    setError("");

    const costValue = parsePrice(state.cost);
    const retailValue = parsePrice(state.retail);
    const unit = state.baseUnit.trim() || "حبة";

    const definition: import("@/types/receiving.types").QuickAddDefinition = {
      name: state.parentName.trim(),
      cost: costValue,
      retailPrice: retailValue,
      taxPercent: defaultTax,
      baseUnit: unit,
    };

    if (state.categoryId) definition.categoryId = state.categoryId;
    else if (state.categoryName) definition.categoryName = state.categoryName;

    if (state.brandId) definition.brandId = state.brandId;
    else if (state.brandName) definition.brandName = state.brandName;

    if (state.variantLabel.trim()) definition.variantLabel = state.variantLabel.trim();

    quickAdd(definition);
  };

  const pickBrand = (brand: { id: string; name: string }) => {
    setBrandText(brand.name);
    setBrandSuggestOpen(false);
    update({ brandId: brand.id, brandName: brand.name });
  };

  const stepTitles = ["التصنيف", "العلامة التجارية", "المنتج الأساسي", "المتغير"];

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-6">
      <div className="max-h-[92vh] w-full max-w-md overflow-y-auto rounded-t-3xl bg-white p-5 shadow-2xl sm:rounded-3xl">
        <div className="mb-3 flex items-start justify-between gap-3">
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

        <p className="mb-3 rounded-xl border border-border bg-surface-muted px-3 py-2 text-xs font-bold text-muted-foreground">
          {target.length > 0 ? (
            <>
              الباركود الممسوح غير معروف — سيُسجَّل كصنف جديد
              <span dir="ltr" className="mt-1 block font-mono text-sm font-black text-foreground">
                {target}
              </span>
            </>
          ) : (
            "لا يوجد باركود — سيتم توليد كود SKU داخلي"
          )}
        </p>

        <div className="mb-4 flex items-center justify-center gap-1.5">
          {Array.from({ length: TOTAL_STEPS }).map((_, i) => (
            <div
              key={i}
              className={`h-2 rounded-full transition-all ${
                i === step ? "w-8 bg-primary" : i < step ? "w-2 bg-success" : "w-2 bg-border"
              }`}
            />
          ))}
          <span className="mr-2 text-xs font-bold text-muted">
            الخطوة {step + 1} من {TOTAL_STEPS} — {stepTitles[step]}
          </span>
        </div>

        {error && (
          <div className="mb-4 rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-sm font-bold text-destructive">
            {error}
          </div>
        )}

        {step === 0 && (
          <div className="space-y-3">
            <p className="text-sm font-black text-foreground">اختر التصنيف</p>

            {!newCategoryMode ? (
              <>
                <div className="grid grid-cols-3 gap-2">
                  {categoryList.map((cat) => {
                    const active = state.categoryId === cat.id;
                    return (
                      <button
                        key={cat.id}
                        type="button"
                        onClick={() => {
                          update({ categoryId: cat.id, categoryName: cat.name });
                          setNewCategoryMode(false);
                        }}
                        className={`rounded-xl border px-3 py-2.5 text-sm font-black transition ${
                          active
                            ? "border-primary bg-primary/10 text-primary"
                            : "border-border bg-surface-muted text-foreground hover:border-primary/40"
                        }`}
                        style={cat.bgColor ? { backgroundColor: active ? undefined : cat.bgColor + "18" } : undefined}
                      >
                        {cat.name}
                        {active && <Check className="mx-auto mt-1 h-4 w-4" />}
                      </button>
                    );
                  })}
                </div>

                <button
                  type="button"
                  onClick={() => {
                    setNewCategoryMode(true);
                    setNewCategoryName("");
                    update({ categoryId: null, categoryName: "" });
                  }}
                  className="flex h-11 w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-primary/40 bg-primary/5 text-xs font-black text-primary transition hover:bg-primary/10"
                >
                  <Tag className="h-4 w-4" />
                  تصنيف جديد +
                </button>
              </>
            ) : (
              <div className="space-y-3">
                <div>
                  <label htmlFor="new-cat-name" className="mb-1.5 block text-sm font-black text-foreground">
                    اسم التصنيف الجديد
                  </label>
                  <input
                    id="new-cat-name"
                    type="text"
                    autoFocus
                    value={newCategoryName}
                    onChange={(e) => setNewCategoryName(e.target.value)}
                    placeholder="مثال: مشروبات، عناية شخصية..."
                    className="h-12 w-full rounded-xl border border-border bg-surface-muted px-3 text-base font-bold text-foreground outline-none transition focus:border-primary"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => setNewCategoryMode(false)}
                  className="flex h-10 w-full items-center justify-center gap-1 rounded-xl border border-border bg-surface-muted text-xs font-bold text-muted transition hover:bg-surface-muted/70"
                >
                  <ChevronRight className="h-4 w-4" />
                  العودة لقائمة التصنيفات
                </button>
              </div>
            )}
          </div>
        )}

        {step === 1 && (
          <div className="space-y-3">
            <p className="text-sm font-black text-foreground">العلامة التجارية</p>

            <div className="relative">
              <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
              <input
                id="brand-search"
                ref={brandInputRef}
                type="text"
                value={brandText}
                onChange={(e) => {
                  setBrandText(e.target.value);
                  setBrandSuggestOpen(true);
                  update({ brandId: null, brandName: e.target.value.trim() });
                }}
                onFocus={() => setBrandSuggestOpen(true)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setBrandSuggestOpen(false);
                  if (e.key === "Enter" && brandSuggestOpen && brandMatches.length > 0) {
                    e.preventDefault();
                    pickBrand(brandMatches[0]!);
                  }
                }}
                placeholder="اكتب اسم العلامة التجارية..."
                className="h-12 w-full rounded-xl border border-border bg-surface-muted ps-10 pe-9 text-base font-bold text-foreground outline-none transition focus:border-primary"
              />
              {brandText && (
                <button
                  type="button"
                  aria-label="مسح"
                  onClick={() => {
                    setBrandText("");
                    setBrandSuggestOpen(false);
                    update({ brandId: null, brandName: "" });
                  }}
                  className="absolute end-2 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-lg text-muted transition hover:bg-surface-muted hover:text-foreground"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>

            {brandSuggestOpen && brandMatches.length > 0 && (
              <ul className="overflow-hidden rounded-xl border border-border bg-white shadow-lg">
                {brandMatches.map((match) => {
                  const active = selectedBrand?.id === match.id;
                  return (
                    <li key={match.id}>
                      <button
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => pickBrand(match)}
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

            {selectedBrand && (
              <p className="flex items-start gap-1.5 rounded-xl border border-success/30 bg-success/10 px-3 py-2 text-xs font-bold text-success">
                <Check className="mt-0.5 h-4 w-4 shrink-0" />
                ستُربط بالعلامة «{selectedBrand.name}» الموجودة
              </p>
            )}
            {isDraftBrand && (
              <p className="flex items-start gap-1.5 rounded-xl border border-primary/30 bg-primary/5 px-3 py-2 text-xs font-bold text-primary">
                <Sparkles className="mt-0.5 h-4 w-4 shrink-0" />
                علامة جديدة — سيُنشأ «{brandText.trim()}» عند حفظ الفاتورة
              </p>
            )}
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4">
            <div>
              <label htmlFor="parent-name" className="mb-1.5 block text-sm font-black text-foreground">
                اسم المنتج الأساسي *
              </label>
              <input
                id="parent-name"
                type="text"
                autoFocus
                value={state.parentName}
                onChange={(e) => update({ parentName: e.target.value })}
                placeholder="مثال: معطر جو، شامبو..."
                className="h-12 w-full rounded-xl border border-border bg-surface-muted px-3 text-base font-bold text-foreground outline-none transition focus:border-primary"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="wizard-cost" className="mb-1.5 block text-sm font-black text-foreground">
                  سعر التكلفة *
                </label>
                <input
                  id="wizard-cost"
                  type="text"
                  inputMode="decimal"
                  dir="ltr"
                  value={state.cost}
                  onChange={(e) => update({ cost: e.target.value })}
                  placeholder="0.00"
                  className="h-12 w-full rounded-xl border border-border bg-surface-muted px-3 text-right font-mono text-base font-bold text-foreground outline-none transition focus:border-primary"
                />
              </div>
              <div>
                <label htmlFor="wizard-retail" className="mb-1.5 block text-sm font-black text-foreground">
                  سعر البيع *
                </label>
                <input
                  id="wizard-retail"
                  type="text"
                  inputMode="decimal"
                  dir="ltr"
                  value={state.retail}
                  onChange={(e) => update({ retail: e.target.value })}
                  placeholder="0.00"
                  className="h-12 w-full rounded-xl border border-border bg-surface-muted px-3 text-right font-mono text-base font-bold text-foreground outline-none transition focus:border-primary"
                />
              </div>
            </div>

            {Number.isFinite(suggestedRetail) && suggestedRetail > 0 && (
              <button
                type="button"
                onClick={() => update({ retail: formatAmount(suggestedRetail) })}
                className="flex h-10 w-full items-center justify-center gap-1 rounded-xl border border-primary/30 bg-primary/5 text-xs font-black text-primary transition hover:bg-primary/10"
              >
                اقتراح سعر البيع: {formatAmount(suggestedRetail)}
              </button>
            )}
          </div>
        )}

        {step === 3 && (
          <div className="space-y-4">
            <div>
              <label htmlFor="wizard-variant" className="mb-1.5 block text-sm font-black text-foreground">
                المتغير <span className="text-xs font-bold text-muted">(اختياري)</span>
              </label>
              <input
                id="wizard-variant"
                type="text"
                autoFocus
                value={state.variantLabel}
                onChange={(e) => update({ variantLabel: e.target.value })}
                placeholder="ليمون، فراولة، أزرق..."
                className="h-12 w-full rounded-xl border border-border bg-surface-muted px-3 text-base font-bold text-foreground outline-none transition focus:border-primary"
              />
              <p className="mt-1.5 text-xs font-bold text-muted">
                لون أو نكهة أو رائحة — اتركه فارغاً لصنف بدون متغير
              </p>
            </div>

            <div>
              <label htmlFor="wizard-unit" className="mb-1.5 block text-sm font-black text-foreground">
                الوحدة *
              </label>
              <input
                id="wizard-unit"
                type="text"
                value={state.baseUnit}
                onChange={(e) => update({ baseUnit: e.target.value })}
                placeholder="حبة"
                className="h-12 w-full rounded-xl border border-border bg-surface-muted px-3 text-base font-bold text-foreground outline-none transition focus:border-primary"
              />
            </div>

            <div className="rounded-xl border border-border bg-surface-muted p-3 text-xs font-bold text-muted-foreground space-y-1">
              <p>
                <span className="text-foreground">المنتج:</span> {state.parentName || "—"}
              </p>
              {state.categoryName && (
                <p>
                  <span className="text-foreground">التصنيف:</span> {state.categoryName}
                </p>
              )}
              {state.brandName && (
                <p>
                  <span className="text-foreground">العلامة:</span> {state.brandName}
                </p>
              )}
              {state.variantLabel && (
                <p>
                  <span className="text-foreground">المتغير:</span> {state.variantLabel}
                </p>
              )}
            </div>
          </div>
        )}

        <div className="mt-5 flex items-center gap-3">
          {step > 0 && (
            <button
              type="button"
              onClick={back}
              className="flex h-14 items-center gap-1 rounded-xl border border-border bg-surface-muted px-5 text-sm font-black text-foreground transition hover:bg-surface-muted/70 active:scale-[0.98]"
            >
              <ChevronRight className="h-5 w-5" />
              رجوع
            </button>
          )}

          {step < TOTAL_STEPS - 1 ? (
            <button
              type="button"
              onClick={advance}
              className="flex h-14 flex-1 items-center justify-center gap-2 rounded-xl bg-success text-base font-black text-success-foreground shadow-sm transition hover:bg-success-hover active:scale-[0.98]"
            >
              التالي
              <ChevronLeft className="h-5 w-5" />
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              className="flex h-14 flex-1 items-center justify-center gap-2 rounded-xl bg-success text-base font-black text-success-foreground shadow-sm transition hover:bg-success-hover active:scale-[0.98]"
            >
              <PackagePlus className="h-5 w-5" />
              حفظ وإضافة للفاتورة
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
