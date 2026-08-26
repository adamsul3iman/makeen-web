"use client";

import { useEffect, useState } from "react";
import { Clock, TrendingDown, TrendingUp, Minus } from "lucide-react";
import { formatMoney } from "@/lib/format";
import { fetchCostHistory, type CostHistoryRow } from "@/lib/purchasesClient";

const SOURCE_LABELS: Record<string, string> = {
  PO_RECEIPT: "استلام شراء",
  PO_RECONCILIATION: "تسوية شراء",
  MANUAL_ADJUSTMENT: "تعديل يدوي",
  MOBILE_RECEIVING: "استلام موبايل",
};

interface Props {
  productId: string;
  productName: string;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export default function CostHistoryPopover({ productId, productName }: Props) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<CostHistoryRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    setError("");
    fetchCostHistory(productId, 10)
      .then((data) => {
        if (alive) setRows(data);
      })
      .catch((err) => {
        if (alive) setError(err instanceof Error ? err.message : "تعذر تحميل السجل");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, productId]);

  return (
    <span className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="سجل تغييرات السعر"
        className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted/50 transition hover:bg-surface-muted hover:text-muted"
      >
        <Clock className="h-3 w-3" />
      </button>

      {open && (
        <>
          {/* Backdrop */}
          <span
            className="fixed inset-0 z-[70]"
            onClick={() => setOpen(false)}
          />
          {/* Popover */}
          <div className="absolute end-0 top-full z-[71] mt-1 w-80 overflow-hidden rounded-xl border border-border bg-surface shadow-lg">
            <div className="border-b border-border px-3 py-2">
              <p className="text-xs font-black text-foreground truncate">{productName}</p>
              <p className="text-[10px] font-bold text-muted">آخر تغييرات السعر</p>
            </div>

            <div className="max-h-72 overflow-y-auto">
              {loading && (
                <div className="flex items-center justify-center py-6">
                  <span className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                </div>
              )}

              {error && !loading && (
                <p className="px-3 py-4 text-center text-xs font-bold text-destructive">{error}</p>
              )}

              {!loading && !error && rows.length === 0 && (
                <p className="px-3 py-4 text-center text-xs font-semibold text-muted">
                  لا سجل بعد
                </p>
              )}

              {!loading && !error && rows.length > 0 && (
                <div className="divide-y divide-border/60">
                  {rows.map((row) => {
                    const costDelta =
                      row.oldCostPrice != null && row.newCostPrice != null
                        ? round2(row.newCostPrice - row.oldCostPrice)
                        : null;
                    const sellingDelta =
                      row.oldSellingPrice != null && row.newSellingPrice != null
                        ? round2(row.newSellingPrice - row.oldSellingPrice)
                        : null;
                    const isUp = (costDelta ?? 0) > 0 || (sellingDelta ?? 0) > 0;
                    const isDown = (costDelta ?? 0) < 0 || (sellingDelta ?? 0) < 0;

                    return (
                      <div key={row.id} className="px-3 py-2.5">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[10px] font-bold text-muted">
                            {new Date(row.changedAt).toLocaleDateString("ar-JO", {
                              day: "2-digit",
                              month: "short",
                              year: "numeric",
                            })}
                          </span>
                          <span className="rounded bg-surface-muted px-1.5 py-0.5 text-[10px] font-bold text-muted">
                            {SOURCE_LABELS[row.source] ?? row.source}
                          </span>
                        </div>

                        <div className="mt-1.5 grid grid-cols-2 gap-2 text-xs">
                          {row.oldCostPrice != null && row.newCostPrice != null && (
                            <div>
                              <span className="block text-[10px] font-bold text-muted">التكلفة</span>
                              <span className="tabular-nums text-foreground">
                                {formatMoney(row.oldCostPrice)}
                                <span className="mx-0.5 text-muted">→</span>
                                {formatMoney(row.newCostPrice)}
                              </span>
                              {costDelta !== null && costDelta !== 0 && (
                                <span
                                  className={`ms-1 inline-flex items-center text-[10px] font-black ${
                                    costDelta > 0 ? "text-destructive" : "text-success"
                                  }`}
                                >
                                  {costDelta > 0 ? (
                                    <TrendingUp className="h-3 w-3" />
                                  ) : costDelta < 0 ? (
                                    <TrendingDown className="h-3 w-3" />
                                  ) : (
                                    <Minus className="h-3 w-3" />
                                  )}
                                  {costDelta > 0 ? "+" : ""}
                                  {costDelta.toFixed(2)}
                                </span>
                              )}
                            </div>
                          )}

                          {row.oldSellingPrice != null && row.newSellingPrice != null && (
                            <div>
                              <span className="block text-[10px] font-bold text-muted">البيع</span>
                              <span className="tabular-nums text-foreground">
                                {formatMoney(row.oldSellingPrice)}
                                <span className="mx-0.5 text-muted">→</span>
                                {formatMoney(row.newSellingPrice)}
                              </span>
                              {sellingDelta !== null && sellingDelta !== 0 && (
                                <span
                                  className={`ms-1 inline-flex items-center text-[10px] font-black ${
                                    sellingDelta > 0 ? "text-success" : "text-destructive"
                                  }`}
                                >
                                  {sellingDelta > 0 ? (
                                    <TrendingUp className="h-3 w-3" />
                                  ) : sellingDelta < 0 ? (
                                    <TrendingDown className="h-3 w-3" />
                                  ) : (
                                    <Minus className="h-3 w-3" />
                                  )}
                                  {sellingDelta > 0 ? "+" : ""}
                                  {sellingDelta.toFixed(2)}
                                </span>
                              )}
                            </div>
                          )}
                        </div>

                        {row.changedBy && (
                          <p className="mt-1 text-[10px] font-semibold text-muted">
                            بواسطة: {row.changedBy}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </span>
  );
}
