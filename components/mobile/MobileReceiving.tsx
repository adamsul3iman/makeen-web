"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { FormEvent } from "react";
import { useRouter } from "next/navigation";
import {
  Camera,
  CheckCircle,
  CircleAlert,
  Info,
  Loader,
  LogOut,
  Minus,
  PackagePlus,
  Plus,
  ReceiptText,
  RefreshCw,
  ScanBarcode,
  ShieldCheck,
  Trash,
  UserPlus,
  Wallet,
  X,
} from "lucide-react";
import BarcodeScanner from "@/components/mobile/BarcodeScanner";
import QuickAddWizard from "@/components/mobile/QuickAddWizard";
import ProductInsightCard from "@/components/mobile/ProductInsightCard";
import AddSupplierModal from "@/components/mobile/AddSupplierModal";
import ReceivingNegotiationShield from "@/components/mobile/ReceivingNegotiationShield";
import { useBackgroundSync } from "@/hooks/useBackgroundSync";
import { probeStaffCapability } from "@/lib/clientAdminSession";
import { usePosStoreHydrated } from "@/hooks/usePosStoreHydrated";
import { usePosStore } from "@/store/usePosStore";
import { useReceivingStore } from "@/store/useReceivingStore";
import { logoutToLogin } from "@/lib/clientLogout";
import { firstReceivingCapability } from "@/lib/permissions";
import { computePaymentTotals, computeReceivingTotals, MAX_RECEIVING_LINES, PAYMENT_METHODS } from "@/lib/receiving";
import { newUuid } from "@/lib/uuid";
import type {
  NegotiationShield,
  PaymentMethod,
  ReceivingDraftLine,
  ReceivingLineUnit,
  ReceivingPayment,
} from "@/types/receiving.types";

const DRAWER_REQUIRED_MESSAGE = "افتح الوردية قبل دفع النقد للمورد من الصندوق";

const METHOD_LABELS: Record<PaymentMethod, string> = {
  CASH: "نقداً",
  BANK: "تحويل بنكي",
  CARD: "بطاقة",
  CLIQ: "كليك",
  WALLET: "محفظة",
};

function parsePrice(value: string): number {
  const raw = value.trim().replace(/[،]/g, ".");
  const n = Number(raw);
  return Number.isFinite(n) ? n : Number.NaN;
}

function formatMoney(value: number): string {
  return (Number.isFinite(value) ? value : 0).toFixed(2);
}

function emptySubscribe() {
  return () => {};
}

function LineCard({
  line,
  shield,
  onCostChange,
  onQuantityChange,
  onRemove,
  onAcceptRetail,
  onDeclineRetail,
  onToggleUnit,
  onOverrideMargin,
}: {
  line: ReceivingDraftLine;
  shield?: NegotiationShield;
  onCostChange: (key: string, cost: number) => void;
  onQuantityChange: (key: string, quantity: number) => void;
  onRemove: (key: string) => void;
  onAcceptRetail: (key: string) => void;
  onDeclineRetail: (key: string) => void;
  onToggleUnit: (key: string, unit: ReceivingLineUnit) => void;
  onOverrideMargin: (key: string) => void;
}) {
  const catalogProduct = usePosStore((s) =>
    line.productId ? s.products[line.productId] : undefined,
  );
  const catalogCategory = usePosStore((s) =>
    catalogProduct?.categoryId ? s.categories[catalogProduct.categoryId] : undefined,
  );
  const [costText, setCostText] = useState(() => formatMoney(line.unitCost));
  const [prevCost, setPrevCost] = useState(line.unitCost);
  const [qtyText, setQtyText] = useState(() => String(line.quantity));
  const [prevQty, setPrevQty] = useState(line.quantity);

  // Adjust-during-render: keep the editable text in sync when the store value
  // changes externally (e.g. a cost committed on blur or a rejected reset),
  // without clobbering in-flight typing.
  if (prevCost !== line.unitCost) {
    setPrevCost(line.unitCost);
    setCostText(formatMoney(line.unitCost));
  }
  if (prevQty !== line.quantity) {
    setPrevQty(line.quantity);
    setQtyText(String(line.quantity));
  }

  const commitCost = () => {
    const value = parsePrice(costText);
    if (Number.isFinite(value) && value >= 0) {
      onCostChange(line.key, value);
      setCostText(formatMoney(value));
    } else {
      setCostText(formatMoney(line.unitCost));
    }
  };

  const commitQuantity = (value: string) => {
    const parsed = Math.round(parsePrice(value));
    const next = Number.isFinite(parsed) ? Math.max(1, parsed) : line.quantity;
    setQtyText(String(next));
    onQuantityChange(line.key, next);
  };

  const decreaseQuantity = () => {
    if (line.quantity > 1) onQuantityChange(line.key, line.quantity - 1);
    else onRemove(line.key);
  };

  const lineTotal = line.quantity * line.unitCost;
  const promptOpen =
    Boolean(shield?.shouldPromptRetailUpdate) && line.retailPromptDismissed !== true;

  return (
    <div className="rounded-2xl border border-border bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-black text-foreground">
            {line.description || "صنف"}
          </p>
          <p dir="ltr" className="mt-0.5 font-mono text-xs font-bold text-muted-foreground">
            {line.barcode}
          </p>
        </div>
        <button
          type="button"
          onClick={() => onRemove(line.key)}
          aria-label="حذف الصنف"
          className="grid h-9 w-9 shrink-0 place-items-center rounded-xl text-muted transition hover:bg-destructive/10 hover:text-destructive"
        >
          <Trash className="h-4 w-4" />
        </button>
      </div>

      {catalogProduct && (
        <div className="mt-3">
          <ProductInsightCard
            productName={catalogProduct.name}
            categoryName={catalogCategory?.name}
            brandName={catalogProduct.brandName}
            currentStock={catalogProduct.totalStock}
            costPrice={catalogProduct.costPrice}
            reorderLevel={catalogProduct.reorderLevel}
          />
        </div>
      )}

      <div className="mt-3 grid grid-cols-2 gap-3">
        <div>
          <label className="mb-1 block text-xs font-black text-muted-foreground">
            سعر التكلفة
          </label>
          <input
            type="text"
            inputMode="decimal"
            dir="ltr"
            value={costText}
            onChange={(event) => setCostText(event.target.value)}
            onBlur={commitCost}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitCost();
                event.currentTarget.blur();
              }
            }}
            className="h-11 w-full rounded-xl border border-border bg-surface-muted px-3 text-right font-mono text-base font-bold text-foreground outline-none transition focus:border-primary"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-black text-muted-foreground">
            الكمية
          </label>
          <div className="flex h-11 items-center gap-1 rounded-xl border border-border bg-surface-muted px-1">
            <button
              type="button"
              onClick={decreaseQuantity}
              aria-label="إنقاص الكمية"
              className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted transition hover:bg-border hover:text-foreground"
            >
              <Minus className="h-4 w-4" />
            </button>
            <input
              type="text"
              inputMode="numeric"
              dir="ltr"
              value={qtyText}
              onChange={(event) => setQtyText(event.target.value)}
              onBlur={() => commitQuantity(qtyText)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitQuantity(qtyText);
                  event.currentTarget.blur();
                }
              }}
              className="min-w-0 flex-1 bg-transparent text-center font-mono text-base font-black text-foreground outline-none"
            />
            <button
              type="button"
              onClick={() => onQuantityChange(line.key, line.quantity + 1)}
              aria-label="زيادة الكمية"
              className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted transition hover:bg-border hover:text-foreground"
            >
              <Plus className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>

      <div className="mt-2 flex items-center justify-between text-xs font-bold text-muted-foreground">
        <span>
          الضريبة {formatMoney(line.taxPercent)}% — الوحدة {line.unitName || line.baseUnit || "حبة"}
        </span>
        <span className="font-mono text-sm font-black text-foreground">
          {formatMoney(lineTotal)}
        </span>
      </div>

      {Array.isArray(line.units) && line.units.length > 1 && (
        <div className="mt-2 flex items-center gap-1.5">
          <span className="shrink-0 text-[11px] font-black text-muted-foreground">الوحدة</span>
          <div className="flex flex-1 gap-1.5">
            {line.units.map((unit) => {
              const active =
                line.multiplier === unit.multiplier || (line.unitName ?? line.baseUnit) === unit.name;
              return (
                <button
                  key={`${unit.multiplier}-${unit.name}`}
                  type="button"
                  onClick={() => onToggleUnit(line.key, unit)}
                  aria-pressed={active}
                  className={`h-9 flex-1 rounded-xl border text-xs font-black transition ${
                    active
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-surface-muted text-muted-foreground hover:border-primary hover:text-primary"
                  }`}
                >
                  {unit.name}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {shield && (
        <ReceivingNegotiationShield
          shield={shield}
          promptOpen={promptOpen}
          acceptedRetail={line.newRetailPrice}
          marginOverridden={Boolean(line.marginOverride)}
          onAcceptRetail={() => onAcceptRetail(line.key)}
          onDeclineRetail={() => onDeclineRetail(line.key)}
          onOverrideMargin={() => onOverrideMargin(line.key)}
        />
      )}
    </div>
  );
}

/**
 * One payment-center row: a payment method + amount, committing the amount on
 * blur/Enter so in-flight typing is never clobbered by the store re-sync.
 */
function PaymentRow({
  payment,
  onCommit,
  onMethodChange,
  onRemove,
}: {
  payment: ReceivingPayment;
  onCommit: (key: string, amount: number) => void;
  onMethodChange: (key: string, method: PaymentMethod) => void;
  onRemove: (key: string) => void;
}) {
  const [amountText, setAmountText] = useState(() => formatMoney(payment.amount));
  const [prevAmount, setPrevAmount] = useState(payment.amount);

  if (prevAmount !== payment.amount) {
    setPrevAmount(payment.amount);
    setAmountText(formatMoney(payment.amount));
  }

  const commitAmount = () => {
    const value = parsePrice(amountText);
    if (Number.isFinite(value) && value >= 0) {
      onCommit(payment.key, value);
      setAmountText(formatMoney(value));
    } else {
      setAmountText(formatMoney(payment.amount));
    }
  };

  return (
    <div className="flex items-center gap-2">
      <select
        value={payment.method}
        onChange={(event) => onMethodChange(payment.key, event.target.value as PaymentMethod)}
        className="h-11 w-28 shrink-0 rounded-xl border border-border bg-surface-muted px-2 text-xs font-black text-foreground outline-none transition focus:border-primary"
      >
        {PAYMENT_METHODS.map((method) => (
          <option key={method} value={method}>
            {METHOD_LABELS[method]}
          </option>
        ))}
      </select>
      <input
        type="text"
        inputMode="decimal"
        dir="ltr"
        value={amountText}
        onChange={(event) => setAmountText(event.target.value)}
        onBlur={commitAmount}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commitAmount();
            event.currentTarget.blur();
          }
        }}
        placeholder="0.00"
        className="h-11 min-w-0 flex-1 rounded-xl border border-border bg-surface-muted px-3 text-right font-mono text-base font-bold text-foreground outline-none transition focus:border-primary"
      />
      <button
        type="button"
        onClick={() => onRemove(payment.key)}
        aria-label="حذف وسيلة الدفع"
        className="grid h-11 w-9 shrink-0 place-items-center rounded-xl text-muted transition hover:bg-destructive/10 hover:text-destructive"
      >
        <Trash className="h-4 w-4" />
      </button>
    </div>
  );
}

/**
 * Smart Goods-In / Smart Receiving mobile screen. Scans items into a draft
 * supplier invoice, shows the Negotiation Shield (last-3 costs + margin
 * suggestion) per line, captures cash paid out of the register (linked to the
 * open shift), and commits the whole draft through the offline-first sync
 * queue.
 */
export default function MobileReceiving() {
  const router = useRouter();
  const hydrated = usePosStoreHydrated();
  const mounted = useSyncExternalStore(emptySubscribe, () => true, () => false);

  const currentCashier = usePosStore((s) => s.currentCashier);
  const currentStore = usePosStore((s) => s.currentStore);
  const shiftStatus = usePosStore((s) => s.shiftState.status);
  const pendingSyncCount = usePosStore((s) => s.pendingSyncCount);

  const draft = useReceivingStore((s) => s.draft);
  const suppliers = useReceivingStore((s) => s.suppliers);
  const shieldByBarcode = useReceivingStore((s) => s.shieldByBarcode);
  const quickAddTarget = useReceivingStore((s) => s.quickAddTarget);
  const notice = useReceivingStore((s) => s.notice);
  const isCommitting = useReceivingStore((s) => s.isCommitting);

  const startNewDraft = useReceivingStore((s) => s.startNewDraft);
  const setSupplier = useReceivingStore((s) => s.setSupplier);
  const setInvoiceMeta = useReceivingStore((s) => s.setInvoiceMeta);
  const loadSuppliers = useReceivingStore((s) => s.loadSuppliers);
  const scanBarcode = useReceivingStore((s) => s.scanBarcode);
  const updateLineCost = useReceivingStore((s) => s.updateLineCost);
  const updateLineQuantity = useReceivingStore((s) => s.updateLineQuantity);
  const updateLineUnit = useReceivingStore((s) => s.updateLineUnit);
  const acceptSuggestedRetail = useReceivingStore((s) => s.acceptSuggestedRetail);
  const declineRetailPrompt = useReceivingStore((s) => s.declineRetailPrompt);
  const overrideMarginWarning = useReceivingStore((s) => s.overrideMarginWarning);
  const removeLine = useReceivingStore((s) => s.removeLine);
  const setPayments = useReceivingStore((s) => s.setPayments);
  const commitDraft = useReceivingStore((s) => s.commitDraft);
  const clearNotice = useReceivingStore((s) => s.clearNotice);

  const [scanOpen, setScanOpen] = useState(false);
  const [manualBarcode, setManualBarcode] = useState("");
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const [addSupplierOpen, setAddSupplierOpen] = useState(false);
  const mainScrollRef = useRef<HTMLElement | null>(null);

  // Receiving commits SUPPLIER_CREATE + SUPPLIER_INVOICE_CREATED into the
  // offline queue; the 15s background sync engine must run here too, or the
  // batch never drains to the server (it is mounted only inside PosLayout).
  useBackgroundSync();

  useEffect(() => {
    void loadSuppliers();
  }, [loadSuppliers]);

  useEffect(() => {
    if (!mounted || !hydrated) return;
    const capability = firstReceivingCapability(currentCashier);
    if (!capability) {
      router.replace("/login");
      return;
    }
    void probeStaffCapability(capability).then((status) => {
      if (status === "invalid") router.replace("/login");
    });
  }, [mounted, hydrated, currentCashier, router]);

  const handleLogout = () => {
    void logoutToLogin();
  };

  const handleScanDetected = (barcode: string) => {
    setScanOpen(false);
    void scanBarcode(barcode);
  };

  const handleManualScan = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const barcode = manualBarcode.trim();
    if (!barcode) return;
    setManualBarcode("");
    void scanBarcode(barcode);
  };

  const handleCommit = async () => {
    const result = await commitDraft();
    if (result.ok) {
      mainScrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    }
  };

  if (!mounted || !hydrated) {
    return (
      <div
        dir="rtl"
        className="flex min-h-screen w-screen items-center justify-center bg-gray-100 p-6"
      >
        <div className="flex w-full max-w-sm flex-col items-center gap-3 rounded-3xl bg-white p-8 shadow-xl">
          <Loader className="h-8 w-8 animate-spin text-primary" />
          <p className="text-sm font-black text-foreground">جارٍ تجهيز الصفحة…</p>
        </div>
      </div>
    );
  }

  const cashierName = currentCashier?.name ?? "";
  const roleName = currentCashier?.roleName ?? currentCashier?.role ?? "";
  const cashierLabel = cashierName
    ? (roleName ? `${cashierName} · ${roleName}` : cashierName)
    : "";

  const totals = computeReceivingTotals(draft.lines);
  const supplierOptions = Object.values(suppliers).sort((a, b) => a.name.localeCompare(b.name, "ar"));
  const payments = draft.payments ?? [];
  const paymentTotals = computePaymentTotals(totals.total, payments);
  const drawerBlocked = paymentTotals.cashPortion > 0 && shiftStatus !== "OPEN";
  const paidExceedsTotal = paymentTotals.totalPaid > totals.total && totals.total > 0;
  const atLineLimit = draft.lines.length >= MAX_RECEIVING_LINES;
  const supplierTermsDays =
    draft.supplierId && suppliers[draft.supplierId] ? suppliers[draft.supplierId].paymentTermsDays ?? 0 : 0;

  const handlePaymentsChange = (next: ReceivingPayment[]) => {
    setPayments(next);
  };

  const addPaymentRow = () => {
    const used = new Set(payments.map((p) => p.method));
    const method = PAYMENT_METHODS.find((m) => !used.has(m)) ?? "CASH";
    handlePaymentsChange([...payments, { key: newUuid(), method, amount: 0 }]);
  };

  const handlePaymentAmountChange = (key: string, amount: number) => {
    handlePaymentsChange(payments.map((p) => (p.key === key ? { ...p, amount } : p)));
  };

  const handlePaymentMethodChange = (key: string, method: PaymentMethod) => {
    handlePaymentsChange(payments.map((p) => (p.key === key ? { ...p, method } : p)));
  };

  const handlePaymentRemove = (key: string) => {
    handlePaymentsChange(payments.filter((p) => p.key !== key));
  };

  return (
    <div dir="rtl" className="flex h-dvh flex-col overflow-hidden bg-gray-100">
      <header className="z-20 shrink-0 border-b border-border bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-md items-center justify-between gap-3 px-4 py-3">
          <div className="flex min-w-0 flex-col">
            <p className="truncate text-sm font-black text-foreground">{currentStore?.name ?? "المتجر"}</p>
            <p className="truncate text-xs font-semibold text-muted">
              استلام بضاعة{cashierLabel ? ` — ${cashierLabel}` : ""}
            </p>
          </div>
          <button
            type="button"
            onClick={handleLogout}
            aria-label="تسجيل الخروج"
            className="flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-xl bg-destructive/10 px-3 text-sm font-black text-destructive transition hover:bg-destructive/20"
          >
            <LogOut className="h-4 w-4" />
            خروج
          </button>
        </div>
      </header>

      <main ref={mainScrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-md px-4 py-5">
        {notice && (
          <div
            className={`mb-4 flex items-start gap-2 rounded-xl border p-3 text-sm font-bold ${
              notice.tone === "error"
                ? "border-destructive/30 bg-destructive/10 text-destructive"
                : notice.tone === "success"
                  ? "border-success/30 bg-success/10 text-success-foreground"
                  : "border-primary/30 bg-primary/10 text-primary"
            }`}
          >
            {notice.tone === "error" ? (
              <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            ) : notice.tone === "success" ? (
              <CheckCircle className="mt-0.5 h-4 w-4 shrink-0" />
            ) : (
              <Info className="mt-0.5 h-4 w-4 shrink-0" />
            )}
            <span className="flex-1">{notice.message}</span>
            <button
              type="button"
              onClick={clearNotice}
              aria-label="إغلاق التنبيه"
              className="grid h-6 w-6 shrink-0 place-items-center rounded-lg text-current opacity-70 transition hover:opacity-100"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        <section className="mb-4 rounded-2xl border border-border bg-white p-4 shadow-sm">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="flex items-center gap-1.5 text-sm font-black text-foreground">
              <ScanBarcode className="h-4 w-4 text-primary" />
              مسح الأصناف
            </h2>
            {!scanOpen && (
              <button
                type="button"
                onClick={() => setScanOpen(true)}
                className="flex h-10 items-center justify-center gap-1.5 rounded-xl bg-primary px-3 text-sm font-black text-primary-foreground transition hover:bg-primary-hover"
              >
                <Camera className="h-4 w-4" />
                مسح بالكاميرا
              </button>
            )}
          </div>

          {scanOpen && (
            <BarcodeScanner
              enabled={scanOpen}
              onDetected={handleScanDetected}
              onRequestClose={() => setScanOpen(false)}
            />
          )}

          <form onSubmit={handleManualScan} className="mt-3 flex gap-2">
            <input
              type="text"
              inputMode="numeric"
              dir="ltr"
              autoComplete="off"
              spellCheck={false}
              value={manualBarcode}
              onChange={(event) => setManualBarcode(event.target.value)}
              placeholder="أو أدخل الباركود يدوياً…"
              className="h-11 min-w-0 flex-1 rounded-xl border border-border bg-surface-muted px-3 font-mono text-sm font-bold text-foreground outline-none transition focus:border-primary"
            />
            <button
              type="submit"
              className="flex h-11 shrink-0 items-center justify-center gap-1 rounded-xl border border-border bg-white px-3 text-sm font-black text-foreground transition hover:bg-surface-muted"
            >
              <Plus className="h-4 w-4" />
              إضافة
            </button>
          </form>

          <button
            type="button"
            onClick={() => useReceivingStore.getState().openQuickAdd("")}
            className="mt-2 flex h-10 w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-border bg-surface-muted text-xs font-black text-muted-foreground transition hover:border-primary hover:text-primary"
          >
            <PackagePlus className="h-4 w-4" />
            إضافة صنف جديد بدون باركود
          </button>
        </section>

        {atLineLimit && (
          <div className="mb-4 flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm font-bold text-amber-800">
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
            <span>الحد الأقصى {MAX_RECEIVING_LINES} بند في الفاتورة</span>
          </div>
        )}

        {draft.lines.length === 0 ? (
          <div className="mb-4 flex flex-col items-center gap-2 rounded-2xl border border-dashed border-border bg-white p-8 text-center shadow-sm">
            <ShieldCheck className="h-8 w-8 text-primary/40" />
            <p className="text-sm font-black text-muted-foreground">امسح أول صنف لبدء فاتورة الاستلام</p>
            <p className="text-xs font-semibold text-muted">
              سيظهر درع التفاوض تلقائياً مع آخر 3 مشتريات واقتراح سعر البيع
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {draft.lines.map((line) => (
              <LineCard
                key={line.key}
                line={line}
                shield={shieldByBarcode[line.key]}
                onCostChange={updateLineCost}
                onQuantityChange={updateLineQuantity}
                onRemove={removeLine}
                onAcceptRetail={acceptSuggestedRetail}
                onDeclineRetail={declineRetailPrompt}
                onToggleUnit={updateLineUnit}
                onOverrideMargin={overrideMarginWarning}
              />
            ))}
          </div>
        )}

        {draft.lines.length > 0 && (
          <section className="mt-4 space-y-4 rounded-2xl border border-border bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <h2 className="flex items-center gap-1.5 text-sm font-black text-foreground">
                <ReceiptText className="h-4 w-4 text-primary" />
                بيانات الفاتورة
              </h2>
              <button
                type="button"
                onClick={() => setResetConfirmOpen(true)}
                className="flex h-9 items-center justify-center gap-1.5 rounded-xl bg-destructive/10 px-3 text-xs font-black text-destructive transition hover:bg-destructive/20"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                فاتورة جديدة
              </button>
            </div>

            <div>
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <label htmlFor="receiving-supplier" className="text-sm font-black text-foreground">
                  المورد *
                </label>
                <button
                  type="button"
                  onClick={() => setAddSupplierOpen(true)}
                  aria-label="إضافة مورد جديد"
                  className="flex h-8 shrink-0 items-center justify-center gap-1 rounded-lg border border-dashed border-border bg-surface-muted px-2.5 text-xs font-black text-muted-foreground transition hover:border-primary hover:text-primary"
                >
                  <UserPlus className="h-3.5 w-3.5" />
                  إضافة مورد
                </button>
              </div>
              <select
                id="receiving-supplier"
                value={draft.supplierId ?? ""}
                onChange={(event) => {
                  const id = event.target.value;
                  const option = suppliers[id];
                  if (id && option) setSupplier(id, option.name);
                  else setSupplier("", "");
                }}
                className="h-12 w-full rounded-xl border border-border bg-surface-muted px-3 text-base font-bold text-foreground outline-none transition focus:border-primary"
              >
                <option value="">اختر المورد…</option>
                {supplierOptions.map((supplier) => (
                  <option key={supplier.id} value={supplier.id}>
                    {supplier.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="receiving-invoice" className="mb-1.5 block text-sm font-black text-foreground">
                رقم فاتورة المورد *
              </label>
              <input
                id="receiving-invoice"
                type="text"
                value={draft.invoiceNumber}
                onChange={(event) => setInvoiceMeta({ invoiceNumber: event.target.value })}
                placeholder="مثال: 2026-0412"
                className="h-12 w-full rounded-xl border border-border bg-surface-muted px-3 text-base font-bold text-foreground outline-none transition focus:border-primary"
              />
              {draft.invoiceNumber.startsWith("AUTO-") && (
                <p className="mt-1 text-[11px] font-bold text-muted-foreground">
                  رقم تلقائي مقترح — يمكنك تعديله أو استبداله برقم فاتورة المورد
                </p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="receiving-invoice-date" className="mb-1.5 block text-sm font-black text-foreground">
                  تاريخ الفاتورة
                </label>
                <input
                  id="receiving-invoice-date"
                  type="date"
                  value={draft.invoiceDate}
                  onChange={(event) => setInvoiceMeta({ invoiceDate: event.target.value })}
                  className="h-12 w-full rounded-xl border border-border bg-surface-muted px-3 font-mono text-sm font-bold text-foreground outline-none transition focus:border-primary"
                />
              </div>
              <div>
                <label htmlFor="receiving-due-date" className="mb-1.5 block text-sm font-black text-foreground">
                  تاريخ الاستحقاق
                </label>
                <input
                  id="receiving-due-date"
                  type="date"
                  value={draft.dueDate}
                  onChange={(event) => setInvoiceMeta({ dueDate: event.target.value })}
                  className="h-12 w-full rounded-xl border border-border bg-surface-muted px-3 font-mono text-sm font-bold text-foreground outline-none transition focus:border-primary"
                />
              </div>
            </div>
            {supplierTermsDays > 0 && (
              <p className="mt-1 text-[11px] font-black text-success-foreground">
                استحقاق تلقائي بعد {supplierTermsDays} يوم وفق شروط المورد
              </p>
            )}

            <div>
              <label htmlFor="receiving-notes" className="mb-1.5 block text-sm font-black text-foreground">
                ملاحظات
              </label>
              <input
                id="receiving-notes"
                type="text"
                value={draft.notes}
                onChange={(event) => setInvoiceMeta({ notes: event.target.value })}
                placeholder="اختياري…"
                className="h-12 w-full rounded-xl border border-border bg-surface-muted px-3 text-base font-bold text-foreground outline-none transition focus:border-primary"
              />
            </div>
          </section>
        )}

        {draft.lines.length > 0 && (
          <section className="mt-4 rounded-2xl border border-border bg-white p-4 shadow-sm">
            <h2 className="flex items-center gap-1.5 text-sm font-black text-foreground">
              <Wallet className="h-4 w-4 text-primary" />
              مركز الدفع للمورد
            </h2>
            <p className="mt-0.5 mb-3 text-[11px] font-bold text-muted-foreground">
              وزّع الدفع على وسائل متعددة، أو اتركه فارغاً لتسجيل الفاتورة على الحساب
            </p>

            {payments.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border bg-surface-muted px-3 py-3 text-center text-xs font-black text-muted-foreground">
                بدون دفع — تُسجل الفاتورة على الحساب
              </div>
            ) : (
              <div className="space-y-2">
                {payments.map((payment) => (
                  <PaymentRow
                    key={payment.key}
                    payment={payment}
                    onCommit={handlePaymentAmountChange}
                    onMethodChange={handlePaymentMethodChange}
                    onRemove={handlePaymentRemove}
                  />
                ))}
              </div>
            )}

            <button
              type="button"
              onClick={addPaymentRow}
              className="mt-3 flex h-10 w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-border bg-surface-muted text-xs font-black text-muted-foreground transition hover:border-primary hover:text-primary"
            >
              <Plus className="h-4 w-4" />
              إضافة وسيلة دفع
            </button>

            <div className="mt-3 space-y-1.5 rounded-xl bg-surface-muted px-3 py-2.5 text-xs font-bold text-muted-foreground">
              <div className="flex items-center justify-between">
                <span>المدفوع</span>
                <span className="font-mono text-foreground">{formatMoney(paymentTotals.totalPaid)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span>منه نقداً من الصندوق</span>
                <span className="font-mono text-foreground">{formatMoney(paymentTotals.cashPortion)}</span>
              </div>
              <div className="flex items-center justify-between border-t border-border pt-1.5 font-black text-foreground">
                <span>المتبقي على الحساب</span>
                <span className="font-mono">{formatMoney(paymentTotals.remaining)}</span>
              </div>
            </div>

            {drawerBlocked && (
              <div className="mt-3 flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-sm font-bold text-destructive">
                <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{DRAWER_REQUIRED_MESSAGE}</span>
              </div>
            )}
            {!drawerBlocked && paidExceedsTotal && (
              <div className="mt-3 flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm font-bold text-amber-800">
                <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                <span>المدفوع أكبر من إجمالي الفاتورة — تحقق من الأرقام</span>
              </div>
            )}
          </section>
        )}

      </div>
      </main>

      {draft.lines.length > 0 && (
        <footer className="z-20 shrink-0 border-t border-border bg-white/95 backdrop-blur">
          <div className="mx-auto max-w-md px-4 py-3">
            <div className="flex items-end justify-between gap-3">
              <div className="space-y-0.5 text-xs font-bold text-muted-foreground">
                <div className="flex items-center justify-between gap-6">
                  <span>إجمالي البضاعة</span>
                  <span className="font-mono text-foreground">{formatMoney(totals.subtotal)}</span>
                </div>
                <div className="flex items-center justify-between gap-6">
                  <span>الضريبة</span>
                  <span className="font-mono text-foreground">{formatMoney(totals.tax)}</span>
                </div>
                <div className="flex items-center justify-between gap-6 border-t border-border pt-0.5 text-sm font-black text-foreground">
                  <span>إجمالي الفاتورة</span>
                  <span className="font-mono">{formatMoney(totals.total)}</span>
                </div>
              </div>

              <button
                type="button"
                onClick={handleCommit}
                disabled={isCommitting || paidExceedsTotal || drawerBlocked}
                className="flex h-14 min-w-44 shrink-0 items-center justify-center gap-2 rounded-xl bg-success px-5 text-base font-black text-success-foreground shadow-sm transition hover:bg-success-hover active:scale-[0.98] disabled:opacity-40"
              >
                {isCommitting ? <Loader className="h-5 w-5 animate-spin" /> : <CheckCircle className="h-5 w-5" />}
                {isCommitting ? "جارٍ الحفظ…" : "حفظ فاتورة الاستلام"}
              </button>
            </div>

            <div className="mt-2.5 flex items-center justify-between gap-3">
              {shiftStatus === "OPEN" ? (
                <span className="flex items-center gap-1 text-[11px] font-black text-success-foreground">
                  <CheckCircle className="h-3.5 w-3.5 shrink-0" />
                  الوردية مفتوحة — النقد للمورد يُخصم من الصندوق
                </span>
              ) : (
                <span className="flex items-center gap-1 text-[11px] font-black text-muted-foreground">
                  <Info className="h-3.5 w-3.5 shrink-0" />
                  الوردية مغلقة — تُسجل الفاتورة على الحساب فقط
                </span>
              )}
              {pendingSyncCount > 0 && (
                <span className="text-[11px] font-bold text-muted-foreground">
                  {pendingSyncCount} عملية بانتظار المزامنة
                </span>
              )}
            </div>
          </div>
        </footer>
      )}

      {quickAddTarget != null && <QuickAddWizard />}
      <AddSupplierModal open={addSupplierOpen} onClose={() => setAddSupplierOpen(false)} />
      {resetConfirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6">
          <div className="w-full max-w-sm rounded-3xl bg-white p-5 shadow-2xl">
            <div className="mb-2 flex items-center gap-2">
              <CircleAlert className="h-5 w-5 text-destructive" />
              <h3 className="text-base font-black text-foreground">بدء فاتورة جديدة</h3>
            </div>
            <p className="text-sm font-bold text-muted-foreground">
              سيتم مسح فاتورة الاستلام الحالية ({draft.lines.length} بند). هل أنت متأكد؟
            </p>
            <div className="mt-4 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setResetConfirmOpen(false)}
                autoFocus
                className="flex h-12 items-center justify-center gap-1.5 rounded-xl border border-border bg-white text-sm font-black text-foreground transition hover:bg-surface-muted"
              >
                <X className="h-4 w-4" />
                إلغاء
              </button>
              <button
                type="button"
                onClick={() => {
                  setResetConfirmOpen(false);
                  startNewDraft();
                }}
                className="flex h-12 items-center justify-center gap-1.5 rounded-xl bg-destructive px-3 text-sm font-black text-destructive-foreground transition hover:bg-destructive/90"
              >
                <RefreshCw className="h-4 w-4" />
                مسح وبدء جديد
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
