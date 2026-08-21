"use client";

import { useEffect, useState } from "react";
import { CreditCard, FileText, X } from "lucide-react";
import { formatMoney } from "@/lib/format";
import { posFetch } from "@/lib/tenantClient";
import type { SupplierInvoiceDetail } from "@/types/supplierAccounts.types";

const PAYMENT_LABELS = { CASH: "نقدي", BANK: "تحويل بنكي", CARD: "بطاقة" } as const;

export default function SupplierInvoiceDetailModal({ invoiceId, onClose }: { invoiceId: string; onClose: () => void }) {
  const [invoice, setInvoice] = useState<SupplierInvoiceDetail | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    posFetch(`/api/supplier-accounts/${encodeURIComponent(invoiceId)}`, { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json().catch(() => null);
        if (!response.ok) throw new Error(body?.error ?? "تعذر تحميل الفاتورة");
        return body as { invoice: SupplierInvoiceDetail };
      })
      .then((body) => { if (alive) setInvoice(body.invoice); })
      .catch((reason) => { if (alive) setError(reason instanceof Error ? reason.message : "تعذر تحميل الفاتورة"); });
    return () => { alive = false; };
  }, [invoiceId]);

  return (
    <div className="fixed inset-0 z-[75] flex items-center justify-center bg-black/45 p-3" dir="rtl" onClick={onClose}>
      <article className="flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-lg bg-white shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <header className="flex items-center justify-between border-b border-border px-4 py-3"><div><h2 className="flex items-center gap-2 font-black text-foreground"><FileText className="h-4 w-4 text-blue-700" /> تفاصيل فاتورة المورد</h2><p className="mt-0.5 text-xs font-bold text-muted">{invoice ? `${invoice.supplierName} • ${invoice.invoiceNumber}` : "جارٍ التحميل…"}</p></div><button type="button" aria-label="إغلاق" onClick={onClose} className="grid h-9 w-9 place-items-center rounded-md text-muted hover:bg-surface-muted"><X className="h-5 w-5" /></button></header>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {error ? <p className="rounded-lg bg-red-50 px-3 py-3 text-sm font-black text-red-700">{error}</p> : null}
          {invoice ? (
            <div className="space-y-5">
              <dl className="grid grid-cols-2 gap-3 rounded-lg bg-slate-50 p-4 text-sm md:grid-cols-4"><div><dt className="font-bold text-muted">تاريخ الفاتورة</dt><dd className="mt-1 font-black">{invoice.invoiceDate}</dd></div><div><dt className="font-bold text-muted">الاستحقاق</dt><dd className="mt-1 font-black">{invoice.dueDate}</dd></div><div><dt className="font-bold text-muted">المدفوع</dt><dd className="mt-1 font-black tabular-nums text-emerald-700">{formatMoney(invoice.paidAmount)}</dd></div><div><dt className="font-bold text-muted">المتبقي</dt><dd className="mt-1 font-black tabular-nums text-amber-700">{formatMoney(invoice.balanceDue)}</dd></div></dl>
              <section className="overflow-hidden rounded-lg border border-border"><div className="overflow-x-auto"><table className="w-full min-w-[680px] text-sm"><thead className="bg-slate-50 text-xs font-black text-muted"><tr><th className="px-3 py-3 text-right">البند</th><th className="px-3 py-3 text-right">الكمية</th><th className="px-3 py-3 text-right">تكلفة الوحدة</th><th className="px-3 py-3 text-right">الصافي</th><th className="px-3 py-3 text-right">الضريبة</th><th className="px-3 py-3 text-right">الإجمالي</th></tr></thead><tbody>{invoice.items.map((item) => <tr key={item.id} className="border-t border-border"><td className="px-3 py-3 font-black">{item.description}</td><td className="px-3 py-3 tabular-nums">{item.quantity}</td><td className="px-3 py-3 tabular-nums">{formatMoney(item.unitCost)}</td><td className="px-3 py-3 tabular-nums">{formatMoney(item.netAmount)}</td><td className="px-3 py-3 tabular-nums">{formatMoney(item.taxAmount)} <span className="text-xs text-muted">({item.taxPercent}%)</span></td><td className="px-3 py-3 font-black tabular-nums">{formatMoney(item.totalAmount)}</td></tr>)}</tbody><tfoot className="border-t-2 border-border bg-slate-50 font-black"><tr><td className="px-3 py-3" colSpan={3}>الإجمالي</td><td className="px-3 py-3 tabular-nums">{formatMoney(invoice.subtotal)}</td><td className="px-3 py-3 tabular-nums">{formatMoney(invoice.taxAmount)}</td><td className="px-3 py-3 tabular-nums">{formatMoney(invoice.totalAmount)}</td></tr></tfoot></table></div></section>
              <section><h3 className="flex items-center gap-2 text-sm font-black text-foreground"><CreditCard className="h-4 w-4 text-emerald-700" /> سجل الدفعات</h3><div className="mt-3 space-y-2">{invoice.payments.map((payment) => <div key={payment.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border px-3 py-3 text-sm"><div><p className="font-black">{PAYMENT_LABELS[payment.method]}</p><p className="mt-0.5 text-xs font-bold text-muted">{new Date(payment.paidAt).toLocaleString("ar-JO")} {payment.reference ? `• ${payment.reference}` : ""}</p></div><p className="font-black tabular-nums text-emerald-700">{formatMoney(payment.amount)}</p></div>)}{invoice.payments.length === 0 ? <p className="rounded-lg bg-slate-50 px-3 py-6 text-center text-sm font-bold text-muted">لم تُسجل دفعات بعد.</p> : null}</div></section>
            </div>
          ) : !error ? <p className="py-16 text-center text-sm font-bold text-muted">جارٍ تحميل تفاصيل الفاتورة…</p> : null}
        </div>
      </article>
    </div>
  );
}
