"use client";

import { useCallback, useMemo, useState } from "react";
import { Package, Minus, Plus, ShoppingCart } from "lucide-react";
import { ModalShell } from "@/components/ui/ModalShell";
import { Button } from "@/components/ui/Button";
import { usePosStore } from "@/store/usePosStore";
import { formatMoney } from "@/lib/format";
import { breakdownStock, maxUnitsAvailable } from "@/lib/stockDisplay";

interface UnitOption {
  variantId: string;
  unitName: string;
  unitMultiplier: number;
  unitId?: string;
  unitPrice: number;
  totalStock: number;
}

const MAX_QTY = 999;

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

const unitKey = (u: { unitId?: string } | undefined): string => u?.unitId ?? "_base";

export default function VariantPickerModal() {
  const isOpen = usePosStore((s) => s.variantPickerProductId !== null);
  const productId = usePosStore((s) => s.variantPickerProductId);
  const products = usePosStore((s) => s.products);
  const productUnits = usePosStore((s) => s.productUnits);
  const barcodeIndex = usePosStore((s) => s.barcodeIndex);
  const closeVariantPicker = usePosStore((s) => s.closeVariantPicker);
  const addVariantMatrixItems = usePosStore((s) => s.addVariantMatrixItems);

  const product = productId ? products[productId] : undefined;
  const units = useMemo(
    () => (productId ? (productUnits[productId] ?? []) : []),
    [productId, productUnits],
  );

  // Flavor x unit matrix, grouped by variant so each flavor appears once.
  const matrix = useMemo<UnitOption[]>(() => {
    if (!productId || !product) return [];
    const seen = new Map<string, UnitOption>();
    for (const entry of Object.values(barcodeIndex)) {
      if (entry.product_id !== productId) continue;
      if (units.length > 0) {
        for (const u of units.filter((un) => un.isActive)) {
          const key = `${entry.variantId}:${u.id}`;
          if (seen.has(key)) continue;
          seen.set(key, {
            variantId: entry.variantId,
            unitName: u.unitName,
            unitMultiplier: u.qtyMultiplier,
            unitId: u.id,
            unitPrice: round2(u.sellingPrice),
            totalStock: entry.totalStock ?? 0,
          });
        }
      } else {
        const key = `${entry.variantId}:_base`;
        if (!seen.has(key)) {
          seen.set(key, {
            variantId: entry.variantId,
            unitName: product.baseUnit ?? "",
            unitMultiplier: 1,
            unitPrice: round2(product.price ?? 0),
            totalStock: entry.totalStock ?? 0,
          });
        }
      }
    }
    return Array.from(seen.values());
  }, [productId, product, barcodeIndex, units]);

  const [selectedUnits, setSelectedUnits] = useState<Record<string, string>>({});
  const [qtyDrafts, setQtyDrafts] = useState<Record<string, number>>({});

  const matrixMeta = useMemo(() => {
    const meta = new Map<string, { variantId: string; variantLabel: string }>();
    for (const entry of Object.values(barcodeIndex)) {
      if (entry.product_id !== productId) continue;
      if (!meta.has(entry.variantId)) {
        meta.set(entry.variantId, { variantId: entry.variantId, variantLabel: entry.variantLabel });
      }
    }
    return meta;
  }, [productId, barcodeIndex]);

  const rows = useMemo<Array<{ variantId: string; variantLabel: string; units: UnitOption[] }>>(() => {
    const byVariant = new Map<string, UnitOption[]>();
    for (const m of matrix) {
      if (!m.variantId) continue;
      const arr = byVariant.get(m.variantId);
      if (arr) arr.push(m);
      else byVariant.set(m.variantId, [m]);
    }
    const result: Array<{ variantId: string; variantLabel: string; units: UnitOption[] }> = [];
    for (const [vid, unitList] of byVariant) {
      const meta = matrixMeta.get(vid);
      result.push({ variantId: vid, variantLabel: meta?.variantLabel ?? "", units: unitList });
    }
    return result;
  }, [matrix, matrixMeta]);

  const setQty = useCallback((variantId: string, delta: number) => {
    setQtyDrafts((prev) => {
      const current = prev[variantId] ?? 0;
      const next = Math.max(0, Math.min(MAX_QTY, current + delta));
      return { ...prev, [variantId]: next };
    });
  }, []);

  const updateQty = useCallback((variantId: string, raw: string) => {
    const v = parseInt(raw, 10);
    setQtyDrafts((prev) => ({
      ...prev,
      [variantId]: isNaN(v) ? 0 : Math.max(0, Math.min(MAX_QTY, v)),
    }));
  }, []);

  const setVariantUnit = useCallback((variantId: string, unitId: string) => {
    setSelectedUnits((prev) => ({ ...prev, [variantId]: unitId }));
  }, []);

  const handleAdd = useCallback(() => {
    if (!productId || !product) return;

    const lineRows: Array<{
      productId: string;
      name: string;
      barcode: string;
      variantId: string;
      variantLabel: string;
      unitName: string;
      unitMultiplier: number;
      unitId?: string;
      unitPrice: number;
      qty: number;
      taxPercent?: number;
      taxIncluded?: boolean;
    }> = [];

    for (const row of rows) {
      const qty = qtyDrafts[row.variantId] ?? 0;
      if (qty <= 0) continue;
      const chosenUnit = row.units.find((u) => unitKey(u) === (selectedUnits[row.variantId] ?? unitKey(row.units[0])))
        ?? row.units[0];
      if (!chosenUnit) continue;
      lineRows.push({
        productId,
        name: product.name,
        barcode: "",
        variantId: row.variantId,
        variantLabel: row.variantLabel,
        unitName: chosenUnit.unitName,
        unitMultiplier: chosenUnit.unitMultiplier,
        unitId: chosenUnit.unitId,
        unitPrice: chosenUnit.unitPrice,
        qty,
        taxPercent: product.taxPercent,
        taxIncluded: product.taxIncluded,
      });
    }

    if (lineRows.length > 0) {
      addVariantMatrixItems(lineRows);
      setQtyDrafts({});
      setSelectedUnits({});
      closeVariantPicker();
    }
  }, [rows, qtyDrafts, selectedUnits, productId, product, addVariantMatrixItems, closeVariantPicker]);

  const handleClose = useCallback(() => {
    setQtyDrafts({});
    setSelectedUnits({});
    closeVariantPicker();
  }, [closeVariantPicker]);

  const totalSelected = useMemo(
    () => rows.reduce((sum, row) => sum + (qtyDrafts[row.variantId] ?? 0), 0),
    [rows, qtyDrafts],
  );

  return (
    <ModalShell
      open={isOpen}
      title={product ? `اختر النكهة/الخيار — ${product.name}` : "اختر الخيار"}
      description="اختر النكهة والوحدة ثم حدد الكمية"
      icon={<Package className="h-5 w-5 text-primary" />}
      onClose={handleClose}
      size="lg"
      placement="top"
    >
      <div className="space-y-2">
        {rows.length === 0 && (
          <p className="py-8 text-center text-muted">لا توجد خيارات لهذا المنتج</p>
        )}

        {rows.map((row) => {
          const selectedUnitId = selectedUnits[row.variantId] ?? unitKey(row.units[0]);
          const selectedUnit = row.units.find((u) => unitKey(u) === selectedUnitId)
            ?? row.units[0];
          if (!selectedUnit) return null;
          const draftQty = qtyDrafts[row.variantId] ?? 0;
          const stock = breakdownStock(
            selectedUnit.totalStock,
            units,
            product?.isWeighed ?? false,
            product?.baseUnit ?? "",
          );
          const maxQty = maxUnitsAvailable(selectedUnit.totalStock, selectedUnit.unitMultiplier);

          return (
            <div
              key={row.variantId}
              className="rounded-xl border border-border bg-surface px-4 py-3"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-bold text-foreground">
                    {row.variantLabel}
                  </div>
                  <div className="mt-1 text-xs text-muted">
                    <span className="tabular-nums">{formatMoney(selectedUnit.unitPrice)}</span>
                    {row.units.length <= 1 && selectedUnit.unitName && (
                      <>
                        {" · "}
                        <span>{selectedUnit.unitName}</span>
                      </>
                    )}
                    {" · "}
                    {stock.label}
                    {maxQty > 0 && (
                      <span className="ml-1 text-muted">(حد أقصى: {maxQty})</span>
                    )}
                  </div>

                  {row.units.length > 1 && (
                    <div className="mt-2 flex flex-wrap items-center gap-1">
                      {row.units.map((u) => {
                        const uid = unitKey(u);
                        const active = uid === selectedUnitId;
                        return (
                          <button
                            key={uid}
                            type="button"
                            onClick={() => setVariantUnit(row.variantId, uid)}
                            className={`h-8 rounded-lg border px-2.5 text-xs font-bold transition ${
                              active
                                ? "border-primary bg-primary-soft text-primary"
                                : "border-border bg-surface text-muted hover:bg-surface-muted"
                            }`}
                          >
                            {u.unitName}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    aria-label="إنقاص الكمية"
                    onClick={() => setQty(row.variantId, -1)}
                    disabled={draftQty <= 0}
                    className="grid h-8 w-8 place-items-center rounded-lg border border-border bg-surface text-muted transition hover:bg-surface-muted disabled:opacity-30"
                  >
                    <Minus className="h-4 w-4" />
                  </button>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={MAX_QTY}
                    value={draftQty}
                    onFocus={(e) => e.currentTarget.select()}
                    onChange={(e) => updateQty(row.variantId, e.target.value)}
                    aria-label="الكمية"
                    className="h-8 w-14 rounded-lg border border-border bg-surface text-center text-sm font-bold text-foreground tabular-nums outline-none transition focus:border-primary/60 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                  />
                  <button
                    type="button"
                    aria-label="زيادة الكمية"
                    onClick={() => setQty(row.variantId, 1)}
                    disabled={draftQty >= MAX_QTY}
                    className="grid h-8 w-8 place-items-center rounded-lg border border-border bg-surface text-muted transition hover:bg-surface-muted disabled:opacity-30"
                  >
                    <Plus className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-4 flex items-center justify-between border-t border-border pt-3">
        <span className="text-sm text-muted">
          {totalSelected > 0 ? `${totalSelected} عنصر محدد` : "اختر الكمية"}
        </span>
        <Button
          onClick={handleAdd}
          disabled={totalSelected <= 0}
          className="gap-2"
        >
          <ShoppingCart className="h-4 w-4" />
          أضف للسلة
        </Button>
      </div>
    </ModalShell>
  );
}
