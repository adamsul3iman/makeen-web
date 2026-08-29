"use client";

import { Calculator } from "lucide-react";
import { formatMoney } from "@/lib/format";
import type { ProfitabilityStatementValues } from "@/types/profitability.types";
import { cn } from "@/lib/cn";

interface StatementRowProps {
  label: string;
  value: string;
  strong?: boolean;
  negative?: boolean;
  muted?: boolean;
}

function StatementRow({ label, value, strong = false, negative = false, muted = false }: StatementRowProps) {
  return (
    <div
      className={cn(
        "flex min-w-0 items-center justify-between gap-3 border-b border-border/70 px-4 py-3",
        strong && "bg-surface-muted/60",
      )}
    >
      <span className={cn("min-w-0 break-words", strong ? "text-sm font-black text-foreground" : "text-sm font-bold text-muted")}>
        {label}
      </span>
      <span
        className={cn(
          "shrink-0 font-black tabular-nums",
          negative ? "text-destructive-strong" : "text-foreground",
          muted && "text-muted",
        )}
      >
        {value}
      </span>
    </div>
  );
}

interface IncomeStatementPanelProps {
  statement?: ProfitabilityStatementValues;
  reliable: boolean;
}

export default function IncomeStatementPanel({ statement, reliable }: IncomeStatementPanelProps) {
  return (
    <section className="min-w-0 overflow-hidden rounded-2xl border border-border bg-surface shadow-card">
      <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-3.5">
        <h2 className="flex min-w-0 items-center gap-2 text-sm font-black text-foreground">
          <Calculator className="h-4 w-4 shrink-0 text-muted" />
          قائمة الدخل
        </h2>
        <span
          className={cn(
            "shrink-0 rounded-full px-2.5 py-1 text-xs font-black",
            reliable ? "bg-success-soft text-success-strong" : "bg-warning-soft text-warning-strong",
          )}
        >
          {reliable ? "تكلفة مكتملة" : "تحتاج استكمال تكلفة"}
        </span>
      </header>

      <div className="min-w-0">
        <StatementRow label="صافي إيراد المبيعات قبل الضريبة" value={statement ? formatMoney(statement.netRevenue) : "—"} />
        <StatementRow label="(-) تكلفة البضاعة المباعة الموثقة" value={statement ? formatMoney(statement.knownCogs) : "—"} negative muted />
        <StatementRow
          label="الربح الإجمالي"
          value={statement ? formatMoney(statement.grossProfit ?? statement.grossProfitCandidate) : "—"}
          strong
        />
        <StatementRow label="(-) المصروفات التشغيلية" value={statement ? formatMoney(statement.operatingExpenses) : "—"} negative muted />
        <StatementRow
          label="الربح التشغيلي"
          value={statement ? formatMoney(statement.operatingProfit ?? statement.operatingProfitCandidate) : "—"}
          strong
        />

        <div className="grid min-w-0 grid-cols-2 gap-3 border-t border-border bg-surface-muted/40 px-4 py-4">
          <div className="min-w-0">
            <p className="text-xs font-bold text-muted">الخصومات</p>
            <p className="mt-1 font-black tabular-nums text-foreground">{statement ? formatMoney(statement.discounts) : "—"}</p>
          </div>
          <div className="min-w-0">
            <p className="text-xs font-bold text-muted">المرتجعات قبل الضريبة</p>
            <p className="mt-1 font-black tabular-nums text-destructive-strong">{statement ? formatMoney(statement.returnsExcludingTax) : "—"}</p>
          </div>
        </div>
      </div>
    </section>
  );
}