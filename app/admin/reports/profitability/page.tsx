"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowRight,
  BadgeDollarSign,
  Calculator,
  Download,
  PackageCheck,
  ReceiptText,
  RefreshCw,
  TrendingDown,
  TrendingUp,
  Wallet,
} from "lucide-react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatMoney } from "@/lib/format";
import { fetchProfitabilityReport } from "@/lib/reportsClient";
import type { ProfitabilityResponse } from "@/types/profitability.types";

const DAY_MS = 24 * 60 * 60 * 1000;
const EXPENSE_LABELS: Record<string, string> = {
  transport: "نقل وتوصيل",
  utilities: "فواتير وخدمات",
  general: "مصروف عام",
  supplies: "قرطاسية ولوازم",
  maintenance: "صيانة",
};

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

function Metric({
  label,
  value,
  delta,
  tone = "neutral",
  icon,
}: {
  label: string;
  value: string;
  delta?: number | null;
  tone?: "neutral" | "good" | "bad" | "warn" | "info";
  icon: React.ReactNode;
}) {
  const toneClass =
    tone === "good"
      ? "border-green-100 bg-green-50 text-green-800"
      : tone === "bad"
        ? "border-red-100 bg-red-50 text-red-800"
        : tone === "warn"
          ? "border-amber-100 bg-amber-50 text-amber-800"
          : tone === "info"
            ? "border-blue-100 bg-blue-50 text-blue-800"
            : "border-border bg-white text-slate-800";
  return (
    <article className={`rounded-lg border p-4 ${toneClass}`}>
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-black">{label}</p>
        <span className="shrink-0">{icon}</span>
      </div>
      <p className="mt-3 text-xl font-black tabular-nums sm:text-2xl">{value}</p>
      {delta !== undefined ? (
        <p className="mt-2 text-xs font-bold opacity-75">{deltaLabel(delta)}</p>
      ) : null}
    </article>
  );
}

function StatementRow({
  label,
  value,
  strong = false,
  negative = false,
}: {
  label: string;
  value: string;
  strong?: boolean;
  negative?: boolean;
}) {
  return (
    <div className={`flex items-center justify-between gap-4 border-t border-border px-4 py-3 ${strong ? "bg-slate-50" : ""}`}>
      <span className={strong ? "font-black text-foreground" : "font-bold text-muted"}>{label}</span>
      <span className={`shrink-0 font-black tabular-nums ${negative ? "text-red-700" : "text-foreground"}`}>
        {value}
      </span>
    </div>
  );
}

export default function ProfitabilityReportPage() {
  const [from, setFrom] = useState(thirtyDaysAgo);
  const [to, setTo] = useState(today);
  const [report, setReport] = useState<ProfitabilityResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let alive = true;
    const loadingTimer = window.setTimeout(() => {
      if (!alive) return;
      setLoading(true);
      setError("");
    }, 0);
    fetchProfitabilityReport({ from, to })
      .then((body) => {
        if (alive) setReport(body as unknown as ProfitabilityResponse);
      })
      .catch((reason) => {
        if (alive) setError(reason instanceof Error ? reason.message : "تعذر تحميل قائمة الدخل");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
      window.clearTimeout(loadingTimer);
    };
  }, [from, to, reloadKey]);

  const current = report?.current;
  const statement = current?.statement;
  const taxPosition = current?.taxPosition;
  // Server payloads are loosely shaped (older RPC versions omit deltaPercent
  // and friends), so EVERY nested read stays optional-chained — one missing
  // section must degrade to "—" instead of crashing the whole report page.
  const deltas = report?.deltaPercent;
  const reliable = current?.quality?.profitReliable ?? true;
  const maxExpense = useMemo(
    () => Math.max(0, ...(current?.expenseBreakdown?.map((group) => group.amount) ?? [])),
    [current?.expenseBreakdown],
  );

  function exportCsv() {
    if (!report?.current?.statement) return;
    const snapshot = report.current;
    const rows: Array<Array<string | number>> = [
      ["قائمة الدخل", "من", from, "إلى", to],
      ["البند", "القيمة"],
      ["صافي الإيراد قبل الضريبة", snapshot.statement.netRevenue],
      ["ضريبة المخرجات", snapshot.statement.outputTax],
      ["ضريبة المدخلات القابلة للخصم", snapshot.taxPosition?.deductibleInputTax ?? 0],
      ["صافي الضريبة المستحقة", snapshot.taxPosition?.netPayable ?? 0],
      ["تكلفة البضاعة الموثقة", snapshot.statement.knownCogs],
      ["الربح الإجمالي", snapshot.statement.grossProfit ?? formatMoney(snapshot.statement.grossProfitCandidate ?? "—")],
      ["المصروفات التشغيلية", snapshot.statement.operatingExpenses],
      ["الربح التشغيلي", snapshot.statement.operatingProfit ?? formatMoney(snapshot.statement.operatingProfitCandidate ?? "—")],
      ["جودة التكلفة", snapshot.quality?.profitReliable ? "مكتملة" : "ناقصة"],
      ["أسطر بلا تكلفة", snapshot.quality?.zeroCostLineCount ?? 0],
      [],
      ["المصروفات حسب الفئة", "العدد", "القيمة"],
      ...(snapshot.expenseBreakdown ?? []).map((group) => [
        EXPENSE_LABELS[group.category] ?? group.category,
        group.entryCount,
        group.amount,
      ]),
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
    <div className="space-y-6">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-xs font-black text-green-700">دفتر الربحية</p>
          <h1 className="mt-1 text-2xl font-black text-foreground">قائمة الدخل والربح التشغيلي</h1>
          <p className="mt-1 text-sm font-semibold text-muted">
            الإيراد قبل الضريبة، تكلفة البضاعة عند البيع، المصروفات، ومقارنة الفترة السابقة.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <Link href="/admin/reports" className="inline-flex h-10 items-center gap-2 rounded-lg bg-slate-900 px-3 text-sm font-black text-white">
            <ArrowRight className="h-4 w-4" /> مركز التقارير
          </Link>
          <button type="button" onClick={exportCsv} disabled={!report || loading} className="inline-flex h-10 items-center gap-2 rounded-lg border border-border bg-white px-3 text-sm font-black text-foreground disabled:opacity-40">
            <Download className="h-4 w-4" /> تصدير CSV
          </button>
          <button type="button" onClick={() => setReloadKey((key) => key + 1)} className="inline-flex h-10 items-center gap-2 rounded-lg border border-border bg-white px-3 text-sm font-black text-foreground">
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /> تحديث
          </button>
        </div>
      </header>

      <section className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-white p-4">
        <label className="grid min-w-44 flex-1 gap-1 text-xs font-black text-muted">
          من
          <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} className="h-11 rounded-lg border border-border px-3 text-sm font-bold" />
        </label>
        <label className="grid min-w-44 flex-1 gap-1 text-xs font-black text-muted">
          إلى
          <input type="date" value={to} onChange={(event) => setTo(event.target.value)} className="h-11 rounded-lg border border-border px-3 text-sm font-bold" />
        </label>
        <p className="min-w-52 flex-[2] text-xs font-bold leading-5 text-muted">
          تتم المقارنة تلقائياً بفترة سابقة مساوية في عدد الأيام، ولا تُعامل المشتريات كمصروف مرة ثانية.
        </p>
      </section>

      {error ? <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-black text-red-700">{error}</div> : null}

      {!loading && current && !reliable ? (
        <section className="flex gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-4 text-amber-950">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
          <div>
            <h2 className="text-sm font-black">الربح النهائي غير محسوم</h2>
            <p className="mt-1 text-sm font-bold leading-6">
              يوجد {current?.quality?.zeroCostLineCount ?? 0} سطر بيع بلا تكلفة، بقيمة مبيعات {formatMoney(current?.quality?.zeroCostNetSales ?? 0)}.
              لذلك نعرض تكلفة البضاعة الموثقة، ولا نعتمد الربح الإجمالي أو التشغيلي كرقم نهائي.
            </p>
          </div>
        </section>
      ) : null}

      <section className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Metric label="صافي الإيراد قبل الضريبة" value={statement ? formatMoney(statement.netRevenue) : "—"} delta={deltas?.netRevenue} tone="info" icon={<TrendingUp className="h-4 w-4" />} />
        <Metric label="تكلفة البضاعة الموثقة" value={statement ? formatMoney(statement.knownCogs) : "—"} delta={deltas?.knownCogs} icon={<PackageCheck className="h-4 w-4" />} />
        <Metric label="المصروفات التشغيلية" value={statement ? formatMoney(statement.operatingExpenses) : "—"} delta={deltas?.operatingExpenses} tone="warn" icon={<Wallet className="h-4 w-4" />} />
        <Metric
          label="الربح التشغيلي"
          value={statement ? (statement.operatingProfit == null ? "—" : formatMoney(statement.operatingProfit)) : "—"}
          delta={deltas?.operatingProfit}
          tone={statement?.operatingProfit != null && statement.operatingProfit < 0 ? "bad" : reliable ? "good" : "warn"}
          icon={statement?.operatingProfit != null && statement.operatingProfit < 0 ? <TrendingDown className="h-4 w-4" /> : <BadgeDollarSign className="h-4 w-4" />}
        />
        {statement?.operatingProfit == null && !reliable && (
          <p className="mt-2 text-xs text-amber-800">الربح التشغيلي غير محسوب بسبب وجود أسطر بدون تكلفة</p>
        )}
      </section>

      <section className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
        <div className="overflow-hidden rounded-lg border border-border bg-white">
          <header className="flex items-center justify-between gap-3 px-4 py-4">
            <h2 className="flex items-center gap-2 text-sm font-black text-foreground"><Calculator className="h-4 w-4 text-green-700" /> قائمة الدخل</h2>
            <span className={`rounded-full px-2 py-1 text-xs font-black ${reliable ? "bg-green-50 text-green-700" : "bg-amber-50 text-amber-700"}`}>
              {reliable ? "تكلفة مكتملة" : "تحتاج استكمال تكلفة"}
            </span>
          </header>
          <StatementRow label="صافي إيراد المبيعات قبل الضريبة" value={statement ? formatMoney(statement.netRevenue) : "—"} />
          <StatementRow label="(-) تكلفة البضاعة المباعة الموثقة" value={statement ? formatMoney(statement.knownCogs) : "—"} negative />
          <StatementRow label="الربح الإجمالي" value={statement ? (statement.grossProfit == null ? formatMoney(statement.grossProfitCandidate ?? "—") : formatMoney(statement.grossProfit)) : "—"} strong />
          <StatementRow label="(-) المصروفات التشغيلية" value={statement ? formatMoney(statement.operatingExpenses) : "—"} negative />
          <StatementRow label="الربح التشغيلي" value={statement ? (statement.operatingProfit == null ? formatMoney(statement.operatingProfitCandidate ?? "—") : formatMoney(statement.operatingProfit)) : "—"} strong />
          <div className="grid grid-cols-2 border-t border-border bg-slate-50 px-4 py-4 text-xs">
            <div><p className="font-bold text-muted">الخصومات</p><p className="mt-1 font-black tabular-nums">{statement ? formatMoney(statement.discounts) : "—"}</p></div>
            <div><p className="font-bold text-muted">المرتجعات قبل الضريبة</p><p className="mt-1 font-black tabular-nums text-red-700">{statement ? formatMoney(statement.returnsExcludingTax) : "—"}</p></div>
          </div>
        </div>

        <div className="min-w-0 rounded-lg border border-border bg-white p-4">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="text-sm font-black text-foreground">اتجاه الإيراد والربح التشغيلي</h2>
            <span className="text-xs font-bold text-muted">يومي</span>
          </div>
          <div className="h-72 min-w-0">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={current?.trend ?? []} margin={{ top: 8, right: 0, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="#e5e7eb" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="date" reversed tick={{ fontSize: 10, fill: "#64748b" }} tickLine={false} axisLine={{ stroke: "#e5e7eb" }} />
                <YAxis orientation="right" width={48} tick={{ fontSize: 10, fill: "#94a3b8" }} tickLine={false} axisLine={false} />
                <Tooltip formatter={(value, name) => [formatMoney(Number(value)), name === "revenue" ? "الإيراد" : "الربح التشغيلي"]} contentStyle={{ borderRadius: 8, border: "1px solid #e5e7eb", fontFamily: "inherit", fontSize: 12 }} />
                <Bar dataKey="revenue" fill="#2563eb" radius={[3, 3, 0, 0]} />
                <Line type="monotone" dataKey="operatingProfit" stroke="#059669" strokeWidth={2.5} connectNulls={false} dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>
      </section>

      <section className="grid gap-5 lg:grid-cols-3">
        <div className="rounded-lg border border-border bg-white p-4">
          <h2 className="text-sm font-black text-foreground">المصروفات حسب الفئة</h2>
          <div className="mt-4 space-y-4">
            {(current?.expenseBreakdown ?? []).map((group) => (
              <div key={group.category}>
                <div className="flex items-center justify-between gap-3 text-sm"><span className="font-bold text-foreground">{EXPENSE_LABELS[group.category] ?? group.category}</span><span className="font-black tabular-nums">{formatMoney(group.amount)}</span></div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-amber-500" style={{ width: `${maxExpense > 0 ? Math.max(4, (group.amount / maxExpense) * 100) : 0}%` }} /></div>
                <p className="mt-1 text-xs font-bold text-muted">{group.entryCount} حركة</p>
              </div>
            ))}
            {!loading && current?.expenseBreakdown?.length === 0 ? <p className="py-8 text-center text-sm font-bold text-muted">لا توجد مصروفات في الفترة.</p> : null}
          </div>
        </div>

        <div className="rounded-lg border border-border bg-white p-4">
          <h2 className="flex items-center gap-2 text-sm font-black text-foreground"><PackageCheck className="h-4 w-4 text-blue-700" /> حركة المشتريات</h2>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <div className="border-l border-border pl-3"><p className="text-xs font-bold text-muted">مستلمة خلال الفترة</p><p className="mt-2 text-xl font-black tabular-nums">{current ? formatMoney(current.purchases?.receivedValue ?? 0) : "—"}</p><p className="mt-1 text-xs font-bold text-muted">{current?.purchases?.receivedCount ?? 0} أمر</p></div>
            <div><p className="text-xs font-bold text-muted">التزامات معلقة</p><p className="mt-2 text-xl font-black tabular-nums text-amber-700">{current ? formatMoney(current.purchases?.pendingValue ?? 0) : "—"}</p><p className="mt-1 text-xs font-bold text-muted">{current?.purchases?.pendingCount ?? 0} أمر</p></div>
          </div>
          <p className="mt-5 rounded-lg bg-blue-50 px-3 py-3 text-xs font-bold leading-5 text-blue-900">المشتريات تزيد المخزون ولا تُخصم من الربح فوراً؛ الخصم يحدث عند بيع البضاعة ضمن تكلفة البضاعة المباعة.</p>
        </div>

        <div className="rounded-lg border border-border bg-white p-4">
          <h2 className="flex items-center gap-2 text-sm font-black text-foreground"><ReceiptText className="h-4 w-4 text-amber-700" /> الضريبة وجودة الدفتر</h2>
          <dl className="mt-4 space-y-3 text-sm">
            <div className="flex justify-between gap-3"><dt className="font-bold text-muted">ضريبة مخرجات المبيعات</dt><dd className="font-black tabular-nums">{taxPosition ? formatMoney(taxPosition.outputTax) : "—"}</dd></div>
            <div className="flex justify-between gap-3"><dt className="font-bold text-muted">(-) ضريبة مدخلات الموردين</dt><dd className="font-black tabular-nums text-blue-700">{taxPosition ? formatMoney(taxPosition.deductibleInputTax) : "—"}</dd></div>
            <div className="flex justify-between gap-3 border-t border-border pt-3"><dt className="font-black text-foreground">{taxPosition && taxPosition.netPayable < 0 ? "رصيد ضريبي دائن" : "صافي الضريبة المستحقة"}</dt><dd className={`font-black tabular-nums ${taxPosition && taxPosition.netPayable < 0 ? "text-green-700" : "text-amber-800"}`}>{taxPosition ? formatMoney(Math.abs(taxPosition.netPayable)) : "—"}</dd></div>
            <div className="flex justify-between gap-3"><dt className="font-bold text-muted">إجمالي المقبوضات مع الضريبة</dt><dd className="font-black tabular-nums">{statement ? formatMoney(statement.receiptsIncludingTax) : "—"}</dd></div>
            <div className="flex justify-between gap-3"><dt className="font-bold text-muted">فواتير الفترة</dt><dd className="font-black tabular-nums">{statement?.invoiceCount ?? 0}</dd></div>
            <div className="flex justify-between gap-3"><dt className="font-bold text-muted">مصروفات مسجلة</dt><dd className="font-black tabular-nums">{statement?.expenseCount ?? 0}</dd></div>
          </dl>
          <p className="mt-5 rounded-lg bg-blue-50 px-3 py-3 text-xs font-bold leading-5 text-blue-950">
            تُحتسب ضريبة المدخلات من بنود فواتير الموردين المسجلة فقط. راجع المستندات والتصنيف الضريبي قبل اعتماد الإقرار النهائي.
            <Link href="/admin/supplier-accounts" className="mr-1 font-black text-blue-700 underline underline-offset-2">فتح ذمم الموردين</Link>
          </p>
        </div>
      </section>

      {loading ? <div className="fixed bottom-4 left-1/2 z-40 -translate-x-1/2 rounded-full border border-border bg-white px-4 py-2 text-sm font-black text-muted shadow-lg">جارٍ إعداد قائمة الدخل…</div> : null}
    </div>
  );
}
