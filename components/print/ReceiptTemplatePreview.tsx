"use client";

import type { ReactNode } from "react";
import { formatMoney } from "@/lib/format";
import { RECEIPT_SECTION_LABELS } from "@/lib/printTemplates";
import type { ReceiptSectionId, ReceiptTemplateConfig } from "@/types/printTemplates";

function FakeBarcode() {
  return <div className="mx-auto h-8 w-36 bg-[repeating-linear-gradient(90deg,#000_0,#000_2px,transparent_2px,transparent_4px,#000_4px,#000_5px,transparent_5px,transparent_8px)]" />;
}

export default function ReceiptTemplatePreview({
  config,
  store,
}: {
  config: ReceiptTemplateConfig;
  store: { name: string; logoUrl?: string; address?: string; phone?: string; taxNumber?: string; receiptHeader?: string; receiptFooter?: string };
}) {
  const compact = config.density === "compact";
  const comfortable = config.density === "comfortable";
  const space = compact ? "space-y-1" : comfortable ? "space-y-3" : "space-y-2";
  const divider = config.dividerStyle === "none"
    ? ""
    : config.dividerStyle === "solid"
      ? "border-t-2 border-black"
      : "border-t border-dashed border-black";
  const logoHeight = config.logoSize === "small" ? "max-h-8" : config.logoSize === "large" ? "max-h-16" : "max-h-11";
  const contact = [store.address, store.phone].filter(Boolean).join(" • ");
  const fullColumns = config.itemColumnMode === "full" && config.paperWidth === 80;
  const headerClass = config.tableHeaderStyle === "dark"
    ? "bg-black text-white"
    : config.tableHeaderStyle === "outline"
      ? "border-y-2 border-black"
      : "border-b border-black";
  const itemCellClass = config.itemStyle === "grid" ? "border border-black" : "";
  const summaryClass = config.summaryStyle === "grid"
    ? "border border-black"
    : config.summaryStyle === "lines"
      ? "border-y border-black"
      : "";
  const totalClass = config.totalStyle === "dark"
    ? "bg-black text-white px-2 py-2"
    : config.totalStyle === "boxed"
      ? "border-2 border-black px-2 py-2"
      : "border-y-2 border-black px-1 py-2";

  const sections: Record<ReceiptSectionId, ReactNode> = {
    branding: (
      <div className="border-y-2 border-black py-2 text-center">
        {store.logoUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={store.logoUrl} alt="" className={`mx-auto mb-1 max-w-[60%] object-contain ${logoHeight}`} />
        )}
        <p className="text-base font-black">{store.name || "اسم المتجر"}</p>
        {contact && <p className="text-[8px] font-bold">{contact}</p>}
        {store.receiptHeader && <p className="mt-1 text-[9px] font-black">{store.receiptHeader}</p>}
      </div>
    ),
    document: (
      <div className="text-center">
        <p className="text-[10px] font-black">فاتورة مبيعات</p>
        <p className="mx-auto mt-1 w-fit border-2 border-black px-2 py-0.5 text-[9px] font-black">رقم الفاتورة 1042</p>
      </div>
    ),
    meta: (
      <div className="grid grid-cols-2 gap-1 text-[8px] font-bold">
        <span>13/08/2026 10:30</span><span className="text-left">الكاشير: أحمد</span>
        <span>الفرع الرئيسي</span><span className="text-left">وردية #A1B2C3</span>
      </div>
    ),
    customer: <div className="border border-black px-2 py-1 text-[8px] font-bold">العميل: محمد العلي • 0790000000</div>,
    items: (
      <table className={`w-full table-fixed border-collapse text-[8px] ${config.itemStyle === "grid" ? "border border-black" : ""}`}>
        <colgroup><col />{fullColumns && <col className="w-[20%]" />}<col className="w-[14%]" /><col className="w-[23%]" /></colgroup>
        <thead><tr className={headerClass}><th className="px-1 py-1 text-right">الصنف</th>{fullColumns && <th className="px-0.5 py-1 text-center">السعر</th>}<th className="px-0.5 py-1 text-center">الكمية</th><th className="px-1 py-1 text-left">الإجمالي</th></tr></thead>
        <tbody>
          {[{ name: "حليب كامل الدسم", code: "625100000001", qty: 2, unit: "حبة", price: 1.25, total: 2.5 }, { name: "مناديل ورقية", code: "625100000002", qty: 1, unit: "عبوة", price: 1, total: 1 }].map((row, index) => (
            <tr key={row.code} className={`${config.itemStyle === "lines" ? "border-b border-dashed border-black" : ""} ${config.zebraRows && index % 2 === 1 ? "bg-black/10" : ""}`}>
              <td className={`${itemCellClass} px-1 py-1 align-top font-bold`}><p>{config.showLineNumbers ? `${index + 1}. ` : ""}{row.name}</p>{!fullColumns && <p className="text-[7px]">سعر الوحدة {formatMoney(row.price)}</p>}{config.showItemTax && <p className="text-[7px]">ضريبة 16% شاملة</p>}{config.showItemBarcode && <p dir="ltr" className="text-[7px]">{row.code}</p>}</td>
              {fullColumns && <td dir="ltr" className={`${itemCellClass} px-0.5 py-1 text-center font-bold`}>{formatMoney(row.price)}</td>}
              <td dir="ltr" className={`${itemCellClass} px-0.5 py-1 text-center font-black`}>{row.qty}{config.showItemUnit && <span dir="rtl" className="block text-[6px] font-bold">{row.unit}</span>}</td>
              <td dir="ltr" className={`${itemCellClass} px-1 py-1 text-left font-black`}>{formatMoney(row.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    ),
    summary: (
      <div className={`${summaryClass} text-[8px] font-bold`}>
        <div className={`flex justify-between px-1 py-0.5 ${config.summaryStyle !== "clean" ? "border-b border-black" : ""}`}><span>الصافي قبل الضريبة</span><span>{formatMoney(3.02)}</span></div>
        <div className="flex justify-between px-1 py-0.5"><span>ضريبة المنتجات</span><span>{formatMoney(0.48)}</span></div>
      </div>
    ),
    total: <div className={`flex items-end justify-between ${totalClass}`}><span className="text-[10px] font-black">الإجمالي</span><strong dir="ltr" style={{ fontSize: `${config.totalScale * 30}px` }}>{formatMoney(3.5)}</strong></div>,
    payment: <div className="flex justify-between text-[8px] font-bold"><span>طريقة الدفع</span><span>نقداً • الباقي {formatMoney(1.5)}</span></div>,
    codes: (
      <div className="text-center">
        {config.showInvoiceBarcode && <FakeBarcode />}
        {config.showInvoiceBarcode && <p className="text-[7px] font-black">A1B2C3D4</p>}
        {config.showFiscalQr && <div className="mx-auto mt-1 grid h-14 w-14 grid-cols-5 gap-px bg-black p-1">{Array.from({ length: 25 }, (_, index) => <i key={index} className={index % 3 === 0 || index % 7 === 0 ? "bg-white" : "bg-black"} />)}</div>}
      </div>
    ),
    footer: <p className="text-center text-[10px] font-black">{store.receiptFooter || "شكراً لزيارتكم"}</p>,
  };

  return (
    <div
      dir="rtl"
      className={`mx-auto bg-white p-3 font-sans leading-snug text-black shadow-xl ${space}`}
      style={{
        width: config.paperWidth === 58 ? 250 : 330,
        fontSize: `${config.fontScale * 11}px`,
      }}
    >
      {config.sections.filter((row) => row.visible).map((section, index, visible) => (
        <div key={section.id} title={RECEIPT_SECTION_LABELS[section.id]}>
          {sections[section.id]}
          {index < visible.length - 1 && config.dividerStyle !== "none" && <div className={`mt-2 ${divider}`} />}
        </div>
      ))}
    </div>
  );
}
