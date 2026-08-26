"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Minus,
  Package,
  Plus,
  Search,
  ShoppingCart,
  Trash2,
} from "lucide-react";
import { ModalShell } from "@/components/ui/ModalShell";
import { Button } from "@/components/ui/Button";
import { usePosStore } from "@/store/usePosStore";
import { formatMoney } from "@/lib/format";
import { breakdownStock, maxUnitsAvailable } from "@/lib/stockDisplay";
import {
  searchProductsForPO,
  type POBuilderProduct,
  type POBuilderVariant,
} from "@/lib/inventoryClient";
import { normalizeArabicText } from "@/lib/arabic";
import type { LocalUnit } from "@/types/pos.types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single PO line item the modal returns to the parent page. */
export interface POBuilderItem {
  productId: string;
  productName: string;
  variantId: string | null;
  variantLabel: string;
  unitId: string | null;
  unitName: string;
  unitMultiplier: number;
  quantity: number;
  qtyInUnit: number;
  unitCost: number;
  newSellingPrice: number | null;
}

interface CostDraft {
  unitCost: string;
  newSellingPrice: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SEARCH_DEBOUNCE = 250;
const MAX_QTY = 999;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMatrixKey(variantId: string, unitId: string): string {
  return `${variantId}:${unitId}`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function POBuilderModal({
  open,
  onClose,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: (items: POBuilderItem[]) => void;
}) {
  const productUnits = usePosStore((s) => s.productUnits);

  // ── Search state ──
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<POBuilderProduct[]>([]);
  const [searching, setSearching] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // ── Pending items (items the user has staged before confirming) ──
  const [staged, setStaged] = useState<POBuilderItem[]>([]);

  // ── Active draft (qty + cost for the currently expanded product) ──
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [qtyDrafts, setQtyDrafts] = useState<Record<string, number>>({});
  const [costDrafts, setCostDrafts] = useState<Record<string, CostDraft>>({});

  // Reset on open
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setResults([]);
    setExpandedId(null);
    setQtyDrafts({});
    setCostDrafts({});
  }, [open]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      debounceRef.current && clearTimeout(debounceRef.current);
      abortRef.current?.abort();
    };
  }, []);

  // ── Search ──
  const doSearch = useCallback(async (q: string) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setSearching(true);
    try {
      const items = await searchProductsForPO(q, 20);
      if (!controller.signal.aborted) setResults(items);
    } catch {
      /* silently ignore */
    } finally {
      setSearching(false);
    }
  }, []);

  const handleQueryChange = useCallback(
    (value: string) => {
      setQuery(value);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => void doSearch(value), SEARCH_DEBOUNCE);
    },
    [doSearch],
  );

  // ── Qty draft helpers ──
  const setQty = useCallback((key: string, delta: number) => {
    setQtyDrafts((prev) => {
      const current = prev[key] ?? 0;
      return { ...prev, [key]: Math.max(0, Math.min(MAX_QTY, current + delta)) };
    });
  }, []);

  const updateQty = useCallback((key: string, raw: string) => {
    const v = parseInt(raw, 10);
    setQtyDrafts((prev) => ({
      ...prev,
      [key]: isNaN(v) ? 0 : Math.max(0, Math.min(MAX_QTY, v)),
    }));
  }, []);

  // ── Cost draft helpers ──
  const updateCost = useCallback((key: string, field: keyof CostDraft, value: string) => {
    setCostDrafts((prev) => ({
      ...prev,
      [key]: { ...prev[key], unitCost: "", newSellingPrice: "", [field]: value },
    }));
  }, []);

  // ── Get units for a product ──
  const getUnits = useCallback(
    (product: POBuilderProduct): LocalUnit[] => {
      return productUnits[product.id] ?? [];
    },
    [productUnits],
  );

  // ── Build matrix for a product ──
  const buildMatrix = useCallback(
    (product: POBuilderProduct) => {
      const units = getUnits(product);
      const rows: Array<{
        key: string;
        variant: POBuilderVariant;
        unit: LocalUnit;
        stockBreakdown: ReturnType<typeof breakdownStock>;
        maxQty: number;
      }> = [];

      if (units.length > 0) {
        for (const variant of product.variants.length > 0 ? product.variants : [{ variantId: "", barcode: "", variantLabel: "—", totalStock: product.totalStock }]) {
          for (const unit of units.filter((u) => u.isActive)) {
            const mk = makeMatrixKey(variant.variantId || product.id, unit.id);
            rows.push({
              key: mk,
              variant,
              unit,
              stockBreakdown: breakdownStock(variant.totalStock, units, product.isWeighed, product.baseUnit),
              maxQty: maxUnitsAvailable(variant.totalStock, unit.qtyMultiplier),
            });
          }
        }
      } else {
        // No units configured — show base tier only
        const variants = product.variants.length > 0 ? product.variants : [{ variantId: "", barcode: "", variantLabel: "—", totalStock: product.totalStock }];
        for (const variant of variants) {
          const mk = makeMatrixKey(variant.variantId || product.id, "_base");
          rows.push({
            key: mk,
            variant,
            unit: { id: "_base", unitName: product.baseUnit, qtyMultiplier: 1, sellingPrice: product.costPrice ?? 0, isDefaultSale: true, isActive: true } as LocalUnit,
            stockBreakdown: breakdownStock(variant.totalStock, [], product.isWeighed, product.baseUnit),
            maxQty: variant.totalStock,
          });
        }
      }

      return rows;
    },
    [getUnits],
  );

  // ── Stage items from the active product draft ──
  const handleStageProduct = useCallback(
    (product: POBuilderProduct) => {
      const matrix = buildMatrix(product);
      const newItems: POBuilderItem[] = [];

      for (const m of matrix) {
        const qty = qtyDrafts[m.key] ?? 0;
        if (qty <= 0) continue;

        const costKey = m.key;
        const costDraft = costDrafts[costKey];
        const unitCost = costDraft?.unitCost
          ? parseFloat(costDraft.unitCost)
          : product.costPrice ?? 0;
        const newSellingPrice = costDraft?.newSellingPrice
          ? parseFloat(costDraft.newSellingPrice) || null
          : null;

        newItems.push({
          productId: product.id,
          productName: product.name,
          variantId: m.variant.variantId || null,
          variantLabel: m.variant.variantLabel,
          unitId: m.unit.id === "_base" ? null : m.unit.id,
          unitName: m.unit.unitName,
          unitMultiplier: m.unit.qtyMultiplier,
          quantity: qty * m.unit.qtyMultiplier,
          qtyInUnit: qty,
          unitCost,
          newSellingPrice,
        });
      }

      if (newItems.length > 0) {
        setStaged((prev) => [...prev, ...newItems]);
        // Reset drafts for this product
        const keysToReset = matrix.map((m) => m.key);
        setQtyDrafts((prev) => {
          const next = { ...prev };
          for (const k of keysToReset) delete next[k];
          return next;
        });
        setCostDrafts((prev) => {
          const next = { ...prev };
          for (const k of keysToReset) delete next[k];
          return next;
        });
      }
    },
    [buildMatrix, qtyDrafts, costDrafts],
  );

  // ── Remove a staged item ──
  const removeStaged = useCallback((index: number) => {
    setStaged((prev) => prev.filter((_, i) => i !== index));
  }, []);

  // ── Confirm all staged items ──
  const handleConfirm = useCallback(() => {
    if (staged.length === 0) return;
    onConfirm(staged);
    setStaged([]);
    onClose();
  }, [staged, onConfirm, onClose]);

  // ── Computed totals ──
  const stagedTotal = useMemo(
    () => staged.reduce((sum, item) => sum + item.quantity * item.unitCost, 0),
    [staged],
  );

  const draftTotal = useMemo(() => {
    if (!expandedId) return 0;
    const product = results.find((p) => p.id === expandedId);
    if (!product) return 0;
    const matrix = buildMatrix(product);
    let total = 0;
    for (const m of matrix) {
      const qty = qtyDrafts[m.key] ?? 0;
      if (qty <= 0) continue;
      const costDraft = costDrafts[m.key];
      const unitCost = costDraft?.unitCost
        ? parseFloat(costDraft.unitCost)
        : product.costPrice ?? 0;
      total += qty * m.unit.qtyMultiplier * unitCost;
    }
    return total;
  }, [expandedId, results, buildMatrix, qtyDrafts, costDrafts]);

  return (
    <ModalShell
      open={open}
      title="إضافة أصناف لأمر الشراء"
      description="ابحث عن المنتج، حدد الكمية والتكلفة لكل variant ووحدة"
      icon={<Package className="h-5 w-5 text-primary" />}
      onClose={onClose}
      size="xl"
      height="lg"
      placement="top"
      footer={
        <div className="flex items-center justify-between gap-4">
          <div className="text-sm font-bold text-muted">
            {staged.length > 0 ? (
              <>
                <span className="font-black tabular-nums text-foreground">{staged.length}</span>
                {" "}بند &middot; الإجمالي: <span className="font-black tabular-nums text-foreground">{formatMoney(stagedTotal)}</span>
              </>
            ) : (
              "لم تُضف بنود بعد"
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={onClose}>إلغاء</Button>
            <Button onClick={handleConfirm} disabled={staged.length === 0} className="gap-2">
              <ShoppingCart className="h-4 w-4" />
              تأكيد الإضافة ({staged.length})
            </Button>
          </div>
        </div>
      }
    >
      {/* ── Search ── */}
      <div className="relative mb-4">
        <Search className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
        <input
          value={query}
          onChange={(e) => handleQueryChange(e.target.value)}
          placeholder="ابحث عن منتج بالاسم..."
          autoFocus
          className="h-11 w-full rounded-xl border border-border bg-white pr-10 pl-3 text-sm font-bold outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
        />
        {searching && (
          <div className="absolute left-3 top-1/2 -translate-y-1/2">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        )}
      </div>

      {/* ── Staged items preview ── */}
      {staged.length > 0 && (
        <div className="mb-4 rounded-xl border border-success/30 bg-success/5 p-3">
          <p className="mb-2 text-xs font-black text-success">بنود جاهزة للإضافة</p>
          <div className="max-h-32 space-y-1 overflow-y-auto">
            {staged.map((item, i) => (
              <div key={i} className="flex items-center justify-between gap-2 rounded-lg bg-white px-2.5 py-1.5 text-xs">
                <span className="min-w-0 flex-1 truncate font-bold text-foreground">
                  {item.productName}
                  {item.variantLabel !== "—" ? ` — ${item.variantLabel}` : ""}
                  {` (${item.unitName})`}
                </span>
                <span className="shrink-0 font-black tabular-nums text-muted">
                  {item.qtyInUnit} × {formatMoney(item.unitCost)}
                </span>
                <button
                  type="button"
                  onClick={() => removeStaged(i)}
                  className="grid h-6 w-6 shrink-0 place-items-center rounded text-muted transition hover:bg-destructive/10 hover:text-destructive"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Product results ── */}
      <div className="space-y-3">
        {results.length === 0 && !searching && query.trim() && (
          <p className="py-8 text-center text-sm font-bold text-muted">
            لا توجد نتائج — جرّب كلمة أخرى
          </p>
        )}
        {results.length === 0 && !searching && !query.trim() && (
          <p className="py-8 text-center text-sm font-bold text-muted">
            ابحث عن منتج لإضافته لأمر الشراء
          </p>
        )}

        {results.map((product) => {
          const isExpanded = expandedId === product.id;
          const matrix = isExpanded ? buildMatrix(product) : [];
          const productUnitsList = getUnits(product);

          return (
            <div
              key={product.id}
              className={`rounded-xl border transition ${isExpanded ? "border-primary/40 bg-primary/5" : "border-border bg-white"}`}
            >
              {/* Product header */}
              <button
                type="button"
                onClick={() => setExpandedId(isExpanded ? null : product.id)}
                className="flex w-full items-center justify-between gap-3 px-4 py-3 text-right"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-black text-foreground">{product.name}</p>
                  <p className="mt-0.5 text-xs font-semibold text-muted">
                    {breakdownStock(product.totalStock, productUnitsList, product.isWeighed, product.baseUnit).label}
                    {product.costPrice != null && (
                      <> &middot; تكلفة: <span className="tabular-nums">{formatMoney(product.costPrice)}</span></>
                    )}
                  </p>
                </div>
                <div className="shrink-0 text-xs font-bold text-muted">
                  {product.variants.length > 0 ? `${product.variants.length} variant` : product.baseUnit}
                </div>
              </button>

              {/* Expanded: variant × unit matrix */}
              {isExpanded && (
                <div className="border-t border-border px-4 py-3 space-y-2">
                  {matrix.length === 0 && (
                    <p className="py-4 text-center text-xs font-bold text-muted">لا توجد variants لهذا المنتج</p>
                  )}

                  {matrix.map((m) => {
                    const draftQty = qtyDrafts[m.key] ?? 0;
                    const costDraft = costDrafts[m.key];

                    return (
                      <div
                        key={m.key}
                        className="flex flex-col gap-2 rounded-lg border border-border/60 bg-surface-muted/40 px-3 py-2.5 sm:flex-row sm:items-center sm:gap-3"
                      >
                        {/* Variant + Unit + Stock info */}
                        <div className="min-w-0 flex-1">
                          <div className="text-xs font-black text-foreground truncate">
                            {m.variant.variantLabel}
                            {m.unit.qtyMultiplier > 1 ? ` — ${m.unit.unitName} (×${m.unit.qtyMultiplier})` : ` — ${m.unit.unitName}`}
                          </div>
                          <div className="mt-0.5 text-[11px] font-semibold text-muted">
                            {m.stockBreakdown.label}
                            {m.maxQty > 0 && (
                              <span className="ms-1 text-muted/70">(حد أقصى: {m.maxQty})</span>
                            )}
                          </div>
                        </div>

                        {/* Qty stepper */}
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            type="button"
                            onClick={() => setQty(m.key, -m.unit.qtyMultiplier)}
                            disabled={draftQty <= 0}
                            className="h-7 w-7 rounded-lg border border-border bg-surface flex items-center justify-center text-muted hover:bg-accent disabled:opacity-30"
                          >
                            <Minus className="h-3.5 w-3.5" />
                          </button>
                          <input
                            type="number"
                            min={0}
                            max={MAX_QTY}
                            value={draftQty}
                            onChange={(e) => updateQty(m.key, e.target.value)}
                            className="h-7 w-12 text-center rounded-lg border border-border bg-surface text-xs font-bold text-foreground [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                          />
                          <button
                            type="button"
                            onClick={() => setQty(m.key, m.unit.qtyMultiplier)}
                            disabled={draftQty >= MAX_QTY}
                            className="h-7 w-7 rounded-lg border border-border bg-surface flex items-center justify-center text-muted hover:bg-accent disabled:opacity-30"
                          >
                            <Plus className="h-3.5 w-3.5" />
                          </button>
                          {draftQty > 0 && (
                            <span className="ms-1 text-[10px] font-bold text-muted tabular-nums">
                              = {draftQty * m.unit.qtyMultiplier} {product.baseUnit}
                            </span>
                          )}
                        </div>

                        {/* Cost inputs (only when qty > 0) */}
                        {draftQty > 0 && (
                          <div className="flex items-center gap-2 shrink-0">
                            <input
                              type="number"
                              min={0}
                              step="0.01"
                              inputMode="decimal"
                              dir="ltr"
                              placeholder={`تكلفة (${formatMoney(product.costPrice ?? 0)})`}
                              value={costDraft?.unitCost ?? ""}
                              onChange={(e) => updateCost(m.key, "unitCost", e.target.value)}
                              className="h-7 w-24 rounded-lg border border-border bg-surface px-2 text-left text-[11px] font-bold tabular-nums outline-none focus:border-primary placeholder:text-muted/50"
                            />
                            <input
                              type="number"
                              min={0}
                              step="0.01"
                              inputMode="decimal"
                              dir="ltr"
                              placeholder="بيع جديد"
                              value={costDraft?.newSellingPrice ?? ""}
                              onChange={(e) => updateCost(m.key, "newSellingPrice", e.target.value)}
                              className="h-7 w-20 rounded-lg border border-border bg-surface px-2 text-left text-[11px] font-bold tabular-nums outline-none focus:border-primary placeholder:text-muted/50"
                            />
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {/* Stage button */}
                  <div className="flex items-center justify-between pt-1">
                    <span className="text-xs font-bold text-muted tabular-nums">
                      {draftTotal > 0 ? `الإجمالي: ${formatMoney(draftTotal)}` : ""}
                    </span>
                    <Button
                      size="sm"
                      onClick={() => handleStageProduct(product)}
                      disabled={matrix.every((m) => (qtyDrafts[m.key] ?? 0) <= 0)}
                      className="gap-1.5"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      أضف للقائمة
                    </Button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </ModalShell>
  );
}
