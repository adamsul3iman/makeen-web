"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Barcode, Search, X, Package, ScanLine } from "lucide-react";
import { ModalShell } from "@/components/ui/ModalShell";
import { formatMoney } from "@/lib/format";
import { breakdownStock, maxUnitsAvailable } from "@/lib/stockDisplay";
import {
  resolveScan,
  type ResolvedProduct,
  type ScanResolveInput,
} from "@/lib/scanResolve";
import { usePosStore } from "@/store/usePosStore";
import { useModalEscape } from "@/hooks/useModalEscape";

/* ────────────────── Types ────────────────── */

interface ScanHistoryItem {
  query: string;
  timestamp: number;
  productName: string;
  totalStock: number;
}

/* ────────────────── Component ────────────────── */

export default function ProductQuantitiesModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const products = usePosStore((s) => s.products);
  const barcodes = usePosStore((s) => s.barcodes);
  const barcodeIndex = usePosStore((s) => s.barcodeIndex);
  const productUnits = usePosStore((s) => s.productUnits);

  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [resolvedQuery, setResolvedQuery] = useState<string | null>(null);
  const input = useMemo<ScanResolveInput>(
    () => ({ barcodeIndex, barcodes, products, productUnits }),
    [barcodeIndex, barcodes, products, productUnits],
  );
  const resolved = useMemo<ResolvedProduct | null>(() => {
    if (!resolvedQuery) return null;
    return resolveScan(resolvedQuery, input);
  }, [resolvedQuery, input]);
  const [notFound, setNotFound] = useState(false);
  const [history, setHistory] = useState<ScanHistoryItem[]>([]);

  // Auto-focus the input whenever the modal opens or a scan resolves.
  const focusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!open) return;
    focusTimerRef.current = setTimeout(() => inputRef.current?.focus(), 80);
    const timer = focusTimerRef.current;
    return () => { if (timer) clearTimeout(timer); };
  }, [open, resolved]);

  const resolve = useCallback(
    (code: string) => {
      const trimmed = code.trim();
      if (!trimmed) return;
      setNotFound(false);

      const result = resolveScan(trimmed, input);
      if (!result) {
        setResolvedQuery(null);
        setNotFound(true);
        return;
      }
      setResolvedQuery(trimmed);
      setHistory((prev) =>
        [
          { query: trimmed, timestamp: Date.now(), productName: result.productName, totalStock: result.totalStock },
          ...prev,
        ].slice(0, 20),
      );
    },
    [input],
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    resolve(query);
    setQuery("");
  };

  const clearHistory = () => setHistory([]);

  useModalEscape(onClose, open);

  if (!open) return null;

  return (
    <ModalShell
      open={open}
      title="كميات المنتجات والاستعلام السريع"
      description="امسح الباركود أو ابحث بالاسم لعرض المخزون التفصيلي"
      icon={<ScanLine className="h-5 w-5 text-primary" />}
      size="xl"
      onClose={onClose}
    >
      {/* ── Search / Scan Input ── */}
      <form onSubmit={handleSubmit} className="flex items-center gap-2">
        <div className="flex h-12 min-w-0 flex-1 items-center gap-2 rounded-xl border-2 border-primary/30 bg-white px-3 transition focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/20">
          <Barcode className="h-5 w-5 shrink-0 text-primary/60" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            dir="ltr"
            autoComplete="off"
            spellCheck={false}
            placeholder="امسح الباركود أو اكتب اسم المنتج…"
            className="min-w-0 flex-1 bg-transparent text-base font-bold tracking-wider outline-none placeholder:text-muted/50"
          />
          {query && (
            <button
              type="button"
              onClick={() => { setQuery(""); inputRef.current?.focus(); }}
              className="grid h-6 w-6 place-items-center rounded text-muted/50 hover:text-muted"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <button
          type="submit"
          className="flex h-12 shrink-0 items-center gap-1.5 rounded-xl bg-primary px-4 text-sm font-black text-primary-foreground transition hover:bg-primary-hover"
        >
          <Search className="h-4 w-4" />
          بحث
        </button>
      </form>

      {notFound && (
        <p className="mt-3 rounded-xl bg-destructive/10 px-3 py-2 text-sm font-bold text-destructive">
          هذا الباركود أو الاسم غير مسجل في الكتالوج
        </p>
      )}

      {/* ── Resolved Product ── */}
      {resolved && (
        <div className="mt-4 space-y-4 animate-pos-pop-in">
          {/* Product header */}
          <div className="flex items-start justify-between gap-3 rounded-xl border border-primary/20 bg-primary/5 p-4">
            <div className="min-w-0">
              <h3 className="text-lg font-black text-foreground">{resolved.productName}</h3>
              <p className="mt-0.5 text-xs font-bold text-muted">
                {resolved.baseUnit} •{" "}
                {resolved.isWeighed ? "وزني" : "عدد"}
              </p>
            </div>
            <div className="text-end">
              <p className="text-2xl font-black tabular-nums text-foreground">
                {breakdownStock(resolved.totalStock, resolved.units, resolved.isWeighed, resolved.baseUnit).label}
              </p>
              <p className="text-xs font-bold text-muted">
                {resolved.totalStock} {resolved.baseUnit}
              </p>
            </div>
          </div>

          {/* Price summary */}
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-xl border border-border bg-surface p-3">
              <span className="block text-[10px] font-bold text-muted">تكلفة الوحدة</span>
              <span className="text-sm font-black tabular-nums text-foreground">{formatMoney(resolved.costPrice)}</span>
            </div>
            <div className="rounded-xl border border-border bg-surface p-3">
              <span className="block text-[10px] font-bold text-muted">سعر البيع</span>
              <span className="text-sm font-black tabular-nums text-foreground">{formatMoney(resolved.sellingPrice)}</span>
            </div>
          </div>

          {/* Unit tiers */}
          {resolved.units.length > 0 && (
            <div>
              <h4 className="mb-2 flex items-center gap-1.5 text-xs font-black text-muted">
                <Package className="h-3.5 w-3.5" />
                وحدات التعبئة
              </h4>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {resolved.units.map((unit) => (
                  <div
                    key={unit.id}
                    className="rounded-lg border border-border bg-surface px-3 py-2"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-black text-foreground">{unit.unitName}</span>
                      <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-black text-primary">
                        ×{unit.qtyMultiplier}
                      </span>
                    </div>
                    {unit.barcode && (
                      <p className="mt-0.5 truncate font-mono text-[10px] text-muted" dir="ltr">
                        {unit.barcode}
                      </p>
                    )}
                    <p className="mt-1 text-[10px] font-bold text-muted">
                      {maxUnitsAvailable(resolved.totalStock, unit.qtyMultiplier)} متاح
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Variants table */}
          {resolved.variants.length > 0 && (
            <div>
              <h4 className="mb-2 text-xs font-black text-muted">
                المتغيرات ({resolved.variants.length})
              </h4>
              <div className="overflow-hidden rounded-xl border border-border">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border bg-surface-muted text-right text-[10px] font-black text-muted">
                      <th className="px-3 py-2">المتغير</th>
                      <th className="px-3 py-2">الباركود</th>
                      <th className="px-3 py-2 text-center">الرصيد</th>
                      <th className="px-3 py-2">التفصيل</th>
                      <th className="px-3 py-2 text-start">التكلفة</th>
                      <th className="px-3 py-2 text-start">البيع</th>
                    </tr>
                  </thead>
                  <tbody>
                    {resolved.variants.map((v) => {
                      const bd = breakdownStock(v.totalStock, resolved.units, resolved.isWeighed, resolved.baseUnit);
                      return (
                        <tr key={v.barcode} className="border-b border-border/60 text-right">
                          <td className="px-3 py-2 font-bold text-foreground">
                            {v.variantLabel}
                          </td>
                          <td className="px-3 py-2 font-mono text-muted" dir="ltr">
                            {v.barcode}
                          </td>
                          <td className="px-3 py-2 text-center tabular-nums font-black text-foreground">
                            {v.totalStock}
                          </td>
                          <td className="px-3 py-2 font-semibold text-muted">
                            {bd.label}
                          </td>
                          <td className="px-3 py-2 text-start tabular-nums text-muted">
                            {formatMoney(v.costPrice)}
                          </td>
                          <td className="px-3 py-2 text-start tabular-nums font-bold text-foreground">
                            {formatMoney(v.price)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <p className="text-center text-[10px] font-bold text-muted/60">
            امسح باركوداً آخر للاستعلام التالي — الإغلاق بـ Esc
          </p>
        </div>
      )}

      {/* ── Scan History ── */}
      {!resolved && history.length > 0 && (
        <div className="mt-4">
          <div className="mb-2 flex items-center justify-between">
            <h4 className="text-xs font-black text-muted">آخر الاستعلامات</h4>
            <button
              type="button"
              onClick={clearHistory}
              className="text-[10px] font-bold text-destructive/70 hover:text-destructive"
            >
              مسح السجل
            </button>
          </div>
          <div className="space-y-1">
            {history.map((item) => (
              <button
                key={`${item.query}-${item.timestamp}`}
                type="button"
                onClick={() => { resolve(item.query); setQuery(""); }}
                className="flex w-full items-center justify-between gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-start transition hover:bg-surface-muted"
              >
                <div className="min-w-0">
                  <span className="block truncate text-sm font-bold text-foreground">{item.productName}</span>
                  <span className="block font-mono text-[10px] text-muted" dir="ltr">{item.query}</span>
                </div>
                <span className="shrink-0 text-xs font-black tabular-nums text-muted">{item.totalStock}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {!resolved && history.length === 0 && (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <div className="grid h-16 w-16 place-items-center rounded-2xl bg-primary/10">
            <ScanLine className="h-8 w-8 text-primary/50" />
          </div>
          <p className="mt-3 text-sm font-bold text-muted">
            امسح باركود منتج أو ابحث بالاسم
          </p>
          <p className="mt-1 text-xs font-semibold text-muted/60">
            يمكن البحث بالاسم أو الباركود — الاستعلام فوري من الكتالوج المحلي
          </p>
        </div>
      )}
    </ModalShell>
  );
}
