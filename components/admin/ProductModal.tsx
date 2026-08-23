"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Barcode,
  Building2,
  Package,
  Percent,
  Plus,
  RefreshCw,
  Save,
  Settings2,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import EntityCombobox, { type EntityOption } from "@/components/shared/EntityCombobox";
import QuickCreateEntityModal from "@/components/shared/QuickCreateEntityModal";

export interface InventoryVariant {
  id: string;
  barcode: string;
  variantLabel: string;
  costPrice: number;
  price: number;
  wholesalePrice: number;
  isDefaultSale: boolean;
}

export interface InventoryProduct {
  id: string;
  name: string;
  categoryId: string;
  category: string;
  brandId: string;
  brand: string;
  supplierId: string;
  supplier: string;
  baseUnit: string;
  stock: number;
  taxPercent: number;
  taxIncluded: boolean;
  isActive: boolean;
  showInPos: boolean;
  isSellable: boolean;
  isPurchasable: boolean;
  allowPriceChange: boolean;
  isQuickKey: boolean;
  reorderLevel: number;
  variants: InventoryVariant[];
  parentId?: string | null;
  variantLabel?: string;
  isVariantRoot?: boolean;
}

export type ProductFormPayload = Omit<InventoryProduct, "id" | "variants"> & {
  variants: Omit<InventoryVariant, "id">[];
};

interface RowDraft {
  key: string;
  barcode: string;
  variantLabel: string;
  costPrice: string;
  price: string;
  wholesalePrice: string;
  isDefaultSale: boolean;
}

type QuickCreateKind = "category" | "brand" | "supplier";

interface QuickCreateState {
  type: QuickCreateKind;
  initialName?: string;
}

export interface ProductEntryDefaults {
  categoryId: string;
  brandId: string;
  supplierId: string;
  baseUnit: string;
  reorderLevel: number;
  taxPercent: number;
  taxIncluded: boolean;
  isActive: boolean;
  showInPos: boolean;
  isSellable: boolean;
  isPurchasable: boolean;
  allowPriceChange: boolean;
  isQuickKey: boolean;
}

export interface ProductSaveOptions {
  addAnother: boolean;
  defaults: ProductEntryDefaults;
}

const freshKey = (): string =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

const emptyRow = (isFirst = false): RowDraft => ({
  key: freshKey(),
  barcode: "",
  variantLabel: "",
  costPrice: "",
  price: "",
  wholesalePrice: "",
  isDefaultSale: isFirst,
});

const toRow = (variant: InventoryVariant): RowDraft => ({
  key: variant.id,
  barcode: variant.barcode,
  variantLabel: variant.variantLabel,
  costPrice: String(variant.costPrice),
  price: String(variant.price),
  wholesalePrice: String(variant.wholesalePrice ?? 0),
  isDefaultSale: variant.isDefaultSale,
});

function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  hint: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-white p-3">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-1 h-4 w-4 accent-primary"
      />
      <span>
        <span className="block text-sm font-black text-foreground">{label}</span>
        <span className="mt-0.5 block text-xs font-semibold text-muted">{hint}</span>
      </span>
    </label>
  );
}

export default function ProductModal({
  initial,
  referenceOptions,
  onCreateReference,
  onClose,
  onSave,
  entryDefaults,
}: {
  initial?: InventoryProduct | null;
  referenceOptions: {
    categories: EntityOption[];
    brands: EntityOption[];
    suppliers: EntityOption[];
  };
  onCreateReference: (
    type: QuickCreateKind,
    data: { name: string; phone: string; parentId?: string | null },
  ) => Promise<EntityOption>;
  onClose: () => void;
  onSave: (payload: ProductFormPayload, options: ProductSaveOptions) => Promise<void> | void;
  entryDefaults?: ProductEntryDefaults | null;
}) {
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(initial?.name ?? "");
  const [categoryId, setCategoryId] = useState(initial?.categoryId ?? entryDefaults?.categoryId ?? "");
  const [brandId, setBrandId] = useState(initial?.brandId ?? entryDefaults?.brandId ?? "");
  const [supplierId, setSupplierId] = useState(initial?.supplierId ?? entryDefaults?.supplierId ?? "");
  const [baseUnit, setBaseUnit] = useState(initial?.baseUnit ?? entryDefaults?.baseUnit ?? "حبة");
  const [stock, setStock] = useState(String(initial?.stock ?? 0));
  const [reorderLevel, setReorderLevel] = useState(String(initial?.reorderLevel ?? entryDefaults?.reorderLevel ?? 0));
  const [taxPercent, setTaxPercent] = useState(String(initial?.taxPercent ?? entryDefaults?.taxPercent ?? 16));
  const [taxIncluded, setTaxIncluded] = useState(initial?.taxIncluded ?? entryDefaults?.taxIncluded ?? true);
  const [isActive, setIsActive] = useState(initial?.isActive ?? entryDefaults?.isActive ?? true);
  const [showInPos, setShowInPos] = useState(initial?.showInPos ?? entryDefaults?.showInPos ?? true);
  const [isSellable, setIsSellable] = useState(initial?.isSellable ?? entryDefaults?.isSellable ?? true);
  const [isPurchasable, setIsPurchasable] = useState(initial?.isPurchasable ?? entryDefaults?.isPurchasable ?? true);
  const [allowPriceChange, setAllowPriceChange] = useState(initial?.allowPriceChange ?? entryDefaults?.allowPriceChange ?? false);
  const [isQuickKey, setIsQuickKey] = useState(initial?.isQuickKey ?? entryDefaults?.isQuickKey ?? false);
  const [rows, setRows] = useState<RowDraft[]>(
    initial?.variants.length ? initial.variants.map(toRow) : [emptyRow(true)],
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [quickCreate, setQuickCreate] = useState<QuickCreateState | null>(null);
  const [generatingKey, setGeneratingKey] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(Boolean(initial));

  // Dirty tracking: serialize the editable form state once at mount, then
  // compare on every render to detect unsaved changes.
  const initialSnapshotRef = useRef<string | null>(null);
  if (initialSnapshotRef.current === null) {
    initialSnapshotRef.current = JSON.stringify({
      name: initial?.name ?? "",
      categoryId: initial?.categoryId ?? entryDefaults?.categoryId ?? "",
      brandId: initial?.brandId ?? entryDefaults?.brandId ?? "",
      supplierId: initial?.supplierId ?? entryDefaults?.supplierId ?? "",
      baseUnit: initial?.baseUnit ?? entryDefaults?.baseUnit ?? "حبة",
      stock: String(initial?.stock ?? 0),
      reorderLevel: String(initial?.reorderLevel ?? entryDefaults?.reorderLevel ?? 0),
      taxPercent: String(initial?.taxPercent ?? entryDefaults?.taxPercent ?? 16),
      taxIncluded: initial?.taxIncluded ?? entryDefaults?.taxIncluded ?? true,
      isActive: initial?.isActive ?? entryDefaults?.isActive ?? true,
      showInPos: initial?.showInPos ?? entryDefaults?.showInPos ?? true,
      isSellable: initial?.isSellable ?? entryDefaults?.isSellable ?? true,
      isPurchasable: initial?.isPurchasable ?? entryDefaults?.isPurchasable ?? true,
      allowPriceChange: initial?.allowPriceChange ?? entryDefaults?.allowPriceChange ?? false,
      isQuickKey: initial?.isQuickKey ?? entryDefaults?.isQuickKey ?? false,
      rows: initial?.variants.length ? initial.variants.map(toRow) : [emptyRow(true)],
    });
  }
  const currentSnapshot = JSON.stringify({ name, categoryId, brandId, supplierId, baseUnit, stock, reorderLevel, taxPercent, taxIncluded, isActive, showInPos, isSellable, isPurchasable, allowPriceChange, isQuickKey, rows });
  const isDirty = currentSnapshot !== initialSnapshotRef.current;

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const updateRow = (key: string, patch: Partial<RowDraft>) => {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  };

  const generateBarcode = async (row: RowDraft) => {
    setGeneratingKey(row.key);
    setSaveError(null);
    try {
      const { generateEan13, checkBarcodeUnique } = await import("@/lib/inventoryClient");
      let candidate = "";
      for (let attempt = 0; attempt < 5; attempt++) {
        candidate = generateEan13();
        const collides = rows.some(
          (other) => other.key !== row.key && other.barcode.trim() === candidate,
        );
        if (!collides) break;
      }
      updateRow(row.key, { barcode: candidate });
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "تعذر توليد الباركود");
    } finally {
      setGeneratingKey(null);
    }
  };

  const setDefault = (key: string) => {
    setRows((current) => current.map((row) => ({ ...row, isDefaultSale: row.key === key })));
  };

  const removeRow = (key: string) => {
    setRows((current) => {
      if (current.length === 1) return current;
      const removed = current.find((row) => row.key === key);
      const next = current.filter((row) => row.key !== key);
      if (removed?.isDefaultSale && next[0]) next[0] = { ...next[0], isDefaultSale: true };
      return next;
    });
  };

  const validRows = rows.filter((row) => row.barcode.trim().length > 0);
  const taxValue = Number(taxPercent);
  const pricesValid = validRows.every((row) => {
    const cost = Number(row.costPrice);
    const sale = Number(row.price);
    return Number.isFinite(cost) && cost > 0 && (allowPriceChange || (Number.isFinite(sale) && sale > 0));
  });
  const taxValid = Number.isFinite(taxValue) && taxValue >= 0 && taxValue <= 100;
  const canSave =
    name.trim().length > 0 &&
    validRows.length > 0 &&
    pricesValid &&
    taxValid;

  // Per-row validation: red = blocks save, amber = row will be silently dropped
  // from the payload (no barcode) — surface it so the user doesn't lose data.
  const rowErrors = useMemo(() => {
    const map: Record<string, { barcode?: "warn" | "error"; costPrice?: boolean; price?: boolean }> = {};
    for (const row of rows) {
      const entry: { barcode?: "warn" | "error"; costPrice?: boolean; price?: boolean } = {};
      const hasBarcode = row.barcode.trim().length > 0;
      const cost = Number(row.costPrice);
      const sale = Number(row.price);
      if (!hasBarcode && (row.costPrice.trim() || row.price.trim() || row.wholesalePrice.trim() || row.variantLabel.trim())) {
        entry.barcode = "warn";
      }
      if (hasBarcode && !(Number.isFinite(cost) && cost > 0)) entry.costPrice = true;
      if (hasBarcode && !allowPriceChange && !(Number.isFinite(sale) && sale > 0)) entry.price = true;
      if (entry.barcode || entry.costPrice || entry.price) map[row.key] = entry;
    }
    return map;
  }, [rows, allowPriceChange]);

  const firstInvalidRowIndex = rows.findIndex(
    (row) => rowErrors[row.key]?.costPrice || rowErrors[row.key]?.price,
  );
  const validationMessage = (() => {
    if (name.trim().length === 0) return "أدخل اسم المنتج";
    if (firstInvalidRowIndex >= 0) {
      const errors = rowErrors[rows[firstInvalidRowIndex].key];
      if (errors.costPrice) return `الصف ${firstInvalidRowIndex + 1}: أدخل تكلفة صحيحة أكبر من صفر`;
      return `الصف ${firstInvalidRowIndex + 1}: أدخل سعر بيع أكبر من صفر`;
    }
    if (validRows.length === 0) return "امسح الباركود أو ولّد باركوداً واحداً على الأقل";
    if (!taxValid) return "نسبة الضريبة يجب أن تكون بين 0 و 100";
    return null;
  })();

  const handleCloseAttempt = () => {
    if (saving) return;
    if (isDirty && !window.confirm("لديك تعديلات غير محفوظة. هل تريد الإغلاق دون حفظ؟")) return;
    onClose();
  };

  const handleSave = async (addAnother: boolean) => {
    if (!canSave) return;
    const payload: ProductFormPayload = {
      name: name.trim(),
      categoryId,
      category: referenceOptions.categories.find((option) => option.id === categoryId)?.name ?? "",
      brandId,
      brand: referenceOptions.brands.find((option) => option.id === brandId)?.name ?? "",
      supplierId,
      supplier: referenceOptions.suppliers.find((option) => option.id === supplierId)?.name ?? "",
      baseUnit: baseUnit.trim() || "حبة",
      stock: Math.max(0, Number((Number(stock) || 0).toFixed(3))),
      reorderLevel: Math.max(0, Math.round(Number(reorderLevel) || 0)),
      taxPercent: Math.max(0, Math.min(100, taxValue)),
      taxIncluded,
      isActive,
      showInPos,
      isSellable,
      isPurchasable,
      allowPriceChange,
      isQuickKey,
      variants: validRows.map((row) => ({
        barcode: row.barcode.trim(),
        variantLabel: row.variantLabel.trim(),
        costPrice: Math.max(0, Number(row.costPrice) || 0),
        price: Math.max(0, Number(row.price) || 0),
        wholesalePrice: Math.max(0, Number(row.wholesalePrice) || 0),
        isDefaultSale: row.isDefaultSale,
      })),
    };

    setSaving(true);
    setSaveError(null);
    try {
      await onSave(payload, {
        addAnother: addAnother && !initial,
        defaults: {
          categoryId,
          brandId,
          supplierId,
          baseUnit: payload.baseUnit,
          reorderLevel: payload.reorderLevel,
          taxPercent: payload.taxPercent,
          taxIncluded,
          isActive,
          showInPos,
          isSellable,
          isPurchasable,
          allowPriceChange,
          isQuickKey,
        },
      });
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "تعذر حفظ المنتج");
    } finally {
      setSaving(false);
    }
  };

  const fieldClass =
    "mt-1.5 w-full rounded-lg border border-border bg-white px-3 py-2.5 text-sm font-bold outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20";

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/45 p-2 sm:p-4"
      dir="rtl"
      onKeyDown={(event) => {
        if (event.ctrlKey && event.key === "Enter" && !saving && canSave) {
          event.preventDefault();
          void handleSave(!initial);
        }
      }}
    >
      <div className="flex max-h-[96vh] w-full max-w-5xl flex-col overflow-hidden rounded-lg bg-surface shadow-2xl">
        <header className="flex items-center justify-between border-b border-border px-4 py-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-2">
            <Barcode className="h-5 w-5 shrink-0 text-primary" />
            <div className="min-w-0">
              <h2 className="truncate text-lg font-black text-foreground">
                {initial ? "تعديل المنتج" : "إضافة منتج جديد"}
              </h2>
              <p className="text-xs font-semibold text-muted">
                {initial ? "بيانات البيع والمخزون والضريبة" : "إدخال منتج"}
              </p>
            </div>
          </div>
          <button
            type="button"
            aria-label="إغلاق"
            onClick={handleCloseAttempt}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-muted hover:bg-surface-muted"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="scrollbar-hidden min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4 sm:px-6">
          {!initial && (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2">
              <div className="min-w-0">
                <p className="text-sm font-black text-primary">إدخال سريع</p>
                <p className="truncate text-xs font-semibold text-muted">
                  {taxPercent}% {taxIncluded ? "شاملة الضريبة" : "تضاف عند البيع"} · {baseUnit || "حبة"}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowAdvanced((value) => !value)}
                className="flex h-9 shrink-0 items-center gap-2 rounded-lg border border-primary/25 bg-white px-3 text-xs font-black text-primary"
              >
                <Settings2 className="h-4 w-4" />
                {showAdvanced ? "إخفاء التفاصيل" : "تفاصيل إضافية"}
              </button>
            </div>
          )}
          <section>
            <div className="mb-3 flex items-center gap-2">
              <Package className="h-4 w-4 text-primary" />
              <h3 className="text-sm font-black text-foreground">بيانات المنتج</h3>
            </div>
            <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
              <label className="md:col-span-2 text-sm font-bold text-muted">
                اسم المنتج <span className="text-destructive">*</span>
                <input
                  ref={nameRef}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="مثال: كاسات بلاستيك 7 أونص"
                  className={fieldClass}
                />
              </label>

              <div className="space-y-1">
                <EntityCombobox
                  id="product-category"
                  label="التصنيف في نقطة البيع (اختياري)"
                  value={categoryId}
                  options={referenceOptions.categories}
                  placeholder="اختر التصنيف"
                  addLabel="إضافة مسار جديد"
                  onChange={setCategoryId}
                  onAdd={(draftQuery) => setQuickCreate({ type: "category", initialName: draftQuery })}
                />
              </div>

              <div className={showAdvanced ? "space-y-1" : "hidden"}>
                <EntityCombobox
                  id="product-brand"
                  label="العلامة التجارية للتقارير (اختياري)"
                  value={brandId}
                  options={referenceOptions.brands}
                  placeholder="بدون علامة تجارية"
                  addLabel="إضافة علامة تجارية"
                  onChange={setBrandId}
                  onAdd={(draftQuery) => setQuickCreate({ type: "brand", initialName: draftQuery })}
                />
                <p className="text-[11px] font-semibold text-muted">
                  تستخدم للفلترة والتقارير، ولا تغيّر مكان ظهور المنتج في نقطة البيع.
                </p>
              </div>

              <EntityCombobox
                id="product-supplier"
                label="المورد (اختياري)"
                value={supplierId}
                options={referenceOptions.suppliers}
                placeholder="بدون مورد"
                addLabel="إضافة مورد جديد"
                onChange={setSupplierId}
                onAdd={(draftQuery) => setQuickCreate({ type: "supplier", initialName: draftQuery })}
              />

              <label className={showAdvanced ? "text-sm font-bold text-muted" : "hidden"}>
                وحدة المخزون الأساسية
                <input
                  value={baseUnit}
                  onChange={(event) => setBaseUnit(event.target.value)}
                  placeholder="حبة"
                  className={fieldClass}
                />
                <span className="mt-1 block text-[11px] font-semibold text-muted">
                  هذه أصغر وحدة يُحسب عليها المخزون. مثال: حبة، علبة، كغ.
                </span>
              </label>

              <label className={showAdvanced ? "text-sm font-bold text-muted" : "hidden"}>
                المخزون بوحدة الأساس
                <input
                  value={stock}
                  onChange={(event) => setStock(event.target.value)}
                  disabled={Boolean(initial)}
                  inputMode="decimal"
                  dir="ltr"
                  title={initial ? "يُعدّل الرصيد من صفحة حركات المخزون" : undefined}
                  className={`${fieldClass} tabular-nums disabled:cursor-not-allowed disabled:bg-surface-muted disabled:text-muted`}
                />
                {initial && (
                  <span className="mt-1 block text-[11px] font-semibold text-muted">
                    يُعدّل الرصيد من صفحة حركات المخزون لحفظ الأثر.
                  </span>
                )}
              </label>

              <label className={showAdvanced ? "text-sm font-bold text-muted" : "hidden"}>
                حد إعادة الطلب
                <input
                  value={reorderLevel}
                  onChange={(event) => setReorderLevel(event.target.value)}
                  inputMode="numeric"
                  dir="ltr"
                  className={`${fieldClass} tabular-nums`}
                />
              </label>
            </div>

          </section>

          <section className={showAdvanced ? "border-y border-border py-4" : "hidden"}>
            <div className="mb-3 flex items-center gap-2">
              <Percent className="h-4 w-4 text-primary" />
              <h3 className="text-sm font-black text-foreground">الضريبة على هذا المنتج</h3>
            </div>
            <div className="grid gap-3 md:grid-cols-[180px_1fr]">
              <label className="text-sm font-bold text-muted">
                نسبة الضريبة %
                <input
                  value={taxPercent}
                  onChange={(event) => setTaxPercent(event.target.value)}
                  inputMode="decimal"
                  dir="ltr"
                  className={`${fieldClass} tabular-nums`}
                />
              </label>
              <div>
                <span className="mb-1.5 block text-sm font-bold text-muted">طريقة احتساب السعر</span>
                <div className="grid grid-cols-2 rounded-lg border border-border bg-surface-muted p-1">
                  <button
                    type="button"
                    onClick={() => setTaxIncluded(true)}
                    className={`h-10 rounded-md text-sm font-black ${taxIncluded ? "bg-white text-primary shadow-sm" : "text-muted"}`}
                  >
                    السعر شامل الضريبة
                  </button>
                  <button
                    type="button"
                    onClick={() => setTaxIncluded(false)}
                    className={`h-10 rounded-md text-sm font-black ${!taxIncluded ? "bg-white text-primary shadow-sm" : "text-muted"}`}
                  >
                    الضريبة تضاف عند البيع
                  </button>
                </div>
              </div>
            </div>
          </section>

          <section className={showAdvanced ? "" : "hidden"}>
            <div className="mb-3 flex items-center gap-2">
              <Building2 className="h-4 w-4 text-primary" />
              <h3 className="text-sm font-black text-foreground">التشغيل والصلاحيات</h3>
            </div>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
              <Toggle checked={isActive} onChange={setIsActive} label="منتج فعّال" hint="يدخل في العمليات والتقارير" />
              <Toggle checked={showInPos} onChange={setShowInPos} label="يظهر في نقطة البيع" hint="يظهر ضمن الأصناف السريعة والبحث" />
              <Toggle checked={isSellable} onChange={setIsSellable} label="قابل للبيع" hint="يسمح بإضافته إلى الفاتورة" />
              <Toggle checked={isPurchasable} onChange={setIsPurchasable} label="قابل للشراء" hint="يظهر في أوامر الشراء" />
              <Toggle checked={allowPriceChange} onChange={setAllowPriceChange} label="سعر مفتوح" hint="يسمح بتعديل السعر وفق الصلاحية" />
            </div>
          </section>

          <section>
            <div className="mb-3 flex items-center gap-2">
              <Zap className="h-4 w-4 text-primary" />
              <h3 className="text-sm font-black text-foreground">إضافة سريعة</h3>
            </div>
            <Toggle checked={isQuickKey} onChange={setIsQuickKey} label="صنف سريع" hint="يظهر في شريط الأصناف السريعة في نقطة البيع — يمكن إضافته بنقرة واحدة" />
          </section>

          <section className="border-t border-border pt-4">
            <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h3 className="text-sm font-black text-foreground">الباركود والسعر</h3>
              </div>
              <button
                type="button"
                onClick={() => setRows((current) => [...current, emptyRow()])}
                className="flex h-10 items-center justify-center gap-1.5 rounded-lg bg-primary px-4 text-sm font-black text-primary-foreground"
              >
                <Plus className="h-4 w-4" /> إضافة باركود / وحدة
              </button>
            </div>

            <div className="space-y-3">
              {rows.map((row, index) => (
                <div key={row.key} className="rounded-lg border border-border bg-white p-3">
                  <div className="mb-3 flex items-center justify-between gap-2">
                    <span className="text-xs font-black text-muted">باركود / وحدة {index + 1}</span>
                    <button
                      type="button"
                      aria-label="حذف الوحدة"
                      onClick={() => removeRow(row.key)}
                      disabled={rows.length === 1}
                      className="grid h-8 w-8 place-items-center rounded-lg text-destructive hover:bg-destructive/10 disabled:opacity-30"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                  <div className={`grid gap-3 sm:grid-cols-2 ${showAdvanced ? "lg:grid-cols-4 xl:grid-cols-6" : "lg:grid-cols-5"}`}>
                    <div className="lg:col-span-2">
                      <span className="text-xs font-bold text-muted">الباركود</span>
                      <div className="mt-1.5 flex items-center gap-1.5">
                        <input
                          value={row.barcode}
                          onChange={(event) => updateRow(row.key, { barcode: event.target.value })}
                          dir="ltr"
                          className={`w-full rounded-lg border bg-white px-3 py-2.5 text-sm font-bold tabular-nums outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20 ${
                            rowErrors[row.key]?.barcode === "warn"
                              ? "border-amber-400 bg-amber-50/50"
                              : "border-border"
                          }`}
                        />
                        <button
                          type="button"
                          onClick={() => void generateBarcode(row)}
                          disabled={Boolean(generatingKey)}
                          title="توليد باركود فريد تلقائياً"
                          className="flex h-[42px] shrink-0 items-center gap-1.5 rounded-lg border border-primary/30 bg-primary/5 px-2.5 text-xs font-black text-primary transition hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          <RefreshCw className={`h-4 w-4 ${generatingKey === row.key ? "animate-spin" : ""}`} />
                          {generatingKey === row.key ? "جارٍ..." : "توليد"}
                        </button>
                      </div>
                      {rowErrors[row.key]?.barcode === "warn" && (
                        <p className="mt-1 text-[11px] font-bold text-amber-600">
                          أدخل أو ولّد باركوداً — وإلا لن يُحفظ هذا الصف
                        </p>
                      )}
                    </div>

                    <label className="text-xs font-bold text-muted">
                      تمييز الباركود
                      <input
                        value={row.variantLabel}
                        onChange={(event) => updateRow(row.key, { variantLabel: event.target.value })}
                        placeholder="اختياري، مثال: ليمون / أزرق / كبير"
                        className={fieldClass}
                      />
                    </label>

                    <label className="text-xs font-bold text-muted">
                      سعر التكلفة <span className="text-destructive">*</span>
                      <input
                        value={row.costPrice}
                        onChange={(event) => updateRow(row.key, { costPrice: event.target.value })}
                        inputMode="decimal"
                        dir="ltr"
                        className={`${fieldClass} tabular-nums ${rowErrors[row.key]?.costPrice ? "border-destructive focus:border-destructive focus:ring-destructive/20" : ""}`}
                      />
                      {rowErrors[row.key]?.costPrice && (
                        <span className="mt-1 block text-[11px] font-bold text-destructive">أدخل تكلفة أكبر من صفر</span>
                      )}
                    </label>

                    <label className="text-xs font-bold text-muted">
                      سعر البيع {!allowPriceChange && <span className="text-destructive">*</span>}
                      <input
                        value={row.price}
                        onChange={(event) => updateRow(row.key, { price: event.target.value })}
                        inputMode="decimal"
                        dir="ltr"
                        className={`${fieldClass} tabular-nums ${rowErrors[row.key]?.price ? "border-destructive focus:border-destructive focus:ring-destructive/20" : ""}`}
                      />
                      {rowErrors[row.key]?.price && (
                        <span className="mt-1 block text-[11px] font-bold text-destructive">أدخل سعر بيع أكبر من صفر</span>
                      )}
                    </label>

                    <label className={showAdvanced ? "text-xs font-bold text-muted" : "hidden"}>
                      سعر الجملة
                      <input
                        value={row.wholesalePrice}
                        onChange={(event) => updateRow(row.key, { wholesalePrice: event.target.value })}
                        inputMode="decimal"
                        dir="ltr"
                        className={`${fieldClass} tabular-nums`}
                      />
                    </label>

                    <label className={showAdvanced ? "flex cursor-pointer items-center gap-2 self-end pb-2 text-xs font-black text-foreground" : "hidden"}>
                      <input
                        type="radio"
                        name="default-sale"
                        checked={row.isDefaultSale}
                        onChange={() => setDefault(row.key)}
                        className="h-4 w-4 accent-primary"
                      />
                      ما يظهر للكاشير افتراضياً
                    </label>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>

        <footer className="flex flex-col-reverse gap-2 border-t border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-end sm:px-6">
          {saveError && (
            <p className="sm:ml-auto rounded-lg bg-destructive/10 px-3 py-2 text-sm font-bold text-destructive">
              {saveError}
            </p>
          )}
          {!saveError && validationMessage && (
            <p className="sm:ml-auto rounded-lg bg-destructive/10 px-3 py-2 text-xs font-bold text-destructive">
              {validationMessage}
            </p>
          )}
          <button
            type="button"
            onClick={handleCloseAttempt}
            disabled={saving}
            className="h-11 rounded-lg border border-border bg-white px-5 text-sm font-black text-muted"
          >
            إلغاء
          </button>
          {!initial && (
            <button
              type="button"
              onClick={() => void handleSave(true)}
              disabled={!canSave || saving}
              className="flex h-11 items-center justify-center gap-2 rounded-lg border border-success bg-success/5 px-5 text-sm font-black text-success disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Plus className="h-4 w-4" />
              {saving ? "جارٍ الحفظ..." : "حفظ وإضافة التالي"}
            </button>
          )}
          <button
            type="button"
            onClick={() => void handleSave(false)}
            disabled={!canSave || saving}
            className="flex h-11 items-center justify-center gap-2 rounded-lg bg-success px-6 text-sm font-black text-success-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Save className={`h-4 w-4 ${saving ? "animate-pulse" : ""}`} />
            {saving ? "جارٍ الحفظ..." : initial ? "حفظ التعديل" : "حفظ وإنهاء"}
          </button>
        </footer>
      </div>

      {quickCreate && (
        <QuickCreateEntityModal
          title={
            quickCreate.type === "category"
              ? "إضافة مسار جديد للكاشير"
              : quickCreate.type === "brand"
                ? "إضافة علامة تجارية"
                : "إضافة مورد"
          }
          nameLabel={
            quickCreate.type === "supplier"
              ? "اسم المورد"
              : quickCreate.type === "category"
                ? "اسم المسار"
                : "اسم العلامة التجارية"
          }
          namePlaceholder={
            quickCreate.type === "supplier"
              ? "مثال: شركة الأمانة"
              : quickCreate.type === "category"
                ? "مثال: منظفات المطبخ"
                : "مثال: نستله"
          }
          withPhone={quickCreate.type === "supplier"}
          initialName={quickCreate.initialName ?? ""}
          parentOptions={quickCreate.type === "category" ? referenceOptions.categories : undefined}
          parentLabel={quickCreate.type === "category" ? "يظهر تحت أي مسار؟" : undefined}
          parentPlaceholder={quickCreate.type === "category" ? "يظهر مباشرة في الشاشة الأولى" : undefined}
          parentInitialValue={quickCreate.type === "category" ? categoryId : ""}
          parentHint={
            quickCreate.type === "category"
              ? "اختياري. اتركه فارغاً إذا كان هذا مساراً رئيسياً، أو اختر مساراً أب إذا كان هذا فرعاً داخله."
              : undefined
          }
          onClose={() => setQuickCreate(null)}
          onCreate={async (data) => {
            const created = await onCreateReference(quickCreate.type, data);
            if (quickCreate.type === "category") setCategoryId(created.id);
            else if (quickCreate.type === "brand") setBrandId(created.id);
            else setSupplierId(created.id);
            setQuickCreate(null);
          }}
        />
      )}
    </div>
  );
}
