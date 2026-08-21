"use client";

import { useCallback, useState } from "react";
import { CheckCircle2, HandCoins, X } from "lucide-react";
import { usePosStore } from "@/store/usePosStore";
import EntityCombobox from "@/components/shared/EntityCombobox";
import QuickCreateEntityModal from "@/components/shared/QuickCreateEntityModal";
import { useCustomerOptions } from "@/components/pos/useCustomerOptions";
import { useModalEscape } from "@/hooks/useModalEscape";

/** سداد الذمم: register a cash payment from a customer against their debt. */
export default function DebtSettlementModal() {
  const isOpen = usePosStore((s) => s.isDebtSettlementModalOpen);
  const closeDebtSettlementModal = usePosStore((s) => s.closeDebtSettlementModal);
  const processDebtSettlement = usePosStore((s) => s.processDebtSettlement);
  const [customerId, setCustomerId] = useState("");
  const [amount, setAmount] = useState("");
  const [addingCustomer, setAddingCustomer] = useState(false);
  const { customers, loading, createCustomer } = useCustomerOptions(isOpen);

  const handleClose = useCallback(() => {
    setCustomerId("");
    setAmount("");
    setAddingCustomer(false);
    closeDebtSettlementModal();
  }, [closeDebtSettlementModal]);

  useModalEscape(handleClose, isOpen);

  if (!isOpen) return null;

  const amountValue = parseFloat(amount) || 0;
  const selectedCustomer = customers.find((customer) => customer.id === customerId);
  const canSubmit = Boolean(selectedCustomer) && amountValue > 0;

  const handleSubmit = () => {
    if (canSubmit && selectedCustomer) {
      void processDebtSettlement(selectedCustomer.name, amountValue, selectedCustomer.id);
      setCustomerId("");
      setAmount("");
      setAddingCustomer(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      dir="rtl"
      onClick={handleClose}
    >
      <div
        className="flex w-full max-w-sm flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-border px-5 py-4">
          <div className="flex items-center gap-2">
            <HandCoins className="h-5 w-5 text-primary" />
            <h2 className="text-lg font-bold">سداد الذمم</h2>
          </div>
          <button
            type="button"
            aria-label="إلغاء"
            onClick={handleClose}
            className="relative z-50 grid h-11 w-11 cursor-pointer place-items-center rounded-lg text-muted transition hover:bg-surface-muted"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="px-5 py-4">
          <div className="space-y-4">
            <EntityCombobox
              id="settlement-customer"
              autoFocus
              label="الزبون"
              value={customerId}
              options={customers}
              placeholder={loading ? "جارٍ تحميل العملاء..." : "اختر زبوناً محفوظاً"}
              emptyLabel="لا يوجد زبون مطابق"
              addLabel="إضافة زبون جديد"
              onChange={setCustomerId}
              onAdd={() => setAddingCustomer(true)}
              required
            />

            <label htmlFor="settlement-amount" className="block text-sm font-bold text-muted">
              المبلغ المدفوع
            </label>
            <input
              id="settlement-amount"
              inputMode="decimal"
              dir="ltr"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="w-full rounded-xl border border-border bg-white px-4 py-3 text-left text-2xl font-bold tabular-nums outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
            />
          </div>
        </div>

        <footer className="border-t border-border px-5 py-4">
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="flex h-14 w-full items-center justify-center gap-2 rounded-xl bg-success text-lg font-black text-success-foreground shadow-sm transition hover:bg-success-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            <CheckCircle2 className="h-5 w-5" />
            تأكيد القبض وطباعة السند
          </button>
        </footer>
      </div>
      {addingCustomer && (
        <QuickCreateEntityModal
          title="إضافة زبون جديد"
          nameLabel="اسم الزبون"
          namePlaceholder="مثال: محمد العلي"
          withPhone
          onClose={() => setAddingCustomer(false)}
          onCreate={async (data) => {
            const customer = await createCustomer(data);
            setCustomerId(customer.id);
            setAddingCustomer(false);
          }}
        />
      )}
    </div>
  );
}
