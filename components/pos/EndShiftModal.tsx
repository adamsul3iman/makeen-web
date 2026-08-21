"use client";

import { useEffect, useState } from "react";
import {
  ArrowDownCircle,
  ArrowUpCircle,
  Check,
  FileText,
  Package,
  ReceiptText,
  X,
} from "lucide-react";
import { usePosStore } from "@/store/usePosStore";
import { formatMoney } from "@/lib/format";
import { evaluateShiftCloseGuard } from "@/lib/shiftGuard";
import { useModalEscape } from "@/hooks/useModalEscape";
import type { CashMovement } from "@/types/pos.types";
import { formatShiftTime, formatShiftDateTime } from "@/lib/dateTime";

type TabId = "summary" | "cashflow" | "products" | "taxes";

const TABS: { id: TabId; label: string; icon: React.ReactNode }[] = [
  { id: "summary", label: "ملخص", icon: <ReceiptText className="h-4 w-4" /> },
  { id: "cashflow", label: "التدفقات", icon: <ArrowDownCircle className="h-4 w-4" /> },
  { id: "products", label: "المنتجات", icon: <Package className="h-4 w-4" /> },
  { id: "taxes", label: "الضرائب", icon: <FileText className="h-4 w-4" /> },
];

const DISCREPANCY_REASONS = [
  { value: "cash_counting_error", label: "خطأ في العد" },
  { value: "missing_receipt", label: "فاتورة لم تُسجّل" },
  { value: "unrecorded_expense", label: "مصروف غير مسجّل" },
  { value: "overpayment", label: "دفعة زائدة" },
  { value: "system_error", label: "خطأ في النظام" },
  { value: "other", label: "أخرى" },
] as const;

/* ─── Summary Tab ─────────────────────────────────────────── */
function SummaryTab({
  shiftState,
  shiftTotals,
  transactionCount,
  actualCash,
  setActualCash,
  actualCard,
  setActualCard,
  actualCliq,
  setActualCliq,
  discrepancyReason,
  setDiscrepancyReason,
  discrepancyNote,
  setDiscrepancyNote,
}: {
  shiftState: ReturnType<typeof usePosStore.getState>["shiftState"];
  shiftTotals: ReturnType<typeof usePosStore.getState>["shiftTotals"];
  transactionCount: number;
  actualCash: string;
  setActualCash: (v: string) => void;
  actualCard: string;
  setActualCard: (v: string) => void;
  actualCliq: string;
  setActualCliq: (v: string) => void;
  discrepancyReason: string;
  setDiscrepancyReason: (v: string) => void;
  discrepancyNote: string;
  setDiscrepancyNote: (v: string) => void;
}) {
  const parsedCash = parseFloat(actualCash) || 0;
  const parsedCard = parseFloat(actualCard) || 0;
  const cashVariance = parsedCash - shiftTotals.expectedCashInDrawer;
  const cardVariance = parsedCard - shiftTotals.expectedCard;
  const hasCashDiscrepancy = actualCash.length > 0 && cashVariance !== 0;
  const hasCardDiscrepancy = actualCard.length > 0 && cardVariance !== 0;
  const cliqVariance = (parseFloat(actualCliq) || 0) - (shiftTotals.cliqSales ?? 0);
  const hasCliqDiscrepancy = actualCliq.length > 0 && cliqVariance !== 0;
  const hasAnyDiscrepancy = hasCashDiscrepancy || hasCardDiscrepancy || hasCliqDiscrepancy;

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-dashed border-border bg-surface-muted px-4 py-3 font-mono text-sm">
        <p className="text-center text-base font-black tracking-wide">
          تقرير نهاية الوردية
        </p>
        <p className="mt-1 text-center text-xs text-muted">
          وردية #{shiftState.shiftId?.slice(0, 8) ?? "—"} •{" "}
          {formatShiftDateTime(new Date().toISOString())}
        </p>
        <div className="my-2 border-t border-dashed border-border" />
        <div className="space-y-1.5">
          {[
            { label: "بداية الوردية", value: formatShiftTime(shiftState.startTime) },
            { label: "العهدة", value: formatMoney(shiftState.startingCash) },
            { label: "المبيعات نقداً", value: formatMoney(shiftTotals.cashSales) },
            { label: "المبيعات بطاقة", value: formatMoney(shiftTotals.visaSales) },
            { label: "المبيعات كليك", value: formatMoney(shiftTotals.cliqSales ?? 0) },
            { label: "مبيعات الذمم", value: formatMoney(shiftTotals.debtSales) },
            { label: "مقبوضات الذمم", value: formatMoney(shiftTotals.debtCollections) },
            { label: "إيداعات", value: formatMoney(shiftTotals.cashInTotal) },
            { label: "سحوبات", value: `- ${formatMoney(shiftTotals.cashOutTotal)}` },
            { label: "المصروفات", value: `- ${formatMoney(shiftTotals.expenses)}` },
            { label: "إجمالي المبيعات", value: formatMoney(shiftTotals.totalSales) },
            { label: "عدد الفواتير", value: String(transactionCount) },
          ].map((r) => (
            <div key={r.label} className="flex items-center justify-between gap-2">
              <span className="text-muted">{r.label}</span>
              <span className="font-bold tabular-nums">{r.value}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Cash Count */}
      <div className="space-y-3">
        <label htmlFor="end-actual-cash" className="block text-sm font-bold text-muted">
          عدّ الصندوق فعلياً
        </label>
        <input
          id="end-actual-cash"
          autoFocus
          inputMode="decimal"
          dir="ltr"
          placeholder="0.00"
          value={actualCash}
          onChange={(e) => setActualCash(e.target.value)}
          className="w-full rounded-xl border border-border bg-white px-4 py-3 text-left text-2xl font-bold tabular-nums outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
        />
        {actualCash.length > 0 && (
          <div className={`rounded-lg px-3 py-2 text-sm font-bold ${cashVariance === 0 ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>
            المطلوب: {formatMoney(shiftTotals.expectedCashInDrawer)} • الفرق: {formatMoney(cashVariance)}
          </div>
        )}
      </div>

      {/* Card Count */}
      <div className="space-y-3">
        <label htmlFor="end-actual-card" className="block text-sm font-bold text-muted">
          إجمالي المبيعات بالبطاقة (POS)
        </label>
        <input
          id="end-actual-card"
          inputMode="decimal"
          dir="ltr"
          placeholder="0.00"
          value={actualCard}
          onChange={(e) => setActualCard(e.target.value)}
          className="w-full rounded-xl border border-border bg-white px-4 py-3 text-left text-2xl font-bold tabular-nums outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
        />
        {actualCard.length > 0 && (
          <div className={`rounded-lg px-3 py-2 text-sm font-bold ${cardVariance === 0 ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>
            المطلوب: {formatMoney(shiftTotals.expectedCard)} • الفرق: {formatMoney(cardVariance)}
          </div>
        )}
      </div>

      {/* CliQ Count */}
      <div className="space-y-3">
        <label htmlFor="end-actual-cliq" className="block text-sm font-bold text-muted">
          إجمالي مبيعات كليك (جهاز CliQ)
        </label>
        <input
          id="end-actual-cliq"
          inputMode="decimal"
          dir="ltr"
          placeholder="0.00"
          value={actualCliq}
          onChange={(e) => setActualCliq(e.target.value)}
          className="w-full rounded-xl border border-border bg-white px-4 py-3 text-left text-2xl font-bold tabular-nums outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
        />
        {actualCliq.length > 0 && (
          <div className={`rounded-lg px-3 py-2 text-sm font-bold ${cliqVariance === 0 ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>
            المطلوب: {formatMoney(shiftTotals.cliqSales ?? 0)} • الفرق: {formatMoney(cliqVariance)}
          </div>
        )}
      </div>

      {/* Discrepancy Enforcement */}
      {hasAnyDiscrepancy && (
        <div className="space-y-3 rounded-xl border border-amber-200 bg-amber-50 p-4">
          <p className="text-sm font-bold text-amber-800">
            يوجد فرق — أسباب الفرق إلزامية
          </p>
          <label htmlFor="discrepancy-reason" className="block text-sm font-bold text-amber-800">
            سبب الفرق
          </label>
          <select
            id="discrepancy-reason"
            value={discrepancyReason}
            onChange={(e) => setDiscrepancyReason(e.target.value)}
            className="w-full rounded-xl border border-amber-300 bg-white px-4 py-3 text-base font-bold outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
          >
            <option value="">اختر السبب…</option>
            {DISCREPANCY_REASONS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
          <label htmlFor="discrepancy-note" className="block text-sm font-bold text-amber-800">
            ملاحظات الفرق
          </label>
          <textarea
            id="discrepancy-note"
            value={discrepancyNote}
            onChange={(e) => setDiscrepancyNote(e.target.value)}
            placeholder="تفاصيل حول سبب الفرق…"
            rows={2}
            className="w-full rounded-xl border border-amber-300 bg-white px-4 py-3 text-base font-bold outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
          />
        </div>
      )}
    </div>
  );
}

/* ─── Cash Flow Tab ───────────────────────────────────────── */
function CashFlowTab({ cashMovements }: { cashMovements: CashMovement[] }) {
  if (cashMovements.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-muted">
        <ArrowDownCircle className="mb-3 h-10 w-10 opacity-30" />
        <p className="text-sm font-bold">لا توجد حركات نقدية في هذه الوردية</p>
      </div>
    );
  }

  const totalIn = cashMovements
    .filter((m) => m.type === "CASH_IN")
    .reduce((sum, m) => sum + m.amount, 0);
  const totalOut = cashMovements
    .filter((m) => m.type === "CASH_OUT")
    .reduce((sum, m) => sum + m.amount, 0);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-center">
          <p className="text-xs font-bold text-emerald-600">إجمالي الإيداعات</p>
          <p className="text-lg font-black tabular-nums text-emerald-700">{formatMoney(totalIn)}</p>
        </div>
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-center">
          <p className="text-xs font-bold text-rose-600">إجمالي السحوبات</p>
          <p className="text-lg font-black tabular-nums text-rose-700">{formatMoney(totalOut)}</p>
        </div>
      </div>
      <div className="space-y-2">
        {cashMovements.map((m) => {
          const isIn = m.type === "CASH_IN";
          return (
            <div
              key={m.id}
              className="flex items-center gap-3 rounded-xl border border-border bg-white px-4 py-3"
            >
              <div className={`grid h-9 w-9 shrink-0 place-items-center rounded-full ${isIn ? "bg-emerald-100" : "bg-rose-100"}`}>
                {isIn ? (
                  <ArrowDownCircle className="h-5 w-5 text-emerald-600" />
                ) : (
                  <ArrowUpCircle className="h-5 w-5 text-rose-600" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-bold">{m.reason}</p>
                {m.notes && <p className="truncate text-xs text-muted">{m.notes}</p>}
              </div>
              <div className="text-left">
                <p className={`text-sm font-bold tabular-nums ${isIn ? "text-emerald-600" : "text-rose-600"}`}>
                  {isIn ? "+" : "-"}{formatMoney(m.amount)}
                </p>
                <p className="text-[10px] text-muted">
                  {formatShiftTime(m.createdAt)}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ─── Products Tab ────────────────────────────────────────── */
interface ProductRow {
  productName: string;
  totalQty: number;
  totalRevenue: number;
  totalProfit: number;
  invoiceCount: number;
}

function ProductsTab({ shiftId }: { shiftId: string }) {
  const [items, setItems] = useState<ProductRow[]>([]);
  const [totalProducts, setTotalProducts] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(`/api/shifts/${shiftId}/items?tab=products`);
        const data = await res.json();
        if (!cancelled) {
          setItems(data.items ?? []);
          setTotalProducts(data.totalProducts ?? 0);
        }
      } catch {
        if (!cancelled) setItems([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [shiftId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-muted">
        <Package className="mb-3 h-10 w-10 opacity-30" />
        <p className="text-sm font-bold">لا توجد منتجات في هذه الوردية</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted">
        أعلى {items.length} منتج من أصل {totalProducts}
      </p>
      <div className="space-y-2">
        {items.map((item, i) => (
          <div
            key={item.productName + i}
            className="flex items-center gap-3 rounded-xl border border-border bg-white px-4 py-3"
          >
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-primary/10 text-xs font-black text-primary">
              {i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-bold">{item.productName}</p>
              <p className="text-xs text-muted">
                الكمية: {item.totalQty.toFixed(1)} • الفواتير: {item.invoiceCount}
              </p>
            </div>
            <div className="text-left">
              <p className="text-sm font-bold tabular-nums">{formatMoney(item.totalRevenue)}</p>
              <p className="text-[10px] text-emerald-600">ربح: {formatMoney(item.totalProfit)}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─── Taxes Tab ───────────────────────────────────────────── */
interface TaxRow {
  taxPercent: number;
  netAmount: number;
  taxAmount: number;
  totalWithTax: number;
  lineCount: number;
}

function TaxesTab({ shiftId }: { shiftId: string }) {
  const [items, setItems] = useState<TaxRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(`/api/shifts/${shiftId}/items?tab=taxes`);
        const data = await res.json();
        if (!cancelled) setItems(data.items ?? []);
      } catch {
        if (!cancelled) setItems([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [shiftId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-muted">
        <FileText className="mb-3 h-10 w-10 opacity-30" />
        <p className="text-sm font-bold">لا توجد ضرائب في هذه الوردية</p>
      </div>
    );
  }

  const totalNet = items.reduce((s, r) => s + r.netAmount, 0);
  const totalTax = items.reduce((s, r) => s + r.taxAmount, 0);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-xl border border-border bg-surface-muted p-3 text-center">
          <p className="text-xs font-bold text-muted">صافي المبيعات</p>
          <p className="text-lg font-black tabular-nums">{formatMoney(totalNet)}</p>
        </div>
        <div className="rounded-xl border border-border bg-surface-muted p-3 text-center">
          <p className="text-xs font-bold text-muted">إجمالي الضريبة</p>
          <p className="text-lg font-black tabular-nums">{formatMoney(totalTax)}</p>
        </div>
      </div>
      <div className="space-y-2">
        {items.map((item) => (
          <div
            key={item.taxPercent}
            className="flex items-center gap-3 rounded-xl border border-border bg-white px-4 py-3"
          >
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-primary/10 text-sm font-black text-primary">
              {item.taxPercent}%
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold">{item.lineCount} صنف</p>
              <p className="text-xs text-muted">صافي: {formatMoney(item.netAmount)}</p>
            </div>
            <div className="text-left">
              <p className="text-sm font-bold tabular-nums">{formatMoney(item.taxAmount)}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─── Main EndShiftModal ─────────────────────────────────── */
export default function EndShiftModal() {
  const isOpen = usePosStore((s) => s.isCloseShiftModalOpen);
  const shiftState = usePosStore((s) => s.shiftState);
  const shiftTotals = usePosStore((s) => s.shiftTotals);
  const cashMovements = usePosStore((s) => s.cashMovements);
  const transactionCount = usePosStore((s) => s.shiftTransactions.length);
  const closeShift = usePosStore((s) => s.closeShift);
  const closeCloseShiftModal = usePosStore((s) => s.closeCloseShiftModal);
  const isCompleting = usePosStore((s) => s.isCompleting);
  const pendingSyncCount = usePosStore((s) => s.pendingSyncCount);
  const isOnline = usePosStore((s) => s.isOnline);

  const [activeTab, setActiveTab] = useState<TabId>("summary");
  const [actualCash, setActualCash] = useState("");
  const [actualCard, setActualCard] = useState("");
  const [actualCliq, setActualCliq] = useState("");
  const [discrepancyReason, setDiscrepancyReason] = useState("");
  const [discrepancyNote, setDiscrepancyNote] = useState("");

  useModalEscape(closeCloseShiftModal, isOpen);

  if (!isOpen) return null;

  const parsedCash = parseFloat(actualCash) || 0;
  const parsedCard = parseFloat(actualCard) || 0;
  const parsedCliq = parseFloat(actualCliq) || 0;
  const actualCashValid = actualCash.trim().length > 0 && Number.isFinite(parsedCash) && parsedCash >= 0;
  const actualCardValid = actualCard.trim().length > 0 && Number.isFinite(parsedCard) && parsedCard >= 0;
  const actualCliqValid = actualCliq.trim().length > 0 && Number.isFinite(parsedCliq) && parsedCliq >= 0;

  const hasCashDiscrepancy = actualCashValid && parsedCash !== shiftTotals.expectedCashInDrawer;
  const hasCardDiscrepancy = actualCardValid && parsedCard !== shiftTotals.expectedCard;
  const hasCliqDiscrepancy = actualCliqValid && parsedCliq !== (shiftTotals.cliqSales ?? 0);
  const hasAnyDiscrepancy = hasCashDiscrepancy || hasCardDiscrepancy || hasCliqDiscrepancy;

  const guard = evaluateShiftCloseGuard({ pendingSyncCount, isOnline, actualCashValid, isCompleting });
  let canClose = guard.canClose;
  // Discrepancy enforcement: block until reason + note are provided
  if (hasAnyDiscrepancy && (discrepancyReason.length === 0 || discrepancyNote.trim().length === 0)) {
    canClose = false;
  }

  const handleClose = async () => {
    if (!canClose) return;
    await closeShift(
      parsedCash,
      parsedCard,
      parsedCliq,
      hasAnyDiscrepancy ? discrepancyReason : "",
      hasAnyDiscrepancy ? discrepancyNote.trim() : "",
    );
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      dir="rtl"
      onClick={closeCloseShiftModal}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <header className="flex items-center justify-between border-b border-border px-5 py-4">
          <div className="flex items-center gap-2">
            <ReceiptText className="h-5 w-5 text-primary" />
            <h2 className="text-lg font-bold">تقرير نهاية الوردية (Z)</h2>
          </div>
          <button
            type="button"
            aria-label="إلغاء"
            onClick={closeCloseShiftModal}
            className="relative z-50 grid h-11 w-11 cursor-pointer place-items-center rounded-lg text-muted transition hover:bg-surface-muted"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        {/* Tabs */}
        <div className="flex border-b border-border">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`flex flex-1 items-center justify-center gap-1.5 px-3 py-3 text-sm font-bold transition ${
                activeTab === tab.id
                  ? "border-b-2 border-primary text-primary"
                  : "text-muted hover:text-foreground"
              }`}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        <div className="scrollbar-hidden min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {activeTab === "summary" && (
            <SummaryTab
              shiftState={shiftState}
              shiftTotals={shiftTotals}
              transactionCount={transactionCount}
              actualCash={actualCash}
              setActualCash={setActualCash}
              actualCard={actualCard}
              setActualCard={setActualCard}
              actualCliq={actualCliq}
              setActualCliq={setActualCliq}
              discrepancyReason={discrepancyReason}
              setDiscrepancyReason={setDiscrepancyReason}
              discrepancyNote={discrepancyNote}
              setDiscrepancyNote={setDiscrepancyNote}
            />
          )}
          {activeTab === "cashflow" && (
            <CashFlowTab cashMovements={cashMovements} />
          )}
          {activeTab === "products" && shiftState.shiftId && (
            <ProductsTab shiftId={shiftState.shiftId} />
          )}
          {activeTab === "taxes" && shiftState.shiftId && (
            <TaxesTab shiftId={shiftState.shiftId} />
          )}
        </div>

        {/* Footer */}
        <footer className="border-t border-border px-5 py-4">
          {guard.blockingReason === "pending_sync" && (
            <div
              role="alert"
              className="mb-3 flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800"
            >
              <span className="mt-0.5 shrink-0">⚠</span>
              <span>
                توجد {pendingSyncCount} حركة بانتظار المزامنة. انتظر اكتمال المزامنة قبل
                إغلاق الوردية حتى لا يُجمد التقرير ناقصاً.
              </span>
            </div>
          )}
          <button
            type="button"
            onClick={handleClose}
            disabled={!canClose}
            className="flex h-14 w-full items-center justify-center gap-2 rounded-xl bg-destructive text-lg font-black text-destructive-foreground transition hover:bg-destructive-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Check className="h-5 w-5" />
            {isCompleting ? "جارٍ حفظ تقرير Z…" : "إغلاق الوردية"}
          </button>
        </footer>
      </div>
    </div>
  );
}
