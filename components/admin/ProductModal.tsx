"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Barcode,
  Building2,
  Boxes,
  Grid3x3,
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
import { getTenantStoreId } from "@/lib/tenantClient";

export interface InventoryVariant {
  id: string;
  barcode: string;
  variantLabel: string;
  costPrice: number;
  price: number;
  wholesalePrice: number;
  isDefaultSale: boolean;
  /** Opening stock for this barcode at creation (create mode only). */
  stock?: number;
}

/**
 * Packaging/UoM row defined inside the product flow (Tier 3.5
 * `product_units`). The inventory page persists these AFTER the product
 * itself is saved, so the modal stays a pure form.
 */
export interface ProductUnitInput {
  id?: string;
  name: string;
  qtyMultiplier: number;
  barcode: string;
  wholesalePrice: number;
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
  /** Packaging rows to upsert after the product save resolves. */
  units?: ProductUnitInput[];
  /** Pre-existing unit ids the user removed in this session. */
  deletedUnitIds?: string[];
};

interface RowDraft {
  key: string;
  barcode: string;
  variantLabel: string;
  stock: string;
  isDefaultSale: boolean;
}

/** Inline packaging/UoM row (carton etc.). */
interface UnitRowDraft {
  key: string;
  id?: string;
  name: string;
  multiplier: string;
  barcode: string;
  wholesalePrice: string;
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
  stock: "",
  isDefaultSale: isFirst,
});

// Variant rows inherit the product-level base pricing — per-row prices are
// intentionally gone (QA redesign: colors of one product share cost/price).
const toRow = (variant: InventoryVariant): RowDraft => ({
  key: variant.id,
  barcode: variant.barcode,
  variantLabel: variant.variantLabel,
  stock: variant.stock != null ? String(variant.stock) : "",
  isDefaultSale: variant.isDefaultSale,
});

const emptyUnitRow = (): UnitRowDraft => ({
  key: freshKey(),
  name: "",
  multiplier: "",
  barcode: "",
  wholesalePrice: "",
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
  // ── Base pricing (QA redesign): ONE cost/price for the whole product.
  // Variant rows inherit these automatically; edit mode seeds from row 1.
  const firstVariant = initial?.variants[0];
  const [baseCost, setBaseCost] = useState(firstVariant ? String(firstVariant.costPrice) : "");
  const [basePrice, setBasePrice] = useState(firstVariant ? String(firstVariant.price) : "");
  const [baseWholesale, setBaseWholesale] = useState(
    firstVariant ? String(firstVariant.wholesalePrice ?? 0) : "",
  );
  // ── Packaging & Units (التعبئة والوحدات): carton-style rows defined in the
  // same flow. Edit mode preloads existing product_units for in-place editing.
  const [unitRows, setUnitRows] = useState<UnitRowDraft[]>([]);
  const originalUnitIdsRef = useRef<string[]>([]);
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
      baseCost,
      basePrice,
      baseWholesale,
      rows: initial?.variants.length ? initial.variants.map(toRow) : [emptyRow(true)],
      unitRows: [] as UnitRowDraft[],
    });
  }
  const currentSnapshot = JSON.stringify({ name, categoryId, brandId, supplierId, baseUnit, stock, reorderLevel, taxPercent, taxIncluded, isActive, showInPos, isSellable, isPurchasable, allowPriceChange, isQuickKey, baseCost, basePrice, baseWholesale, rows, unitRows });
  const isDirty = currentSnapshot !== initialSnapshotRef.current;

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  // Edit mode: preload existing packaging units so they can be edited or
  // removed inline. setState happens only inside async callbacks so the
  // effect body itself never cascades renders.
  useEffect(() => {
    if (!initial) return;
    let cancelled = false;
    const storeId = getTenantStoreId();
    if (!storeId || !initial.id) return;
    void import("@/lib/productUnitsClient")
      .then(({ fetchProductUnits }) => fetchProductUnits(storeId, initial.id))
      .then((units) => {
        if (cancelled) return;
        originalUnitIdsRef.current = units.map((u) => u.id);
        setUnitRows(
          units.map((u) => ({
            key: u.id,
            id: u.id,
            name: u.unitName,
            multiplier: String(u.qtyMultiplier),
            barcode: u.barcode ?? "",
            wholesalePrice: String(u.wholesalePrice ?? 0),
          })),
        );
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [initial]);

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

  /* ── Packaging & Units (التعبئة والوحدات) ───────────────────────────── */
  const updateUnitRow = (key: string, patch: Partial<UnitRowDraft>) =>
    setUnitRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  const removeUnitRow = (key: string) =>
    setUnitRows((current) => current.filter((row) => row.key !== key));

  const [unitGeneratingKey, setUnitGeneratingKey] = useState<string | null>(null);

  const generateUnitBarcode = async (key: string) => {
    setUnitGeneratingKey(key);
    setSaveError(null);
    try {
      const { generateEan13 } = await import("@/lib/inventoryClient");
      const used = new Set<string>([
        ...rows.map((row) => row.barcode.trim()).filter(Boolean),
        ...unitRows.map((row) => row.barcode.trim()).filter(Boolean),
      ]);
      let candidate = generateEan13();
      for (let attempt = 0; attempt < 5 && used.has(candidate); attempt++) {
        candidate = generateEan13();
      }
      updateUnitRow(key, { barcode: candidate });
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "تعذر توليد الباركود");
    } finally {
      setUnitGeneratingKey(null);
    }
  };

  const addQuickCarton = () => {
    const next: UnitRowDraft = { ...emptyUnitRow(), name: "كرتون", multiplier: "" };
    setUnitRows((current) => [...current, next]);
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

  /* ── Phase 4: Variant Matrix Generator ──────────────────────────────── */
  // One attribute list (colors) or a cartesian product of two (color ×
  // size) becomes variant rows with unique generated barcodes. Pricing is
  // inherited from the product-level base — no per-row price entry.
  const MAX_MATRIX_VARIANTS = 30;

  const [matrixOpen, setMatrixOpen] = useState(false);
  const [matrixDim1, setMatrixDim1] = useState("");
  const [matrixDim2, setMatrixDim2] = useState("");
  const [matrixBusy, setMatrixBusy] = useState(false);

  const parseDims = (raw: string): string[] =>
    raw.split(/[,،\n]/).map((v) => v.trim()).filter(Boolean).slice(0, 30);

  const generateMatrix = async () => {
    const dim1 = parseDims(matrixDim1);
    const dim2 = parseDims(matrixDim2);
    if (dim1.length === 0 && dim2.length === 0) {
      setSaveError("أدخل قيمة واحدة على الأقل (مثال: أحمر، أزرق، أسود)");
      return;
    }
    const combos: string[] = [];
    if (dim1.length > 0 && dim2.length > 0) {
      for (const a of dim1) for (const b of dim2) combos.push(`${a} - ${b}`);
    } else {
      combos.push(...(dim1.length > 0 ? dim1 : dim2));
    }

    const existingLabels = new Set(rows.map((row) => row.variantLabel.trim()));
    const room = Math.max(0, MAX_MATRIX_VARIANTS - rows.length);
    const fresh = combos.filter((c) => !existingLabels.has(c)).slice(0, room);
    if (fresh.length === 0) {
      setSaveError("كل التوليفات موجودة مسبقاً أو تم بلوغ الحد الأقصى للوحدات");
      return;
    }

    setMatrixBusy(true);
    setSaveError(null);
    try {
      const { generateEan13 } = await import("@/lib/inventoryClient");
      const usedBarcodes = new Set(rows.map((row) => row.barcode.trim()).filter(Boolean));
      const stamp = Date.now().toString(36);
      const generated: RowDraft[] = fresh.map((label, i) => {
        let barcode = generateEan13();
        while (usedBarcodes.has(barcode)) barcode = generateEan13();
        usedBarcodes.add(barcode);
        return {
          key: `${stamp}-${i}`,
          barcode,
          variantLabel: label,
          stock: "",
          isDefaultSale: false,
        };
      });
      setRows((current) => [...current, ...generated]);
      setMatrixOpen(false);
      setMatrixDim1("");
      setMatrixDim2("");
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "تعذر توليد الوحدات");
    } finally {
      setMatrixBusy(false);
    }
  };

  const validRows = rows.filter((row) => row.barcode.trim().length > 0);
  const taxValue = Number(taxPercent);
  const baseCostValue = Number(baseCost);
  const basePriceValue = Number(basePrice);
  const baseWholesaleValue = Number(baseWholesale);
  // Base pricing validates ONCE at product level — rows inherit it.
  const pricesValid =
    Number.isFinite(baseCostValue) &&
    baseCostValue > 0 &&
    (allowPriceChange || (Number.isFinite(basePriceValue) && basePriceValue > 0));
  const taxValid = Number.isFinite(taxValue) && taxValue >= 0 && taxValue <= 100;
  const canSave =
    name.trim().length > 0 &&
    validRows.length > 0 &&
    pricesValid &&
    taxValid;

  // Per-row validation: red = blocks save, amber = row will be silently dropped
  // from the payload (no barcode) — surface it so the user doesn't lose data.
  const rowErrors = useMemo(() => {
    const map: Record<string, { barcode?: "warn" | "error" }> = {};
    for (const row of rows) {
      const hasBarcode = row.barcode.trim().length > 0;
      if (!hasBarcode && (row.stock.trim() || row.variantLabel.trim())) {
        map[row.key] = { barcode: "warn" };
      }
    }
    return map;
  }, [rows]);

  const validationMessage = (() => {
    if (name.trim().length === 0) return "أدخل اسم المنتج";
    if (!(Number.isFinite(baseCostValue) && baseCostValue > 0))
      return "أدخل سعر تكلفة أساسي صحيحاً أكبر من صفر";
    if (!allowPriceChange && !(Number.isFinite(basePriceValue) && basePriceValue > 0))
      return "أدخل سعر بيع أساسياً أكبر من صفر";
    if (validRows.length === 0) return "امسح الباركود أو ولّد باركوداً واحداً على الأقل";
    if (!taxValid) return "نسبة الضريبة يجب أن تكون بين 0 و 100";
    return null;
  })();

  const handleCloseAttempt = () => {
    if (saving) return;
    if (isDirty && !window.confirm("لديك تعديلات غير محفوظة. هل تريد الإغلاق دون حفظ؟")) return;
    onClose();
  };

  const round2 = (value: number): number => Math.max(0, Math.round(value * 100) / 100);

  const formatUnitMath = (multiplier: number, pieceWholesale: number): string =>
    pieceWholesale > 0
      ? `عبوة تحتوي ${multiplier} — بسعر الجملة الأساسي تعادل تقديرياً ${round2(multiplier * pieceWholesale)}`
      : `عبوة تحتوي ${multiplier} من وحدة الأساس`;

  const handleSave = async (addAnother: boolean) => {
    if (!canSave) return;
    // Every variant inherits the product-level base pricing; only barcode,
    // color label and opening stock are per-row.
    const inheritedWholesale = Number.isFinite(baseWholesaleValue) ? baseWholesaleValue : 0;
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
        costPrice: round2(baseCostValue),
        price: round2(basePriceValue),
        wholesalePrice: round2(inheritedWholesale),
        isDefaultSale: row.isDefaultSale,
        stock: Math.max(0, Number(row.stock) || 0),
      })),
      units: unitRows
        .filter((unit) => unit.name.trim().length > 0 && (Number(unit.multiplier) || 0) > 0)
        .map((unit) => ({
          id: unit.id,
          name: unit.name.trim().slice(0, 60),
          qtyMultiplier: Number(unit.multiplier) || 1,
          barcode: unit.barcode.trim(),
          wholesalePrice: round2(Number(unit.wholesalePrice) || 0),
        })),
      deletedUnitIds: originalUnitIdsRef.current.filter(
        (id) => !unitRows.some((unit) => unit.id === id),
      ),
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
                <p className="mt-0.5 text-xs font-semibold text-muted">
                  حدّد التسعير الأساسي مرة واحدة — كل الألوان/الوحدات أدناه ترثه تلقائياً.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setRows((current) => [...current, emptyRow()])}
                className="flex h-10 items-center justify-center gap-1.5 rounded-lg bg-primary px-4 text-sm font-black text-primary-foreground"
              >
                <Plus className="h-4 w-4" /> إضافة باركود / وحدة
              </button>
            </div>

            {/* ── Base pricing (inherited by every variant row) ── */}
            <div className="mb-4 rounded-lg border border-primary/25 bg-primary/5 p-3">
              <div className="grid gap-3 sm:grid-cols-3">
                <label className="text-xs font-bold text-muted">
                  التكلفة الأساسية <span className="text-destructive">*</span>
                  <input
                    value={baseCost}
                    onChange={(event) => setBaseCost(event.target.value)}
                    inputMode="decimal"
                    dir="ltr"
                    placeholder="0.00"
                    className={`${fieldClass} mt-1 tabular-nums`}
                  />
                </label>
                <label className="text-xs font-bold text-muted">
                  سعر البيع الأساسي {!allowPriceChange && <span className="text-destructive">*</span>}
                  <input
                    value={basePrice}
                    onChange={(event) => setBasePrice(event.target.value)}
                    inputMode="decimal"
                    dir="ltr"
                    placeholder="0.00"
                    className={`${fieldClass} mt-1 tabular-nums`}
                  />
                </label>
                <label className={showAdvanced ? "text-xs font-bold text-muted" : "hidden"}>
                  سعر الجملة الأساسي
                  <input
                    value={baseWholesale}
                    onChange={(event) => setBaseWholesale(event.target.value)}
                    inputMode="decimal"
                    dir="ltr"
                    placeholder="0.00"
                    className={`${fieldClass} mt-1 tabular-nums`}
                  />
                </label>
              </div>
            </div>

            {/* ── Variant Matrix Generator (Phase 4) ── */}
            {matrixOpen ? (
              <div className="mb-3 rounded-lg border border-primary/30 bg-primary/5 p-3">
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="text-xs font-bold text-muted">
                    البعد الأول (مفصولة بفاصلة)
                    <input
                      value={matrixDim1}
                      onChange={(event) => setMatrixDim1(event.target.value)}
                      placeholder="أحمر، أزرق، أسود"
                      autoFocus
                      className={`${fieldClass} mt-1`}
                    />
                  </label>
                  <label className="text-xs font-bold text-muted">
                    البعد الثاني — اختياري
                    <input
                      value={matrixDim2}
                      onChange={(event) => setMatrixDim2(event.target.value)}
                      placeholder="كبير، وسط، صغير"
                      className={`${fieldClass} mt-1`}
                    />
                  </label>
                </div>
                <p className="mt-1.5 text-[11px] font-bold text-muted">
                  يولّد صفّاً لكل قيمة (أو كل تقاطع بين البعدين) مع باركود فريد وأسعار منسوخة من أول صف مُسعّر.
                </p>
                <div className="mt-2 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void generateMatrix()}
                    disabled={matrixBusy}
                    className="flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-black text-primary-foreground transition hover:bg-primary-hover disabled:opacity-40"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${matrixBusy ? "animate-spin" : ""}`} />
                    توليد الوحدات
                  </button>
                  <button
                    type="button"
                    onClick={() => { setMatrixOpen(false); setSaveError(null); }}
                    className="flex h-9 items-center rounded-lg border border-border bg-white px-3 text-xs font-black text-muted transition hover:text-foreground"
                  >
                    إلغاء
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setMatrixOpen(true)}
                className="mb-3 flex h-9 w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-primary/40 bg-primary/5 text-xs font-black text-primary transition hover:bg-primary/10"
              >
                <Grid3x3 className="h-4 w-4" />
                توليد مصفوفة وحدات (ألوان / مقاسات) دفعة واحدة
              </button>
            )}

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
                      تمييز الباركود (اللون)
                      <input
                        value={row.variantLabel}
                        onChange={(event) => updateRow(row.key, { variantLabel: event.target.value })}
                        placeholder="اختياري، مثال: ليمون / أزرق / كبير"
                        className={fieldClass}
                      />
                    </label>

                    {!initial && (
                      <label className="text-xs font-bold text-muted">
                        المخزون الافتتاحي
                        <input
                          value={row.stock}
                          onChange={(event) => updateRow(row.key, { stock: event.target.value })}
                          inputMode="decimal"
                          dir="ltr"
                          placeholder="0"
                          className={`${fieldClass} tabular-nums`}
                        />
                      </label>
                    )}

                    <div className="flex items-end pb-2">
                      <span className="w-full rounded-lg border border-border bg-surface-muted px-3 py-2 text-[11px] font-bold leading-4 text-muted">
                        يرث التسعير الأساسي: تكلفة {baseCost || "—"} · بيع {basePrice || "—"}
                        {showAdvanced && baseWholesale ? ` · جملة ${baseWholesale}` : ""}
                      </span>
                    </div>

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

          {/* ── Packaging & Units (التعبئة والوحدات) ── */}
          <section className="border-t border-border pt-4">
            <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h3 className="flex items-center gap-2 text-sm font-black text-foreground">
                  <Boxes className="h-4 w-4 text-primary" />
                  التعبئة والوحدات
                </h3>
                <p className="mt-0.5 text-xs font-semibold text-muted">
                  عرّف الكرتون ومعامل التحويل (مثال: كرتون = 12 حبة) مع باركوده وسعر جملته — يُحسب المخزون دائماً بوحدة الأساس.
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={addQuickCarton}
                  className="flex h-10 items-center justify-center gap-1.5 rounded-lg border border-primary/30 bg-primary/5 px-3 text-xs font-black text-primary transition hover:bg-primary/10"
                >
                  <Plus className="h-4 w-4" /> كرتون سريع
                </button>
                <button
                  type="button"
                  onClick={() => setUnitRows((current) => [...current, emptyUnitRow()])}
                  className="flex h-10 items-center justify-center gap-1.5 rounded-lg bg-primary px-4 text-sm font-black text-primary-foreground"
                >
                  <Plus className="h-4 w-4" /> إضافة وحدة تعبئة
                </button>
              </div>
            </div>

            {unitRows.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-xs font-bold text-muted">
                لا توجد وحدات تعبئة — أضف كرتوناً إذا كنت تبيع بالجملة أو بتعبئات.
              </p>
            ) : (
              <div className="space-y-3">
                {unitRows.map((unit, index) => (
                  <div key={unit.key} className="rounded-lg border border-border bg-white p-3">
                    <div className="mb-3 flex items-center justify-between gap-2">
                      <span className="text-xs font-black text-muted">وحدة تعبئة {index + 1}</span>
                      <button
                        type="button"
                        aria-label="حذف وحدة التعبئة"
                        onClick={() => removeUnitRow(unit.key)}
                        className="grid h-8 w-8 place-items-center rounded-lg text-destructive hover:bg-destructive/10"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                      <label className="lg:col-span-1 text-xs font-bold text-muted">
                        اسم الوحدة
                        <input
                          value={unit.name}
                          onChange={(event) => updateUnitRow(unit.key, { name: event.target.value })}
                          placeholder="كرتون / علبة / درزن"
                          className={fieldClass}
                        />
                      </label>
                      <label className="text-xs font-bold text-muted">
                        تحتوي على (وحدة أساس)
                        <input
                          value={unit.multiplier}
                          onChange={(event) => updateUnitRow(unit.key, { multiplier: event.target.value })}
                          inputMode="decimal"
                          dir="ltr"
                          placeholder="12"
                          className={`${fieldClass} tabular-nums`}
                        />
                      </label>
                      <label className="text-xs font-bold text-muted">
                        الباركود
                        <input
                          value={unit.barcode}
                          onChange={(event) => updateUnitRow(unit.key, { barcode: event.target.value })}
                          dir="ltr"
                          className={`${fieldClass} tabular-nums`}
                        />
                      </label>
                      <div className="flex items-end gap-1.5 pb-0.5">
                        <button
                          type="button"
                          onClick={() => void generateUnitBarcode(unit.key)}
                          disabled={Boolean(unitGeneratingKey)}
                          title="توليد باركود فريد تلقائياً"
                          className="flex h-[42px] w-full items-center justify-center gap-1.5 rounded-lg border border-primary/30 bg-primary/5 px-2.5 text-xs font-black text-primary transition hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          <RefreshCw className={`h-4 w-4 ${unitGeneratingKey === unit.key ? "animate-spin" : ""}`} />
                          {unitGeneratingKey === unit.key ? "جارٍ..." : "توليد"}
                        </button>
                      </div>
                      <label className="text-xs font-bold text-muted">
                        سعر جملة الوحدة
                        <input
                          value={unit.wholesalePrice}
                          onChange={(event) => updateUnitRow(unit.key, { wholesalePrice: event.target.value })}
                          inputMode="decimal"
                          dir="ltr"
                          placeholder="0.00"
                          className={`${fieldClass} tabular-nums`}
                        />
                      </label>
                    </div>
                    {Number(unit.multiplier) > 0 && Number(baseWholesaleValue) >= 0 && (
                      <p className="mt-2 text-[11px] font-semibold text-muted">
                        بيع الكرتون بسعر الجملة الأساسي يعادل {formatUnitMath(Number(unit.multiplier), baseWholesaleValue)}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
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
