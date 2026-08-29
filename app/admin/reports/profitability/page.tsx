"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowLeft,
  BadgeDollarSign,
  Download,
  PackageCheck,
  RefreshCw,
  TrendingDown,
  TrendingUp,
  Wallet,
} from "lucide-react";
import {
  DateField,
} from "@/components/ui/Select";
import { PageHeader } from "@/components/ui/Card";
import KpiCard from "@/components/admin/dashboard/KpiCard";
import IncomeStatementPanel from "@/components/admin/reports/profitability/IncomeStatementPanel";
import ProfitabilityTrendChart from "@/components/admin/reports/profitability/ProfitabilityTrendChart";
import ExpenseBreakdownCard from "@/components/admin/reports/profitability/ExpenseBreakdownCard";
import { PurchasesCard, TaxPositionCard } from "@/components/admin/reports/profitability/Cards";
import { fetchProfitabilityReport } from "@/lib/reportsClient";
import { formatMoney } from "@/lib/format";
import type { ProfitabilityResponse } from "@/types/profitability.types";

const DAY_MS = 24 * 60 * 60 * 1000;

function ammanDate(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Amman",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

const today = ammanDate(new Date());
const thirtyDaysAgo = ammanDate(new Date(Date.now() - 29 * DAY_MS));

function deltaLabel(value: number | null): string {
  if (value == null) return "لا توجد قاعدة مقارنة";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}% عن الفترة السابقة`;
}

/** Bounded in-memory query cache so switching range back and forth (or a
 *  remount) reuses prior results instead of re-hitting the network. */
const MAX_CACHED_REPORTS = 12;
const reportCache = new Map<string, ProfitabilityResponse>();

function cacheReport(key: string, body: ProfitabilityResponse): void {
  reportCache.delete(key);
  reportCache.set(key, body);
  if (reportCache.size > MAX_CACHED_REPORTS) {
    const oldest = reportCache.keys().next().value;
    if (oldest !== undefined) reportCache.delete(oldest);
  }
}

export default function ProfitabilityReportPage() {
  const [from, setFrom] = useState(thirtyDaysAgo);
  const [to, setTo] = useState(today);
  const [report, setReport] = useState<ProfitabilityResponse | null>(() => {
    const params = { from: thirtyDaysAgo, to: today };
    return reportCache.get(JSON.stringify(params)) ?? null;
  });
  const [loading, setLoading] = useState(!report);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const params = useMemo(() => ({ from, to }), [from, to]);
  const paramsKey = useMemo(() => JSON.stringify({ from, to }), [from, to]);

  useEffect(() => {
    let alive = true;
    // Deferred into an async continuation: the effect body never synchronously
    // calls setState (react-hooks/set-state-in-effect), and instant-paint stays tidy.
    Promise.resolve().then(() => {
      if (!mountedRef.current) return;
      const cached = reportCache.get(paramsKey);
      if (cached) {
        setReport(cached);
        setLoading(false);
        setError(null);
        return;
      }
      setLoading(true);
      setError(null);
      fetchProfitabilityReport(params)
        .then((body) => {
          if (!alive) return;
          cacheReport(paramsKey, body);
          setReport(body);
        })
        .catch((reason) => {
          if (alive) setError(reason instanceof Error ? reason.message : "تعذر تحميل قائمة الدخل");
        })
        .finally(() => {
          if (alive) setLoading(false);
        });
    });
    return () => {
      alive = false;
    };
  }, [params, paramsKey, reloadKey]);

  const current = report?.current;
  const statement = current?.statement;
  const taxPosition = current?.taxPosition;
  const previous = report?.previous;
  const reliable = current?.quality?.profitReliable ?? true;

  const deltas = useMemo(
    () => ({
      netRevenue: previous?.statement ? (previous.statement.netRevenue === 0 ? null : percentageDelta(statement?.netRevenue ?? 0, previous.statement.netRevenue)) : null,
      knownCogs: previous?.statement ? (previous.statement.knownCogs === 0 ? null : percentageDelta(statement?.knownCogs ?? 0, previous.statement.knownCogs)) : null,
      operatingExpenses: previous?.statement ? (previous.statement.operatingExpenses === 0 ? null : percentageDelta(statement?.operatingExpenses ?? 0, previous.statement.operatingExpenses)) : null,
      operatingProfit: previous?.statement ? (previous.statement.operatingProfit == null || previous.statement.operatingProfit === 0 ? null : percentageDelta(statement?.operatingProfit ?? 0, previous.statement.operatingProfit!)) : null,
    }),
    [statement, previous],
  );

  function percentageDelta(currentValue: number, previousValue: number): number | null {
    if (previousValue === 0) return null;
    return Math.round(((currentValue - previousValue) / Math.abs(previousValue)) * 10000) / 100;
  }

  function exportCsv() {
    if (!current?.statement) return;
    const snapshot = current;
    const rows: Array<Array<string | number>> = [
      ["قائمة الدخل", "من", from, "إلى", to],
      ["البند", "القيمة"],
      ["صافي الإيراد قبل الضريبة", snapshot.statement.netRevenue],
      ["ضريبة المخرجات", snapshot.statement.outputTax],
      ["ضريبة المدخلات القابلة للخصم", snapshot.taxPosition?.deductibleInputTax ?? 0],
      ["صافي الضريبة المستحقة", snapshot.taxPosition?.netPayable ?? 0],
      ["تكلفة البضاعة الموثقة", snapshot.statement.knownCogs],
      ["الربح الإجمالي", snapshot.statement.grossProfit ?? snapshot.statement.grossProfitCandidate],
      ["المصروفات التشغيلية", snapshot.statement.operatingExpenses],
      ["الربح التشغيلي", snapshot.statement.operatingProfit ?? snapshot.statement.operatingProfitCandidate],
      ["جودة التكلفة", snapshot.quality?.profitReliable ? "مكتملة" : "ناقصة"],
      ["أسطر بلا تكلفة", snapshot.quality?.zeroCostLineCount ?? 0],
      [],
      ["المصروفات حسب الفئة", "العدد", "القيمة"],
      ...(snapshot.expenseBreakdown ?? []).map((group) => [group.category, group.entryCount, group.amount]),
      [],
      ["التاريخ", "الإيراد", "التكلفة", "المصروفات", "الربح التشغيلي"],
      ...(snapshot.trend ?? []).map((point) => [
        point.date,
        point.revenue,
        point.cogs,
        point.expenses,
        point.operatingProfit ?? "غير محسوم",
      ]),
    ];
    const csv = rows
      .map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(","))
      .join("\r\n");
    const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `profitability-${from}-${to}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="min-w-0 space-y-5">
      <PageHeader
        title="قائمة الدخل والربح التشغيلي"
        subtitle="الإيراد قبل الضريبة، تكلفة البضاعة عند البيع، المصروفات، ومقارنة الفترة السابقة"
        action={(
          <>
            <button
              type="button"
              onClick={exportCsv}
              disabled={!report || loading}
              className="inline-flex h-10 items-center gap-2 rounded-lg border border-border bg-surface px-3 text-sm font-black text-foreground hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Download className="h-4 w-4" />
              تصدير CSV
            </button>
            <button
              type="button"
              onClick={() => setReloadKey((key) => key + 1)}
              className="inline-flex h-10 items-center gap-2 rounded-lg border border-border bg-surface px-3 text-sm font-black text-foreground hover:bg-surface-muted"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
              تحديث
            </button>
            <Link href="/admin/reports" className="inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-3 text-sm font-black text-primary-foreground hover:bg-primary-hover">
              مركز التقارير
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </>
        )}
      />

      {/* Range + comparison hint — calm filter card with unified fields */}
      <section className="min-w-0 rounded-2xl border border-border bg-surface p-4 shadow-sm">
        <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <label className="grid min-w-0 gap-1.5">
            <span className="text-xs font-black text-muted">من</span>
            <DateField value={from} onChange={setFrom} />
          </label>
          <label className="grid min-w-0 gap-1.5">
            <span className="text-xs font-black text-muted">إلى</span>
            <DateField value={to} onChange={setTo} />
          </label>
          <p className="min-w-52 text-xs font-bold leading-5 text-muted xl:col-span-2 xl:self-end">
            تتم المقارنة تلقائياً بفترة سابقة مساوية في عدد الأيام، ولا تُعامل المشتريات كمصروف مرة ثانية.
          </p>
        </div>
      </section>

      {error ? (
        <div className="rounded-lg border border-destructive/20 bg-destructive-soft px-4 py-3 text-sm font-bold text-destructive-strong">{error}</div>
      ) : null}

      {current && !reliable ? (
        <section className="flex items-start gap-3 rounded-2xl border border-warning/20 bg-warning-soft px-4 py-3 text-warning-strong">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
          <div>
            <h2 className="text-sm font-black">الربح النهائي غير محسوم</h2>
            <p className="mt-1 text-xs font-bold leading-5">
              يوجد {current.quality?.zeroCostLineCount ?? 0} سطر بيع بلا تكلفة، بقيمة مبيعات {formatMoney(current.quality?.zeroCostNetSales ?? 0)}.
              لذلك نعرض تكلفة البضاعة الموثقة، ولا نعتمد الربح الإجمالي أو التشغيلي كرقم نهائي.
            </p>
          </div>
        </section>
      ) : null}

      {/* Financial totals — calm enterprise KPI cards */}
      <div className="grid min-w-0 grid-cols-2 gap-4 [&>*]:min-w-0 sm:grid-cols-3 xl:grid-cols-4">
        <KpiCard
          label="صافي الإيراد قبل الضريبة"
          value={statement ? formatMoney(statement.netRevenue) : "—"}
          icon={TrendingUp}
          tone="primary"
          hint={deltas?.netRevenue != null ? deltaLabel(deltas.netRevenue) : undefined}
        />
        <KpiCard
          label="تكلفة البضاعة الموثقة"
          value={statement ? formatMoney(statement.knownCogs) : "—"}
          icon={PackageCheck}
          hint={deltas?.knownCogs != null ? deltaLabel(deltas.knownCogs) : undefined}
        />
        <KpiCard
          label="المصروفات التشغيلية"
          value={statement ? formatMoney(statement.operatingExpenses) : "—"}
          icon={Wallet}
          tone={statement && statement.operatingExpenses > 0 ? "destructive" : "default"}
          hint={deltas?.operatingExpenses != null ? deltaLabel(deltas.operatingExpenses) : undefined}
        />
        <KpiCard
          label="الربح التشغيلي"
          value={statement ? (statement.operatingProfit == null ? "غير محسوم" : formatMoney(statement.operatingProfit)) : "—"}
          icon={statement?.operatingProfit != null && statement.operatingProfit < 0 ? TrendingDown : BadgeDollarSign}
          tone={statement?.operatingProfit != null ? (statement.operatingProfit < 0 ? "destructive" : "success") : "default"}
          hint={deltas?.operatingProfit != null ? deltaLabel(deltas.operatingProfit) : undefined}
        />
      </div>

      {/* Income statement + trend */}
      <div className="grid min-w-0 gap-5 lg:grid-cols-2">
        <IncomeStatementPanel statement={statement} reliable={reliable} />
        <section className="min-w-0 overflow-hidden rounded-2xl border border-border bg-surface p-5 shadow-card">
          <div className="h-72 min-w-0">
            <ProfitabilityTrendChart points={current?.trend ?? []} />
          </div>
        </section>
      </div>

      {/* Expenses, purchases, tax */}
      <div className="grid min-w-0 gap-5 lg:grid-cols-3">
        <ExpenseBreakdownCard groups={current?.expenseBreakdown} loading={loading} />
        <PurchasesCard purchases={current?.purchases} />
        <TaxPositionCard taxPosition={taxPosition} statement={statement} />
      </div>

      {loading ? (
        <div className="fixed bottom-4 left-1/2 z-40 -translate-x-1/2 rounded-full border border-border bg-surface px-4 py-2 text-sm font-black text-muted shadow-elevated">
          جارٍ إعداد قائمة الدخل…
        </div>
      ) : null}
    </div>
  );
}