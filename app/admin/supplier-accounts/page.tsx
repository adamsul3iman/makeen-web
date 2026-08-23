"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CalendarClock,
  Download,
  Eye,
  FilePlus2,
  HandCoins,
  RefreshCw,
  Search,
  WalletCards,
} from "lucide-react";
import SupplierInvoiceDetailModal from "@/components/admin/SupplierInvoiceDetailModal";
import SupplierInvoiceModal from "@/components/admin/SupplierInvoiceModal";
import SupplierPaymentModal from "@/components/admin/SupplierPaymentModal";
import {
  AdminDataTable,
  AdminTableActions,
  type AdminDataTableColumn,
} from "@/components/ui/AdminDataTable";
import { PageHeader } from "@/components/ui/Card";
import { formatMoney } from "@/lib/format";
import { fetchSuppliers, fetchSupplierInvoices } from "@/lib/suppliersClient";
import type {
  SupplierAccountsResponse,
  SupplierInvoiceFilterStatus,
  SupplierInvoiceListItem,
} from "@/types/supplierAccounts.types";

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
const ninetyDaysAgo = ammanDate(new Date(Date.now() - 89 * DAY_MS));

const STATUS_LABELS = { OPEN: "مفتوحة", PARTIAL: "مدفوعة جزئياً", PAID: "مدفوعة", VOID: "ملغاة" } as const;

function statusClasses(invoice: SupplierInvoiceListItem): string {
  if (invoice.isOverdue) return "bg-destructive-soft text-destructive-strong";
  if (invoice.status === "PAID") return "bg-success-soft text-success-strong";
  if (invoice.status === "PARTIAL") return "bg-info-soft text-info-strong";
  if (invoice.status === "VOID") return "bg-surface-muted text-muted";
  return "bg-warning-soft text-warning-strong";
}

export default function SupplierAccountsPage() {
  const [from, setFrom] = useState(ninetyDaysAgo);
  const [to, setTo] = useState(today);
  const [supplierId, setSupplierId] = useState("");
  const [status, setStatus] = useState<SupplierInvoiceFilterStatus>("ALL");
  const [search, setSearch] = useState("");
  const [submittedSearch, setSubmittedSearch] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<SupplierAccountsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [creating, setCreating] = useState(false);
  const [paying, setPaying] = useState<SupplierInvoiceListItem | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const loadingTimer = window.setTimeout(() => {
      if (!alive) return;
      setLoading(true);
      setError("");
    }, 0);
    const filterStatus = status === "ALL" || status === "OVERDUE" ? undefined : status;
    Promise.all([
      fetchSupplierInvoices({ status: filterStatus, page, pageSize: 50 }),
      fetchSuppliers(),
    ])
      .then(([ledger, supplierList]) => {
        if (!alive) return;
        const dueSoonCutoff = ammanDate(new Date(Date.now() + 7 * DAY_MS));
        const invoices: SupplierInvoiceListItem[] = ledger.invoices.map((invoice) => ({
          id: invoice.id,
          supplierId: invoice.supplierId,
          supplierName: invoice.supplierName,
          purchaseOrderId: null,
          invoiceNumber: invoice.invoiceNumber,
          invoiceDate: invoice.invoiceDate || invoice.createdAt?.slice(0, 10) || "",
          dueDate: invoice.dueDate ?? "",
          subtotal: invoice.subtotal,
          taxAmount: invoice.taxAmount,
          totalAmount: invoice.totalAmount,
          paidAmount: invoice.paidAmount,
          balanceDue: invoice.balanceDue,
          status: invoice.status as SupplierInvoiceListItem["status"],
          notes: invoice.notes ?? "",
          itemCount: 0,
          paymentCount: 0,
          isOverdue:
            invoice.balanceDue > 0 &&
            invoice.status !== "PAID" &&
            invoice.status !== "VOID" &&
            invoice.dueDate !== null &&
            invoice.dueDate < today,
          createdAt: invoice.createdAt ?? "",
        }));
        const openRows = invoices.filter((invoice) => invoice.status === "OPEN" || invoice.status === "PARTIAL");
        const overdueRows = invoices.filter((invoice) => invoice.isOverdue);
        const sum = (pick: (invoice: SupplierInvoiceListItem) => number) => invoices.reduce((acc, invoice) => acc + pick(invoice), 0);
        const dueSoonBalance = openRows
          .filter((invoice) => !invoice.isOverdue && invoice.dueDate !== "" && invoice.dueDate <= dueSoonCutoff)
          .reduce((acc, invoice) => acc + invoice.balanceDue, 0);
        const next: SupplierAccountsResponse = {
          invoices,
          summary: {
            invoiceCount: ledger.total,
            purchasesExcludingTax: sum((invoice) => invoice.subtotal),
            inputTax: sum((invoice) => invoice.taxAmount),
            purchasesIncludingTax: sum((invoice) => invoice.totalAmount),
            paymentCount: 0,
            payments: 0,
            openInvoiceCount: openRows.length,
            outstandingBalance: openRows.reduce((acc, invoice) => acc + invoice.balanceDue, 0),
            overdueCount: overdueRows.length,
            overdueBalance: overdueRows.reduce((acc, invoice) => acc + invoice.balanceDue, 0),
            dueSoonBalance,
          },
          suppliers: supplierList.map((supplier) => ({ id: supplier.id, name: supplier.name, balance: supplier.balance })),
          products: [],
          pagination: {
            page: ledger.page,
            pageSize: ledger.pageSize,
            total: ledger.total,
            totalPages: Math.max(1, Math.ceil(ledger.total / ledger.pageSize)),
          },
          generatedAt: new Date().toISOString(),
        };
        // The direct query has no product lookup; keep any options already loaded.
        if (!alive) return;
        setData((previous) => ({ ...next, products: previous?.products ?? [] }));
      })
      .catch((reason) => { if (alive) setError(reason instanceof Error ? reason.message : "تعذر تحميل حسابات الموردين"); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; window.clearTimeout(loadingTimer); };
  }, [from, to, supplierId, status, submittedSearch, page, reloadKey]);

  const summary = data?.summary;
  const invoiceCountLabel = useMemo(() => new Intl.NumberFormat("ar-JO").format(data?.pagination.total ?? 0), [data?.pagination.total]);

  const refresh = () => setReloadKey((key) => key + 1);
  const completeAction = () => {
    setCreating(false);
    setPaying(null);
    setDetailId(null);
    refresh();
  };

  function exportCsv() {
    if (!data) return;
    const rows = [
      ["رقم الفاتورة", "المورد", "تاريخ الفاتورة", "الاستحقاق", "الصافي", "الضريبة", "الإجمالي", "المدفوع", "المتبقي", "الحالة"],
      ...data.invoices.map((invoice) => [invoice.invoiceNumber, invoice.supplierName, invoice.invoiceDate, invoice.dueDate, invoice.subtotal, invoice.taxAmount, invoice.totalAmount, invoice.paidAmount, invoice.balanceDue, invoice.isOverdue ? "متأخرة" : STATUS_LABELS[invoice.status]]),
    ];
    const csv = rows.map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `supplier-accounts-${from}-${to}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  const invoiceColumns: AdminDataTableColumn<SupplierInvoiceListItem>[] = [
    {
      id: "invoice",
      header: "الفاتورة / المورد",
      cell: (invoice) => (
        <div>
          <p className="font-black text-foreground">{invoice.invoiceNumber}</p>
          <p className="mt-0.5 text-xs font-bold text-muted">{invoice.supplierName}</p>
        </div>
      ),
    },
    {
      id: "dates",
      header: "التاريخ والاستحقاق",
      cell: (invoice) => (
        <div>
          <p className="font-bold">{invoice.invoiceDate}</p>
          <p className={`mt-0.5 text-xs font-bold ${invoice.isOverdue ? "text-destructive-strong" : "text-muted"}`}>
            استحقاق {invoice.dueDate}
          </p>
        </div>
      ),
    },
    {
      id: "status",
      header: "الحالة",
      cell: (invoice) => (
        <span className={`rounded-full px-2 py-1 text-xs font-black ${statusClasses(invoice)}`}>
          {invoice.isOverdue ? "متأخرة" : STATUS_LABELS[invoice.status]}
        </span>
      ),
    },
    {
      id: "total",
      header: "الإجمالي",
      cell: (invoice) => <span className="font-black tabular-nums">{formatMoney(invoice.totalAmount)}</span>,
    },
    {
      id: "tax",
      header: "الضريبة",
      cell: (invoice) => <span className="font-bold tabular-nums text-info-strong">{formatMoney(invoice.taxAmount)}</span>,
    },
    {
      id: "balance",
      header: "المتبقي",
      cell: (invoice) => <span className="font-black tabular-nums text-warning-strong">{formatMoney(invoice.balanceDue)}</span>,
    },
    {
      id: "actions",
      header: "إجراءات",
      action: true,
      cell: (invoice) => (
        <AdminTableActions>
          <button
            type="button"
            title="عرض التفاصيل"
            aria-label={`عرض تفاصيل الفاتورة ${invoice.invoiceNumber}`}
            onClick={() => setDetailId(invoice.id)}
            className="grid h-9 w-9 place-items-center rounded-md text-info-strong transition hover:bg-info-soft"
          >
            <Eye className="h-4 w-4" />
          </button>
          {invoice.balanceDue > 0 ? (
            <button
              type="button"
              title="تسجيل دفعة"
              onClick={() => setPaying(invoice)}
              className="inline-flex h-9 items-center gap-1 rounded-md bg-success-soft px-2.5 text-xs font-black text-success-strong transition hover:bg-success-soft/70"
            >
              <HandCoins className="h-4 w-4" /> دفع
            </button>
          ) : null}
        </AdminTableActions>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="فواتير الموردين والدفعات"
        subtitle="ضريبة المدخلات، المبالغ المستحقة، تواريخ الاستحقاق، والدفعات الجزئية."
        action={(
          <>
            <button type="button" onClick={() => setCreating(true)} className="inline-flex h-10 items-center gap-2 rounded-lg bg-success px-4 text-sm font-black text-success-foreground transition hover:bg-success-hover"><FilePlus2 className="h-4 w-4" /> فاتورة مورد</button>
            <button type="button" onClick={exportCsv} disabled={!data || loading} className="inline-flex h-10 items-center gap-2 rounded-lg border border-border bg-surface px-3 text-sm font-black text-foreground disabled:opacity-40"><Download className="h-4 w-4" /> CSV</button>
            <button type="button" onClick={refresh} className="inline-flex h-10 items-center gap-2 rounded-lg border border-border bg-surface px-3 text-sm font-black text-foreground"><RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /> تحديث</button>
          </>
        )}
      />

      <section className="grid grid-cols-2 gap-3 xl:grid-cols-5">
        <article className="rounded-lg border border-warning/20 bg-warning-soft p-4"><p className="text-xs font-black text-warning-strong">إجمالي المستحق</p><p className="mt-3 text-xl font-black tabular-nums text-warning-strong sm:text-2xl">{summary ? formatMoney(summary.outstandingBalance) : "—"}</p><p className="mt-1 text-xs font-bold text-warning-strong">{summary?.openInvoiceCount ?? 0} فاتورة مفتوحة</p></article>
        <article className="rounded-lg border border-destructive/20 bg-destructive-soft p-4"><p className="flex items-center gap-2 text-xs font-black text-destructive-strong"><AlertTriangle className="h-4 w-4" /> متأخر السداد</p><p className="mt-3 text-xl font-black tabular-nums text-destructive-strong sm:text-2xl">{summary ? formatMoney(summary.overdueBalance) : "—"}</p><p className="mt-1 text-xs font-bold text-destructive-strong">{summary?.overdueCount ?? 0} فاتورة</p></article>
        <article className="rounded-lg border border-info/20 bg-info-soft p-4"><p className="text-xs font-black text-info-strong">ضريبة المدخلات</p><p className="mt-3 text-xl font-black tabular-nums text-info-strong sm:text-2xl">{summary ? formatMoney(summary.inputTax) : "—"}</p><p className="mt-1 text-xs font-bold text-info-strong">ضمن الفترة المحددة</p></article>
        <article className="rounded-lg border border-border bg-surface p-4"><p className="text-xs font-black text-muted">مشتريات مع الضريبة</p><p className="mt-3 text-xl font-black tabular-nums text-foreground sm:text-2xl">{summary ? formatMoney(summary.purchasesIncludingTax) : "—"}</p><p className="mt-1 text-xs font-bold text-muted">{summary?.invoiceCount ?? 0} فاتورة بالفترة</p></article>
        <article className="col-span-2 rounded-lg border border-success/20 bg-success-soft p-4 xl:col-span-1"><p className="text-xs font-black text-success-strong">دفعات الفترة</p><p className="mt-3 text-xl font-black tabular-nums text-success-strong sm:text-2xl">{summary ? formatMoney(summary.payments) : "—"}</p><p className="mt-1 text-xs font-bold text-success-strong">{summary?.paymentCount ?? 0} دفعة</p></article>
      </section>

      <section className="grid gap-3 rounded-lg border border-border bg-surface p-4 md:grid-cols-2 xl:grid-cols-[1fr_1fr_1fr_2fr_auto] xl:items-end">
        <label className="grid gap-1 text-xs font-black text-muted">من<input type="date" value={from} onChange={(event) => { setFrom(event.target.value); setPage(1); }} className="h-10 rounded-lg border border-border px-3 font-bold" /></label>
        <label className="grid gap-1 text-xs font-black text-muted">إلى<input type="date" value={to} onChange={(event) => { setTo(event.target.value); setPage(1); }} className="h-10 rounded-lg border border-border px-3 font-bold" /></label>
        <label className="grid gap-1 text-xs font-black text-muted">الحالة<select value={status} onChange={(event) => { setStatus(event.target.value as SupplierInvoiceFilterStatus); setPage(1); }} className="h-10 rounded-lg border border-border bg-surface px-3 font-bold"><option value="ALL">كل الحالات</option><option value="OPEN">مفتوحة</option><option value="PARTIAL">مدفوعة جزئياً</option><option value="PAID">مدفوعة</option><option value="OVERDUE">متأخرة</option></select></label>
        <label className="grid gap-1 text-xs font-black text-muted">المورد<select value={supplierId} onChange={(event) => { setSupplierId(event.target.value); setPage(1); }} className="h-10 rounded-lg border border-border bg-surface px-3 font-bold"><option value="">كل الموردين</option>{(data?.suppliers ?? []).map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}</select></label>
        <form className="flex gap-2 md:col-span-2 xl:col-span-1" onSubmit={(event) => { event.preventDefault(); setSubmittedSearch(search.trim()); setPage(1); }}><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="رقم الفاتورة أو المورد" className="h-10 min-w-0 flex-1 rounded-lg border border-border px-3 text-sm font-bold xl:w-48" /><button type="submit" aria-label="بحث" className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground transition hover:bg-primary-hover"><Search className="h-4 w-4" /></button></form>
      </section>

      {error ? <p className="rounded-lg border border-destructive/20 bg-destructive-soft px-4 py-3 text-sm font-black text-destructive-strong">{error}</p> : null}

      <section className="overflow-hidden rounded-xl border border-border bg-surface shadow-card">
        <header className="flex items-center justify-between border-b border-border px-4 py-3"><h2 className="text-sm font-black text-foreground">سجل فواتير الموردين</h2><span className="text-xs font-bold text-muted">{invoiceCountLabel} فاتورة</span></header>
        <AdminDataTable className="hidden rounded-none border-0 shadow-none md:block" caption="سجل فواتير الموردين" columns={invoiceColumns} rows={data?.invoices ?? []} getRowKey={(invoice) => invoice.id} loading={loading} tableClassName="min-w-[900px]" />
        <div className="divide-y divide-border md:hidden">{(data?.invoices ?? []).map((invoice) => <article key={invoice.id} className="space-y-3 p-4"><div className="flex items-start justify-between gap-3"><div><p className="font-black">{invoice.invoiceNumber}</p><p className="mt-0.5 text-xs font-bold text-muted">{invoice.supplierName}</p></div><span className={`rounded-full px-2 py-1 text-xs font-black ${statusClasses(invoice)}`}>{invoice.isOverdue ? "متأخرة" : STATUS_LABELS[invoice.status]}</span></div><dl className="grid grid-cols-3 gap-2 text-xs"><div><dt className="font-bold text-muted">الإجمالي</dt><dd className="mt-1 font-black tabular-nums">{formatMoney(invoice.totalAmount)}</dd></div><div><dt className="font-bold text-muted">الضريبة</dt><dd className="mt-1 font-black tabular-nums text-info-strong">{formatMoney(invoice.taxAmount)}</dd></div><div><dt className="font-bold text-muted">المتبقي</dt><dd className="mt-1 font-black tabular-nums text-warning-strong">{formatMoney(invoice.balanceDue)}</dd></div></dl><div className="flex gap-2"><button type="button" onClick={() => setDetailId(invoice.id)} className="inline-flex h-9 flex-1 items-center justify-center gap-2 rounded-lg border border-border text-xs font-black"><Eye className="h-4 w-4" /> التفاصيل</button>{invoice.balanceDue > 0 ? <button type="button" onClick={() => setPaying(invoice)} className="inline-flex h-9 flex-1 items-center justify-center gap-2 rounded-lg bg-success text-xs font-black text-success-foreground"><HandCoins className="h-4 w-4" /> تسجيل دفعة</button> : null}</div></article>)}{!loading && data?.invoices.length === 0 ? <p className="px-4 py-12 text-center text-sm font-bold text-muted">لا توجد فواتير مطابقة.</p> : null}</div>
        <footer className="flex items-center justify-between border-t border-border px-4 py-3"><button type="button" disabled={page <= 1 || loading} onClick={() => setPage((value) => Math.max(1, value - 1))} className="h-9 rounded-lg border border-border px-3 text-xs font-black disabled:opacity-40">السابق</button><span className="text-xs font-bold text-muted">صفحة {data?.pagination.page ?? page} من {Math.max(1, data?.pagination.totalPages ?? 1)}</span><button type="button" disabled={loading || page >= (data?.pagination.totalPages ?? 0)} onClick={() => setPage((value) => value + 1)} className="h-9 rounded-lg border border-border px-3 text-xs font-black disabled:opacity-40">التالي</button></footer>
      </section>

      <section className="grid gap-3 md:grid-cols-2"><div className="flex gap-3 rounded-lg border border-warning/20 bg-warning-soft p-4"><CalendarClock className="h-5 w-5 shrink-0 text-warning-strong" /><div><p className="text-sm font-black">مستحق خلال 7 أيام</p><p className="mt-1 text-xl font-black tabular-nums text-warning-strong">{summary ? formatMoney(summary.dueSoonBalance) : "—"}</p></div></div><div className="flex gap-3 rounded-lg border border-info/20 bg-info-soft p-4"><WalletCards className="h-5 w-5 shrink-0 text-info-strong" /><div><p className="text-sm font-black">مشتريات قبل الضريبة</p><p className="mt-1 text-xl font-black tabular-nums text-info-strong">{summary ? formatMoney(summary.purchasesExcludingTax) : "—"}</p></div></div></section>

      {loading ? <div className="fixed bottom-4 left-1/2 z-40 -translate-x-1/2 rounded-full border border-border bg-surface px-4 py-2 text-sm font-black text-muted shadow-elevated">جارٍ تحميل حسابات الموردين…</div> : null}
      {creating && data ? <SupplierInvoiceModal suppliers={data.suppliers} products={data.products} onClose={() => setCreating(false)} onCreated={completeAction} /> : null}
      {paying ? <SupplierPaymentModal invoice={paying} onClose={() => setPaying(null)} onPaid={completeAction} /> : null}
      {detailId ? <SupplierInvoiceDetailModal invoiceId={detailId} onClose={() => setDetailId(null)} /> : null}
    </div>
  );
}
