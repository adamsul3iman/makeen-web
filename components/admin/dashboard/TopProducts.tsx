"use client";

import { Crown } from "lucide-react";
import { formatMoney } from "@/lib/format";
import type { ReportsTopProduct } from "@/types/reports.types";

export default function TopProducts({ products }: { products: ReportsTopProduct[] }) {
  if (products.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-surface-muted/40 py-12 text-center">
        <Crown className="h-8 w-8 text-muted-foreground" />
        <p className="mt-3 text-sm font-bold text-foreground">لا توجد مبيعات ضمن الفترة</p>
        <p className="mt-1 text-xs font-semibold text-muted">ستظهر الأصناف الأكثر مبيعاً بمجرد توفر مبيعات.</p>
      </div>
    );
  }

  return (
    <div className="scrollbar-hidden max-h-80 overflow-auto">
      <table className="w-full min-w-0 text-sm">
        <thead>
          <tr className="border-b border-border text-right text-xs font-bold text-muted">
            <th className="py-2 pl-3">الصنف</th>
            <th className="py-2 pl-3">الكمية</th>
            <th className="py-2 pl-3">المبيعات</th>
            <th className="py-2">المخزون</th>
          </tr>
        </thead>
        <tbody>
          {products.slice(0, 8).map((p) => (
            <tr key={`${p.productId}-${p.barcode || ""}`} className="border-b border-border/60 text-right">
              <td className="min-w-0 py-2.5 pl-3">
                <span className="block max-w-full break-words font-bold text-foreground">{p.name}</span>
              </td>
              <td className="whitespace-nowrap py-2.5 pl-3 font-semibold tabular-nums text-muted">{p.quantity}</td>
              <td className="whitespace-nowrap py-2.5 pl-3 font-black tabular-nums text-foreground">{formatMoney(p.sales)}</td>
              <td className="whitespace-nowrap py-2.5 tabular-nums text-muted">{p.stock ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
