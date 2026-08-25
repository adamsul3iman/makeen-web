"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader, PackageOpen, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { ModalShell } from "@/components/ui/ModalShell";
import {
  deleteProductUnit,
  fetchProductUnits,
  saveProductUnit,
  type ProductUnitRow,
} from "@/lib/productUnitsClient";
import { formatMoney } from "@/lib/format";

/**
 * Phase 4 (UoM setup): manage the packaging tiers of ONE parent product —
 * قطعة / كرتون / دستة … Each tier carries its own qty multiplier (pieces
 * per carton), carton retail/wholesale price and an optional dedicated
 * barcode. Stock is never edited here: variants keep owning inventory.
 */

interface UnitDraft {
  key: string;
  id: string;
  unitName: string;
  qtyMultiplier: string;
  costPrice: string;
  sellingPrice: string;
  wholesalePrice: string;
  barcode: string;
  isDefaultSale: boolean;
  isActive: boolean;
}

const fieldClass =
  "h-10 w-full rounded-lg border border-border bg-white px-2 text-left text-sm font-bold tabular-nums outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20";

let draftSeq = 0;
const nextKey = () => `u${++draftSeq}-${Date.now().toString(36)}`;

function toDraft(row: ProductUnitRow): UnitDraft {
  return {
    key: nextKey(),
    id: row.id,
    unitName: row.unitName,
    qtyMultiplier: String(row.qtyMultiplier),
    costPrice: String(row.costPrice),
    sellingPrice: String(row.sellingPrice),
    wholesalePrice: String(row.wholesalePrice),
    barcode: row.barcode ?? "",
    isDefaultSale: row.isDefaultSale,
    isActive: row.isActive,
  };
}

export default function UnitsEditorModal({
  productId,
  productName,
  baseUnit,
  storeId,
  onClose,
  onSaved,
}: {
  productId: string;
  productName: string;
  baseUnit: string;
  storeId: string;
  onClose: () => void;
  /** Called after units are successfully saved so the parent can trigger a
   *  catalog refresh (hydrateCatalog) on the same tab — BroadcastChannel
   *  only notifies *other* tabs, not the writer. */
  onSaved?: () => void;
}) {
  const [rows, setRows] = useState<UnitDraft[]>([]);
  const [deletedIds, setDeletedIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedOnce, setSavedOnce] = useState(false);

  // Event-handler refresh (used after saving); never invoked from render.
  const reload = useCallback(async () => {
    try {
      const units = await fetchProductUnits(storeId, productId);
      setRows(units.length > 0 ? units.map(toDraft) : []);
      setDeletedIds([]);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "تعذر تحميل الوحدات");
    }
  }, [storeId, productId]);

  // Mount fetch: setState only inside async callbacks so the effect body
  // itself never cascades renders (react-hooks/set-state-in-effect).
  useEffect(() => {
    let cancelled = false;
    fetchProductUnits(storeId, productId)
      .then((units) => {
        if (cancelled) return;
        setRows(units.length > 0 ? units.map(toDraft) : []);
        setDeletedIds([]);
        setError(null);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "تعذر تحميل الوحدات");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [storeId, productId]);

  const updateRow = (key: string, patch: Partial<UnitDraft>) =>
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  // Radio semantics: exactly one default sale unit.
  const setDefaultSale = (key: string) =>
    setRows((current) => current.map((row) => ({ ...row, isDefaultSale: row.key === key })));

  const removeRow = (key: string) => {
    setRows((current) => {
      const target = current.find((row) => row.key === key);
      if (!target) return current;
      if (target.id) setDeletedIds((ids) => [...ids, target.id]);
      const next = current.filter((row) => row.key !== key);
      if (next.length > 0 && target.isDefaultSale && !next.some((r) => r.isDefaultSale)) {
        next[0] = { ...next[0], isDefaultSale: true };
      }
      return next;
    });
  };

  const addRow = () =>
    setRows((current) => [
      ...current,
      {
        key: nextKey(),
        id: "",
        unitName: "",
        qtyMultiplier: "12",
        costPrice: "",
        sellingPrice: "",
        wholesalePrice: "",
        barcode: "",
        isDefaultSale: current.length === 0,
        isActive: true,
      },
    ]);

  const handleSave = async () => {
    if (saving) return;
    const valid = rows.filter((row) => row.unitName.trim());
    if (valid.length === 0) {
      setError("أضف وحدة واحدة على الأقل مع اسمها");
      return;
    }
    if (!valid.some((row) => row.isDefaultSale)) {
      setError("حدّد وحدة البيع الافتراضية");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      let order = 0;
      for (const row of valid) {
        await saveProductUnit(storeId, {
          id: row.id,
          productId,
          unitName: row.unitName,
          qtyMultiplier: Number(row.qtyMultiplier) || 1,
          costPrice: Number(row.costPrice) || 0,
          sellingPrice: Number(row.sellingPrice) || 0,
          wholesalePrice: Number(row.wholesalePrice) || 0,
          barcode: row.barcode.trim() || null,
          isDefaultSale: row.isDefaultSale,
          isActive: row.isActive,
          sortOrder: order++,
        });
      }
      for (const id of deletedIds) {
        await deleteProductUnit(storeId, id);
      }
      await reload();
      setSavedOnce(true);
      setTimeout(() => setSavedOnce(false), 2500);
      onSaved?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "تعذر حفظ الوحدات");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell
      title={`وحدات التغليف — ${productName}`}
      onClose={onClose}
      size="lg"
      height="lg"
      bodyClassName="px-4 py-3"
      footer={
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleSave}
            disabled={loading || saving}
            className="flex h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-success text-sm font-black text-success-foreground transition hover:bg-success-hover disabled:opacity-40"
          >
            {saving ? <Loader className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {saving ? "جارٍ الحفظ…" : savedOnce ? "تم الحفظ ✓" : "حفظ الوحدات"}
          </button>
          <button
            type="button"
            onClick={addRow}
            disabled={saving}
            className="flex h-11 items-center justify-center gap-1.5 rounded-xl border border-primary/30 bg-primary/5 px-3 text-xs font-black text-primary transition hover:bg-primary/10 disabled:opacity-40"
          >
            <Plus className="h-4 w-4" />
            وحدة جديدة
          </button>
        </div>
      }
    >
      <p className="mb-3 rounded-xl bg-surface-muted px-3 py-2 text-xs font-bold text-muted">
        الوحدة الأساسية هي <span className="font-black text-foreground">{baseUnit || "القطعة"}</span> (معامل 1).
        أضف الكرتون بمعامل عدد القطع فيه وسعره الخاص — البيع بالكرتون يخصم القطع من المخزون تلقائياً.
      </p>

      {error && (
        <div className="mb-3 flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-xs font-black text-destructive">
          <span className="flex-1">{error}</span>
          <button type="button" aria-label="إغلاق" onClick={() => setError(null)} className="opacity-70 hover:opacity-100">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {loading ? (
        <div className="flex flex-col items-center gap-2 py-10">
          <Loader className="h-6 w-6 animate-spin text-primary" />
          <p className="text-sm font-bold text-muted">جارٍ تحميل الوحدات…</p>
        </div>
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border py-8 text-center">
          <PackageOpen className="h-8 w-8 text-slate-300" />
          <p className="text-sm font-black text-muted">لا توجد وحدات محفوظة</p>
          <p className="text-xs font-semibold text-muted">أضف الكرتون ليظهر في نقطة البيع والاستلام</p>
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((row) => (
            <div key={row.key} className="rounded-xl border border-border bg-white p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <label className="flex cursor-pointer items-center gap-2 text-xs font-black text-foreground">
                  <input
                    type="radio"
                    name="units-default-sale"
                    checked={row.isDefaultSale}
                    onChange={() => setDefaultSale(row.key)}
                    className="h-4 w-4 accent-primary"
                  />
                  وحدة البيع الافتراضية
                </label>
                <div className="flex items-center gap-2">
                  <label className="flex cursor-pointer items-center gap-1.5 text-[11px] font-bold text-muted">
                    <input
                      type="checkbox"
                      checked={row.isActive}
                      onChange={(event) => updateRow(row.key, { isActive: event.target.checked })}
                      className="h-3.5 w-3.5 accent-primary"
                    />
                    فعّالة
                  </label>
                  <button
                    type="button"
                    aria-label="حذف الوحدة"
                    onClick={() => removeRow(row.key)}
                    className="grid h-8 w-8 place-items-center rounded-lg text-destructive transition hover:bg-destructive/10"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
                <label className="text-[11px] font-bold text-muted sm:col-span-2 lg:col-span-1">
                  اسم الوحدة *
                  <input
                    value={row.unitName}
                    onChange={(event) => updateRow(row.key, { unitName: event.target.value })}
                    placeholder="كرتون"
                    className={`${fieldClass} mt-1 text-right`}
                  />
                </label>
                <label className="text-[11px] font-bold text-muted">
                  عدد القطع * 
                  <input
                    value={row.qtyMultiplier}
                    onChange={(event) => updateRow(row.key, { qtyMultiplier: event.target.value })}
                    inputMode="decimal"
                    dir="ltr"
                    className={`${fieldClass} mt-1`}
                  />
                </label>
                <label className="text-[11px] font-bold text-muted">
                  سعر التكلفة
                  <input
                    value={row.costPrice}
                    onChange={(event) => updateRow(row.key, { costPrice: event.target.value })}
                    inputMode="decimal"
                    dir="ltr"
                    placeholder={formatMoney(0)}
                    className={`${fieldClass} mt-1`}
                  />
                </label>
                <label className="text-[11px] font-bold text-muted">
                  سعر بيع الكرتون
                  <input
                    value={row.sellingPrice}
                    onChange={(event) => updateRow(row.key, { sellingPrice: event.target.value })}
                    inputMode="decimal"
                    dir="ltr"
                    placeholder={formatMoney(0)}
                    className={`${fieldClass} mt-1`}
                  />
                </label>
                <label className="text-[11px] font-bold text-muted">
                  سعر الجملة
                  <input
                    value={row.wholesalePrice}
                    onChange={(event) => updateRow(row.key, { wholesalePrice: event.target.value })}
                    inputMode="decimal"
                    dir="ltr"
                    placeholder={formatMoney(0)}
                    className={`${fieldClass} mt-1`}
                  />
                </label>
              </div>
              <label className="mt-2 block text-[11px] font-bold text-muted">
                باركود الكرتون — اختياري (فريد على مستوى المتجر)
                <input
                  value={row.barcode}
                  onChange={(event) => updateRow(row.key, { barcode: event.target.value })}
                  dir="ltr"
                  placeholder="امسحه في POS ليبيع بالكرتون مباشرة"
                  className={`${fieldClass} mt-1 font-mono`}
                />
              </label>
            </div>
          ))}
        </div>
      )}
    </ModalShell>
  );
}
