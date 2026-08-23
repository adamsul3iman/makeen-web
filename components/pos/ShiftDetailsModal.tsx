"use client";

import { useState } from "react";
import { Printer, X } from "lucide-react";
import { usePosStore } from "@/store/usePosStore";
import { formatMoney } from "@/lib/format";
import { formatShiftDateTime } from "@/lib/dateTime";
import { smartPrint } from "@/lib/printAgent";
import { buildLiveShiftAudit } from "@/lib/shiftPrintPayload";
import { useModalEscape } from "@/hooks/useModalEscape";

export default function ShiftDetailsModal() {
  const isOpen = usePosStore((s) => s.isShiftDetailsModalOpen);
  const shiftState = usePosStore((s) => s.shiftState);
  const shiftTotals = usePosStore((s) => s.shiftTotals);
  const invoiceCount = usePosStore((s) => s.shiftTransactions.length);
  const closeShiftDetailsModal = usePosStore((s) => s.closeShiftDetailsModal);
  const activeTerminalId = usePosStore((s) => s.activeTerminalId);
  const currentCashier = usePosStore((s) => s.currentCashier);
  const currentStore = usePosStore((s) => s.currentStore);
  const [printing, setPrinting] = useState(false);

  useModalEscape(closeShiftDetailsModal, isOpen);

  if (!isOpen) return null;

  const rows: { label: string; value: string }[] = [
    { label: "العهدة", value: formatMoney(shiftState.startingCash) },
    { label: "المبيعات نقداً", value: formatMoney(shiftTotals.cashSales) },
    { label: "المبيعات بطاقة", value: formatMoney(shiftTotals.visaSales) },
    { label: "المبيعات كليك", value: formatMoney(shiftTotals.cliqSales ?? 0) },
    { label: "مبيعات الذمم", value: formatMoney(shiftTotals.debtSales) },
    { label: "مقبوضات الذمم", value: formatMoney(shiftTotals.debtCollections) },
    { label: "إيداعات", value: formatMoney(shiftTotals.cashInTotal) },
    { label: "سحوبات", value: `- ${formatMoney(shiftTotals.cashOutTotal)}` },
    { label: "المصروفات", value: `- ${formatMoney(shiftTotals.expenses)}` },
  ];

  const handlePrint = async () => {
    setPrinting(true);
    try {
      const printedSilently = await smartPrint({
        terminalId: activeTerminalId ?? "",
        jobType: "X_REPORT",
        printerKind: "THERMAL",
        shift: buildLiveShiftAudit({
          shiftId: shiftState.shiftId,
          startTime: shiftState.startTime,
          startingCash: shiftState.startingCash,
          totals: shiftTotals,
          invoiceCount,
          cashierName: currentCashier?.name ?? "",
          branchName: currentStore?.name ?? "",
        }),
      });
      if (!printedSilently) window.print();
    } catch {
      window.print();
    } finally {
      setPrinting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      dir="rtl"
      onClick={closeShiftDetailsModal}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-md flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 className="text-lg font-bold">تفاصيل الوردية الحالية (X)</h2>
          <button
            type="button"
            aria-label="إغلاق"
            onClick={closeShiftDetailsModal}
            className="grid h-11 w-11 cursor-pointer place-items-center rounded-lg text-muted transition hover:bg-surface-muted"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="scrollbar-hidden min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div className="rounded-xl border border-dashed border-border bg-surface-muted px-4 py-3 font-mono text-sm">
            <p className="text-center text-base font-black tracking-wide">
              تقرير مؤقت (X)
            </p>
            <p className="mt-1 text-center text-xs text-muted">
              وردية #{shiftState.shiftId?.slice(0, 8) ?? "—"} •{" "}
              {formatShiftDateTime(shiftState.startTime)}
            </p>
            <div className="my-2 border-t border-dashed border-border" />
            <div className="space-y-1.5">
              {rows.map((r) => (
                <div key={r.label} className="flex items-center justify-between gap-2">
                  <span className="text-muted">{r.label}</span>
                  <span className="font-bold tabular-nums">{r.value}</span>
                </div>
              ))}
            </div>
            <div className="my-2 border-t border-dashed border-border" />
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted">إجمالي المبيعات</span>
                <span className="font-bold tabular-nums">{formatMoney(shiftTotals.totalSales)}</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted">عدد الفواتير</span>
                <span className="font-bold tabular-nums">{invoiceCount}</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted">مرات فتح الدرج</span>
                <span className="font-bold tabular-nums">{shiftTotals.drawerOpenCount}</span>
              </div>
            </div>
            <div className="my-2 border-t border-dashed border-border" />
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted">متوقع بالصندوق</span>
              <span className="font-black tabular-nums">{formatMoney(shiftTotals.expectedCashInDrawer)}</span>
            </div>
          </div>
        </div>

        <footer className="border-t border-border px-5 py-4">
          <button
            type="button"
            onClick={() => void handlePrint()}
            disabled={printing}
            className="flex h-14 w-full items-center justify-center gap-2 rounded-xl bg-primary text-lg font-black text-primary-foreground shadow-sm transition hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Printer className={`h-5 w-5 ${printing ? "animate-pulse" : ""}`} />
            {printing ? "جارٍ الإرسال للطابعة…" : "طباعة تقرير مؤقت X"}
          </button>
        </footer>
      </div>

      {/* Fallback printable report — used only when window.print() is the last resort */}
      <div id="x-report-print" className="hidden print:block print:p-4" dir="rtl">
        <h1 className="text-center text-lg font-black">تقرير مؤقت (X)</h1>
        <p className="text-center text-sm">
          وردية #{shiftState.shiftId?.slice(0, 8) ?? "—"}
        </p>
        <p className="text-center text-sm">
          {formatShiftDateTime(shiftState.startTime)}
        </p>
        <hr className="my-2" />
        <table className="w-full text-sm">
          <tbody>
            {rows.map((r) => (
              <tr key={r.label}>
                <td className="py-1">{r.label}</td>
                <td className="py-1 text-left font-bold">{r.value}</td>
              </tr>
            ))}
            <tr><td colSpan={2}><hr className="my-1" /></td></tr>
            <tr>
              <td className="py-1 font-bold">إجمالي المبيعات</td>
              <td className="py-1 text-left font-bold">{formatMoney(shiftTotals.totalSales)}</td>
            </tr>
            <tr>
              <td className="py-1">عدد الفواتير</td>
              <td className="py-1 text-left font-bold">{invoiceCount}</td>
            </tr>
            <tr>
              <td className="py-1">مرات فتح الدرج</td>
              <td className="py-1 text-left font-bold">{shiftTotals.drawerOpenCount}</td>
            </tr>
            <tr><td colSpan={2}><hr className="my-1" /></td></tr>
            <tr>
              <td className="py-1 font-bold">متوقع بالصندوق</td>
              <td className="py-1 text-left font-black">{formatMoney(shiftTotals.expectedCashInDrawer)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
