"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  Copy,
  ImageUp,
  Loader2,
  Plus,
  Save,
  Trash2,
} from "lucide-react";
import BarcodeLabel, { type BarcodeLabelData } from "@/components/print/BarcodeLabel";
import ReceiptTemplatePreview from "@/components/print/ReceiptTemplatePreview";
import { cacheDefaultPrintTemplate, defaultPrintConfig } from "@/lib/clientPrintTemplates";
import { deletePrintTemplate, fetchPrintTemplates, savePrintTemplate, updateLogo } from "@/lib/printClient";
import { LABEL_ELEMENT_LABELS, RECEIPT_SECTION_LABELS } from "@/lib/printTemplates";
import { usePosStore } from "@/store/usePosStore";
import type {
  BarcodeLabelElementId,
  BarcodeLabelTemplateConfig,
  PrintTemplate,
  PrintTemplateConfig,
  PrintTemplateKind,
  ReceiptSectionId,
  ReceiptTemplateConfig,
} from "@/types/printTemplates";

const SAMPLE_LABEL: BarcodeLabelData = {
  name: "قهوة عربية فاخرة 250 غرام",
  barcode: "6251234567890",
  price: 3.75,
  unitName: "عبوة",
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function Toggle({ label, checked, onChange, disabled = false }: { label: string; checked: boolean; onChange: (value: boolean) => void; disabled?: boolean }) {
  return (
    <label className={`flex items-center justify-between gap-3 py-2 text-sm font-bold ${disabled ? "text-muted" : "cursor-pointer"}`}>
      <span>{label}</span>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} className="h-5 w-5 accent-primary" />
    </label>
  );
}

function NumberField({ label, value, min, max, step = 1, suffix, onChange }: { label: string; value: number; min: number; max: number; step?: number; suffix?: string; onChange: (value: number) => void }) {
  return (
    <label className="text-xs font-bold text-muted">
      {label}
      <div className="mt-1 flex h-10 items-center rounded-lg border border-border bg-surface px-2 focus-within:border-primary">
        <input type="number" value={value} min={min} max={max} step={step} onChange={(event) => onChange(Number(event.target.value))} dir="ltr" className="min-w-0 flex-1 bg-transparent text-sm font-black tabular-nums outline-none" />
        {suffix && <span className="text-xs font-bold text-muted">{suffix}</span>}
      </div>
    </label>
  );
}

function Segmented<T extends string | number>({ value, options, onChange }: { value: T; options: Array<{ value: T; label: string }>; onChange: (value: T) => void }) {
  return (
    <div className="grid grid-flow-col auto-cols-fr rounded-lg border border-border bg-surface-muted p-1">
      {options.map((option) => (
        <button key={String(option.value)} type="button" onClick={() => onChange(option.value)} className={`h-9 rounded-md px-2 text-xs font-black ${value === option.value ? "bg-surface text-primary shadow-card" : "text-muted"}`}>{option.label}</button>
      ))}
    </div>
  );
}

export default function PrintStudioPage() {
  const currentStore = usePosStore((state) => state.currentStore);
  const setCurrentStore = usePosStore((state) => state.setCurrentStore);
  const storeId = currentStore?.id ?? null;
  const logoInputRef = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<PrintTemplateKind>("RECEIPT");
  const [templates, setTemplates] = useState<PrintTemplate[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [name, setName] = useState("الفاتورة الحرارية الأساسية");
  const [config, setConfig] = useState<PrintTemplateConfig>(() => defaultPrintConfig("RECEIPT"));
  const [isDefault, setIsDefault] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchPrintTemplates()
      .then((rows) => {
        if (cancelled) return;
        setTemplates(rows);
        const selected = rows.find((row) => row.kind === "RECEIPT" && row.isDefault)
          ?? rows.find((row) => row.kind === "RECEIPT");
        if (selected) {
          setActiveId(selected.id);
          setName(selected.name);
          setConfig(clone(selected.config));
          setIsDefault(selected.isDefault);
        }
      })
      .catch((error) => { if (!cancelled) setMessage({ tone: "error", text: error instanceof Error ? error.message : "تعذر تحميل القوالب" }); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const kindTemplates = useMemo(() => templates.filter((row) => row.kind === kind), [kind, templates]);

  const selectTemplate = (template: PrintTemplate) => {
    setActiveId(template.id);
    setName(template.name);
    setConfig(clone(template.config));
    setIsDefault(template.isDefault);
    setMessage(null);
  };

  const startNew = () => {
    if (loading) return;
    setActiveId(null);
    setName(kind === "RECEIPT" ? "فاتورة جديدة" : "ملصق جديد");
    setConfig(defaultPrintConfig(kind));
    setIsDefault(kindTemplates.length === 0);
    setMessage(null);
  };

  const changeKind = (value: PrintTemplateKind) => {
    setKind(value);
    const selected = templates.find((row) => row.kind === value && row.isDefault)
      ?? templates.find((row) => row.kind === value);
    if (selected) selectTemplate(selected);
    else {
      setActiveId(null);
      setName(value === "RECEIPT" ? "فاتورة جديدة" : "ملصق جديد");
      setConfig(defaultPrintConfig(value));
      setIsDefault(true);
      setMessage(null);
    }
  };

  const duplicate = () => {
    if (loading) return;
    setActiveId(null);
    setName(`${name} - نسخة`);
    setIsDefault(false);
    setConfig(clone(config));
    setMessage(null);
  };

  const save = async () => {
    if (!name.trim()) return setMessage({ tone: "error", text: "اسم القالب مطلوب" });
    setSaving(true);
    setMessage(null);
    try {
      const saved = await savePrintTemplate({ kind, name: name.trim(), isDefault, config }, activeId ?? undefined);
      setTemplates((current) => {
        const next = current.filter((row) => row.id !== saved.id).map((row) => saved.isDefault && row.kind === saved.kind ? { ...row, isDefault: false } : row);
        return [saved, ...next];
      });
      setActiveId(saved.id);
      setConfig(clone(saved.config));
      setIsDefault(saved.isDefault);
      if (saved.isDefault) cacheDefaultPrintTemplate(saved, storeId);
      setMessage({ tone: "success", text: saved.isDefault ? "تم حفظ القالب وتفعيله على أجهزة المتجر" : "تم حفظ القالب" });
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "تعذر حفظ القالب" });
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!activeId || isDefault || !window.confirm(`حذف القالب «${name}»؟`)) return;
    try {
      await deletePrintTemplate(activeId);
    } catch (error) {
      return setMessage({ tone: "error", text: error instanceof Error ? error.message : "تعذر حذف القالب" });
    }
    const remaining = templates.filter((row) => row.id !== activeId);
    setTemplates(remaining);
    const fallback = remaining.find((row) => row.kind === kind && row.isDefault)
      ?? remaining.find((row) => row.kind === kind);
    if (fallback) selectTemplate(fallback);
    else {
      setActiveId(null);
      setName(kind === "RECEIPT" ? "فاتورة جديدة" : "ملصق جديد");
      setConfig(defaultPrintConfig(kind));
      setIsDefault(true);
    }
    setMessage({ tone: "success", text: "تم حذف القالب" });
  };

  const uploadLogo = async (file: File | undefined) => {
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type) || file.size > 600_000) {
      return setMessage({ tone: "error", text: "استخدم PNG أو JPEG أو WebP بحجم لا يتجاوز 600KB" });
    }
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("تعذر قراءة الشعار"));
      reader.readAsDataURL(file);
    });
    try {
      await updateLogo(dataUrl);
    } catch (error) {
      return setMessage({ tone: "error", text: error instanceof Error ? error.message : "تعذر حفظ الشعار" });
    }
    if (currentStore) setCurrentStore({ ...currentStore, logoUrl: dataUrl });
    setMessage({ tone: "success", text: "تم تحديث شعار الفاتورة" });
  };

  const receipt = config as ReceiptTemplateConfig;
  const label = config as BarcodeLabelTemplateConfig;
  const moveReceiptSection = (id: ReceiptSectionId, direction: -1 | 1) => {
    const index = receipt.sections.findIndex((row) => row.id === id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= receipt.sections.length) return;
    const sections = [...receipt.sections];
    [sections[index], sections[target]] = [sections[target], sections[index]];
    setConfig({ ...receipt, sections });
  };
  const moveLabelElement = (id: BarcodeLabelElementId, direction: -1 | 1) => {
    const index = label.order.indexOf(id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= label.order.length) return;
    const order = [...label.order];
    [order[index], order[target]] = [order[target], order[index]];
    setConfig({ ...label, order });
  };

  return (
    <div className="mx-auto max-w-6xl" dir="rtl">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
        <div><h1 className="text-2xl font-black">استوديو الطباعة</h1><p className="mt-1 text-sm font-semibold text-muted">صمّم القالب، عاينه، ثم فعّله لكل أجهزة المتجر</p></div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={duplicate} disabled={loading} className="grid h-10 w-10 place-items-center rounded-lg border border-border bg-surface text-muted disabled:opacity-40" title="نسخ القالب"><Copy className="h-4 w-4" /></button>
          <button type="button" onClick={startNew} disabled={loading} className="grid h-10 w-10 place-items-center rounded-lg border border-border bg-surface text-primary disabled:opacity-40" title="قالب جديد"><Plus className="h-4 w-4" /></button>
          <button type="button" onClick={() => void save()} disabled={loading || saving} className="flex h-10 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-black text-primary-foreground disabled:opacity-50">{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}حفظ</button>
        </div>
      </header>

      <div className="mt-4 flex items-center justify-between gap-3">
        <Segmented value={kind} onChange={changeKind} options={[{ value: "RECEIPT", label: "الفواتير" }, { value: "BARCODE_LABEL", label: "ملصقات الباركود" }]} />
        {message && <p className={`text-sm font-black ${message.tone === "success" ? "text-success" : "text-destructive"}`}>{message.text}</p>}
      </div>

      <div className="scrollbar-hidden mt-3 flex gap-2 overflow-x-auto pb-1">
        {loading ? <Loader2 className="h-5 w-5 animate-spin text-primary" /> : kindTemplates.map((template) => (
          <button key={template.id} type="button" onClick={() => selectTemplate(template)} className={`flex h-10 shrink-0 items-center gap-2 rounded-lg border px-3 text-sm font-black ${activeId === template.id ? "border-primary bg-primary/10 text-primary" : "border-border bg-surface text-muted"}`}>{template.isDefault && <Check className="h-4 w-4" />}{template.name}</button>
        ))}
      </div>

      <div className="mt-4 grid min-h-0 gap-4 md:h-[calc(100dvh-15rem)] md:grid-cols-[minmax(210px,240px)_minmax(0,1fr)]">
        <aside className="min-w-0 overflow-hidden rounded-lg border border-border bg-surface md:h-full">
          <div className="border-b border-border p-3">
            <label className="text-xs font-bold text-muted">اسم القالب<input value={name} onChange={(event) => setName(event.target.value)} className="mt-1 h-10 w-full rounded-lg border border-border px-3 text-sm font-black outline-none focus:border-primary" /></label>
            <Toggle label="القالب الافتراضي للأجهزة" checked={isDefault} onChange={setIsDefault} disabled={Boolean(activeId && kindTemplates.find((row) => row.id === activeId)?.isDefault)} />
          </div>
          <div className="scrollbar-hidden max-h-[540px] space-y-4 overflow-y-auto p-3 md:h-[calc(100%-73px)] md:max-h-none">
            {kind === "RECEIPT" ? (
              <>
                <section><h2 className="mb-2 text-xs font-black text-foreground">الورق والمظهر</h2><div className="space-y-2"><Segmented value={receipt.paperWidth} onChange={(paperWidth) => setConfig({ ...receipt, paperWidth, itemColumnMode: paperWidth === 58 ? "compact" : receipt.itemColumnMode })} options={[{ value: 80, label: "80mm" }, { value: 58, label: "58mm" }]} /><Segmented value={receipt.density} onChange={(density) => setConfig({ ...receipt, density })} options={[{ value: "compact", label: "مضغوط" }, { value: "standard", label: "متوازن" }, { value: "comfortable", label: "واسع" }]} /><Segmented value={receipt.dividerStyle} onChange={(dividerStyle) => setConfig({ ...receipt, dividerStyle })} options={[{ value: "dashed", label: "متقطع" }, { value: "solid", label: "متصل" }, { value: "none", label: "بدون" }]} /><NumberField label="حجم النص" value={receipt.fontScale} min={0.8} max={1.3} step={0.1} onChange={(fontScale) => setConfig({ ...receipt, fontScale })} /></div></section>
                <section className="border-t border-border pt-3"><div className="mb-2 flex items-center justify-between"><h2 className="text-xs font-black">الشعار</h2><button type="button" onClick={() => logoInputRef.current?.click()} className="flex h-8 items-center gap-1.5 rounded-lg border border-border px-2 text-xs font-black text-primary"><ImageUp className="h-3.5 w-3.5" />رفع</button><input ref={logoInputRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(event) => void uploadLogo(event.target.files?.[0])} /></div><Segmented value={receipt.logoSize} onChange={(logoSize) => setConfig({ ...receipt, logoSize })} options={[{ value: "small", label: "صغير" }, { value: "medium", label: "متوسط" }, { value: "large", label: "كبير" }]} /></section>
                <section className="border-t border-border pt-3">
                  <h2 className="mb-2 text-xs font-black">جدول الأصناف</h2>
                  <p className="mb-1.5 text-[11px] font-bold text-muted">الكمية والإجمالي أعمدة ثابتة دائماً</p>
                  <div className="space-y-2">
                    <Segmented value={receipt.itemColumnMode} onChange={(itemColumnMode) => setConfig({ ...receipt, itemColumnMode })} options={[{ value: "full", label: "4 أعمدة" }, { value: "compact", label: "3 أعمدة" }]} />
                    <Segmented value={receipt.tableHeaderStyle} onChange={(tableHeaderStyle) => setConfig({ ...receipt, tableHeaderStyle })} options={[{ value: "dark", label: "داكن" }, { value: "outline", label: "محدد" }, { value: "minimal", label: "خفيف" }]} />
                    <Segmented value={receipt.itemStyle} onChange={(itemStyle) => setConfig({ ...receipt, itemStyle })} options={[{ value: "grid", label: "شبكة" }, { value: "lines", label: "أسطر" }, { value: "clean", label: "بسيط" }]} />
                  </div>
                  <div className="mt-1 grid grid-cols-2 gap-x-3">
                    <Toggle label="رقم السطر" checked={receipt.showLineNumbers} onChange={(showLineNumbers) => setConfig({ ...receipt, showLineNumbers })} />
                    <Toggle label="تظليل الصفوف" checked={receipt.zebraRows} onChange={(zebraRows) => setConfig({ ...receipt, zebraRows })} />
                    <Toggle label="وحدة القياس" checked={receipt.showItemUnit} onChange={(showItemUnit) => setConfig({ ...receipt, showItemUnit })} />
                    <Toggle label="خصم السطر" checked={receipt.showItemDiscount} onChange={(showItemDiscount) => setConfig({ ...receipt, showItemDiscount })} />
                    <Toggle label="باركود الصنف" checked={receipt.showItemBarcode} onChange={(showItemBarcode) => setConfig({ ...receipt, showItemBarcode })} />
                    <Toggle label="ضريبة الصنف" checked={receipt.showItemTax} onChange={(showItemTax) => setConfig({ ...receipt, showItemTax })} />
                  </div>
                </section>
                <section className="border-t border-border pt-3">
                  <h2 className="mb-2 text-xs font-black">المجاميع والإجمالي</h2>
                  <div className="space-y-2">
                    <Segmented value={receipt.summaryStyle} onChange={(summaryStyle) => setConfig({ ...receipt, summaryStyle })} options={[{ value: "grid", label: "شبكة" }, { value: "lines", label: "أسطر" }, { value: "clean", label: "بسيط" }]} />
                    <Segmented value={receipt.totalStyle} onChange={(totalStyle) => setConfig({ ...receipt, totalStyle })} options={[{ value: "rules", label: "خطوط" }, { value: "boxed", label: "إطار" }, { value: "dark", label: "داكن" }]} />
                    <NumberField label="حجم الإجمالي" value={receipt.totalScale} min={0.8} max={1.5} step={0.1} onChange={(totalScale) => setConfig({ ...receipt, totalScale })} />
                  </div>
                </section>
                <section className="border-t border-border pt-3"><h2 className="mb-1 text-xs font-black">بيانات الفاتورة</h2><div className="grid grid-cols-2 gap-x-3"><Toggle label="هاتف العميل" checked={receipt.showCustomerPhone} onChange={(showCustomerPhone) => setConfig({ ...receipt, showCustomerPhone })} /><Toggle label="الفرع والجهاز" checked={receipt.showBranchTerminal} onChange={(showBranchTerminal) => setConfig({ ...receipt, showBranchTerminal })} /></div></section>
                <section className="border-t border-border pt-3"><h2 className="mb-1 text-xs font-black">ترتيب أقسام الفاتورة</h2>{receipt.sections.map((section, index) => { const locked = section.id === "items" || section.id === "total"; return <div key={section.id} className="flex items-center gap-1 border-b border-border/60 py-1.5"><input type="checkbox" checked={section.visible} disabled={locked} onChange={(event) => setConfig({ ...receipt, sections: receipt.sections.map((row) => row.id === section.id ? { ...row, visible: event.target.checked } : row) })} className="h-4 w-4 accent-primary" /><span className="min-w-0 flex-1 truncate text-xs font-bold">{RECEIPT_SECTION_LABELS[section.id]}</span><button type="button" disabled={index === 0} onClick={() => moveReceiptSection(section.id, -1)} className="grid h-7 w-7 place-items-center disabled:opacity-20"><ArrowUp className="h-3.5 w-3.5" /></button><button type="button" disabled={index === receipt.sections.length - 1} onClick={() => moveReceiptSection(section.id, 1)} className="grid h-7 w-7 place-items-center disabled:opacity-20"><ArrowDown className="h-3.5 w-3.5" /></button></div>; })}</section>
                <section className="border-t border-border pt-3"><Toggle label="الرقم الضريبي" checked={receipt.showTaxNumber} onChange={(showTaxNumber) => setConfig({ ...receipt, showTaxNumber })} /><Toggle label="اسم الكاشير والوقت" checked={receipt.showCashierTime} onChange={(showCashierTime) => setConfig({ ...receipt, showCashierTime })} /><Toggle label="باركود الفاتورة" checked={receipt.showInvoiceBarcode} onChange={(showInvoiceBarcode) => setConfig({ ...receipt, showInvoiceBarcode })} /><Toggle label="QR الضريبي" checked={receipt.showFiscalQr} onChange={(showFiscalQr) => setConfig({ ...receipt, showFiscalQr })} /></section>
              </>
            ) : (
              <>
                <section><h2 className="mb-2 text-xs font-black">مقاس الملصق</h2><div className="grid grid-cols-2 gap-2"><NumberField label="العرض" value={label.widthMm} min={20} max={100} suffix="mm" onChange={(widthMm) => setConfig({ ...label, widthMm })} /><NumberField label="الارتفاع" value={label.heightMm} min={12} max={80} suffix="mm" onChange={(heightMm) => setConfig({ ...label, heightMm })} /><NumberField label="المسافة" value={label.gapMm} min={0} max={10} step={0.5} suffix="mm" onChange={(gapMm) => setConfig({ ...label, gapMm })} /><NumberField label="ارتفاع الرمز" value={label.barcodeHeightMm} min={3} max={30} step={0.5} suffix="mm" onChange={(barcodeHeightMm) => setConfig({ ...label, barcodeHeightMm })} /></div></section>
                <section className="border-t border-border pt-3"><h2 className="mb-2 text-xs font-black">الإطار والنص</h2><Segmented value={label.borderStyle} onChange={(borderStyle) => setConfig({ ...label, borderStyle })} options={[{ value: "none", label: "بلا إطار" }, { value: "solid", label: "متصل" }, { value: "dashed", label: "متقطع" }]} /><div className="mt-2 grid grid-cols-2 gap-2"><NumberField label="الحواف" value={label.paddingMm} min={0} max={6} step={0.5} suffix="mm" onChange={(paddingMm) => setConfig({ ...label, paddingMm })} /><NumberField label="حجم النص" value={label.fontScale} min={0.7} max={1.4} step={0.1} onChange={(fontScale) => setConfig({ ...label, fontScale })} /></div></section>
                <section className="border-t border-border pt-3"><h2 className="mb-1 text-xs font-black">العناصر وترتيبها</h2>{label.order.map((id, index) => { const toggleMap: Partial<Record<BarcodeLabelElementId, keyof BarcodeLabelTemplateConfig>> = { store: "showStoreName", name: "showName", barcodeText: "showBarcodeText", unit: "showUnit", price: "showPrice" }; const key = toggleMap[id]; const checked = id === "barcode" || (key ? Boolean(label[key]) : true); return <div key={id} className="flex items-center gap-1 border-b border-border/60 py-1.5"><input type="checkbox" checked={checked} disabled={id === "barcode"} onChange={(event) => key && setConfig({ ...label, [key]: event.target.checked })} className="h-4 w-4 accent-primary" /><span className="min-w-0 flex-1 truncate text-xs font-bold">{LABEL_ELEMENT_LABELS[id]}</span><button type="button" disabled={index === 0} onClick={() => moveLabelElement(id, -1)} className="grid h-7 w-7 place-items-center disabled:opacity-20"><ArrowUp className="h-3.5 w-3.5" /></button><button type="button" disabled={index === label.order.length - 1} onClick={() => moveLabelElement(id, 1)} className="grid h-7 w-7 place-items-center disabled:opacity-20"><ArrowDown className="h-3.5 w-3.5" /></button></div>; })}</section>
              </>
            )}
            <button type="button" onClick={() => void remove()} disabled={!activeId || isDefault} className="flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-destructive/30 text-sm font-black text-destructive disabled:opacity-30"><Trash2 className="h-4 w-4" />حذف القالب</button>
          </div>
        </aside>

        <section className="flex min-h-80 min-w-0 items-start justify-center overflow-auto rounded-lg border border-border bg-surface-muted p-4 md:h-full md:min-h-0">
          {kind === "RECEIPT" ? <ReceiptTemplatePreview config={receipt} store={{ name: currentStore?.name ?? "اسم المتجر", logoUrl: currentStore?.logoUrl, address: currentStore?.address, phone: currentStore?.phone, taxNumber: currentStore?.taxNumber, receiptHeader: currentStore?.receiptHeader, receiptFooter: currentStore?.receiptFooter }} /> : <div className="flex min-h-80 w-full items-center justify-center md:min-h-0"><BarcodeLabel data={SAMPLE_LABEL} config={label} storeName={currentStore?.name ?? "اسم المتجر"} preview /></div>}
        </section>
      </div>
    </div>
  );
}
