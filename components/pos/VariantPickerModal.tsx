"use client";

import { useCallback, useMemo, useState } from "react";
import { Package, Minus, Plus, ShoppingCart } from "lucide-react";
import { ModalShell } from "@/components/ui/ModalShell";
import { Button } from "@/components/ui/Button";
import { usePosStore } from "@/store/usePosStore";
import { formatMoney } from "@/lib/format";
import { breakdownStock, maxUnitsAvailable } from "@/lib/stockDisplay";

interface MatrixRow {
  variantLabel: string;
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

export default function VariantPickerModal() {
  const isOpen = usePosStore((s) => s.variantPickerProductId !== null);
  const productId = usePosStore((s) => s.variantPickerProductId);
  const products = usePosStore((s) => s.products);
  const productUnits = usePosStore((s) => s.productUnits);
  const barcodeIndex = usePosStore((s) => s.barcodeIndex);
  const closeVariantPicker = usePosStore((s) => s.closeVariantPicker);
  const addVariantMatrixItems = usePosStore((s) => s.addVariantMatrixItems);

  const [qtyDrafts, setQtyDrafts] = useState<Record<string, number>>({});

  const product = productId ? products[productId] : undefined;
  const units = productId ? (productUnits[productId] ?? []) : [];

  const matrix = useMemo<MatrixRow[]>(() => {
    if (!productId || !product) return [];

    const seen = new Map<string, MatrixRow>();

    for (const entry of Object.values(barcodeIndex)) {
      if (entry.product_id !== productId) continue;

      if (units.length > 0) {
        for (const u of units.filter((un) => un.isActive)) {
          const key = `${entry.variantId}:${u.id}`;
          if (seen.has(key)) continue;
          seen.set(key, {
            variantLabel: entry.variantLabel,
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
            variantLabel: entry.variantLabel,
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

  const setQty = useCallback((key: string, delta: number) => {
    setQtyDrafts((prev) => {
      const current = prev[key] ?? 0;
      const next = Math.max(0, Math.min(MAX_QTY, current + delta));
      return { ...prev, [key]: next };
    });
  }, []);

  const updateQty = useCallback((key: string, raw: string) => {
    const v = parseInt(raw, 10);
    setQtyDrafts((prev) => ({
      ...prev,
      [key]: isNaN(v) ? 0 : Math.max(0, Math.min(MAX_QTY, v)),
    }));
  }, []);

  const handleAdd = useCallback(() => {
    if (!productId || !product) return;

    const rows: Array<{
      productId: string;
      name: string;
      barcode: string;
      variantLabel: string;
      unitName: string;
      unitMultiplier: number;
      unitId?: string;
      unitPrice: number;
      qty: number;
    }> = [];

    for (const m of matrix) {
      const key = `${m.variantId}:${m.unitId ?? "_base"}`;
      const qty = qtyDrafts[key] ?? 0;
      if (qty <= 0) continue;
      rows.push({
        productId,
        name: product.name,
        barcode: "",
        variantLabel: m.variantLabel,
        unitName: m.unitName,
        unitMultiplier: m.unitMultiplier,
        unitId: m.unitId,
        unitPrice: m.unitPrice,
        qty,
      });
    }

    if (rows.length > 0) {
      addVariantMatrixItems(rows);
      setQtyDrafts({});
      closeVariantPicker();
    }
  }, [matrix, qtyDrafts, productId, product, addVariantMatrixItems, closeVariantPicker]);

  const handleClose = useCallback(() => {
    setQtyDrafts({});
    closeVariantPicker();
  }, [closeVariantPicker]);

  const totalSelected = useMemo(
    () => matrix.reduce((sum, m) => {
      const key = `${m.variantId}:${m.unitId ?? "_base"}`;
      return sum + (qtyDrafts[key] ?? 0);
    }, 0),
    [matrix, qtyDrafts],
  );

  return (
    <ModalShell
      open={isOpen}
      title={product ? `اختيار Variant — ${product.name}` : "اختيار Variant"}
      description="اختر الكمية لكل variant ووحدة"
      icon={<Package className="h-5 w-5 text-primary" />}
      onClose={handleClose}
      size="xl"
      height="lg"
      placement="top"
    >
      <div className="space-y-2">
        {matrix.length === 0 && (
          <p className="text-center text-muted py-8">لا توجد variants لهذا المنتج</p>
        )}

        {matrix.map((m) => {
          const key = `${m.variantId}:${m.unitId ?? "_base"}`;
          const draftQty = qtyDrafts[key] ?? 0;
          const stock = breakdownStock(
            m.totalStock,
            units,
            product?.isWeighed ?? false,
            product?.baseUnit ?? "",
          );
          const maxQty = maxUnitsAvailable(m.totalStock, m.unitMultiplier);

          return (
            <div
              key={key}
              className="flex items-center gap-3 rounded-xl border border-border bg-muted/30 px-4 py-3"
            >
              <div className="min-w-0 flex-1">
                <div className="text-sm font-bold text-foreground truncate">
                  {m.variantLabel}
                </div>
                <div className="text-xs text-muted mt-0.5">
                  {m.unitName} &middot; {formatMoney(m.unitPrice)} &middot; {stock.label}
                  {maxQty > 0 && (
                    <span className="text-muted ml-1">(حد أقصى: {maxQty})</span>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  onClick={() => setQty(key, -1)}
                  disabled={draftQty <= 0}
                  className="h-8 w-8 rounded-lg border border-border bg-surface flex items-center justify-center text-muted hover:bg-accent disabled:opacity-30"
                >
                  <Minus className="h-4 w-4" />
                </button>
                <input
                  type="number"
                  min={0}
                  max={MAX_QTY}
                  value={draftQty}
                  onChange={(e) => updateQty(key, e.target.value)}
                  className="h-8 w-14 text-center rounded-lg border border-border bg-surface text-sm font-bold text-foreground [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                />
                <button
                  type="button"
                  onClick={() => setQty(key, 1)}
                  disabled={draftQty >= MAX_QTY}
                  className="h-8 w-8 rounded-lg border border-border bg-surface flex items-center justify-center text-muted hover:bg-accent disabled:opacity-30"
                >
                  <Plus className="h-4 w-4" />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-between mt-4 pt-3 border-t border-border">
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
