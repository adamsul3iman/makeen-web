"use client";

import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  AlertTriangle,
  Banknote,
  Calculator,
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
  TrendingUp,
} from "lucide-react";
import {
  AdminDataTable,
  AdminTableActions,
  type AdminDataTableColumn,
} from "@/components/ui/AdminDataTable";
import { PageHeader } from "@/components/ui/Card";
import { formatMoney } from "@/lib/format";
import { fetchSalesReport, exportSalesLedgerCsv } from "@/lib/reportsClient";
import type { SalesLedgerResponse, SalesPaymentMethod } from "@/types/salesLedger.types";

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

function Metric({ label, value, icon, tone = "default" }: { label: string; value: string; icon: ReactNode; tone?: "default" | "good" | "bad" | "warn" }) {
  const toneClass = tone === "good"
    ? "border-success/20 bg-success-soft text-success-strong"
    : tone === "bad"
      ? "border-destructive/20 bg-destructive-soft text-destructive-strong"
      : tone === "warn"
        ? "border-warning/20 bg-warning-soft text-warning-strong"
        : "border-border bg-surface text-foreground";
  return (
    <div className={`rounded-lg border p-3 ${toneClass}`}>
      <div className="flex items-center justify-between gap-2 text-xs font-black">
        <span>{label}</span>
        {icon}
      </div>
      <p className="mt-2 text-xl font-black tabular-nums">{value}</p>
    </div>
  );
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

const INVOICE_COLUMNS: AdminDataTableColumn<SalesInvoiceRow>[] = [
  {
    id: "reference",
    header: "المرجع والتاريخ",
    cell: (invoice) => <div><p className="font-black tabular-nums">{invoice.reference}</p><p className="mt-0.5 text-xs font-bold text-muted">{dateTime(invoice.completedAt)}</p></div>,
  },
  {
    id: "kind",
    header: "النوع",
    cell: (invoice) => <span className={invoice.isReturn ? "rounded-full bg-destructive-soft px-2 py-1 text-xs font-black text-destructive-strong" : "rounded-full bg-success-soft px-2 py-1 text-xs font-black text-success-strong"}>{invoice.isReturn ? "مرتجع" : "مبيعات"}</span>,
  },
  {
    id: "cashier",
    header: "الكاشير / الجهاز",
    cell: (invoice) => <div><p className="font-black">{invoice.cashierName || "غير محدد"}</p><p className="mt-0.5 text-xs font-bold text-muted">{[invoice.branchName, invoice.terminalName].filter(Boolean).join(" / ") || "بدون جهاز"}</p></div>,
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
  const [data, setData] = useState<SalesLedgerResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const loadingTimer = window.setTimeout(() => {
      if (!active) return;
      setLoading(true);
      setError(null);
    }, 0);
    const params = { from, to, page, pageSize: 50, kind, branchId, terminalId, cashierId, paymentMethod, search };
    fetchSalesReport(params)
      .then((body) => {
        if (active) setData(body);
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : "تعذر تحميل سجل المبيعات");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      window.clearTimeout(loadingTimer);
    };
  }, [branchId, cashierId, from, kind, page, paymentMethod, reloadKey, search, terminalId, to]);

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

  return (
    <div className="space-y-5">
      <PageHeader
        title="سجل المبيعات والفواتير"
        subtitle="بحث وتدقيق المبيعات والمرتجعات والربح والضريبة حسب الفرع والكاشير والجهاز"
        action={(
          <>
            <button type="button" onClick={exportCsv} disabled={loading || !pagination?.total} className="inline-flex h-10 items-center gap-2 rounded-lg border border-border bg-surface px-3 text-sm font-black hover:bg-surface-muted disabled:opacity-40">
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

      <section className="grid gap-3 rounded-lg border border-border bg-surface p-4 shadow-card md:grid-cols-3 xl:grid-cols-6">
        <label className="grid gap-1 text-xs font-black text-muted">
          من
          <input type="date" value={from} onChange={(event) => resetPage(() => setFrom(event.target.value))} className="h-10 rounded-lg border border-border px-3 text-sm font-bold text-foreground" />
        </label>
        <label className="grid gap-1 text-xs font-black text-muted">
          إلى
          <input type="date" value={to} onChange={(event) => resetPage(() => setTo(event.target.value))} className="h-10 rounded-lg border border-border px-3 text-sm font-bold text-foreground" />
        </label>
        <label className="grid gap-1 text-xs font-black text-muted">
          نوع المستند
          <select value={kind} onChange={(event) => resetPage(() => setKind(event.target.value))} className="h-10 rounded-lg border border-border bg-surface px-3 text-sm font-bold text-foreground">
            <option value="ALL">الكل</option>
            <option value="SALE">مبيعات فقط</option>
            <option value="RETURN">مرتجعات فقط</option>
          </select>
        </label>
        <label className="grid gap-1 text-xs font-black text-muted">
          طريقة الدفع
          <select value={paymentMethod} onChange={(event) => resetPage(() => setPaymentMethod(event.target.value))} className="h-10 rounded-lg border border-border bg-surface px-3 text-sm font-bold text-foreground">
            <option value="">كل الطرق</option>
            <option value="CASH">نقدي</option>
            <option value="VISA">بطاقة</option>
            <option value="CLIQ">كليك</option>
            <option value="SPLIT">مختلط</option>
            <option value="DEBT">ذمم</option>
          </select>
        </label>
        <label className="grid gap-1 text-xs font-black text-muted">
          الفرع
          <select value={branchId} onChange={(event) => resetPage(() => { setBranchId(event.target.value); setTerminalId(""); })} className="h-10 rounded-lg border border-border bg-surface px-3 text-sm font-bold text-foreground">
            <option value="">كل الفروع</option>
            {(data?.filters?.branches ?? []).map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
          </select>
        </label>
        <label className="grid gap-1 text-xs font-black text-muted">
          الجهاز
          <select value={terminalId} onChange={(event) => resetPage(() => setTerminalId(event.target.value))} className="h-10 rounded-lg border border-border bg-surface px-3 text-sm font-bold text-foreground">
            <option value="">كل الأجهزة</option>
            {terminals.map((terminal) => <option key={terminal.id} value={terminal.id}>{terminal.name}</option>)}
          </select>
        </label>
        <label className="grid gap-1 text-xs font-black text-muted md:col-span-1">
          الكاشير
          <select value={cashierId} onChange={(event) => resetPage(() => setCashierId(event.target.value))} className="h-10 rounded-lg border border-border bg-surface px-3 text-sm font-bold text-foreground">
            <option value="">كل الكاشيرين</option>
            {(data?.filters?.cashiers ?? []).map((cashier) => <option key={cashier.id} value={cashier.id}>{cashier.name}</option>)}
          </select>
        </label>
        <form onSubmit={submitSearch} className="flex items-end gap-2 md:col-span-2 xl:col-span-5">
          <label className="grid min-w-0 flex-1 gap-1 text-xs font-black text-muted">
            بحث بالمرجع أو اسم الكاشير أو العميل
            <input value={searchDraft} onChange={(event) => setSearchDraft(event.target.value)} placeholder="اكتب مرجع الفاتورة أو الاسم" className="h-10 rounded-lg border border-border px-3 text-sm font-bold text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/30" />
          </label>
          <button type="submit" aria-label="بحث" className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground hover:bg-primary-hover"><Search className="h-4 w-4" /></button>
          {(search || searchDraft) && <button type="button" onClick={() => { setSearchDraft(""); resetPage(() => setSearch("")); }} className="h-10 rounded-lg border border-border px-3 text-sm font-black text-muted hover:bg-surface-muted">مسح</button>}
        </form>
      </section>

      {error && <div className="rounded-lg border border-destructive/20 bg-destructive-soft px-4 py-3 text-sm font-bold text-destructive-strong">{error}</div>}

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-9">
        <Metric label="صافي المبيعات" value={summary ? formatMoney(summary.netSales) : "—"} icon={<TrendingUp className="h-4 w-4" />} tone="good" />
        <Metric
          label="الربح الإجمالي"
          value={summary ? (summary.grossProfit == null ? (summary.profitReliable ? formatMoney(summary.grossProfitCandidate ?? "—") : "غير محسوم بسبب نقص التكلفة") : formatMoney(summary.grossProfit)) : "—"}
          icon={<CircleDollarSign className="h-4 w-4" />}
          tone={summary?.profitReliable ? "good" : "warn"}
        />
        <Metric
          label="هامش الربح"
          value={summary ? (summary.profitMargin == null ? (summary.profitReliable ? "—" : "غير محسوب") : `${summary.profitMargin.toFixed(1)}%`) : "—"}
          icon={<Percent className="h-4 w-4" />}
        />
        <Metric label="الضريبة" value={summary ? formatMoney(summary.tax) : "—"} icon={<Calculator className="h-4 w-4" />} tone="warn" />
        <Metric label="المرتجعات" value={summary ? formatMoney(summary.returns) : "—"} icon={<RotateCcw className="h-4 w-4" />} tone={summary && summary.returns > 0 ? "bad" : "default"} />
        <Metric label="نقدي" value={summary ? formatMoney(summary.cash) : "—"} icon={<Banknote className="h-4 w-4" />} />
        <Metric label="بطاقات" value={summary ? formatMoney(summary.visa) : "—"} icon={<CreditCard className="h-4 w-4" />} />
        <Metric label="كليك" value={summary ? formatMoney(summary.cliq) : "—"} icon={<Send className="h-4 w-4" />} />
        <Metric label="عدد الفواتير" value={summary ? quantity(summary.invoiceCount) : "—"} icon={<ReceiptText className="h-4 w-4" />} />
      </section>

      {data && ((data.dataQuality?.zeroCostLineCount ?? 0) > 0 || (data.dataQuality?.missingBarcodeLineCount ?? 0) > 0 || (data.dataQuality?.unknownProductLineCount ?? 0) > 0) && (
        <section className="flex items-start gap-3 rounded-lg border border-warning/20 bg-warning-soft px-4 py-3 text-warning-strong">
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
            <div>
              <h2 className="text-sm font-black text-foreground">الكشف الضريبي حسب نسبة المنتج</h2>
              <p className="mt-0.5 text-xs font-semibold text-muted">الإعفاء ونسب الضريبة مفصولة من أسطر الفواتير، وليس من إجمالي الفاتورة</p>
            </div>
            <Calculator className="h-5 w-5 shrink-0 text-warning-strong" />
          </div>
        )}
      />

      <section className="overflow-hidden rounded-xl border border-border bg-surface shadow-card">
        <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div>
            <h2 className="text-sm font-black text-foreground">الفواتير</h2>
            <p className="mt-0.5 text-xs font-bold text-muted">{pagination ? `${pagination.total} مستند` : "جار التحميل"}</p>
          </div>
          <FileSearch className="h-5 w-5 text-info-strong" />
        </header>
        <AdminDataTable className="hidden rounded-none border-0 shadow-none md:block" caption="فواتير المبيعات والمرتجعات" columns={INVOICE_COLUMNS} rows={data?.invoices ?? []} getRowKey={(invoice) => invoice.id} loading={loading} tableClassName="min-w-[1050px]" emptyState="لا توجد فواتير مطابقة" />
        <div className="divide-y divide-border md:hidden">
          {(data?.invoices ?? []).map((invoice) => (
            <Link key={invoice.id} href={`/admin/reports/sales/invoice?id=${encodeURIComponent(invoice.id)}`} className="block space-y-2 p-4 hover:bg-surface-muted">
              <div className="flex items-center justify-between gap-3"><span className="font-black tabular-nums">{invoice.reference}</span><span className={invoice.isReturn ? "text-xs font-black text-destructive-strong" : "text-xs font-black text-success-strong"}>{invoice.isReturn ? "مرتجع" : "مبيعات"}</span></div>
              <div className="flex items-center justify-between gap-3"><span className="text-xs font-bold text-muted">{dateTime(invoice.completedAt)} · {invoice.cashierName || "غير محدد"}</span><span className="font-black tabular-nums">{formatMoney(invoice.total)}</span></div>
            </Link>
          ))}
          {!loading && (data?.invoices?.length ?? 0) === 0 && <p className="px-4 py-12 text-center text-sm font-bold text-muted">لا توجد فواتير مطابقة</p>}
        </div>
        <footer className="flex items-center justify-between gap-3 border-t border-border px-4 py-3">
          <button type="button" disabled={!pagination || page <= 1 || loading} onClick={() => setPage((value) => Math.max(1, value - 1))} className="inline-flex h-9 items-center gap-1 rounded-lg border border-border px-3 text-sm font-black disabled:opacity-40"><ChevronRight className="h-4 w-4" />السابق</button>
          <span className="text-sm font-black tabular-nums text-muted">صفحة {pagination?.page ?? 1} من {Math.max(1, pagination?.totalPages ?? 1)}</span>
          <button type="button" disabled={!pagination || page >= pagination.totalPages || loading} onClick={() => setPage((value) => value + 1)} className="inline-flex h-9 items-center gap-1 rounded-lg border border-border px-3 text-sm font-black disabled:opacity-40">التالي<ChevronLeft className="h-4 w-4" /></button>
        </footer>
      </section>
    </div>
  );
}
