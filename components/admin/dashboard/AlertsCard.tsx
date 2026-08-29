"use client";

import { AlertTriangle, Boxes, Loader2, PackageMinus } from "lucide-react";
import { formatProductDisplayName } from "@/lib/productDisplayName";
import { Badge } from "@/components/ui/Badge";
import type { ReportsNegativeStock, ReportsStockAlert } from "@/types/reports.types";

function StockDaysBadge({ daysOfStockLeft }: Pick<ReportsStockAlert, "daysOfStockLeft">) {
  if (daysOfStockLeft === null) return <Badge tone="muted">غير محسوب</Badge>;
  if (daysOfStockLeft === 0) return <Badge tone="destructive">نفد اليوم</Badge>;
  if (daysOfStockLeft <= 2) return <Badge tone="destructive">{daysOfStockLeft} يوم</Badge>;
  return <Badge tone="warning">{daysOfStockLeft} يوم</Badge>;
}

interface AlertsCardProps {
  stockAlerts: ReportsStockAlert[];
  negativeStock: ReportsNegativeStock[];
  countInputs: Record<string, string>;
  countingId: string | null;
  onCountChange: (productId: string, value: string) => void;
  onSubmitCount: (product: ReportsNegativeStock) => void;
}

export default function AlertsCard({
  stockAlerts,
  negativeStock,
  countInputs,
  countingId,
  onCountChange,
  onSubmitCount,
}: AlertsCardProps) {
  const hasNegative = negativeStock.length > 0;

  return (
    <div className="flex flex-col gap-5">
      {/* Actionable: negative stock with inline physical count */}
      <section aria-labelledby="negative-stock-title">
        <div className="mb-2.5 flex items-center gap-2">
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-destructive/10 text-destructive">
            <PackageMinus className="h-4 w-4" />
          </span>
          <h3 id="negative-stock-title" className="text-sm font-black text-foreground">
            نواقص المخزون (مخزون سالب)
          </h3>
          {hasNegative && (
            <Badge tone="destructive" className="mr-auto">{negativeStock.length}</Badge>
          )}
        </div>

        {hasNegative ? (
          <div className="scrollbar-hidden max-h-64 overflow-auto">
            <table className="w-full min-w-0 text-sm">
              <thead>
                <tr className="border-b border-border text-right text-xs font-bold text-muted">
                  <th className="py-2 pl-3">الصنف</th>
                  <th className="py-2 pl-3">المخزون الحالي</th>
                  <th className="py-2">الجرد الفعلي</th>
                </tr>
              </thead>
              <tbody>
                {negativeStock.map((product) => (
                  <tr key={product.productId} className="border-b border-border/60 text-right">
                    <td className="py-2.5 pl-3 font-bold text-foreground">
                      <span className="block min-w-0 break-words">{formatProductDisplayName(product.name, product.variantLabel)}</span>
                      {product.barcode && (
                        <span dir="ltr" className="mt-0.5 block break-all font-mono text-xs font-bold text-muted">
                          {product.barcode}
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 pl-3 whitespace-nowrap font-black tabular-nums text-destructive">
                      {product.stock}
                    </td>
                    <td className="py-2.5">
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          onSubmitCount(product);
                        }}
                        className="flex items-center gap-2"
                      >
                        <input
                          type="number"
                          min={0}
                          inputMode="numeric"
                          dir="ltr"
                          value={countInputs[product.productId] ?? ""}
                          onChange={(e) => onCountChange(product.productId, e.target.value)}
                          placeholder="0"
                          aria-label={`جرد فعلي لـ ${product.name}`}
                          className="h-9 w-24 rounded-lg border border-border bg-surface-muted px-2 text-right text-sm font-bold tabular-nums text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
                        />
                        <button
                          type="submit"
                          disabled={countingId === product.productId}
                          className="flex h-9 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-black text-primary-foreground transition hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {countingId === product.productId ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <PackageMinus className="h-4 w-4" />
                          )}
                          اعتماد
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="rounded-xl bg-success/10 px-4 py-3.5 text-sm font-bold text-success">
            لا توجد أصناف بمخزون سالب — كل الأرصدة ضمن الحدود
          </p>
        )}
      </section>

      {/* Watch list: low-stock alerts */}
      <section aria-labelledby="stock-alerts-title">
        <div className="mb-2.5 flex items-center gap-2">
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-amber-100 text-amber-700">
            <Boxes className="h-4 w-4" />
          </span>
          <h3 id="stock-alerts-title" className="text-sm font-black text-foreground">
            تنبيهات المخزون
          </h3>
          {stockAlerts.length > 0 && (
            <Badge tone="warning" className="mr-auto">{stockAlerts.length}</Badge>
          )}
        </div>

        {stockAlerts.length === 0 ? (
          <p className="flex items-center gap-2 rounded-xl bg-surface-muted/50 px-4 py-3.5 text-sm font-bold text-muted">
            <AlertTriangle className="h-4 w-4" />
            لا توجد تنبيهات مخزون حالياً
          </p>
        ) : (
          <div className="scrollbar-hidden max-h-56 overflow-auto">
            <table className="w-full min-w-0 text-sm">
              <thead>
                <tr className="border-b border-border text-right text-xs font-bold text-muted">
                  <th className="py-2 pl-3">الصنف</th>
                  <th className="py-2 pl-3">المخزون</th>
                  <th className="py-2">الأيام المتبقية</th>
                </tr>
              </thead>
              <tbody>
                {stockAlerts.slice(0, 8).map((a) => (
                  <tr key={a.productId} className="border-b border-border/60 text-right">
                    <td className="min-w-0 py-2.5 pl-3">
                      <span className="block max-w-full break-words font-bold text-foreground">{a.name}</span>
                    </td>
                    <td className="whitespace-nowrap py-2.5 pl-3 font-black tabular-nums text-muted">{a.stock}</td>
                    <td className="whitespace-nowrap py-2.5">
                      <StockDaysBadge daysOfStockLeft={a.daysOfStockLeft} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
