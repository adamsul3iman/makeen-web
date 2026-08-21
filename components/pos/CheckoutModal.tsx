"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeftRight, Banknote, Check, CreditCard, Send, Truck, User } from "lucide-react";
import { ModalShell } from "@/components/ui/ModalShell";
import { usePosStore } from "@/store/usePosStore";
import { formatMoney } from "@/lib/format";
import { isValidMoneyInput, parseMoneyInput } from "@/lib/moneyInput";
import type { PaymentMethod } from "@/types/pos.types";
import EntityCombobox from "@/components/shared/EntityCombobox";
import QuickCreateEntityModal from "@/components/shared/QuickCreateEntityModal";
import { useCustomerOptions } from "@/components/pos/useCustomerOptions";

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** Next logical note combinations for quick cash, e.g. total 13.50 -> [13.50, 15, 20, 50, 100]. */
function quickCashOptions(total: number): number[] {
  const options: number[] = [];
  const push = (v: number) => {
    const r = round2(v);
    if (r > 0 && !options.includes(r)) options.push(r);
  };
  push(total);
  for (const step of [5, 10, 20, 50, 100]) {
    push(Math.ceil(total / step) * step);
  }
  return options.sort((a, b) => a - b);
}

const METHODS: { id: PaymentMethod; label: string; icon: typeof Banknote }[] = [
  { id: "CASH", label: "نقداً", icon: Banknote },
  { id: "VISA", label: "بطاقة", icon: CreditCard },
  { id: "CLIQ", label: "كليك", icon: Send },
  { id: "SPLIT", label: "نقد + بطاقة", icon: ArrowLeftRight },
  { id: "DEBT", label: "ذمم", icon: User },
];

export default function CheckoutModal() {
  const isOpen = usePosStore((s) => s.isCheckoutModalOpen);
  const totals = usePosStore((s) => s.totals);
  const closeCheckout = usePosStore((s) => s.closeCheckout);
  const completeCheckout = usePosStore((s) => s.completeCheckout);
  const isCompleting = usePosStore((s) => s.isCompleting);
  const deliveryFee = usePosStore((s) => s.deliveryFee);
  const setDeliveryFee = usePosStore((s) => s.setDeliveryFee);

  const [method, setMethod] = useState<PaymentMethod>("CASH");
  const [amount, setAmount] = useState(() =>
    totals.total >= 0 ? totals.total.toFixed(2) : "",
  );
  // Phase 4: a customer picked on the cart (price-memory badges) is carried
  // into checkout, so the sale stays attached to the same customer.
  const [customerId, setCustomerId] = useState(() => usePosStore.getState().activeCustomerId ?? "");
  const [addingCustomer, setAddingCustomer] = useState(false);
  const [deliveryEnabled, setDeliveryEnabled] = useState(() => usePosStore.getState().deliveryFee > 0);
  const [deliveryDraft, setDeliveryDraft] = useState(() => {
    const fee = usePosStore.getState().deliveryFee;
    return fee > 0 ? String(fee) : "";
  });
  const amountRef = useRef<HTMLInputElement>(null);
  const lastTotalRef = useRef(totals.total);
  const { customers, loading: customersLoading, createCustomer } = useCustomerOptions(isOpen);

  useEffect(() => {
    if (isOpen) {
      requestAnimationFrame(() => amountRef.current?.focus());
    }
  }, [isOpen]);

  // Keep the store's delivery fee in step with the toggle + amount so the
  // header total (and the sync payload) always include it. Cancel leaves the
  // draft on the invoice, exactly like items and discounts do.
  useEffect(() => {
    const fee = deliveryEnabled ? parseFloat(deliveryDraft) : 0;
    setDeliveryFee(Number.isFinite(fee) && fee > 0 ? fee : 0);
  }, [deliveryEnabled, deliveryDraft, setDeliveryFee]);

  // When the live total moves (e.g. a delivery fee was just toggled), keep
  // the exact-amount cash default in step — but never clobber a cash amount
  // the cashier already typed.
  useEffect(() => {
    const previous = lastTotalRef.current;
    lastTotalRef.current = totals.total;
    if (
      previous !== totals.total &&
      amount === (previous >= 0 ? previous.toFixed(2) : "")
    ) {
      setAmount(totals.total >= 0 ? totals.total.toFixed(2) : "");
    }
  }, [totals.total, amount]);

  const isDebt = method === "DEBT";
  const selectedCustomer = customers.find((customer) => customer.id === customerId);

  const total = totals.total;
  const isReturn = total < 0;
  const quickCash = useMemo(() => quickCashOptions(total), [total]);

  const handleClose = useCallback(() => {
    if (isCompleting) return;
    setCustomerId("");
    setAddingCustomer(false);
    closeCheckout();
  }, [closeCheckout, isCompleting]);

  if (!isOpen) return null;

  const cashParsed = parseMoneyInput(amount);
  // NaN when the tendered amount is not well-formed money (e.g. a 13-digit
  // barcode burst): every downstream branch stays false and nothing submits.
  const cash = cashParsed === null ? Number.NaN : cashParsed;
  const isVisa = method === "VISA";
  const isCliq = method === "CLIQ";
  const isCard = isVisa || isCliq;
  const isSplit = method === "SPLIT";

  // Returns (negative totals) are paid out in cash, refunded to card, or
  // transferred back via CliQ; a split refund or a credit (DEBT) return are
  // not meaningful, so those two methods are hidden on return invoices.
  const methods = isReturn
    ? METHODS.filter((m) => m.id === "CASH" || m.id === "VISA" || m.id === "CLIQ")
    : METHODS;

  let cashPortion = 0;
  let cardPortion = 0;
  let change = 0;
  let canComplete = false;

  if (isCard) {
    cardPortion = total;
    canComplete = total !== 0;
  } else if (isSplit) {
    const overpaidInCash = cash >= total;
    cashPortion = overpaidInCash ? total : cash;
    cardPortion = overpaidInCash ? 0 : round2(total - cash);
    change = overpaidInCash ? round2(cash - total) : 0;
    canComplete = total > 0 && cash > 0 && (cardPortion > 0 || overpaidInCash);
  } else if (isDebt) {
    canComplete = total > 0 && Boolean(selectedCustomer);
  } else {
    cashPortion = cash;
    change = round2(Math.max(0, cash - total));
    // Negative totals (return mode) complete with zero cash received.
    canComplete = total !== 0 && cash >= total;
  }

  const shortfall = round2(Math.max(0, total - cash));
  // Pass the RAW cash given (not the clamped cashPortion) for SPLIT so the
  // receipt's change is correct when the customer overpays in cash.
  const amountPaid =
    isCard ? total : isDebt ? 0 : isSplit ? cash : cashPortion;

  const handleConfirm = () => {
    if (canComplete && !isCompleting) {
      const customer = selectedCustomer;
      void completeCheckout(
        method,
        amountPaid,
        customer?.name,
        customer && !customer.id.startsWith("local-") ? customer.id : undefined,
        customer?.phone,
      );
      setCustomerId("");
      setAddingCustomer(false);
    }
  };

  return (
    <>
      <ModalShell
        title="إتمام الدفع"
        onClose={handleClose}
        size="md"
        height="lg"
        bodyClassName="space-y-3 px-4 py-3"
        footer={
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!canComplete || isCompleting}
            className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-success text-lg font-black text-success-foreground transition hover:bg-success-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Check className="h-5 w-5" />
            {isCompleting
              ? "جارٍ الحفظ..."
              : "تأكيد الدفع (" +
                (isDebt
                  ? "على الذمم"
                  : isCliq
                    ? "عبر كليك"
                    : isVisa
                      ? "بطاقة"
                      : isSplit
                        ? "نقد + بطاقة"
                        : "نقداً") +
                ")"}
          </button>
        }
      >
          <div className="rounded-xl bg-surface-muted px-3 py-2 text-center">
            <p className="text-sm font-semibold text-muted">الإجمالي • {Math.abs(totals.itemCount)} صنف</p>
            {totals.discount > 0 && (
              <p className="text-sm font-bold text-destructive">
                الخصم: -{formatMoney(totals.discount)}
              </p>
            )}
            <p className="mt-1 text-3xl font-black tabular-nums">{formatMoney(total)}</p>
          </div>

          {!isReturn && (
            <div className="rounded-xl border border-border bg-surface p-2.5">
              <div className="flex items-center justify-between gap-2">
                <label className="flex cursor-pointer items-center gap-2 text-sm font-bold text-muted">
                  <input
                    type="checkbox"
                    checked={deliveryEnabled}
                    onChange={(e) => setDeliveryEnabled(e.target.checked)}
                    className="h-4 w-4 accent-primary"
                  />
                  <Truck className="h-4 w-4 text-primary" />
                  رسوم التوصيل
                </label>
                {deliveryEnabled && (
                  <input
                    type="number"
                    inputMode="decimal"
                    dir="ltr"
                    min={0}
                    step="0.01"
                    value={deliveryDraft}
                    onChange={(e) => setDeliveryDraft(e.target.value)}
                    placeholder="0.00"
                    autoFocus
                    className="w-32 rounded-lg border border-border bg-surface-muted px-3 py-2 text-left text-lg font-black tabular-nums outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
                  />
                )}
              </div>
              {deliveryEnabled && deliveryFee > 0 && (
                <p className="mt-1.5 text-xs font-semibold text-muted-foreground">
                  ستُضاف{" "}
                  <span className="tabular-nums font-black text-primary">{formatMoney(deliveryFee)}</span>{" "}
                  على الإجمالي وتُطبع على الإيصال — لا تدخل ضمن الأصناف أو المخزون
                </p>
              )}
            </div>
          )}

          <div>
            <p className="mb-2 text-sm font-bold text-muted">طريقة الدفع</p>
            {isReturn && (
              <p className="mb-2 rounded-lg bg-surface-muted px-3 py-1.5 text-xs font-semibold text-muted">
                فاتورة مرتجع — يُصرف المبلغ نقداً أو يُعاد على البطاقة أو عبر كليك
              </p>
            )}
            <div
              className="grid gap-2"
              style={{ gridTemplateColumns: `repeat(${methods.length}, minmax(0, 1fr))` }}
            >
              {methods.map((m) => {
                const Icon = m.icon;
                const selected = method === m.id;
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => setMethod(m.id)}
                    className={`flex flex-col items-center gap-1 rounded-xl border px-1 py-2.5 text-xs font-bold transition ${
                      selected
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-surface text-muted hover:bg-surface-muted"
                    }`}
                  >
                    <Icon className="h-5 w-5" />
                    {m.label}
                  </button>
                );
              })}
            </div>
          </div>

          {!isCard && !isDebt && (
            <div className="space-y-3">
              <label htmlFor="checkout-amount" className="block text-sm font-bold text-muted">
                المبلغ المستلم
              </label>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  handleConfirm();
                }}
              >
                <input
                  id="checkout-amount"
                  ref={amountRef}
                  value={amount}
                  onChange={(e) => {
                    // Reject keystrokes that don't form valid money (digits +
                    // one decimal separator); a wedge scan can never type a
                    // 13-digit barcode into the tendered-amount field.
                    if (isValidMoneyInput(e.target.value)) setAmount(e.target.value);
                  }}
                  onFocus={(e) => e.currentTarget.select()}
                  inputMode="decimal"
                  dir="ltr"
                  placeholder="0.00"
                  className="min-h-14 w-full rounded-xl border border-border bg-surface px-4 py-2.5 text-left text-2xl font-bold tabular-nums outline-none transition focus:border-primary focus-visible:focus-ring"
                />
                <div className="mt-2 flex flex-wrap gap-2">
                  {quickCash.map((v) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => setAmount(String(v))}
                      className="min-h-11 rounded-lg border border-border bg-surface-muted px-3 py-2 text-sm font-bold tabular-nums transition hover:bg-surface"
                    >
                      {v.toFixed(2)}
                    </button>
                  ))}
                </div>
              </form>

              {isSplit && cardPortion > 0 && (
                <p className="text-sm font-semibold text-muted">
                  الباقي على البطاقة:{" "}
                  <span className="tabular-nums text-primary">{formatMoney(cardPortion)}</span>
                </p>
              )}
              {change > 0 && (
                <p className="text-lg font-black text-success">
                  الباقي: <span className="tabular-nums">{formatMoney(change)}</span>
                </p>
              )}
              {!isSplit && cash > 0 && cash < total && (
                <p className="text-lg font-black text-destructive">
                  ناقص: <span className="tabular-nums">{formatMoney(shortfall)}</span>
                </p>
              )}
            </div>
          )}

          {isCard && (
            <p className="text-lg font-black text-primary">
              {isCliq ? "المبلغ عبر كليك" : "المبلغ على البطاقة"}:{" "}
              <span className="tabular-nums">{formatMoney(total)}</span>
            </p>
          )}

          {!isReturn && (
            <div className="space-y-2">
              <EntityCombobox
                id="checkout-customer"
                label="الزبون"
                value={customerId}
                options={customers}
                placeholder={customersLoading ? "جارٍ تحميل العملاء..." : isDebt ? "اختر زبوناً محفوظاً" : "اختر زبوناً (اختياري)"}
                emptyLabel="لا يوجد زبون مطابق"
                addLabel="إضافة زبون جديد"
                onChange={setCustomerId}
                onAdd={() => setAddingCustomer(true)}
                required={isDebt}
              />
              {isDebt && (
                <>
                  <p className="text-lg font-black text-primary">
                    المبلغ على الذمم:{" "}
                    <span className="tabular-nums">{formatMoney(total)}</span>
                  </p>
                  <p className="text-xs font-semibold text-muted-foreground">
                    يُضاف إلى رصيد الزبون ولا يُحتسب ضمن الصندوق النقدي
                  </p>
                </>
              )}
              {!isDebt && selectedCustomer && (
                <p className="text-xs font-semibold text-muted">
                  سيُطبع اسم الزبون{" "}
                  <span className="font-black text-foreground">{selectedCustomer.name}</span>
                  {selectedCustomer.phone ? (
                    <>
                      {" "}والهاتف{" "}
                      <span dir="ltr" className="font-black tabular-nums">{selectedCustomer.phone}</span>
                    </>
                  ) : null}{" "}
                  على الإيصال
                </p>
              )}
            </div>
          )}

      </ModalShell>
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
    </>
  );
}
