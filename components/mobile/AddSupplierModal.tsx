"use client";

import { useState } from "react";
import type { FormEvent } from "react";
import { Loader, UserPlus, X } from "lucide-react";
import { useReceivingStore } from "@/store/useReceivingStore";

/**
 * Inline vendor creation from the goods-in picker. The cashier types a name
 * (and optionally a phone) without leaving the invoice; the store saves the
 * vendor offline-first, queues a SUPPLIER_CREATE sync event, mirrors it to the
 * server when reachable, and auto-selects the new vendor — the current draft
 * lines, payments, and invoice meta are never touched.
 */
export default function AddSupplierModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const addSupplier = useReceivingStore((s) => s.addSupplier);

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  if (!open) return null;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");

    const supplierName = name.trim();
    if (!supplierName) {
      setError("أدخل اسم المورد");
      return;
    }

    setSaving(true);
    try {
      const result = await addSupplier({ name: supplierName, phone: phone.trim() });
      if (!result.ok) {
        setError(result.error === "supplier_name_required" ? "أدخل اسم المورد" : "تعذر حفظ المورد");
        return;
      }
      setName("");
      setPhone("");
      onClose();
    } catch {
      setError("تعذر حفظ المورد");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-6">
      <div className="w-full max-w-md rounded-t-3xl bg-white p-5 shadow-2xl sm:rounded-3xl">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <UserPlus className="h-5 w-5 text-primary" />
            <h3 className="text-base font-black text-foreground">إضافة مورد جديد</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="إغلاق"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-xl text-muted transition hover:bg-surface-muted hover:text-foreground"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <p className="mb-4 rounded-xl border border-border bg-surface-muted px-3 py-2 text-xs font-bold text-muted-foreground">
          سيُضاف المورد إلى القائمة ويُحدَّد تلقائياً على الفاتورة الحالية
        </p>

        {error && (
          <div className="mb-4 rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-sm font-bold text-destructive">
            {error}
          </div>
        )}

        <form onSubmit={submit} className="space-y-4">
          <div>
            <label htmlFor="add-supplier-name" className="mb-1.5 block text-sm font-black text-foreground">
              اسم المورد *
            </label>
            <input
              id="add-supplier-name"
              type="text"
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="مثال: مؤسسة الرشيد للتوزيع"
              className="h-12 w-full rounded-xl border border-border bg-surface-muted px-3 text-base font-bold text-foreground outline-none transition focus:border-primary"
            />
          </div>

          <div>
            <label htmlFor="add-supplier-phone" className="mb-1.5 block text-sm font-black text-foreground">
              رقم الهاتف
            </label>
            <input
              id="add-supplier-phone"
              type="tel"
              inputMode="tel"
              dir="ltr"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              placeholder="07xxxxxxxx"
              className="h-12 w-full rounded-xl border border-border bg-surface-muted px-3 text-right font-mono text-base font-bold text-foreground outline-none transition focus:border-primary"
            />
          </div>

          <button
            type="submit"
            disabled={saving}
            className="flex h-14 w-full items-center justify-center gap-2 rounded-xl bg-success text-base font-black text-success-foreground shadow-sm transition hover:bg-success-hover active:scale-[0.98] disabled:opacity-40"
          >
            {saving ? <Loader className="h-5 w-5 animate-spin" /> : <UserPlus className="h-5 w-5" />}
            {saving ? "جارٍ الحفظ…" : "إضافة المورد وتحديده"}
          </button>
        </form>
      </div>
    </div>
  );
}
