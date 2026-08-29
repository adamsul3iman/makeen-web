"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Banknote,
  BarChart3,
  Calculator,
  CalendarDays,
  Download,
  PackageSearch,
  ReceiptText,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  TrendingUp,
  Users,
  Wallet,
  WalletCards,
} from "lucide-react";
import { formatMoney } from "@/lib/format";
import { fetchReportsOverview } from "@/lib/reportsClient";
import { getTenantStoreId } from "@/lib/tenantClient";
import { readDashboardOverview, writeDashboardOverview } from "@/lib/dashboardCache";
import { cn } from "@/lib/cn";
import { PageHeader } from "@/components/ui/Card";
import type { ReportsOverview } from "@/types/reports.types";
import KpiCard from "@/components/admin/dashboard/KpiCard";
import TrendChart from "@/components/admin/dashboard/TrendChart";
import PaymentBreakdown from "@/components/admin/dashboard/PaymentBreakdown";

const DAY_MS = 24 * 60 * 60 * 1000;
const isoDate = (date: Date): string => date.toISOString().slice(0, 10);
// Module-scope constants so render stays pure — no Date.now during render.
const nowMs = Date.now();
const today = isoDate(new Date(nowMs));
const thirtyDaysAgo = isoDate(new Date(nowMs - 29 * DAY_MS));

const QUICK_RANGES = [
  { id: "today", label: "اليوم", from: isoDate(new Date(nowMs)) },
  { id: "7d", label: "آخر ٧ أيام", from: isoDate(new Date(nowMs - 6 * DAY_MS)) },
  { id: "30d", label: "آخر ٣٠ يوم", from: isoDate(new Date(nowMs - 29 * DAY_MS)) },
  { id: "90d", label: "آخر ٩٠ يوم", from: isoDate(new Date(nowMs - 89 * DAY_MS)) },
] as const;

function pct(value: number | null): string {
  return value == null ? "غير محسوم" : `${value.toFixed(1)}%`;
}

function qty(value: number): string {
  return new Intl.NumberFormat("ar-JO", { maximumFractionDigits: 2 }).format(value);
}

export default function AdminReportsPage() {
  const [from, setFrom] = useState(thirtyDaysAgo);
  const [to, setTo] = useState(today);

  // Instant first paint: seed from the last cached 30-day overview so the report
  // renders real data immediately (offline-first), then refresh in the background.
  // Only reused when the requested window matches the cached default, so a custom
  // range never shows mismatched numbers.
  const [overview, setOverview] = useState<ReportsOverview | null>(() => {
    const cached = readDashboardOverview(getTenantStoreId());
    return cached && cached.range?.days === 30 ? cached : null;
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const mountedRef = useRef(true);

  const isDefaultRange = from === thirtyDaysAgo && to === today;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    // Deferred into an async continuation so the effect body never synchronously
    // calls setState (react-hooks/set-state-in-effect).
    Promise.resolve().then(() => {
      const storeId = getTenantStoreId();
      if (!storeId) {
        if (alive) setLoading(false);
        return;
      }
      setError(null);
      setLoading(true);
      fetchReportsOverview(storeId, { from, to })
        .then((body) => {
          if (!alive) return;
          setOverview(body);
          writeDashboardOverview(storeId, body);
        })
        .catch((err) => {
          if (!alive) return;
          setError(err instanceof Error ? err.message : "تعذر تحميل التقرير");
        })
        .finally(() => {
          if (alive) setLoading(false);
        });
    });
    return () => {
      alive = false;
    };
  }, [from, to, reloadKey]);

  const summary = overview?.summary;

  const qualityTone = useMemo(() => {
    if (!overview || overview.dataQuality.some((issue) => issue.severity === "high")) return "bad";
    if (overview.dataQuality.some((issue) => issue.severity === "medium")) return "warn";
    return "good";
  }, [overview]);

  const applyQuickRange = useCallback((fromValue: string) => {
    setTo(today);
    setFrom(fromValue);
  }, []);

  function exportCsv() {
    if (!overview) return;
    const rows: Array<Array<string | number>> = [
      ["القسم", "الاسم", "القيمة 1", "القيمة 2", "القيمة 3"],
      ["ملخص", "صافي المبيعات", overview.summary.netSales, "الربح", overview.summary.profit ?? "غير محسوم"],
      ["ملخص", "الضريبة", overview.summary.tax, "الفواتير", overview.summary.invoiceCount],
      ...overview.paymentBreakdown.map((p) => ["طرق الدفع", p.label, p.amount, "النسبة", p.share]),
      ...overview.topProducts.map((p) => ["أفضل المنتجات", p.name, p.sales, "الكمية", p.quantity]),
      ...overview.dataQuality.map((q) => ["جودة البيانات", q.label, q.count, q.severity, q.amount ?? ""]),
    ];
    const csv = rows
      .map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(","))
      .join("\n");
    const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `alburj-reports-${from}-${to}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  const renderSummaryLoading = isDefaultRange ? !overview : loading;

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        title="مركز التقارير والذكاء التجاري"
        subtitle="قراءة محاسبية من سجل البيع الحقيقي: المبيعات، الضريبة، الربح، المخزون، وجودة البيانات."
        action={
          <>
            <Link
              href="/admin/reports/profitability"
              className="inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-3 text-sm font-black text-primary-foreground transition hover:bg-primary-hover"
            >
              <Calculator className="h-4 w-4" />
              قائمة الدخل
            </Link>
            <Link
              href="/admin/reports/sales"
              className="inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-3 text-sm font-black text-primary-foreground transition hover:bg-primary-hover"
            >
              <ReceiptText className="h-4 w-4" />
              سجل الفواتير
            </Link>
          </>
        }
      />

      {/* Filters — date range + quick presets */}
      <section className="grid min-w-0 gap-3 rounded-2xl border border-border bg-surface p-4 shadow-sm md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,auto)] md:items-end">
        <label className="grid min-w-0 gap-1.5 text-xs font-black text-muted">
          من
          <input
            type="date"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
            className="h-10 min-w-0 rounded-lg border border-border bg-white px-3 text-sm font-bold text-foreground"
          />
        </label>
        <label className="grid min-w-0 gap-1.5 text-xs font-black text-muted">
          إلى
          <input
            type="date"
            value={to}
            onChange={(event) => setTo(event.target.value)}
            className="h-10 min-w-0 rounded-lg border border-border bg-white px-3 text-sm font-bold text-foreground"
          />
        </label>
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="فترات سريعة">
            {QUICK_RANGES.map((range) => {
              const active = from === range.from && to === today;
              return (
                <button
                  key={range.id}
                  type="button"
                  onClick={() => applyQuickRange(range.from)}
                  className={cn(
                    "h-10 rounded-lg border px-3 text-sm font-black transition",
                    active
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border bg-white text-muted hover:bg-surface-muted hover:text-foreground",
                  )}
                >
                  {range.label}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            onClick={() => setReloadKey((key) => key + 1)}
            className="inline-flex h-10 items-center gap-2 rounded-lg border border-border bg-white px-3 text-sm font-black text-foreground transition hover:bg-surface-muted"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            تحديث
          </button>
          <button
            type="button"
            disabled={!overview}
            onClick={exportCsv}
            className="inline-flex h-10 items-center gap-2 rounded-lg border border-border bg-white px-3 text-sm font-black text-foreground transition hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Download className="h-4 w-4" />
            CSV
          </button>
        </div>
      </section>

      {error && !overview && (
        <div className="rounded-2xl border border-destructive/20 bg-destructive-soft px-4 py-3 text-sm font-bold text-destructive-strong">
          {error}
        </div>
      )}

      {/* KPI row — key financial totals */}
      {renderSummaryLoading ? (
        <div className="grid grid-cols-2 gap-4 xl:grid-cols-3 2xl:grid-cols-6 [&>*]:min-w-0">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex min-w-0 flex-col rounded-2xl border border-border bg-surface p-5 shadow-sm">
              <div className="h-3 w-24 animate-pulse rounded bg-surface-muted" />
              <div className="mt-3 h-7 w-28 animate-pulse rounded bg-surface-muted" />
            </div>
          ))}
        </div>
      ) : (
        summary && (
          <>
            <div className="grid grid-cols-2 gap-4 xl:grid-cols-3 2xl:grid-cols-6 [&>*]:min-w-0">
              <KpiCard label="صافي المبيعات" value={formatMoney(summary.netSales)} icon={Wallet} tone="primary" hint={`${summary.invoiceCount.toLocaleString("ar-JO")} فاتورة`} />
              <KpiCard
                label="الربح الإجمالي"
                value={summary.profit == null ? "غير محسوم" : formatMoney(summary.profit)}
                icon={TrendingUp}
                tone={summary.profit == null ? "default" : summary.profit > 0 ? "success" : "destructive"}
              />
              <KpiCard label="هامش الربح" value={pct(summary.profitMargin)} icon={WalletCards} />
              <KpiCard label="ضريبة المبيعات" value={formatMoney(summary.tax)} icon={ShieldAlert} />
              <KpiCard
                label="المرتجعات"
                value={formatMoney(summary.returns)}
                icon={RotateCcw}
                tone={summary.returns > 0 ? "destructive" : "default"}
              />
              <KpiCard label="صافي النقد" value={formatMoney(summary.netCashMovement)} icon={Banknote} />
            </div>

            {/* Trend + payment distribution */}
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,0.65fr)] [&>*]:min-w-0">
              <section className="flex min-w-0 flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
                <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-3.5">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="shrink-0 text-muted"><CalendarDays className="h-4 w-4" /></span>
                    <h2 className="truncate text-sm font-black text-foreground">حركة المبيعات اليومية</h2>
                  </div>
                  <span className="shrink-0 text-xs font-bold text-muted">{overview.range.days} يوم</span>
                </header>
                <div className="flex-1 p-5">
                  <TrendChart points={overview.trend ?? []} generatedAt={overview.generatedAt} showProfit />
                </div>
              </section>

              <section className="flex min-w-0 flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
                <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-3.5">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="shrink-0 text-muted"><Users className="h-4 w-4" /></span>
                    <h2 className="truncate text-sm font-black text-foreground">طرق الدفع</h2>
                  </div>
                </header>
                <div className="flex-1 p-5">
                  <PaymentBreakdown methods={overview.paymentBreakdown ?? []} />
                </div>
              </section>
            </div>

            {/* Top products + stock & data quality */}
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2 [&>*]:min-w-0">
              <section className="flex min-w-0 flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
                <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-3.5">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="shrink-0 text-muted"><PackageSearch className="h-4 w-4" /></span>
                    <h2 className="truncate text-sm font-black text-foreground">أفضل المنتجات</h2>
                  </div>
                  <span className="shrink-0 text-xs font-bold text-muted">{overview.topProducts.length} صنف</span>
                </header>
                <div className="scrollbar-hidden max-h-[26rem] overflow-auto p-5">
                  {overview.topProducts.length === 0 ? (
                    <p className="py-10 text-center text-sm font-bold text-muted">لا توجد مبيعات ضمن الفترة.</p>
                  ) : (
                    <table className="w-full min-w-0 text-sm">
                      <thead>
                        <tr className="border-b border-border text-right text-xs font-bold text-muted">
                          <th className="py-2 pl-3">الصنف</th>
                          <th className="py-2 pl-3">الكمية</th>
                          <th className="py-2 pl-3">المبيعات</th>
                          <th className="py-2 pl-3">الربح</th>
                          <th className="py-2">المخزون</th>
                        </tr>
                      </thead>
                      <tbody>
                        {overview.topProducts.map((product) => (
                          <tr key={`${product.productId}-${product.barcode || ""}`} className="border-b border-border/60 text-right">
                            <td className="min-w-0 py-2.5 pl-3">
                              <p className="max-w-full break-words font-bold text-foreground">{product.name}</p>
                              <p dir="ltr" className="mt-0.5 break-all text-right text-xs font-bold text-muted">{product.barcode || "بدون باركود"}</p>
                            </td>
                            <td className="whitespace-nowrap py-2.5 pl-3 font-bold tabular-nums text-muted">{qty(product.quantity)}</td>
                            <td className="whitespace-nowrap py-2.5 pl-3 font-black tabular-nums text-foreground">{formatMoney(product.sales)}</td>
                            <td className={cn("whitespace-nowrap py-2.5 pl-3 font-black tabular-nums", product.profit == null ? "text-warning-strong" : product.profit < 0 ? "text-destructive-strong" : "text-success-strong")}>
                              {product.profit == null ? "غير محسوم" : formatMoney(product.profit)}
                            </td>
                            <td className={cn("whitespace-nowrap py-2.5 tabular-nums", product.stock != null && product.stock <= 0 ? "font-black text-destructive-strong" : "font-bold text-muted")}>
                              {product.stock ?? "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </section>

              <section className="flex min-w-0 flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
                <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-3.5">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="shrink-0 text-muted"><BarChart3 className="h-4 w-4" /></span>
                    <h2 className="truncate text-sm font-black text-foreground">تنبيهات المخزون وجودة البيانات</h2>
                  </div>
                  <span
                    className={cn(
                      "shrink-0 rounded-full px-2.5 py-1 text-xs font-black",
                      qualityTone === "bad" ? "bg-destructive-soft text-destructive-strong" : qualityTone === "warn" ? "bg-warning-soft text-warning-strong" : "bg-success-soft text-success-strong",
                    )}
                  >
                    {qualityTone === "bad" ? "تحتاج متابعة" : qualityTone === "warn" ? "متوسطة" : "سليمة"}
                  </span>
                </header>
                <div className="scrollbar-hidden max-h-[26rem] overflow-auto p-5">
                  <div className="grid gap-4 lg:grid-cols-2">
                    <div className="space-y-2">
                      <p className="text-xs font-black text-muted">المخزون الأكثر خطورة</p>
                      {overview.stockAlerts.length === 0 ? (
                        <p className="rounded-lg bg-surface-muted/50 px-3 py-6 text-center text-sm font-bold text-muted">لا توجد تنبيهات مخزون للفترة.</p>
                      ) : (
                        overview.stockAlerts.slice(0, 8).map((alert) => (
                          <div key={alert.productId} className="rounded-xl border border-border px-3 py-2.5">
                            <div className="flex items-center justify-between gap-3">
                              <p className="min-w-0 break-words text-sm font-black text-foreground">{alert.name}</p>
                              <span className={cn("shrink-0 text-sm font-black tabular-nums", alert.severity === "critical" ? "text-destructive-strong" : "text-warning-strong")}>
                                {alert.stock}
                              </span>
                            </div>
                            <p className="mt-1 text-xs font-bold text-muted">
                              بيع {qty(alert.soldQuantity)} • {alert.daysOfStockLeft === null ? "لا توجد سرعة بيع" : `${alert.daysOfStockLeft} يوم متبقٍ`}
                            </p>
                          </div>
                        ))
                      )}
                    </div>
                    <div className="space-y-2">
                      <p className="text-xs font-black text-muted">جودة البيانات</p>
                      {overview.dataQuality.length === 0 ? (
                        <p className="rounded-lg bg-success-soft px-3 py-6 text-center text-sm font-bold text-success-strong">لا توجد مشاكل جودة واضحة.</p>
                      ) : (
                        overview.dataQuality.map((issue) => (
                          <div
                            key={issue.id}
                            className={cn(
                              "rounded-xl border px-3 py-2.5",
                              issue.severity === "high" ? "border-destructive/20 bg-destructive-soft" : issue.severity === "medium" ? "border-warning/20 bg-warning-soft" : "border-border bg-surface-muted/50",
                            )}
                          >
                            <div className="flex items-center justify-between gap-3">
                              <p className="text-sm font-black text-foreground">{issue.label}</p>
                              <span className="shrink-0 text-sm font-black tabular-nums text-foreground">{issue.count}</span>
                            </div>
                            <p className="mt-1 text-xs font-bold leading-5 text-muted">{issue.description}</p>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              </section>
            </div>
          </>
        )
      )}
    </div>
  );
}
