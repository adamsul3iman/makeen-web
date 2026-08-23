"use client";

import { useState } from "react";
import { CheckCircle2, X } from "lucide-react";
import { formatMoney } from "@/lib/format";
import { recordSupplierPayment } from "@/lib/suppliersClient";
import type { SupplierInvoiceListItem, SupplierPaymentMethod } from "@/types/supplierAccounts.types";

export default function SupplierPaymentModal({ invoice, onClose, onPaid }: { invoice: SupplierInvoiceListItem; onClose: () => void; onPaid: () => void }) {
  const [amount, setAmount] = useState(String(invoice.balanceDue));
  const [method, setMethod] = useState<SupplierPaymentMethod>("BANK");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const value = Number(amount) || 0;

  const submit = async () => {
    if (value <= 0 || value > invoice.balanceDue || saving) return;
    setSaving(true);
    setError("");
    try {
      await recordSupplierPayment(invoice.id, { amount: value, method, reference, notes });
      onPaid();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "تعذر تسجيل الدفعة");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/45 p-4" dir="rtl" onClick={onClose}>
      <form className="flex max-h-[90vh] w-full max-w-md flex-col overflow-hidden rounded-lg bg-white shadow-2xl" onClick={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <header className="flex items-center justify-between border-b border-border px-4 py-3"><div><h2 className="font-black text-foreground">تسجيل دفعة للمورد</h2><p className="mt-0.5 text-xs font-bold text-muted">{invoice.supplierName} • فاتورة {invoice.invoiceNumber}</p></div><button type="button" aria-label="إغلاق" onClick={onClose} className="grid h-9 w-9 place-items-center rounded-md text-muted hover:bg-surface-muted"><X className="h-5 w-5" /></button></header>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          <div className="rounded-lg bg-amber-50 px-3 py-3"><p className="text-xs font-bold text-amber-800">الرصيد المستحق</p><p className="mt-1 text-2xl font-black tabular-nums text-amber-900">{formatMoney(invoice.balanceDue)}</p></div>
          <label className="grid gap-1.5 text-sm font-bold text-muted">المبلغ<input autoFocus inputMode="decimal" dir="ltr" value={amount} onChange={(event) => setAmount(event.target.value)} className="h-12 rounded-lg border border-border px-3 text-left text-xl font-black tabular-nums outline-none focus:border-primary" /></label>
          <label className="grid gap-1.5 text-sm font-bold text-muted">طريقة الدفع<select value={method} onChange={(event) => setMethod(event.target.value as SupplierPaymentMethod)} className="h-11 rounded-lg border border-border bg-white px-3 font-bold"><option value="BANK">تحويل بنكي</option><option value="CASH">نقدي</option><option value="CARD">بطاقة</option></select></label>
          <label className="grid gap-1.5 text-sm font-bold text-muted">مرجع الدفع<input value={reference} onChange={(event) => setReference(event.target.value)} placeholder="رقم الحوالة أو السند" className="h-11 rounded-lg border border-border px-3 font-bold" /></label>
          <label className="grid gap-1.5 text-sm font-bold text-muted">ملاحظات<input value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="اختياري" className="h-11 rounded-lg border border-border px-3 font-bold" /></label>
          {value > invoice.balanceDue ? <p className="text-sm font-black text-red-700">المبلغ يتجاوز الرصيد المستحق</p> : null}
          {error ? <p className="rounded-lg bg-red-50 px-3 py-2 text-sm font-black text-red-700">{error}</p> : null}
        </div>
        <footer className="flex gap-2 border-t border-border p-4"><button type="button" onClick={onClose} disabled={saving} className="h-11 flex-1 rounded-lg border border-border text-sm font-black text-muted">إلغاء</button><button type="submit" disabled={saving || value <= 0 || value > invoice.balanceDue} className="inline-flex h-11 flex-[2] items-center justify-center gap-2 rounded-lg bg-green-600 text-sm font-black text-white disabled:opacity-40"><CheckCircle2 className="h-4 w-4" /> {saving ? "جارٍ التسجيل…" : value === invoice.balanceDue ? "سداد كامل" : "تسجيل دفعة جزئية"}</button></footer>
      </form>
    </div>
  );
}
