"use client";

import { useMemo, useState } from "react";
import { Plus, Save, Trash2, X } from "lucide-react";
import EntityCombobox from "@/components/shared/EntityCombobox";
import QuickCreateEntityModal from "@/components/shared/QuickCreateEntityModal";
import { formatMoney } from "@/lib/format";
import { createSupplier as createSupplierRequest, createSupplierInvoice } from "@/lib/suppliersClient";
import type { SupplierAccountOption, SupplierProductOption } from "@/types/supplierAccounts.types";

interface InvoiceLineInput {
  productId: string;
  description: string;
  quantity: string;
  unitCost: string;
  taxPercent: string;
}

const today = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Amman",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());

function plusDays(value: string, days: number): string {
  const date = new Date(`${value}T12:00:00+03:00`);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function emptyLine(): InvoiceLineInput {
  return { productId: "", description: "", quantity: "1", unitCost: "", taxPercent: "16" };
}

export default function SupplierInvoiceModal({
  suppliers,
  products,
  onClose,
  onCreated,
}: {
  suppliers: SupplierAccountOption[];
  products: SupplierProductOption[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [supplierOptions, setSupplierOptions] = useState(suppliers);
  const [supplierId, setSupplierId] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [invoiceDate, setInvoiceDate] = useState(today);
  const [dueDate, setDueDate] = useState(plusDays(today, 30));
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<InvoiceLineInput[]>([emptyLine()]);
  const [addingSupplier, setAddingSupplier] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const totals = useMemo(() => {
    return lines.reduce(
      (sum, line) => {
        const quantity = Number(line.quantity) || 0;
        const unitCost = Number(line.unitCost) || 0;
        const taxPercent = Number(line.taxPercent) || 0;
        const net = round2(quantity * unitCost);
        const tax = round2((net * taxPercent) / 100);
        return { net: round2(sum.net + net), tax: round2(sum.tax + tax), total: round2(sum.total + net + tax) };
      },
      { net: 0, tax: 0, total: 0 },
    );
  }, [lines]);

  const updateLine = (index: number, patch: Partial<InvoiceLineInput>) => {
    setLines((current) => current.map((line, lineIndex) => (lineIndex === index ? { ...line, ...patch } : line)));
  };

  const chooseProduct = (index: number, productId: string) => {
    const product = products.find((option) => option.id === productId);
    updateLine(index, {
      productId,
      description: product?.name ?? lines[index].description,
      taxPercent: product ? String(product.taxPercent) : lines[index].taxPercent,
    });
  };

  const createSupplier = async (data: { name: string; phone: string }) => {
    const supplier = await createSupplierRequest({ name: data.name, phone: data.phone });
    setSupplierOptions((current) => [...current, { id: supplier.id, name: supplier.name, balance: supplier.balance }].sort((a, b) => a.name.localeCompare(b.name, "ar")));
    setSupplierId(supplier.id);
    setAddingSupplier(false);
  };

  const submit = async () => {
    if (saving) return;
    const parsedLines = lines.map((line) => ({
      productId: line.productId || null,
      description: line.description.trim(),
      quantity: Number(line.quantity),
      unitCost: Number(line.unitCost),
      taxPercent: Number(line.taxPercent),
    }));
    if (!supplierId || !invoiceNumber.trim()) {
      setError("اختر المورد وأدخل رقم الفاتورة");
      return;
    }
    if (dueDate < invoiceDate) {
      setError("تاريخ الاستحقاق يجب أن يساوي أو يلي تاريخ الفاتورة");
      return;
    }
    if (parsedLines.some((line) => !line.description || line.quantity <= 0 || line.unitCost < 0 || line.taxPercent < 0 || line.taxPercent > 100)) {
      setError("راجع وصف البنود والكميات والتكلفة ونسبة الضريبة");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await createSupplierInvoice({
        supplier_id: supplierId,
        invoice_number: invoiceNumber.trim(),
        total_amount: totals.total,
        due_date: dueDate,
        notes,
        items: parsedLines,
      });
      onCreated();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "تعذر إنشاء فاتورة المورد");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/45 p-3" dir="rtl" onClick={onClose}>
      <form className="flex max-h-[94vh] w-full max-w-5xl flex-col overflow-hidden rounded-lg bg-white shadow-2xl" onClick={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <div><h2 className="text-base font-black text-foreground">فاتورة مورد جديدة</h2><p className="mt-0.5 text-xs font-bold text-muted">التكلفة المدخلة قبل الضريبة، والضريبة تُحسب لكل بند</p></div>
          <button type="button" aria-label="إغلاق" onClick={onClose} className="grid h-9 w-9 place-items-center rounded-md text-muted hover:bg-surface-muted"><X className="h-5 w-5" /></button>
        </header>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
          <section className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
            <div className="lg:col-span-2">
              <EntityCombobox id="supplier-invoice-supplier" label="المورد" value={supplierId} options={supplierOptions} placeholder="اختر المورد" emptyLabel="لا يوجد مورد مطابق" addLabel="إضافة مورد جديد" onChange={setSupplierId} onAdd={() => setAddingSupplier(true)} required />
            </div>
            <label className="grid gap-1.5 text-sm font-bold text-muted">رقم فاتورة المورد *<input value={invoiceNumber} onChange={(event) => setInvoiceNumber(event.target.value)} placeholder="مثال: INV-1025" dir="ltr" className="h-11 rounded-lg border border-border px-3 text-left font-bold outline-none focus:border-primary" /></label>
            <label className="grid gap-1.5 text-sm font-bold text-muted">ملاحظات<input value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="اختياري" className="h-11 rounded-lg border border-border px-3 font-bold outline-none focus:border-primary" /></label>
            <label className="grid gap-1.5 text-sm font-bold text-muted">تاريخ الفاتورة<input type="date" value={invoiceDate} onChange={(event) => { setInvoiceDate(event.target.value); if (dueDate < event.target.value) setDueDate(event.target.value); }} className="h-11 rounded-lg border border-border px-3 font-bold" /></label>
            <label className="grid gap-1.5 text-sm font-bold text-muted">تاريخ الاستحقاق<input type="date" value={dueDate} min={invoiceDate} onChange={(event) => setDueDate(event.target.value)} className="h-11 rounded-lg border border-border px-3 font-bold" /></label>
          </section>

          <section>
            <div className="mb-3 flex items-center justify-between gap-3"><h3 className="text-sm font-black text-foreground">بنود الفاتورة</h3><button type="button" onClick={() => setLines((current) => [...current, emptyLine()])} className="inline-flex h-9 items-center gap-2 rounded-lg bg-blue-600 px-3 text-xs font-black text-white"><Plus className="h-4 w-4" /> إضافة بند</button></div>
            <div className="space-y-3">
              {lines.map((line, index) => {
                const net = round2((Number(line.quantity) || 0) * (Number(line.unitCost) || 0));
                const tax = round2((net * (Number(line.taxPercent) || 0)) / 100);
                return (
                  <article key={index} className="rounded-lg border border-border bg-slate-50 p-3">
                    <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-[1.3fr_1.5fr_0.65fr_0.8fr_0.65fr_auto] lg:items-end">
                      <label className="grid gap-1 text-xs font-black text-muted">المنتج (اختياري)<select value={line.productId} onChange={(event) => chooseProduct(index, event.target.value)} className="h-10 min-w-0 rounded-lg border border-border bg-white px-2 text-sm font-bold"><option value="">بند غير مربوط بمنتج</option>{products.map((product) => <option key={product.id} value={product.id}>{product.name}</option>)}</select></label>
                      <label className="grid gap-1 text-xs font-black text-muted">الوصف *<input value={line.description} onChange={(event) => updateLine(index, { description: event.target.value })} className="h-10 min-w-0 rounded-lg border border-border bg-white px-3 text-sm font-bold" /></label>
                      <label className="grid gap-1 text-xs font-black text-muted">الكمية<input inputMode="decimal" dir="ltr" value={line.quantity} onChange={(event) => updateLine(index, { quantity: event.target.value })} className="h-10 min-w-0 rounded-lg border border-border bg-white px-2 text-left text-sm font-bold tabular-nums" /></label>
                      <label className="grid gap-1 text-xs font-black text-muted">تكلفة الوحدة<input inputMode="decimal" dir="ltr" value={line.unitCost} onChange={(event) => updateLine(index, { unitCost: event.target.value })} placeholder="0.00" className="h-10 min-w-0 rounded-lg border border-border bg-white px-2 text-left text-sm font-bold tabular-nums" /></label>
                      <label className="grid gap-1 text-xs font-black text-muted">الضريبة %<input inputMode="decimal" dir="ltr" value={line.taxPercent} onChange={(event) => updateLine(index, { taxPercent: event.target.value })} className="h-10 min-w-0 rounded-lg border border-border bg-white px-2 text-left text-sm font-bold tabular-nums" /></label>
                      <button type="button" aria-label="حذف البند" disabled={lines.length === 1} onClick={() => setLines((current) => current.filter((_, lineIndex) => lineIndex !== index))} className="grid h-10 w-10 place-items-center rounded-lg text-red-600 hover:bg-red-50 disabled:opacity-30"><Trash2 className="h-4 w-4" /></button>
                    </div>
                    <p className="mt-2 text-left text-xs font-bold tabular-nums text-muted" dir="ltr">{formatMoney(net)} + {formatMoney(tax)} = <span className="text-foreground">{formatMoney(net + tax)}</span></p>
                  </article>
                );
              })}
            </div>
          </section>

          {error ? <p className="rounded-lg bg-red-50 px-3 py-2 text-sm font-black text-red-700">{error}</p> : null}
        </div>

        <footer className="flex flex-col gap-3 border-t border-border bg-white p-4 sm:flex-row sm:items-center sm:justify-between">
          <dl className="flex flex-wrap gap-x-5 gap-y-1 text-sm"><div><dt className="inline font-bold text-muted">الصافي: </dt><dd className="inline font-black tabular-nums">{formatMoney(totals.net)}</dd></div><div><dt className="inline font-bold text-muted">الضريبة: </dt><dd className="inline font-black tabular-nums">{formatMoney(totals.tax)}</dd></div><div><dt className="inline font-black text-foreground">الإجمالي: </dt><dd className="inline text-lg font-black tabular-nums text-green-700">{formatMoney(totals.total)}</dd></div></dl>
          <div className="flex gap-2"><button type="button" onClick={onClose} disabled={saving} className="h-11 rounded-lg border border-border px-5 text-sm font-black text-muted">إلغاء</button><button type="submit" disabled={saving || totals.total <= 0} className="inline-flex h-11 items-center gap-2 rounded-lg bg-green-600 px-5 text-sm font-black text-white disabled:opacity-40"><Save className="h-4 w-4" /> {saving ? "جارٍ الحفظ…" : "حفظ الفاتورة"}</button></div>
        </footer>
      </form>
      {addingSupplier ? <QuickCreateEntityModal title="إضافة مورد" nameLabel="اسم المورد" namePlaceholder="اسم الشركة أو المورد" withPhone onClose={() => setAddingSupplier(false)} onCreate={createSupplier} /> : null}
    </div>
  );
}
