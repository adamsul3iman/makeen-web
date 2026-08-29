"use client";

import { useMemo } from "react";
import { formatMoney } from "@/lib/format";
import { cn } from "@/lib/cn";
import type { ProfitabilityExpenseGroup } from "@/types/profitability.types";

const EXPENSE_LABELS: Record<string, string> = {
  transport: "نقل وتوصيل",
  utilities: "فواتير وخدمات",
  general: "مصروف عام",
  supplies: "قرطاسية ولوازم",
  maintenance: "صيانة",
};

/** Restrained categorical fills — calm enterprise, no neon. */
const CATEGORY_COLOR: Record<string, string> = {
  transport: "bg-slate-600",
  utilities: "bg-blue-700",
  general: "bg-slate-500",
  supplies: "bg-warning-strong",
  maintenance: "bg-info-strong",
};

const FALLBACK_COLOR = "bg-slate-400";

interface ExpenseBreakdownCardProps {
  groups?: ProfitabilityExpenseGroup[];
  loading?: boolean;
}

export default function ExpenseBreakdownCard({ groups = [], loading = false }: ExpenseBreakdownCardProps) {
  const sorted = useMemo(
    () => [...groups].sort((a, b) => b.amount - a.amount),
    [groups],
  );
  const maxAmount = useMemo(
    () => Math.max(0, ...sorted.map((group) => group.amount)),
    [sorted],
  );

  return (
    <section className="min-w-0 rounded-2xl border border-border bg-surface p-5 shadow-card">
      <h2 className="text-sm font-black text-foreground">المصروفات حسب الفئة</h2>
      <div className="mt-4 space-y-4">
        {sorted.map((group) => (
          <div key={group.category} className="min-w-0">
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="min-w-0 truncate font-bold text-foreground">{EXPENSE_LABELS[group.category] ?? group.category}</span>
              <span className="shrink-0 font-black tabular-nums text-foreground">{formatMoney(group.amount)}</span>
            </div>
            <div className="mt-2 h-2 min-w-0 overflow-hidden rounded-full bg-surface-muted">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${maxAmount > 0 ? Math.max(3, (group.amount / maxAmount) * 100) : 0}%`,
                }}
              >
                <div className={cn("h-full w-full rounded-full", CATEGORY_COLOR[group.category] ?? FALLBACK_COLOR)} />
              </div>
            </div>
            <p className="mt-1 text-xs font-bold text-muted">{group.entryCount} حركة</p>
          </div>
        ))}
        {!loading && sorted.length === 0 ? (
          <p className="py-8 text-center text-sm font-bold text-muted">لا توجد مصروفات في الفترة.</p>
        ) : null}
      </div>
    </section>
  );
}