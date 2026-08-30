"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, RotateCcw } from "lucide-react";
import { usePosStore } from "@/store/usePosStore";
import type { LocalOrder } from "@/types/orders.types";

/**
 * زر الإرجاع — يظهر على بطاقات الطلبات المكتملة فقط (غير الملغاة) التي لها
 * فاتورة مرتبطة. يمرر الفاتورة إلى وضع المرتجع في السلة (hydrating the cart)
 * ثم ينقل المستخدم إلى شاشة نقطة البيع حيث يمكن تأكيد الإرجاع. يميّزه لون وردي
 * هادئ عن زر الطباعة المحايد، ويبقى أيقونةً نظيفة بلا نصوص لإبقاء البطاقة غير
 * مزدحمة.
 */
export default function OrderReturnButton({
  order,
}: {
  order: LocalOrder;
}) {
  const router = useRouter();
  const beginReturnByInvoice = usePosStore((s) => s.beginReturnByInvoice);
  const setNotice = usePosStore((s) => s.setNotice);
  const [busy, setBusy] = useState(false);

  const completed = order.status === "CLOSED";
  if (!completed) return null;

  const invoiceSyncId = order.invoiceSyncId;
  if (!invoiceSyncId) return null;

  const handleReturn = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const ok = await beginReturnByInvoice(invoiceSyncId);
      if (ok) {
        router.push("/pos");
      } else {
        // beginReturnByInvoice already surfaces the specific reason notice
        // (already-returned, duplicate, etc.). Only add generic feedback for
        // the silent "invoice not found locally" path.
        setNotice(
          "فاتورة هذه الفاتورة غير متوفرة محلياً لإجراء الإرجاع — أعد المحاولة من قريب بعد مزامنة السجل",
          "error",
        );
      }
    } catch {
      setNotice("تعذر تحميل فاتورة المرتجع", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      aria-label="إرجاع هذه الفاتورة"
      title="إرجاع هذه الفاتورة"
      onClick={handleReturn}
      disabled={busy}
      className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-rose-200 text-rose-600 transition hover:bg-rose-50 hover:text-rose-700 disabled:opacity-50"
    >
      {busy ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <RotateCcw className="h-4 w-4" />
      )}
    </button>
  );
}
