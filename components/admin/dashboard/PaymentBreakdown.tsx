"use client";

import { useMemo } from "react";
import { Banknote, CreditCard, HandCoins, Smartphone, CircleDollarSign } from "lucide-react";
import { formatMoney } from "@/lib/format";
import type { ReportsPaymentBreakdown } from "@/types/reports.types";
import { cn } from "@/lib/cn";

const METHOD_ICON: Record<string, typeof Banknote> = {
  CASH: Banknote,
  VISA: CreditCard,
  CLIQ: Smartphone,
  DEBT: HandCoins,
  SPLIT: CircleDollarSign,
};

/** Restrained, muted palette so the bar reads as a calm enterprise summary. */
const METHOD_COLOR: Record<string, string> = {
  CASH: "bg-slate-700",
  VISA: "bg-blue-600",
  CLIQ: "bg-amber-500",
  DEBT: "bg-rose-400",
};

const FALLBACK_COLOR = "bg-slate-300";

interface PaymentBreakdownProps {
  methods: ReportsPaymentBreakdown[];
}

export default function PaymentBreakdown({ methods }: PaymentBreakdownProps) {
  const rows = useMemo(
    () =>
      methods
        .map((m) => ({
          icon: METHOD_ICON[m.method] ?? CircleDollarSign,
          color: METHOD_COLOR[m.method] ?? FALLBACK_COLOR,
          method: m,
        }))
        .sort((a, b) => Math.abs(b.method.amount) - Math.abs(a.method.amount)),
    [methods],
  );

  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-surface-muted/40 py-12 text-center">
        <CircleDollarSign className="h-8 w-8 text-muted-foreground" />
        <p className="mt-3 text-sm font-bold text-foreground">لا توجد مبيعات ضمن الفترة</p>
        <p className="mt-1 text-xs font-semibold text-muted">ستظهر توزيعات طرق الدفع بمجرد توفر مبيعات.</p>
      </div>
    );
  }

  const denominator = rows.reduce((sum, r) => sum + Math.abs(r.method.amount), 0) || 1;

  return (
    <div className="space-y-5">
      {/* Segmented distribution bar — pure CSS, no resize lag. */}
      <div className="flex h-3 w-full min-w-0 overflow-hidden rounded-full bg-surface-muted">
        {rows.map((r) => (
          <div
            key={r.method.method}
            title={`${r.method.label} — ${r.method.share}%`}
            className={cn("h-full min-w-[2px]", r.color)}
            style={{ width: `${Math.max(0, (Math.abs(r.method.amount) / denominator) * 100)}%` }}
          />
        ))}
      </div>

      <ul className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
        {rows.map((r) => {
          const Icon = r.icon;
          return (
            <li key={r.method.method} className="flex min-w-0 items-center gap-3 rounded-xl border border-border/70 bg-surface-muted/40 px-3 py-2.5">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-surface text-muted ring-1 ring-border">
                <Icon className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate text-sm font-bold text-foreground">{r.method.label}</p>
                  <p className="shrink-0 text-xs font-black tabular-nums text-muted">{r.method.share}%</p>
                </div>
                <div className="mt-0.5 flex items-center justify-between gap-2">
                  <p className="min-w-0 truncate text-sm font-black tabular-nums text-foreground">{formatMoney(r.method.amount)}</p>
                  <p className="shrink-0 text-[11px] font-semibold tabular-nums text-muted">{r.method.count} فاتورة</p>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
