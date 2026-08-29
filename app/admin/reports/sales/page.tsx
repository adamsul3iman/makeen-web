"use client";

import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowLeft,
  Banknote,
  Calculator,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleDollarSign,
  CreditCard,
  Download,
  FileSearch,
  Percent,
  ReceiptText,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  SlidersHorizontal,
  TrendingUp,
} from "lucide-react";
import {
  AdminDataTable,
  AdminTableActions,
  type AdminDataTableColumn,
} from "@/components/ui/AdminDataTable";
import { DateField, Select, type SelectOption } from "@/components/ui/Select";
import { PageHeader } from "@/components/ui/Card";
import { formatMoney } from "@/lib/format";
import { cn } from "@/lib/cn";
import { fetchSalesReport, exportSalesLedgerCsv } from "@/lib/reportsClient";
import type { SalesLedgerResponse, SalesPaymentMethod } from "@/types/salesLedger.types";
import KpiCard from "@/components/admin/dashboard/KpiCard";

const isoDate = (date: Date): string => date.toISOString().slice(0, 10);
const today = isoDate(new Date());
const thirtyDaysAgo = isoDate(new Date(Date.now() - 29 * 24 * 60 * 60 * 1000));

const PAYMENT_LABEL: Record<SalesPaymentMethod, string> = {
  CASH: "نقدي",
  VISA: "بطاقة",
  CLIQ: "كليك",
  SPLIT: "مختلط",
  DEBT: "ذمم",
  UNKNOWN: "غير محدد",
};

function quantity(value: number): string {
  return new Intl.NumberFormat("ar-JO", { maximumFractionDigits: 3 }).format(value);
}

function dateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("ar-JO", { dateStyle: "short", timeStyle: "short" }).format(date);
}

type TaxBreakdownRow = SalesLedgerResponse["taxBreakdown"][number];
type SalesInvoiceRow = SalesLedgerResponse["invoices"][number];

function profitTone(value: number | null): string {
  if (value == null) return "text-warning-strong";
  return value < 0 ? "text-destructive-strong" : "text-success-strong";
}

/** Bounded in-memory query cache so revisiting a filter set (or paging back)
 *  reuses prior results instead of re-hitting the network. */
const MAX_CACHED_RESPONSES = 24;
const responseCache = new Map<string, SalesLedgerResponse>();

function cacheResponse(key: string, body: SalesLedgerResponse): void {
  responseCache.delete(key);
  responseCache.set(key, body);
  if (responseCache.size > MAX_CACHED_RESPONSES) {
    const oldest = responseCache.keys().next().value;
    if (oldest !== undefined) responseCache.delete(oldest);
  }
}

const TAX_COLUMNS: AdminDataTableColumn<TaxBreakdownRow>[] = [
  {
    id: "tax-treatment",
    header: "المعاملة",
    cell: (group) => <span className="font-black">{group.taxPercent === 0 ? "معفى / صفرية" : `${group.taxPercent}% ${group.taxIncluded ? "شاملة" : "مضافة"}`}</span>,
  },
  {
    id: "lines",
    header: "الأسطر",
    cell: (group) => <span className="tabular-nums text-muted">{quantity(group.lineCount)}</span>,
  },
  {
    id: "net",
    header: "الصافي قبل الضريبة",
    cell: (group) => <span className="tabular-nums">{formatMoney(group.netSales)}</span>,
  },
  {
    id: "tax",
    header: "الضريبة",
    cell: (group) => <span className="font-black tabular-nums text-warning-strong">{formatMoney(group.tax)}</span>,
  },
  {
    id: "gross",
    header: "الإجمالي",
    cell: (group) => <span className="font-black tabular-nums">{formatMoney(group.grossSales)}</span>,
  },
  {
    id: "profit",
    header: "الربح",
    cell: (group) => <span className={`font-black tabular-nums ${profitTone(group.grossProfit)}`}>{group.grossProfit == null ? "غير محسوم" : formatMoney(group.grossProfit)}</span>,
  },
];

function InvoiceReferenceCell({ invoice }: { invoice: SalesInvoiceRow }) {
  return (
    <div className="min-w-0">
      <p className="break-words font-black tabular-nums">{invoice.invoiceNumber?.trim() || invoice.reference}</p>
      <p className="mt-0.5 text-xs font-bold text-muted">
        {invoice.invoiceNumber?.trim() ? invoice.reference : ""}
        {invoice.invoiceNumber?.trim() ? " • " : ""}
        {dateTime(invoice.completedAt)}
      </p>
    </div>
  );
}

const INVOICE_COLUMNS: AdminDataTableColumn<SalesInvoiceRow>[] = [
  {
    id: "reference",
    header: "رقم الفاتورة والتاريخ",
    cell: (invoice) => <InvoiceReferenceCell invoice={invoice} />,
  },
  {
    id: "kind",
    header: "النوع",
    cell: (invoice) => <span className={invoice.isReturn ? "rounded-full bg-destructive-soft px-2 py-1 text-xs font-black text-destructive-strong" : "rounded-full bg-success-soft px-2 py-1 text-xs font-black text-success-strong"}>{invoice.isReturn ? "مرتجع" : "مبيعات"}</span>,
  },
  {
    id: "cashier",
    header: "الكاشير / الجهاز",
    cell: (invoice) => (
      <div className="min-w-0">
        <p className="break-words font-black">{invoice.cashierName || "غير محدد"}</p>
        <p className="mt-0.5 text-xs font-bold text-muted">{[invoice.branchName, invoice.terminalName].filter(Boolean).join(" / ") || "بدون جهاز"}</p>
      </div>
    ),
  },
  {
    id: "payment",
    header: "الدفع",
    cell: (invoice) => PAYMENT_LABEL[invoice.paymentMethod],
  },
  {
    id: "total",
    header: "الإجمالي",
    cell: (invoice) => <span className={`font-black tabular-nums ${invoice.total < 0 ? "text-destructive-strong" : "text-foreground"}`}>{formatMoney(invoice.total)}</span>,
  },
  {
    id: "tax",
    header: "الضريبة",
    cell: (invoice) => <span className="font-bold tabular-nums text-warning-strong">{formatMoney(invoice.tax)}</span>,
  },
  {
    id: "profit",
    header: "الربح",
    cell: (invoice) => <span className={`font-black tabular-nums ${profitTone(invoice.grossProfit)}`}>{invoice.grossProfit == null ? "غير محسوم" : formatMoney(invoice.grossProfit)}</span>,
  },
  {
    id: "actions",
    header: "التفاصيل",
    action: true,
    cell: (invoice) => (
      <AdminTableActions>
        <Link href={`/admin/reports/sales/invoice?id=${encodeURIComponent(invoice.id)}`} className="inline-flex min-h-9 items-center gap-1 rounded-lg border border-border px-3 text-xs font-black text-info-strong transition hover:bg-info-soft">
          فتح <ChevronLeft className="h-3.5 w-3.5" />
        </Link>
      </AdminTableActions>
    ),
  },
];

function FieldLabel({ children }: { children: ReactNode }) {
  return <span className="text-xs font-black text-muted">{children}</span>;
}

export default function SalesLedgerPage() {
  const [from, setFrom] = useState(thirtyDaysAgo);
  const [to, setTo] = useState(today);
  const [branchId, setBranchId] = useState("");
  const [terminalId, setTerminalId] = useState("");
  const [cashierId, setCashierId] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("");
  const [kind, setKind] = useState("ALL");
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [reloadKey, setReloadKey] = useState(0);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [data, setData] = useState<SalesLedgerResponse | null>(() => {
    // Instant paint: reuse the last cached response for the default view.
    const params = { from: thirtyDaysAgo, to: today, page: 1, pageSize: 50, kind: "ALL", branchId: "", terminalId: "", cashierId: "", paymentMethod: "", search: "" };
    return responseCache.get(JSON.stringify(params)) ?? null;
  });
  const [loading, setLoading] = useState(!data);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  // A single, stable param object + its cache key. The effect only re-runs when
  // the key genuinely changes, and the whole report comes from one batched RPC.
  const params = useMemo(
    () => ({ from, to, page, pageSize: 50, kind, branchId, terminalId, cashierId, paymentMethod, search }),
    [from, to, page, kind, branchId, terminalId, cashierId, paymentMethod, search],
  );
  const paramsKey = JSON.stringify(params);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    // Deferred into an async continuation so the effect body never synchronously
    // calls setState, and so caching/instant-paint stays tidy.
    Promise.resolve().then(() => {
      if (!mountedRef.current) return;
      const cached = responseCache.get(paramsKey);
      if (cached) {
        setData(cached);
        setLoading(false);
        setError(null);
        return;
      }
      setLoading(true);
      setError(null);
      fetchSalesReport(params)
        .then((body) => {
          if (!alive) return;
          cacheResponse(paramsKey, body);
          setData(body);
        })
        .catch((reason) => {
          if (alive) setError(reason instanceof Error ? reason.message : "تعذر تحميل سجل المبيعات");
        })
        .finally(() => {
          if (alive) setLoading(false);
        });
    });
    return () => {
      alive = false;
    };
  }, [paramsKey, reloadKey, params]);

  const terminals = useMemo(() => {
    const options = data?.filters?.terminals ?? [];
    return branchId ? options.filter((terminal) => terminal.branchId === branchId) : options;
  }, [branchId, data]);

  function resetPage(change: () => void) {
    setPage(1);
    change();
  }

  function submitSearch(event: FormEvent) {
    event.preventDefault();
    resetPage(() => setSearch(searchDraft.trim()));
  }

  const summary = data?.summary;
  const pagination = data?.pagination;

  async function exportCsv() {
    try {
      const { filename, csv } = await exportSalesLedgerCsv({ from, to, kind, branchId, terminalId, cashierId, paymentMethod, search });
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "تعذر تصدير سجل المبيعات");
    }
  }

  const hasQualityNotice =
    (data?.dataQuality?.zeroCostLineCount ?? 0) > 0 ||
    (data?.dataQuality?.missingBarcodeLineCount ?? 0) > 0 ||
    (data?.dataQuality?.unknownProductLineCount ?? 0) > 0;

  return (
    <div className="min-w-0 space-y-5">
      <PageHeader
        title="سجل المبيعات والفواتير"
        subtitle="بحث وتدقيق المبيعات والمرتجعات والربح والضريبة حسب الفرع والكاشير والجهاز"
        action={(
          <>
            <button type="button" onClick={exportCsv} disabled={loading || !pagination?.total} className="inline-flex h-10 items-center gap-2 rounded-lg border border-border bg-surface px-3 text-sm font-black hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-40">
              <Download className="h-4 w-4" />
              تصدير CSV
            </button>
            <button type="button" onClick={() => setReloadKey((value) => value + 1)} className="inline-flex h-10 items-center gap-2 rounded-lg border border-border bg-surface px-3 text-sm font-black hover:bg-surface-muted">
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

      {/* Smart filter panel — only frequently-used filters visible by default */}
      <section className="min-w-0 space-y-4 rounded-2xl border border-border bg-surface p-4 shadow-sm">
        <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <label className="grid min-w-0 gap-1.5">
            <FieldLabel>من</FieldLabel>
            <DateField value={from} onChange={(value) => resetPage(() => setFrom(value))} />
          </label>
          <label className="grid min-w-0 gap-1.5">
            <FieldLabel>إلى</FieldLabel>
            <DateField value={to} onChange={(value) => resetPage(() => setTo(value))} />
          </label>
          <label className="grid min-w-0 gap-1.5">
            <FieldLabel>الفرع</FieldLabel>
            <Select
              value={branchId}
              onChange={(value) => resetPage(() => { setBranchId(value); setTerminalId(""); })}
              placeholder="كل الفروع"
              options={[
                { value: "", label: "كل الفروع" },
                ...(data?.filters?.branches ?? []).map((branch): SelectOption => ({ value: branch.id, label: branch.name })),
              ]}
            />
          </label>
          <label className="grid min-w-0 gap-1.5">
            <FieldLabel>طريقة الدفع</FieldLabel>
            <Select
              value={paymentMethod}
              onChange={(value) => resetPage(() => setPaymentMethod(value))}
              placeholder="كل الطرق"
              options={[
                { value: "", label: "كل الطرق" },
                { value: "CASH", label: "نقدي" },
                { value: "VISA", label: "بطاقة" },
                { value: "CLIQ", label: "كليك" },
                { value: "SPLIT", label: "مختلط" },
                { value: "DEBT", label: "ذمم" },
              ]}
            />
          </label>
        </div>

        <form onSubmit={submitSearch} className="flex min-w-0 items-end gap-2">
          <label className="grid min-w-0 flex-1 gap-1.5">
            <FieldLabel>بحث بالمرجع أو اسم الكاشير أو العميل</FieldLabel>
            <input value={searchDraft} onChange={(event) => setSearchDraft(event.target.value)} placeholder="اكتب مرجع الفاتورة أو الاسم" className="h-10 min-w-0 rounded-lg border border-border bg-white px-3 text-sm font-bold text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30" />
          </label>
          <button type="submit" aria-label="بحث" className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground hover:bg-primary-hover"><Search className="h-4 w-4" /></button>
          {(search || searchDraft) && <button type="button" onClick={() => { setSearchDraft(""); resetPage(() => setSearch("")); }} className="h-10 rounded-lg border border-border px-3 text-sm font-black text-muted hover:bg-surface-muted">مسح</button>}
        </form>

        <div className="border-t border-border pt-3">
          <button type="button" onClick={() => setShowAdvanced((value) => !value)} className="flex items-center gap-2 text-sm font-black text-muted transition hover:text-foreground" aria-expanded={showAdvanced}>
            <SlidersHorizontal className="h-4 w-4" />
            إعدادات متقدمة
            <ChevronDown className={cn("h-4 w-4 transition-transform", showAdvanced ? "rotate-0" : "-rotate-90")} />
          </button>
          {showAdvanced && (
            <div className="mt-3 grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              <label className="grid min-w-0 gap-1.5">
                <FieldLabel>الجهاز</FieldLabel>
                <Select
                  value={terminalId}
                  onChange={(value) => resetPage(() => setTerminalId(value))}
                  placeholder="كل الأجهزة"
                  options={[
                    { value: "", label: "كل الأجهزة" },
                    ...terminals.map((terminal): SelectOption => ({ value: terminal.id, label: terminal.name })),
                  ]}
                />
              </label>
              <label className="grid min-w-0 gap-1.5">
                <FieldLabel>الكاشير</FieldLabel>
                <Select
                  value={cashierId}
                  onChange={(value) => resetPage(() => setCashierId(value))}
                  placeholder="كل الكاشيرين"
                  options={[
                    { value: "", label: "كل الكاشيرين" },
                    ...(data?.filters?.cashiers ?? []).map((cashier): SelectOption => ({ value: cashier.id, label: cashier.name })),
                  ]}
                />
              </label>
              <label className="grid min-w-0 gap-1.5">
                <FieldLabel>نوع المستند</FieldLabel>
                <Select
                  value={kind}
                  onChange={(value) => resetPage(() => setKind(value))}
                  placeholder="الكل"
                  options={[
                    { value: "ALL", label: "الكل" },
                    { value: "SALE", label: "مبيعات فقط" },
                    { value: "RETURN", label: "مرتجعات فقط" },
                  ]}
                />
              </label>
            </div>
          )}
        </div>
      </section>

      {error && <div className="rounded-lg border border-destructive/20 bg-destructive-soft px-4 py-3 text-sm font-bold text-destructive-strong">{error}</div>}

      {/* Financial totals — calm enterprise KPI cards */}
      <div className="grid min-w-0 grid-cols-2 gap-4 [&>*]:min-w-0 sm:grid-cols-3 xl:grid-cols-6">
        <KpiCard label="صافي المبيعات" value={summary ? formatMoney(summary.netSales) : "—"} icon={TrendingUp} tone="primary" hint={summary ? `${summary.invoiceCount.toLocaleString("ar-JO")} فاتورة` : undefined} />
        <KpiCard
          label="الربح الإجمالي"
          value={summary ? (summary.grossProfit == null ? (summary.profitReliable ? formatMoney(summary.grossProfitCandidate) : "غير محسوم") : formatMoney(summary.grossProfit)) : "—"}
          icon={CircleDollarSign}
          tone={summary ? (summary.profitReliable ? (summary.grossProfit != null && summary.grossProfit < 0 ? "destructive" : "success") : "default") : "default"}
        />
        <KpiCard label="هامش الربح" value={summary ? (summary.profitMargin == null ? (summary.profitReliable ? "—" : "غير محسوب") : `${summary.profitMargin.toFixed(1)}%`) : "—"} icon={Percent} />
        <KpiCard label="ضريبة المبيعات" value={summary ? formatMoney(summary.tax) : "—"} icon={Calculator} />
        <KpiCard label="المرتجعات" value={summary ? formatMoney(summary.returns) : "—"} icon={RotateCcw} tone={summary && summary.returns > 0 ? "destructive" : "default"} />
        <KpiCard label="عدد الفواتير" value={summary ? quantity(summary.invoiceCount) : "—"} icon={ReceiptText} />
      </div>

      {/* Payment method split — compact restrained strip */}
      <div className="grid min-w-0 grid-cols-2 gap-3 sm:grid-cols-4 [&>*]:min-w-0">
        {[
          { label: "نقدي", value: summary ? formatMoney(summary.cash) : "—", icon: Banknote },
          { label: "بطاقات", value: summary ? formatMoney(summary.visa) : "—", icon: CreditCard },
          { label: "كليك", value: summary ? formatMoney(summary.cliq) : "—", icon: Send },
          { label: "ذمم", value: summary ? formatMoney(summary.debt) : "—", icon: CircleDollarSign },
        ].map((item) => (
          <div key={item.label} className="flex min-w-0 items-center gap-3 rounded-2xl border border-border bg-surface p-4 shadow-sm">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-surface-muted text-muted">
              <item.icon className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <p className="truncate text-xs font-bold text-muted">{item.label}</p>
              <p className="truncate text-base font-black tabular-nums text-foreground">{item.value}</p>
            </div>
          </div>
        ))}
      </div>

      {hasQualityNotice && data && (
        <section className="flex items-start gap-3 rounded-2xl border border-warning/20 bg-warning-soft px-4 py-3 text-warning-strong">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
          <div>
            <h2 className="text-sm font-black">تنبيه جودة البيانات المحاسبية</h2>
            <p className="mt-1 text-xs font-bold leading-5">
              {(data.dataQuality?.zeroCostLineCount ?? 0) > 0 ? `${data.dataQuality?.zeroCostLineCount} سطر بلا تكلفة بقيمة مبيعات ${formatMoney(data.dataQuality?.zeroCostNetSales ?? 0)}؛ لذلك تم حجب الربح والهامش حتى استكمال التكلفة. ` : ""}
              {(data.dataQuality?.missingBarcodeLineCount ?? 0) > 0 ? `${data.dataQuality?.missingBarcodeLineCount} سطر تاريخي بلا باركود. ` : ""}
              {(data.dataQuality?.unknownProductLineCount ?? 0) > 0 ? `${data.dataQuality?.unknownProductLineCount} سطر غير مرتبط بمنتج حالي.` : ""}
            </p>
          </div>
        </section>
      )}

      <AdminDataTable
        caption="الكشف الضريبي حسب نسبة المنتج"
        columns={TAX_COLUMNS}
        rows={data?.taxBreakdown ?? []}
        getRowKey={(group) => `${group.taxPercent}-${group.taxIncluded}`}
        loading={loading}
        tableClassName="min-w-[760px]"
        emptyState="لا توجد أسطر مبيعات في الفترة المحددة"
        toolbar={(
          <div className="flex items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <h2 className="text-sm font-black text-foreground">الكشف الضريبي حسب نسبة المنتج</h2>
              <p className="mt-0.5 text-xs font-semibold text-muted">الإعفاء ونسب الضريبة مفصولة من أسطر الفواتير، وليس من إجمالي الفاتورة</p>
            </div>
            <Calculator className="h-5 w-5 shrink-0 text-warning-strong" />
          </div>
        )}
      />

      <section className="overflow-hidden rounded-2xl border border-border bg-surface shadow-card">
        <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-3.5">
          <div className="min-w-0">
            <h2 className="text-sm font-black text-foreground">الفواتير</h2>
            <p className="mt-0.5 text-xs font-bold text-muted">{pagination ? `${pagination.total} مستند` : "جار التحميل"}</p>
          </div>
          <FileSearch className="h-5 w-5 shrink-0 text-info-strong" />
        </header>
        <AdminDataTable
          className="hidden rounded-none border-0 shadow-none md:block"
          caption="فواتير المبيعات والمرتجعات"
          columns={INVOICE_COLUMNS}
          rows={data?.invoices ?? []}
          getRowKey={(invoice) => invoice.id}
          loading={loading}
          tableClassName="min-w-[1050px]"
          emptyState="لا توجد فواتير مطابقة"
        />
        <div className="divide-y divide-border md:hidden">
          {(data?.invoices ?? []).map((invoice) => (
            <Link key={invoice.id} href={`/admin/reports/sales/invoice?id=${encodeURIComponent(invoice.id)}`} className="block space-y-2 p-4 hover:bg-surface-muted">
              <div className="flex items-center justify-between gap-3">
                <span className="min-w-0 break-words font-black tabular-nums">{invoice.invoiceNumber?.trim() || invoice.reference}</span>
                <span className={invoice.isReturn ? "shrink-0 text-xs font-black text-destructive-strong" : "shrink-0 text-xs font-black text-success-strong"}>{invoice.isReturn ? "مرتجع" : "مبيعات"}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="min-w-0 truncate text-xs font-bold text-muted">{dateTime(invoice.completedAt)} · {invoice.cashierName || "غير محدد"}</span>
                <span className="shrink-0 font-black tabular-nums">{formatMoney(invoice.total)}</span>
              </div>
            </Link>
          ))}
          {!loading && (data?.invoices?.length ?? 0) === 0 && <p className="px-4 py-12 text-center text-sm font-bold text-muted">لا توجد فواتير مطابقة</p>}
        </div>
        <footer className="flex items-center justify-between gap-3 border-t border-border px-5 py-3">
          <button type="button" disabled={!pagination || page <= 1 || loading} onClick={() => setPage((value) => Math.max(1, value - 1))} className="inline-flex h-9 items-center gap-1 rounded-lg border border-border px-3 text-sm font-black disabled:opacity-40"><ChevronRight className="h-4 w-4" />السابق</button>
          <span className="text-sm font-black tabular-nums text-muted">صفحة {pagination?.page ?? 1} من {Math.max(1, pagination?.totalPages ?? 1)}</span>
          <button type="button" disabled={!pagination || page >= pagination.totalPages || loading} onClick={() => setPage((value) => value + 1)} className="inline-flex h-9 items-center gap-1 rounded-lg border border-border px-3 text-sm font-black disabled:opacity-40">التالي<ChevronLeft className="h-4 w-4" /></button>
        </footer>
      </section>
    </div>
  );
}
