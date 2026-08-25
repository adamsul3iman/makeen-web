"use client";

import { formatMoney } from "@/lib/format";
import type { PurchaseOrderDetail } from "@/lib/purchasesClient";
import { usePosStore } from "@/store/usePosStore";

/**
 * Official printable purchase order (A4). Rendered hidden on the Purchases
 * page and revealed by the `#purchase-order-print` block in globals.css when
 * window.print() fires — the same visibility-switch pattern as the thermal
 * receipt. Meant to be sent to the supplier over WhatsApp or on paper.
 */
export default function PurchaseOrderPrint({ detail }: { detail: PurchaseOrderDetail }) {
  const currentStore = usePosStore((s) => s.currentStore);
  const { order, items } = detail;
  const total = items.reduce((acc, item) => acc + item.total_price, 0);

  return (
    <div id="purchase-order-print" className="hidden print:block">
      <div dir="rtl" className="mx-auto w-full bg-white px-6 py-8 text-black" style={{ maxWidth: "210mm" }}>
        {/* Header */}
        <div className="flex items-start justify-between border-b-2 border-black pb-4">
          <div>
            <p className="text-xl font-black">{currentStore?.name ?? "متجر"}</p>
            {currentStore?.phone && <p className="mt-1 text-xs font-bold">هاتف: {currentStore.phone}</p>}
            {currentStore?.address && <p className="text-xs font-bold">{currentStore.address}</p>}
          </div>
          <div className="text-left">
            <h1 className="text-2xl font-black underline decoration-2 underline-offset-4">أمر شراء</h1>
            <p className="mt-2 text-sm font-bold" dir="ltr">
              PO-{order.order_number || order.id.slice(0, 8).toUpperCase()}
            </p>
          </div>
        </div>

        {/* Meta */}
        <div className="mt-4 grid grid-cols-3 gap-3 text-sm font-bold">
          <div className="rounded border border-black p-3">
            <p className="text-[10px] font-black uppercase text-neutral-500">المورد</p>
            <p className="mt-1 text-base font-black">{order.supplier_name}</p>
          </div>
          <div className="rounded border border-black p-3">
            <p className="text-[10px] font-black uppercase text-neutral-500">تاريخ الأمر</p>
            <p className="mt-1 tabular-nums">
              {new Date(order.created_at).toLocaleDateString("en-US", { day: "2-digit", month: "2-digit", year: "numeric" })}
            </p>
          </div>
          <div className="rounded border border-black p-3">
            <p className="text-[10px] font-black uppercase text-neutral-500">التسليم المتوقع</p>
            <p className="mt-1 tabular-nums">
              {order.expected_date
                ? new Date(order.expected_date).toLocaleDateString("en-US", { day: "2-digit", month: "2-digit", year: "numeric" })
                : "—"}
            </p>
          </div>
        </div>

        {/* Items */}
        <table className="mt-5 w-full border-collapse text-sm">
          <thead>
            <tr className="bg-black text-white">
              <th className="border border-black px-2 py-2 text-right text-xs font-black">#</th>
              <th className="border border-black px-2 py-2 text-right text-xs font-black">الصنف</th>
              <th className="border border-black px-2 py-2 text-center text-xs font-black">الكمية</th>
              <th className="border border-black px-2 py-2 text-center text-xs font-black">تكلفة الوحدة</th>
              <th className="border border-black px-2 py-2 text-center text-xs font-black">الإجمالي</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item, index) => (
              <tr key={item.id} className={index % 2 === 1 ? "bg-neutral-100" : ""}>
                <td className="border border-black px-2 py-2 tabular-nums">{index + 1}</td>
                <td className="border border-black px-2 py-2 font-bold">{item.productName}</td>
                <td className="border border-black px-2 py-2 text-center tabular-nums">{item.quantity}</td>
                <td className="border border-black px-2 py-2 text-center tabular-nums">{formatMoney(item.unit_cost)}</td>
                <td className="border border-black px-2 py-2 text-center font-black tabular-nums">{formatMoney(item.total_price)}</td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td colSpan={5} className="border border-black px-2 py-4 text-center text-xs font-bold text-neutral-500">
                  لا بنود
                </td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={4} className="border border-black px-2 py-2 text-left text-sm font-black">
                الإجمالي الإجمالي
              </td>
              <td className="border border-black bg-neutral-100 px-2 py-2 text-center text-base font-black tabular-nums">
                {formatMoney(total)}
              </td>
            </tr>
          </tfoot>
        </table>

        {/* Notes */}
        {order.notes && (
          <div className="mt-4 rounded border border-black p-3">
            <p className="text-[10px] font-black uppercase text-neutral-500">ملاحظات</p>
            <p className="mt-1 whitespace-pre-wrap text-sm font-bold">{order.notes}</p>
          </div>
        )}

        {/* Signatures */}
        <div className="mt-10 grid grid-cols-2 gap-8 text-sm font-bold">
          <div className="border-t border-black pt-2 text-center">
            توقيع المورد
          </div>
          <div className="border-t border-black pt-2 text-center">
            توقيع المستلم
          </div>
        </div>

        <p className="mt-6 text-center text-[10px] font-semibold text-neutral-500">
          هذه الوثيقة صادرة إلكترونياً من نظام نقاط البيع — يرجى مراجعة الكميات والأسعار قبل التوقيع.
        </p>
      </div>
    </div>
  );
}
