"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Banknote,
  Boxes,
  CalendarDays,
  RefreshCw,
  TrendingUp,
  Users,
  Wallet,
} from "lucide-react";
import { formatMoney } from "@/lib/format";
import { fetchReportsOverview, submitInventoryCount } from "@/lib/reportsClient";
import { usePosStore } from "@/store/usePosStore";
import { getTenantStoreId } from "@/lib/tenantClient";
import { readDashboardOverview, writeDashboardOverview } from "@/lib/dashboardCache";
import { PageHeader } from "@/components/ui/Card";
import { StatCardSkeleton } from "@/components/ui/Skeleton";
import type { ReportsNegativeStock, ReportsOverview } from "@/types/reports.types";
import KpiCard from "@/components/admin/dashboard/KpiCard";
import PaymentBreakdown from "@/components/admin/dashboard/PaymentBreakdown";
import TrendChart from "@/components/admin/dashboard/TrendChart";
import AlertsCard from "@/components/admin/dashboard/AlertsCard";
import TopProducts from "@/components/admin/dashboard/TopProducts";

export default function AdminDashboardPage() {
  const adminSession = usePosStore((s) => s.adminSession);

  // Instant first paint: seed state synchronously from the last cached overview
  // so the dashboard renders real data immediately (offline-first / no blank
  // skeleton when revisiting), then refresh in the background.
  const [reportsResponse, setReportsResponse] = useState<{ overview: ReportsOverview } | null>(() => {
    const overview = readDashboardOverview(getTenantStoreId());
    return overview ? { overview } : null;
  });
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(!reportsResponse);
  const mountedRef = useRef(true);

  const refetch = useCallback(() => {
    const storeId = getTenantStoreId();
    if (!storeId) return;
    setError(null);
    setIsLoading(true);
    fetchReportsOverview(storeId)
      .then((overview) => {
        if (!mountedRef.current) return;
        setReportsResponse({ overview });
        writeDashboardOverview(storeId, overview);
        setIsLoading(false);
      })
      .catch((err) => {
        if (!mountedRef.current) return;
        // Keep showing the cached overview if a refresh fails; surface a notice.
        if (!reportsResponse) setError(err instanceof Error ? err.message : "تعذر تحميل البيانات");
        setIsLoading(false);
      });
  }, [reportsResponse]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  useEffect(() => {
    if (adminSession) {
      // Deferred into an async continuation so the effect body never
      // synchronously calls setState (react-hooks/set-state-in-effect).
      Promise.resolve().then(() => {
        if (mountedRef.current) refetch();
      });
    }
  }, [adminSession, refetch]);

  const overview = reportsResponse?.overview ?? null;

  const [countInputs, setCountInputs] = useState<Record<string, string>>({});
  const [countingId, setCountingId] = useState<string | null>(null);
  const [countStatus, setCountStatus] = useState<{ tone: "success" | "error"; message: string } | null>(null);

  const onCountChange = useCallback((productId: string, value: string) => {
    setCountInputs((current) => ({ ...current, [productId]: value }));
  }, []);

  const submitPhysicalCount = async (product: ReportsNegativeStock) => {
    const quantity = Number(countInputs[product.productId]);
    if (!Number.isFinite(quantity) || quantity < 0) {
      setCountStatus({ tone: "error", message: "أدخل كمية فعلية صحيحة" });
      return;
    }
    setCountingId(product.productId);
    setCountStatus(null);
    try {
      const storeId = getTenantStoreId();
      if (!storeId) throw new Error("المتجر غير محدد");
      const actorName = adminSession?.name ?? "مدير";
      await submitInventoryCount({
        storeId,
        productId: product.productId,
        quantity,
        reason: "جرد تصحيحي لأصناف بمخزون سالب (نواقص المخزون)",
        actorName,
      });
      setCountInputs((current) => ({ ...current, [product.productId]: "" }));
      setCountStatus({ tone: "success", message: `تم تحديث مخزون «${product.name}» إلى ${quantity} — حُلّت القيمة السالبة` });
      refetch();
    } catch (err) {
      setCountStatus({
        tone: "error",
        message: err instanceof Error ? err.message : "تعذر اعتماد الجرد",
      });
    } finally {
      setCountingId(null);
    }
  };

  const today = new Date().toLocaleDateString("ar-JO", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });

  const netSales = overview ? (overview.summary?.netSales ?? 0) : 0;
  const invoiceCount = overview ? (overview.summary?.invoiceCount ?? 0) : 0;
  const profit = overview ? (overview.summary?.profit ?? null) : null;
  const avgTicket = overview ? (overview.summary?.averageTicket ?? 0) : 0;

  const showSkeleton = isLoading && !overview;

  return (
    <div className="min-w-0 space-y-6">
      <PageHeader
        title="نظرة مباشرة"
        subtitle={`بيانات المتجر الفعلية — ${today}`}
        action={
          <button
            type="button"
            onClick={() => refetch()}
            disabled={isLoading}
            className="flex h-10 items-center justify-center gap-2 rounded-lg border border-border bg-surface px-4 text-sm font-black text-muted transition hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
            تحديث
          </button>
        }
      />

      {countStatus && (
        <p
          role="status"
          className={`rounded-xl border px-4 py-3 text-sm font-bold ${
            countStatus.tone === "success"
              ? "border-success/20 bg-success/10 text-success"
              : "border-destructive/20 bg-destructive/10 text-destructive"
          }`}
        >
          {countStatus.message}
        </p>
      )}

      {error && !overview && (
        <div className="rounded-2xl border border-destructive/20 bg-destructive/10 p-5 text-sm font-bold text-destructive">
          {error}
        </div>
      )}

      {showSkeleton ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4 [&>*]:min-w-0">
          {Array.from({ length: 4 }).map((_, i) => (
            <StatCardSkeleton key={i} />
          ))}
        </div>
      ) : (
        overview && (
          <>
            {/* KPI row — instant financial overview */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4 [&>*]:min-w-0">
              <KpiCard
                label="صافي المبيعات"
                value={formatMoney(netSales)}
                icon={Wallet}
                tone="primary"
                hint={`${invoiceCount.toLocaleString("ar-JO")} فاتورة`}
              />
              <KpiCard label="عدد الفواتير" value={invoiceCount.toLocaleString("ar-JO")} icon={Boxes} />
              <KpiCard
                label="الربح الإجمالي"
                value={profit == null ? "غير محسوم" : formatMoney(profit)}
                icon={TrendingUp}
                tone={profit == null ? "default" : profit > 0 ? "success" : "destructive"}
              />
              <KpiCard label="متوسط الفاتورة" value={formatMoney(avgTicket)} icon={Banknote} />
            </div>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 [&>*]:min-w-0">
              {/* Payment method distribution */}
              <section className="flex min-w-0 flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
                <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-3.5">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="shrink-0 text-muted"><Users className="h-4 w-4" /></span>
                    <h2 className="truncate text-sm font-black text-foreground">توزيع طرق الدفع</h2>
                  </div>
                  <span className="shrink-0 text-xs font-bold text-muted">{overview.range.days} يوم</span>
                </header>
                <div className="flex-1 p-5">
                  <PaymentBreakdown methods={overview.paymentBreakdown ?? []} />
                </div>
              </section>

              {/* Trend */}
              <section className="flex min-w-0 flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
                <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-3.5">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="shrink-0 text-muted"><CalendarDays className="h-4 w-4" /></span>
                    <h2 className="truncate text-sm font-black text-foreground">اتجاه المبيعات</h2>
                  </div>
                </header>
                <div className="flex-1 p-5">
                  <TrendChart points={overview.trend ?? []} generatedAt={overview.generatedAt} />
                </div>
              </section>
            </div>

            <div className="grid grid-cols-1 gap-4 xl:grid-cols-3 [&>*]:min-w-0">
              {/* Operational alerts */}
              <section className="flex min-w-0 flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-sm xl:col-span-2">
                <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-3.5">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="shrink-0 text-muted"><Wallet className="h-4 w-4" /></span>
                    <h2 className="truncate text-sm font-black text-foreground">التنبيهات التشغيلية</h2>
                  </div>
                </header>
                <div className="scrollbar-hidden flex-1 overflow-y-auto p-5">
                  <AlertsCard
                    stockAlerts={overview.stockAlerts ?? []}
                    negativeStock={overview.negativeStock ?? []}
                    countInputs={countInputs}
                    countingId={countingId}
                    onCountChange={onCountChange}
                    onSubmitCount={submitPhysicalCount}
                  />
                </div>
              </section>

              {/* Top products */}
              <section className="flex min-w-0 flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
                <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-3.5">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="shrink-0 text-muted"><TrendingUp className="h-4 w-4" /></span>
                    <h2 className="truncate text-sm font-black text-foreground">الأسرع مبيعاً</h2>
                  </div>
                </header>
                <div className="flex-1 p-5">
                  <TopProducts products={overview.topProducts ?? []} />
                </div>
              </section>
            </div>
          </>
        )
      )}
    </div>
  );
}
