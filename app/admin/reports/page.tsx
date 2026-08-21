"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Banknote,
  BarChart3,
  Calculator,
  CalendarDays,
  CreditCard,
  Download,
  PackageSearch,
  RefreshCw,
  ReceiptText,
  RotateCcw,
  ShieldAlert,
  TrendingUp,
  WalletCards,
} from "lucide-react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatMoney } from "@/lib/format";
import { posFetch } from "@/lib/tenantClient";
import type { ReportsOverview } from "@/types/reports.types";

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

const today = isoDate(new Date());
const thirtyDaysAgo = isoDate(new Date(Date.now() - 29 * 24 * 60 * 60 * 1000));

function pct(value: number | null): string {
  return value == null ? "غير محسوم" : `${value.toFixed(1)}%`;
}

function qty(value: number): string {
  return new Intl.NumberFormat("ar-JO", { maximumFractionDigits: 2 }).format(value);
}

function StatTile({
  label,
  value,
  tone = "neutral",
  icon,
}: {
  label: string;
  value: string;
  tone?: "neutral" | "good" | "bad" | "info" | "warn";
  icon: React.ReactNode;
}) {
  const toneClass =
    tone === "good"
      ? "text-emerald-700 bg-emerald-50 border-emerald-100"
      : tone === "bad"
        ? "text-red-700 bg-red-50 border-red-100"
        : tone === "info"
          ? "text-blue-700 bg-blue-50 border-blue-100"
          : tone === "warn"
            ? "text-amber-700 bg-amber-50 border-amber-100"
            : "text-slate-700 bg-white border-border";
  return (
    <div className={`rounded-lg border p-4 ${toneClass}`}>
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-black">{label}</p>
        <span className="shrink-0">{icon}</span>
      </div>
      <p className="mt-3 text-2xl font-black tabular-nums">{value}</p>
    </div>
  );
}

export default function AdminReportsPage() {
  const [from, setFrom] = useState(thirtyDaysAgo);
  const [to, setTo] = useState(today);
  const [overview, setOverview] = useState<ReportsOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let alive = true;
    const loadingTimer = window.setTimeout(() => {
      if (!alive) return;
      setLoading(true);
      setError(null);
    }, 0);
    posFetch(`/api/reports/overview?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, {
      cache: "no-store",
    })
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error(data?.error ?? "تعذر تحميل التقرير");
        return data as { overview?: ReportsOverview };
      })
      .then((data) => {
        if (alive) setOverview(data.overview ?? null);
      })
      .catch((err) => {
        if (alive) setError(err instanceof Error ? err.message : "تعذر تحميل التقرير");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
      window.clearTimeout(loadingTimer);
    };
  }, [from, to, reloadKey]);

  const summary = overview?.summary;
  const qualityTone = useMemo(() => {
    if (!overview || overview.dataQuality.some((issue) => issue.severity === "high")) return "bad";
    if (overview.dataQuality.some((issue) => issue.severity === "medium")) return "warn";
    return "good";
  }, [overview]);

  function exportCsv() {
    if (!overview) return;
    const rows = [
      ["القسم", "الاسم", "القيمة 1", "القيمة 2", "القيمة 3"],
      ["ملخص", "صافي المبيعات", overview.summary.netSales, "الربح", overview.summary.profit ?? "غير محسوم"],
      ["ملخص", "الضريبة", overview.summary.tax, "الفواتير", overview.summary.invoiceCount],
      ...overview.paymentBreakdown.map((p) => ["طرق الدفع", p.label, p.amount, "النسبة", p.share]),
      ...overview.topProducts.map((p) => ["أفضل المنتجات", p.name, p.sales, "الكمية", p.quantity]),
      ...overview.dataQuality.map((q) => ["جودة البيانات", q.label, q.count, q.severity, q.amount ?? ""]),
    ];
    const csv = rows
      .map((row) =>
        row
          .map((cell) => `"${String(cell).replaceAll('"', '""')}"`)
          .join(","),
      )
      .join("\n");
    const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `alburj-reports-${from}-${to}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h1 className="text-2xl font-black text-foreground">مركز التقارير والذكاء التجاري</h1>
          <p className="mt-1 text-sm font-semibold text-muted">
            قراءة محاسبية من سجل البيع الحقيقي: المبيعات، الضريبة، الربح، المخزون، وجودة البيانات.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <Link
            href="/admin/reports/profitability"
            className="inline-flex h-10 items-center gap-2 rounded-lg bg-emerald-600 px-3 text-sm font-black text-white transition hover:bg-emerald-700"
          >
            <Calculator className="h-4 w-4" />
            قائمة الدخل
          </Link>
          <Link
            href="/admin/reports/sales"
            className="inline-flex h-10 items-center gap-2 rounded-lg bg-blue-600 px-3 text-sm font-black text-white transition hover:bg-blue-700"
          >
            <ReceiptText className="h-4 w-4" />
            سجل الفواتير
          </Link>
          <label className="grid gap-1 text-xs font-black text-muted">
            من
            <input
              type="date"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
              className="h-10 rounded-lg border border-border bg-white px-3 text-sm font-bold text-foreground"
            />
          </label>
          <label className="grid gap-1 text-xs font-black text-muted">
            إلى
            <input
              type="date"
              value={to}
              onChange={(event) => setTo(event.target.value)}
              className="h-10 rounded-lg border border-border bg-white px-3 text-sm font-bold text-foreground"
            />
          </label>
          <button
            type="button"
            onClick={() => setReloadKey((key) => key + 1)}
            className="inline-flex h-10 items-center gap-2 rounded-lg bg-slate-900 px-3 text-sm font-black text-white transition hover:bg-slate-800"
          >
            <RefreshCw className="h-4 w-4" />
            تحديث
          </button>
          <button
            type="button"
            disabled={!overview}
            onClick={exportCsv}
            className="inline-flex h-10 items-center gap-2 rounded-lg border border-border bg-white px-3 text-sm font-black text-foreground transition hover:bg-surface-muted disabled:opacity-50"
          >
            <Download className="h-4 w-4" />
            CSV
          </button>
        </div>
      </header>

      {error ? (
        <section className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-bold text-red-700">
          {error}
        </section>
      ) : null}

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        <StatTile label="صافي المبيعات" value={summary ? formatMoney(summary.netSales) : "—"} tone="info" icon={<TrendingUp className="h-5 w-5" />} />
        <StatTile label="الربح الإجمالي" value={summary ? (summary.profit == null ? "غير محسوم" : formatMoney(summary.profit)) : "—"} tone={summary?.profitReliable ? "good" : "warn"} icon={<BarChart3 className="h-5 w-5" />} />
        <StatTile label="هامش الربح" value={summary ? pct(summary.profitMargin) : "—"} tone="good" icon={<WalletCards className="h-5 w-5" />} />
        <StatTile label="ضريبة المبيعات" value={summary ? formatMoney(summary.tax) : "—"} tone="warn" icon={<ShieldAlert className="h-5 w-5" />} />
        <StatTile label="المرتجعات" value={summary ? formatMoney(summary.returns) : "—"} tone={summary && summary.returns > 0 ? "bad" : "neutral"} icon={<RotateCcw className="h-5 w-5" />} />
        <StatTile label="صافي النقد" value={summary ? formatMoney(summary.netCashMovement) : "—"} tone="neutral" icon={<Banknote className="h-5 w-5" />} />
      </section>

      <section className="grid gap-4 xl:grid-cols-[1.35fr_0.65fr]">
        <div className="rounded-lg border border-border bg-white p-4 shadow-sm">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="flex items-center gap-2 text-sm font-black text-foreground">
              <CalendarDays className="h-4 w-4 text-blue-700" />
              حركة المبيعات اليومية
            </h2>
            <span className="text-xs font-bold text-muted">
              {overview ? `${overview.range.days} يوم` : loading ? "جار التحميل" : "لا توجد بيانات"}
            </span>
          </div>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={overview?.trend ?? []} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="#e5e7eb" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="date" reversed tick={{ fontSize: 11, fill: "#64748b" }} tickLine={false} axisLine={{ stroke: "#e5e7eb" }} />
                <YAxis orientation="right" tick={{ fontSize: 11, fill: "#94a3b8" }} tickLine={false} axisLine={false} width={48} />
                <Tooltip
                  formatter={(value, name) => [name === "profit" ? formatMoney(Number(value)) : formatMoney(Number(value)), name === "profit" ? "الربح" : "المبيعات"]}
                  contentStyle={{ borderRadius: 8, border: "1px solid #e5e7eb", fontFamily: "inherit", fontSize: 12 }}
                />
                <Line type="monotone" dataKey="sales" stroke="#2563eb" strokeWidth={2.5} dot={false} />
                <Line type="monotone" dataKey="profit" stroke="#059669" strokeWidth={2.5} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="rounded-lg border border-border bg-white p-4 shadow-sm">
          <h2 className="mb-4 flex items-center gap-2 text-sm font-black text-foreground">
            <CreditCard className="h-4 w-4 text-blue-700" />
            طرق الدفع
          </h2>
          <div className="space-y-3">
            {(overview?.paymentBreakdown ?? []).map((payment) => (
              <div key={payment.method}>
                <div className="mb-1 flex items-center justify-between gap-3 text-sm">
                  <span className="font-black text-foreground">{payment.label}</span>
                  <span className="font-bold tabular-nums text-muted">{formatMoney(payment.amount)}</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                  <div className="h-full rounded-full bg-blue-600" style={{ width: `${Math.min(100, payment.share)}%` }} />
                </div>
                <p className="mt-1 text-xs font-bold tabular-nums text-muted">{pct(payment.share)} • {payment.count} عملية</p>
              </div>
            ))}
            {!loading && overview?.paymentBreakdown.length === 0 ? (
              <p className="py-8 text-center text-sm font-bold text-muted">لا توجد مدفوعات في الفترة.</p>
            ) : null}
          </div>
        </div>
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        <div className="overflow-hidden rounded-lg border border-border bg-white shadow-sm">
          <header className="flex items-center justify-between border-b border-border px-4 py-3">
            <h2 className="flex items-center gap-2 text-sm font-black text-foreground">
              <PackageSearch className="h-4 w-4 text-blue-700" />
              أفضل المنتجات
            </h2>
            <span className="text-xs font-bold text-muted">{overview?.topProducts.length ?? 0} صنف</span>
          </header>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs font-black text-muted">
                <tr>
                  <th className="px-4 py-3 text-right">الصنف</th>
                  <th className="px-4 py-3 text-right">الكمية</th>
                  <th className="px-4 py-3 text-right">المبيعات</th>
                  <th className="px-4 py-3 text-right">الربح</th>
                  <th className="px-4 py-3 text-right">المخزون</th>
                </tr>
              </thead>
              <tbody>
                {(overview?.topProducts ?? []).map((product) => (
                  <tr key={`${product.productId}-${product.barcode}`} className="border-t border-border/70">
                    <td className="max-w-64 px-4 py-3">
                      <p className="truncate font-black text-foreground">{product.name}</p>
                      <p className="mt-0.5 text-xs font-bold text-muted">{product.barcode || "بدون باركود"}</p>
                    </td>
                    <td className="px-4 py-3 font-bold tabular-nums text-muted">{qty(product.quantity)}</td>
                    <td className="px-4 py-3 font-black tabular-nums text-foreground">{formatMoney(product.sales)}</td>
                    <td className={product.profit != null && product.profit < 0 ? "px-4 py-3 font-black tabular-nums text-red-700" : product.profit == null ? "px-4 py-3 font-black tabular-nums text-amber-700" : "px-4 py-3 font-black tabular-nums text-emerald-700"}>
                      {product.profit == null ? "غير محسوم" : formatMoney(product.profit)}
                    </td>
                    <td className={product.stock != null && product.stock <= 0 ? "px-4 py-3 font-black tabular-nums text-red-700" : "px-4 py-3 font-bold tabular-nums text-muted"}>
                      {product.stock ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="overflow-hidden rounded-lg border border-border bg-white shadow-sm">
          <header className="flex items-center justify-between border-b border-border px-4 py-3">
            <h2 className="flex items-center gap-2 text-sm font-black text-foreground">
              <AlertTriangle className="h-4 w-4 text-amber-600" />
              تنبيهات المخزون وجودة البيانات
            </h2>
            <span
              className={
                qualityTone === "bad"
                  ? "rounded-full bg-red-50 px-2 py-1 text-xs font-black text-red-700"
                  : qualityTone === "warn"
                    ? "rounded-full bg-amber-50 px-2 py-1 text-xs font-black text-amber-700"
                    : "rounded-full bg-emerald-50 px-2 py-1 text-xs font-black text-emerald-700"
              }
            >
              {qualityTone === "bad" ? "تحتاج متابعة" : qualityTone === "warn" ? "متوسطة" : "سليمة"}
            </span>
          </header>
          <div className="grid gap-4 p-4 lg:grid-cols-2">
            <div className="space-y-2">
              <p className="text-xs font-black text-muted">المخزون الأكثر خطورة</p>
              {(overview?.stockAlerts ?? []).slice(0, 8).map((alert) => (
                <div key={alert.productId} className="rounded-lg border border-border px-3 py-2">
                  <div className="flex items-center justify-between gap-3">
                    <p className="truncate text-sm font-black text-foreground">{alert.name}</p>
                    <span className={alert.severity === "critical" ? "text-sm font-black tabular-nums text-red-700" : "text-sm font-black tabular-nums text-amber-700"}>
                      {alert.stock}
                    </span>
                  </div>
                  <p className="mt-1 text-xs font-bold text-muted">
                    بيع {qty(alert.soldQuantity)} • {alert.daysOfStockLeft === null ? "لا توجد سرعة بيع" : `${alert.daysOfStockLeft} يوم متبقٍ`}
                  </p>
                </div>
              ))}
              {!loading && overview?.stockAlerts.length === 0 ? (
                <p className="rounded-lg bg-slate-50 px-3 py-6 text-center text-sm font-bold text-muted">لا توجد تنبيهات مخزون للفترة.</p>
              ) : null}
            </div>
            <div className="space-y-2">
              <p className="text-xs font-black text-muted">جودة البيانات</p>
              {(overview?.dataQuality ?? []).map((issue) => (
                <div
                  key={issue.id}
                  className={
                    issue.severity === "high"
                      ? "rounded-lg border border-red-100 bg-red-50 px-3 py-2"
                      : issue.severity === "medium"
                        ? "rounded-lg border border-amber-100 bg-amber-50 px-3 py-2"
                        : "rounded-lg border border-slate-100 bg-slate-50 px-3 py-2"
                  }
                >
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-black text-foreground">{issue.label}</p>
                    <span className="text-sm font-black tabular-nums text-foreground">{issue.count}</span>
                  </div>
                  <p className="mt-1 text-xs font-bold leading-5 text-muted">{issue.description}</p>
                </div>
              ))}
              {!loading && overview?.dataQuality.length === 0 ? (
                <p className="rounded-lg bg-emerald-50 px-3 py-6 text-center text-sm font-bold text-emerald-700">لا توجد مشاكل جودة واضحة.</p>
              ) : null}
            </div>
          </div>
        </div>
      </section>

      {loading ? (
        <div className="fixed inset-x-0 bottom-4 mx-auto w-fit rounded-full border border-border bg-white px-4 py-2 text-sm font-black text-muted shadow-lg">
          جارٍ تحميل التقارير…
        </div>
      ) : null}
    </div>
  );
}
