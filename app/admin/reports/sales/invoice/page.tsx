"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AlertTriangle, ArrowRight, Loader2, Printer, ReceiptText, RotateCcw } from "lucide-react";
import SalesInvoiceDocument from "@/components/admin/SalesInvoiceDocument";
import { formatMoney } from "@/lib/format";
import { fetchSalesInvoiceDetail } from "@/lib/reportsClient";
import type { SalesInvoiceDetail } from "@/types/salesLedger.types";

export default function SalesInvoiceDetailPage() {
  const searchParams = useSearchParams();
  const invoiceId = searchParams.get("id");
  const [invoice, setInvoice] = useState<SalesInvoiceDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!invoiceId) {
      const missingTimer = window.setTimeout(() => {
        setError("معرّف الفاتورة مفقود");
        setLoading(false);
      }, 0);
      return () => { window.clearTimeout(missingTimer); };
    }
    let active = true;
    fetchSalesInvoiceDetail(invoiceId)
      .then((body) => {
        if (active) setInvoice(body.invoice);
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : "تعذر تحميل الفاتورة");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [invoiceId]);

  if (loading) return <div className="grid min-h-[55vh] place-items-center"><div className="flex items-center gap-2 text-sm font-black text-muted"><Loader2 className="h-5 w-5 animate-spin" />جار تحميل الفاتورة</div></div>;
  if (error || !invoice) return <div className="rounded-lg border border-red-200 bg-red-50 p-5 text-sm font-black text-red-700">{error || "الفاتورة غير موجودة"}</div>;

  return (
    <div className="space-y-5">
      <header className="flex flex-col gap-3 print:hidden sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-sm font-bold text-blue-700"><ReceiptText className="h-4 w-4" />مرجع {invoice.reference}</div>
          <h1 className="mt-1 text-2xl font-black">تفاصيل الفاتورة</h1>
        </div>
        <div className="flex gap-2">
          <Link href="/admin/reports/sales/" className="inline-flex h-10 items-center gap-2 rounded-lg border border-border bg-white px-3 text-sm font-black hover:bg-surface-muted"><ArrowRight className="h-4 w-4" />سجل المبيعات</Link>
          <button type="button" onClick={() => window.print()} className="inline-flex h-10 items-center gap-2 rounded-lg bg-slate-900 px-4 text-sm font-black text-white hover:bg-slate-800"><Printer className="h-4 w-4" />طباعة الفاتورة</button>
        </div>
      </header>

      <SalesInvoiceDocument invoice={invoice} />

      {(invoice.items ?? []).some((item) => item.costPrice <= 0 || !item.barcode) && (
        <section className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-amber-900 print:hidden">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
          <div>
            <h2 className="text-sm font-black">بيانات تاريخية غير مكتملة</h2>
            <p className="mt-1 text-xs font-bold leading-5">يوجد سطر بلا تكلفة محفوظة أو بلا باركود. إجمالي الفاتورة والضريبة صحيحان، لكن الربح لا يُعد نهائياً قبل استكمال التكلفة.</p>
          </div>
        </section>
      )}

      <section className="grid gap-4 print:hidden lg:grid-cols-2">
        <div className="overflow-hidden rounded-lg border border-border bg-white shadow-sm">
          <header className="border-b border-border px-4 py-3"><h2 className="text-sm font-black">تحليل التكلفة والربح</h2></header>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[620px] text-sm">
              <thead className="bg-slate-50 text-xs font-black text-muted"><tr><th className="px-4 py-3 text-right">الصنف</th><th className="px-4 py-3 text-right">الصافي</th><th className="px-4 py-3 text-right">التكلفة</th><th className="px-4 py-3 text-right">الربح</th></tr></thead>
              <tbody>{(invoice.items ?? []).map((item) => <tr key={item.id} className="border-t border-border/70"><td className="px-4 py-3"><p className="font-black">{item.productName}</p><p className="text-xs font-bold text-muted">{item.barcode || "بدون باركود"}</p></td><td className="px-4 py-3 font-bold tabular-nums">{formatMoney(item.netTotal)}</td><td className="px-4 py-3 font-bold tabular-nums text-muted">{formatMoney(item.costTotal)}</td><td className={`px-4 py-3 font-black tabular-nums ${item.grossProfit != null && item.grossProfit < 0 ? "text-red-700" : item.grossProfit == null ? "text-amber-700" : "text-green-700"}`}>{item.grossProfit == null ? "غير محسوم" : formatMoney(item.grossProfit)}</td></tr>)}</tbody>
              <tfoot className="border-t-2 border-slate-900 bg-slate-50 font-black"><tr><td className="px-4 py-3">الإجمالي</td><td className="px-4 py-3 tabular-nums">{formatMoney(invoice.subtotal + invoice.deliveryFee)}</td><td className="px-4 py-3 tabular-nums">{formatMoney((invoice.items ?? []).reduce((sum, item) => sum + item.costTotal, 0))}</td><td className={invoice.grossProfit == null ? "px-4 py-3 tabular-nums text-amber-700" : "px-4 py-3 tabular-nums text-green-700"}>{invoice.grossProfit == null ? "غير محسوم" : formatMoney(invoice.grossProfit)}</td></tr></tfoot>
            </table>
          </div>
        </div>

        <div className="overflow-hidden rounded-lg border border-border bg-white shadow-sm">
          <header className="border-b border-border px-4 py-3"><h2 className="text-sm font-black">التحليل الضريبي</h2></header>
          <div className="divide-y divide-border">
            {(invoice.taxBreakdown ?? []).map((group) => <div key={`${group.taxPercent}-${group.taxIncluded}`} className="grid grid-cols-4 gap-3 px-4 py-3 text-sm"><div><p className="text-xs font-bold text-muted">المعاملة</p><p className="mt-1 font-black">{group.taxPercent === 0 ? "معفى" : `${group.taxPercent}% ${group.taxIncluded ? "شاملة" : "مضافة"}`}</p></div><div><p className="text-xs font-bold text-muted">الصافي</p><p className="mt-1 font-black tabular-nums">{formatMoney(group.netSales)}</p></div><div><p className="text-xs font-bold text-muted">الضريبة</p><p className="mt-1 font-black tabular-nums text-amber-700">{formatMoney(group.tax)}</p></div><div><p className="text-xs font-bold text-muted">الإجمالي</p><p className="mt-1 font-black tabular-nums">{formatMoney(group.grossSales)}</p></div></div>)}
          </div>
          {(invoice.linkedReturns?.length ?? 0) > 0 && <div className="border-t border-border p-4"><h3 className="flex items-center gap-2 text-sm font-black text-red-700"><RotateCcw className="h-4 w-4" />مرتجعات مرتبطة</h3><div className="mt-2 space-y-2">{(invoice.linkedReturns ?? []).map((item) => <Link key={item.id} href={`/admin/reports/sales/invoice?id=${encodeURIComponent(item.id)}`} className="flex items-center justify-between rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-sm font-black"><span>{item.reference}</span><span className="tabular-nums text-red-700">{formatMoney(item.total)}</span></Link>)}</div></div>}
        </div>
      </section>
    </div>
  );
}
