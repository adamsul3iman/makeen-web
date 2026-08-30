"use client";

import { useState } from "react";
import { Printer, LogOut, CheckCircle } from "lucide-react";
import { usePosStore } from "@/store/usePosStore";
import { formatMoney } from "@/lib/format";
import { formatShiftDateTime } from "@/lib/dateTime";
import { isElectron } from "@/lib/printAgent";
import { buildLiveShiftAudit } from "@/lib/shiftPrintPayload";
import { renderShiftPrintHtml } from "@/lib/printRenderer";
import { dispatchPrintJob } from "@/lib/hardware/dispatch";

const REASON_LABELS: Record<string, string> = {
  cash_counting_error: "خطأ في العد",
  missing_receipt: "فاتورة لم تُسجّل",
  unrecorded_expense: "مصروف غير مسجّل",
  overpayment: "دفعة زائدة",
  system_error: "خطأ في النظام",
  other: "أخرى",
};

/**
 * Post-close success screen shown after a shift is successfully closed.
 * Replaces the abrupt lockScreen redirect. The cashier can review the
 * summary and print a final Z-report before logging out.
 */
export default function ShiftClosedSuccess() {
  const isClosed = usePosStore((s) => s.isShiftClosedSuccess);
  const shiftState = usePosStore((s) => s.shiftState);
  const setShiftClosedSuccess = usePosStore((s) => s.setShiftClosedSuccess);
  const lockScreen = usePosStore((s) => s.lockScreen);
  const activeTerminalId = usePosStore((s) => s.activeTerminalId);
  const currentCashier = usePosStore((s) => s.currentCashier);
  const [printing, setPrinting] = useState(false);
  // Use a snapshot of the closed shift totals — after closeShift, shiftTotals
  // is reset to empty. We read the last known values from the success state
  // which we'll store in a dedicated snapshot on the store.
  const closedSummary = usePosStore((s) => s.closedShiftSummary);

  if (!isClosed || shiftState.status !== "CLOSED") return null;

  const handleLogout = () => {
    setShiftClosedSuccess(false);
    void lockScreen();
  };

  if (!closedSummary) {
    // Fallback: no summary data available, just show logout
    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-white"
        dir="rtl"
      >
        <div className="flex flex-col items-center gap-6 p-8 text-center">
          <CheckCircle className="h-20 w-20 text-green-500" />
          <h1 className="text-2xl font-black text-foreground">تم إغلاق الوردية بنجاح</h1>
          <button
            type="button"
            onClick={handleLogout}
            className="flex h-14 items-center gap-2 rounded-xl bg-primary px-8 text-lg font-black text-primary-foreground transition hover:bg-primary-hover"
          >
            <LogOut className="h-5 w-5" />
            تسجيل خروج
          </button>
        </div>
      </div>
    );
  }

  const s = closedSummary;

  const handlePrint = async () => {
    // Never open the native dialog inside Electron — silent paths only.
    if ((!activeTerminalId || !s) && !isElectron()) {
      window.print();
      return;
    }
    if (!activeTerminalId || !s) return;
    setPrinting(true);
    const shift = buildLiveShiftAudit({
      shiftId: s.shiftId,
      startTime: s.startTime,
      startingCash: s.startingCash,
      totals: s,
      cashierName: currentCashier?.name ?? "",
      closedAt: s.closeTime,
      actualCash: s.actualCash,
      variance: s.variance,
      discrepancyReason: s.discrepancyReason,
      discrepancyNote: s.discrepancyNote,
    });
    try {
      const result = await dispatchPrintJob("A4_REPORT", {
        html: renderShiftPrintHtml(shift, "Z_REPORT"),
        shift,
        jobType: "Z_REPORT",
        terminalId: activeTerminalId,
      });
      if (!result.printed && !result.attempted && !isElectron()) window.print();
    } catch {
      if (!isElectron()) window.print();
    } finally {
      setPrinting(false);
    }
  };

  const summaryRows: { label: string; value: string; bold?: boolean }[] = [
    { label: "البداية", value: formatShiftDateTime(s.startTime) },
    { label: "النهاية", value: formatShiftDateTime(s.closeTime) },
    { label: "العهدة", value: formatMoney(s.startingCash) },
    { label: "نقداً", value: formatMoney(s.cashSales) },
    { label: "بطاقة", value: formatMoney(s.visaSales) },
    { label: "كليك", value: formatMoney(s.cliqSales) },
    { label: "ذمم", value: formatMoney(s.debtSales) },
    { label: "تحصيل الذمم", value: formatMoney(s.debtCollections) },
    { label: "إيداعات", value: formatMoney(s.cashInTotal) },
    { label: "سحوبات", value: formatMoney(s.cashOutTotal) },
    { label: "المصروفات", value: formatMoney(s.expenses) },
    { label: "خصومات", value: formatMoney(s.discounts) },
    { label: "مرتجعات", value: formatMoney(s.returns) },
    { label: "الإجمالي", value: formatMoney(s.totalSales), bold: true },
  ];

  const varianceRows: { label: string; expected: string; actual: string; variance: string }[] = [
    {
      label: "النقدي",
      expected: formatMoney(s.expectedCashInDrawer),
      actual: formatMoney(s.actualCash),
      variance: formatMoney(s.variance),
    },
    {
      label: "البطاقة",
      expected: formatMoney(s.expectedCard),
      actual: formatMoney(s.actualCard),
      variance: formatMoney(s.cardVariance),
    },
    {
      label: "كليك",
      expected: formatMoney(s.expectedCliq),
      actual: formatMoney(s.actualCliq),
      variance: formatMoney(s.cliqVariance),
    },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-white"
      dir="rtl"
    >
      <div className="scrollbar-hidden flex max-h-[90vh] w-full max-w-md flex-col overflow-y-auto p-6">
        <div className="flex flex-col items-center gap-3 pb-6">
          <CheckCircle className="h-16 w-16 text-green-500" />
          <h1 className="text-2xl font-black text-foreground">تم إغلاق الوردية بنجاح</h1>
        </div>

        <div className="rounded-xl border border-dashed border-border bg-surface-muted px-4 py-3 font-mono text-sm">
          <p className="text-center text-base font-black tracking-wide">
            تقرير نهاية الوردية (Z)
          </p>
          <p className="mt-1 text-center text-xs text-muted">
            وردية #{s.shiftId?.slice(0, 8) ?? "—"}
          </p>
          <div className="my-2 border-t border-dashed border-border" />
          <div className="space-y-1.5">
            {summaryRows.map((r) => (
              <div key={r.label} className="flex items-center justify-between gap-2">
                <span className="text-muted">{r.label}</span>
                <span className={`tabular-nums ${r.bold ? "font-black" : "font-bold"}`}>{r.value}</span>
              </div>
            ))}
          </div>

          <div className="my-3 border-t border-dashed border-border" />
          <p className="mb-2 text-center text-sm font-black">التسوية</p>
          <div className="space-y-2">
            <div className="grid grid-cols-4 gap-1 text-center text-xs font-bold text-muted">
              <span></span>
              <span>المطلوب</span>
              <span>الفعلي</span>
              <span>الفرق</span>
            </div>
            {varianceRows.map((r) => (
              <div key={r.label} className="grid grid-cols-4 gap-1 text-center text-sm tabular-nums">
                <span className="font-bold">{r.label}</span>
                <span>{r.expected}</span>
                <span>{r.actual}</span>
                <span className={r.variance === "0.00" ? "text-green-600 font-bold" : "text-amber-600 font-black"}>
                  {r.variance}
                </span>
              </div>
            ))}
          </div>

          {s.discrepancyReason && (
            <>
              <div className="my-3 border-t border-dashed border-border" />
              <p className="text-sm font-bold text-amber-700">سبب الفرق: {REASON_LABELS[s.discrepancyReason] || s.discrepancyReason}</p>
              {s.discrepancyNote && (
                <p className="mt-1 text-xs text-muted">{s.discrepancyNote}</p>
              )}
            </>
          )}
        </div>

        <div className="mt-6 flex flex-col gap-3">
          <button
            type="button"
            onClick={handlePrint}
            disabled={printing}
            className="flex h-14 items-center justify-center gap-2 rounded-xl border-2 border-primary bg-white text-lg font-black text-primary transition hover:bg-primary/5 disabled:opacity-50"
          >
            <Printer className="h-5 w-5" />
            {printing ? "جارٍ الإرسال…" : "طباعة تقرير Z النهائي"}
          </button>
          <button
            type="button"
            onClick={handleLogout}
            className="flex h-14 items-center justify-center gap-2 rounded-xl bg-primary text-lg font-black text-primary-foreground transition hover:bg-primary-hover"
          >
            <LogOut className="h-5 w-5" />
            تسجيل خروج
          </button>
        </div>
      </div>

      {/* Hidden printable Z-report */}
      <div id="z-report-print" className="hidden print:block print:p-4" dir="rtl">
        <h1 className="text-center text-lg font-black">تقرير نهاية الوردية (Z)</h1>
        <p className="text-center text-sm">وردية #{s.shiftId?.slice(0, 8) ?? "—"}</p>
        <hr className="my-2" />
        <table className="w-full text-sm">
          <tbody>
            {summaryRows.map((r) => (
              <tr key={r.label}>
                <td className="py-1">{r.label}</td>
                <td className={`py-1 text-left ${r.bold ? "font-black" : "font-bold"}`}>{r.value}</td>
              </tr>
            ))}
            <tr><td colSpan={2}><hr className="my-2" /></td></tr>
            <tr><td colSpan={2} className="py-1 text-center font-black">التسوية</td></tr>
            <tr className="text-xs font-bold text-muted">
              <td></td>
              <td className="text-left">المطلوب / الفعلي / الفرق</td>
            </tr>
            {varianceRows.map((r) => (
              <tr key={r.label}>
                <td className="py-1">{r.label}</td>
                <td className="py-1 text-left">{r.expected} / {r.actual} / {r.variance}</td>
              </tr>
            ))}
            {s.discrepancyReason && (
              <>
                <tr><td colSpan={2}><hr className="my-1" /></td></tr>
                <tr>
                  <td className="py-1">سبب الفرق</td>
                  <td className="py-1 text-left">{REASON_LABELS[s.discrepancyReason] || s.discrepancyReason}</td>
                </tr>
                {s.discrepancyNote && (
                  <tr>
                    <td className="py-1">ملاحظات</td>
                    <td className="py-1 text-left">{s.discrepancyNote}</td>
                  </tr>
                )}
              </>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
