"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  AlertTriangle,
  Banknote,
  Boxes,
  Clock,
  CreditCard,
  Crown,
  Loader2,
  PackageMinus,
  RefreshCw,
  Smartphone,
  TrendingUp,
} from "lucide-react";
import { formatMoney } from "@/lib/format";
import { fetchReportsOverview, submitInventoryCount } from "@/lib/reportsClient";
import { usePosStore } from "@/store/usePosStore";
import { getTenantStoreId } from "@/lib/tenantClient";
import { Card, StatCard, PageHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { TableSkeleton, StatCardSkeleton, CardSkeleton } from "@/components/ui/Skeleton";
import type { ReportsNegativeStock, ReportsOverview, ReportsStockAlert } from "@/types/reports.types";

function StockDaysBadge({ daysOfStockLeft }: Pick<ReportsStockAlert, "daysOfStockLeft">) {
  if (daysOfStockLeft === null) return <Badge tone="muted">غير محسوب</Badge>;
  if (daysOfStockLeft === 0) return <Badge tone="destructive">نفد اليوم</Badge>;
  if (daysOfStockLeft <= 2) return <Badge tone="destructive">{daysOfStockLeft} يوم</Badge>;
  return <Badge tone="warning">{daysOfStockLeft} يوم</Badge>;
}

export default function AdminDashboardPage() {
  const adminSession = usePosStore((s) => s.adminSession);
  const [reportsResponse, setReportsResponse] = useState<{ overview: ReportsOverview } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const mountedRef = useRef(true);

  const refetch = useCallback(() => {
    const storeId = getTenantStoreId();
    if (!storeId) return;
    setError(null);
    setIsLoading(true);
    fetchReportsOverview(storeId)
      .then((overview) => { if (mountedRef.current) { setReportsResponse({ overview }); setIsLoading(false); } })
      .catch((err) => { if (mountedRef.current) { setError(err instanceof Error ? err.message : "تعذر تحميل البيانات"); setIsLoading(false); } });
  }, []);

  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
  useEffect(() => { if (adminSession) refetch(); }, [adminSession, refetch]);

  const overview = reportsResponse?.overview ?? null;
  const [countInputs, setCountInputs] = useState<Record<string, string>>({});
  const [countingId, setCountingId] = useState<string | null>(null);
  const [countStatus, setCountStatus] = useState<{ tone: "success" | "error"; message: string } | null>(null);

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
      await submitInventoryCount({ storeId, productId: product.productId, quantity, reason: "جرد تصحيحي لأصناف بمخزون سالب (نواقص المخزون)", actorName });
      setCountInputs((current) => ({ ...current, [product.productId]: "" }));
      setCountStatus({
        tone: "success",
        message: `تم تحديث مخزون «${product.name}» إلى ${quantity} — حُلّت القيمة السالبة`,
      });
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

  const stats = overview
    ? [
        { id: "sales", label: "صافي المبيعات", value: formatMoney(overview?.summary?.netSales ?? 0), icon: TrendingUp, tone: "primary" as const },
        { id: "invoices", label: "عدد الفواتير", value: (overview?.summary?.invoiceCount ?? 0).toLocaleString("ar-JO"), icon: Boxes, tone: "default" as const },
        { id: "profit", label: "الربح الإجمالي", value: overview?.summary?.profit == null ? "غير محسوم" : formatMoney(overview?.summary?.profit ?? 0), icon: TrendingUp, tone: overview?.summary?.profit != null && overview?.summary?.profit > 0 ? "success" as const : "destructive" as const },
        { id: "ticket", label: "متوسط الفاتورة", value: formatMoney(overview?.summary?.averageTicket ?? 0), icon: Clock, tone: "default" as const },
        { id: "tax", label: "ضريبة المبيعات", value: formatMoney(overview?.summary?.tax ?? 0), icon: AlertTriangle, tone: "warning" as const },
      ]
    : [];

  return (
    <div className="space-y-6">
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

      {isLoading && !overview && (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {Array.from({ length: 8 }).map((_, i) => <StatCardSkeleton key={i} />)}
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <CardSkeleton><TableSkeleton rows={4} cols={3} /></CardSkeleton>
            <CardSkeleton />
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            <div className="lg:col-span-2"><CardSkeleton><TableSkeleton rows={5} cols={3} /></CardSkeleton></div>
            <CardSkeleton><div className="h-56 w-full" /></CardSkeleton>
          </div>
        </>
      )}

      {error && (
        <div className="rounded-2xl border border-destructive/20 bg-destructive/10 p-6 text-sm font-bold text-destructive">
          {error}
        </div>
      )}

      {overview && (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {stats.map((stat, i) => (
              <div key={stat.id} className="animate-pos-pop-in" style={{ animationDelay: `${i * 40}ms` }}>
                <StatCard label={stat.label} value={stat.value} icon={stat.icon} tone={stat.tone} />
              </div>
            ))}
            <div className="animate-pos-pop-in" style={{ animationDelay: `${stats.length * 40}ms` }}>
              <StatCard
                label="نقدي"
                value={formatMoney(overview.summary?.cash ?? 0)}
                subtitle={`${overview.paymentBreakdown?.find((p) => p.method === "CASH")?.count ?? 0} فاتورة`}
                icon={Banknote}
                tone="success"
              />
            </div>
            <div className="animate-pos-pop-in" style={{ animationDelay: `${(stats.length + 1) * 40}ms` }}>
              <StatCard
                label="بطاقة"
                value={formatMoney(overview.summary?.visa ?? 0)}
                subtitle={`${overview.paymentBreakdown?.find((p) => p.method === "VISA")?.count ?? 0} فاتورة`}
                icon={CreditCard}
                tone="primary"
              />
            </div>
            <div className="animate-pos-pop-in" style={{ animationDelay: `${(stats.length + 2) * 40}ms` }}>
              <StatCard
                label="كليك"
                value={formatMoney(overview.summary?.cliq ?? 0)}
                subtitle={`${overview.paymentBreakdown?.find((p) => p.method === "CLIQ")?.count ?? 0} فاتورة`}
                icon={Smartphone}
                tone="default"
              />
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="الأسرع مبيعاً" icon={<Crown className="h-4 w-4" />}>
              <div className="scrollbar-hidden max-h-72 overflow-y-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-right text-xs font-bold text-muted">
                      <th className="py-2 pl-3">الصنف</th>
                      <th className="py-2 pl-3">الكمية</th>
                      <th className="py-2 pl-3">المبيعات</th>
                      <th className="py-2">المخزون</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overview.topProducts.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="py-8 text-center text-sm font-bold text-muted">
                          لا توجد مبيعات ضمن الفترة
                        </td>
                      </tr>
                    ) : (
                      overview.topProducts.slice(0, 8).map((p) => (
                        <tr key={`${p.productId}-${p.barcode}`} className="border-b border-border/60 text-right">
                          <td className="py-2.5 pl-3 font-bold text-foreground">{p.name}</td>
                          <td className="py-2.5 pl-3 font-semibold tabular-nums">{p.quantity}</td>
                          <td className="py-2.5 pl-3 font-bold tabular-nums">{formatMoney(p.sales)}</td>
                          <td className="py-2.5 tabular-nums text-muted">{p.stock ?? "—"}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </Card>

            <Card title="جودة البيانات" icon={<AlertTriangle className="h-4 w-4" />}>
              <div className="space-y-3">
                {overview.dataQuality.length === 0 ? (
                  <p className="rounded-xl bg-success/10 px-4 py-4 text-sm font-bold text-success">
                    لا توجد مشاكل بيانات واضحة
                  </p>
                ) : (
                  overview.dataQuality.slice(0, 5).map((issue) => (
                    <div key={issue.id} className="rounded-xl border border-border bg-surface-muted px-4 py-3">
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-sm font-black text-foreground">{issue.label}</p>
                        <Badge>{issue.count}</Badge>
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs font-semibold text-muted">{issue.description}</p>
                    </div>
                  ))
                )}
              </div>
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Card title="تنبيهات المخزون" icon={<Boxes className="h-4 w-4" />} className="lg:col-span-2">
              <div className="scrollbar-hidden max-h-64 overflow-y-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-right text-xs font-bold text-muted">
                      <th className="py-2 pl-3">الصنف</th>
                      <th className="py-2 pl-3">المخزون</th>
                      <th className="py-2 pl-3">المباع</th>
                      <th className="py-2">الأيام المتبقية</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overview.stockAlerts.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="py-8 text-center text-sm font-bold text-muted">
                          لا توجد تنبيهات مخزون حالياً
                        </td>
                      </tr>
                    ) : (
                      overview.stockAlerts.slice(0, 8).map((a) => (
                        <tr key={a.productId} className="border-b border-border/60 text-right">
                          <td className="py-2.5 pl-3 font-bold text-foreground">{a.name}</td>
                          <td className="py-2.5 pl-3 font-black tabular-nums text-destructive">{a.stock}</td>
                          <td className="py-2.5 pl-3 tabular-nums text-muted">{a.soldQuantity}</td>
                          <td className="py-2.5">
                            <StockDaysBadge daysOfStockLeft={a.daysOfStockLeft} />
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </Card>

            <Card title="مبيعات الفترة" icon={<TrendingUp className="h-4 w-4" />}>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={overview.trend} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e4e4e7" vertical={false} />
                    <XAxis
                      dataKey="date"
                      reversed
                      tick={{ fontSize: 11, fill: "#52525b" }}
                      axisLine={{ stroke: "#e4e4e7" }}
                      tickLine={false}
                    />
                    <YAxis
                      orientation="right"
                      tick={{ fontSize: 11, fill: "#a1a1aa" }}
                      axisLine={false}
                      tickLine={false}
                      width={42}
                    />
                    <Tooltip
                      formatter={(value) => [formatMoney(Number(value)), "المبيعات"]}
                      contentStyle={{
                        borderRadius: 12,
                        border: "1px solid #e4e4e7",
                        fontSize: 13,
                        fontFamily: "inherit",
                      }}
                    />
                    <Line
                      type="monotone"
                      dataKey="sales"
                      stroke="#1d4ed8"
                      strokeWidth={2.5}
                      dot={{ r: 3, fill: "#1d4ed8", strokeWidth: 0 }}
                      activeDot={{ r: 5 }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <p className="mt-3 flex items-center justify-between border-t border-border pt-3 text-xs font-semibold text-muted">
                <span className="flex items-center gap-1.5">
                  <Clock className="h-3.5 w-3.5" />
                  آخر تحديث
                </span>
                <span className="tabular-nums font-black text-foreground">
                  {new Date(overview.generatedAt).toLocaleTimeString("ar-JO", { hour: "2-digit", minute: "2-digit" })}
                </span>
              </p>
            </Card>
          </div>

          <Card title="نواقص المخزون" icon={<PackageMinus className="h-4 w-4" />}>
            <p className="mb-3 text-xs font-semibold text-muted">
              أصناف بيعت أكثر من رصيدها الحالي (مخزون سالب). أدخل الجرد الفعلي ثم اضغط
              «اعتماد» — القيمة الجديدة تحل محل القيمة السالبة.
            </p>

            {countStatus && (
              <p
                className={`mb-3 rounded-lg px-3 py-2 text-sm font-bold ${
                  countStatus.tone === "success"
                    ? "bg-success/10 text-success"
                    : "bg-destructive/10 text-destructive"
                }`}
                role="status"
              >
                {countStatus.message}
              </p>
            )}

            {overview.negativeStock.length === 0 ? (
              <p className="rounded-xl bg-success/10 px-4 py-4 text-sm font-bold text-success">
                لا توجد أصناف بمخزون سالب — كل الأرصدة ضمن الحدود
              </p>
            ) : (
              <div className="scrollbar-hidden max-h-72 overflow-y-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-right text-xs font-bold text-muted">
                      <th className="py-2 pl-3">الصنف</th>
                      <th className="py-2 pl-3">المخزون الحالي</th>
                      <th className="py-2">الجرد الفعلي</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overview.negativeStock.map((product) => (
                      <tr key={product.productId} className="border-b border-border/60 text-right">
                        <td className="py-2.5 pl-3 font-bold text-foreground">{product.name}</td>
                        <td className="py-2.5 pl-3 font-black tabular-nums text-destructive">
                          {product.stock}
                        </td>
                        <td className="py-2.5">
                          <form
                            onSubmit={(e) => {
                              e.preventDefault();
                              void submitPhysicalCount(product);
                            }}
                            className="flex items-center gap-2"
                          >
                            <input
                              type="number"
                              min={0}
                              inputMode="numeric"
                              dir="ltr"
                              value={countInputs[product.productId] ?? ""}
                              onChange={(e) =>
                                setCountInputs((current) => ({
                                  ...current,
                                  [product.productId]: e.target.value,
                                }))
                              }
                              placeholder="0"
                              aria-label={`جرد فعلي لـ ${product.name}`}
                              className="h-10 w-24 rounded-lg border border-border bg-surface-muted px-2 text-right text-sm font-bold tabular-nums text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
                            />
                            <button
                              type="submit"
                              disabled={countingId === product.productId}
                              className="flex h-10 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-black text-primary-foreground transition hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
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
            )}
          </Card>
        </>
      )}
    </div>
  );
}
