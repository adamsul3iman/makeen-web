"use client";

import { formatMoney } from "@/lib/format";
import { formatShiftDateTime } from "@/lib/dateTime";
import type { ShiftAudit } from "@/types/shifts.types";

const REASON_LABELS: Record<string, string> = {
  cash_counting_error: "خطأ في العد",
  missing_receipt: "فاتورة لم تُسجّل",
  unrecorded_expense: "مصروف غير مسجّل",
  overpayment: "دفعة زائدة",
  system_error: "خطأ في النظام",
  other: "أخرى",
};

function fmt(n: number): string {
  return formatMoney(n);
}

/**
 * A4 office-printer Z-report. Strictly A4 portrait — do NOT use for thermal.
 * For thermal printers use ThermalShiftPrintView instead.
 */
export default function ShiftPrintView({ shift }: { shift: ShiftAudit }) {
  const durationMs =
    shift.openedAt && shift.closedAt
      ? new Date(shift.closedAt).getTime() - new Date(shift.openedAt).getTime()
      : 0;
  const durationH = Math.floor(durationMs / 3_600_000);
  const durationM = Math.floor((durationMs % 3_600_000) / 60_000);
  const durationLabel = durationMs > 0 ? `${durationH}س ${durationM}د` : "—";

  const hasDiscrepancy =
    shift.variance !== 0 || shift.cardVariance !== 0 || shift.cliqVariance !== 0;

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: A4_PRINT_CSS }} />
      <div id="shift-print-view" className="print-shift-root" dir="rtl">
        {/* ═══════ HEADER ═══════════════════════════════════════════════ */}
        <table className="ps-header">
          <tbody>
            <tr>
              <td className="ps-header-title">تقرير نهاية الوردية (Z)</td>
            </tr>
            <tr>
              <td className="ps-header-sub">
                وردية #{shift.shiftId?.slice(0, 8) ?? "—"} &mdash; {shift.date}
              </td>
            </tr>
            <tr>
              <td className="ps-header-sub">
                {shift.cashier || "—"} &bull; {shift.branch || "—"}
                {shift.terminal ? ` • ${shift.terminal}` : ""}
              </td>
            </tr>
          </tbody>
        </table>

        {/* ═══════ TIMES ════════════════════════════════════════════════ */}
        <table className="ps-section">
          <thead>
            <tr><th colSpan={2} className="ps-section-head">الأوقات</th></tr>
          </thead>
          <tbody>
            <tr><td className="ps-label">البداية</td><td className="ps-value">{formatShiftDateTime(shift.openedAt)}</td></tr>
            <tr><td className="ps-label">النهاية</td><td className="ps-value">{formatShiftDateTime(shift.closedAt)}</td></tr>
            <tr><td className="ps-label">المدة</td><td className="ps-value">{durationLabel}</td></tr>
          </tbody>
        </table>

        {/* ═══════ FINANCIAL SUMMARY ════════════════════════════════════ */}
        <table className="ps-section">
          <thead>
            <tr><th colSpan={2} className="ps-section-head">الملخص المالي</th></tr>
          </thead>
          <tbody>
            <tr><td className="ps-label">العهدة</td><td className="ps-value">{fmt(shift.startingCash)}</td></tr>
            <tr><td className="ps-label">المبيعات النقدية</td><td className="ps-value ps-positive">{fmt(shift.cashSales)}</td></tr>
            <tr><td className="ps-label">المبيعات بالبطاقة</td><td className="ps-value">{fmt(shift.visaSales)}</td></tr>
            <tr><td className="ps-label">مبيعات كليك</td><td className="ps-value">{fmt(shift.cliqSales)}</td></tr>
            <tr><td className="ps-label">مبيعات الذمم</td><td className="ps-value">{fmt(shift.debtSales)}</td></tr>
            <tr><td className="ps-label">تحصيل الذمم</td><td className="ps-value">{fmt(shift.debtCollections)}</td></tr>
            <tr><td className="ps-label">إيداعات</td><td className="ps-value ps-positive">{fmt(shift.cashIn)}</td></tr>
            <tr><td className="ps-label">سحوبات</td><td className="ps-value ps-negative">{fmt(shift.cashOut)}</td></tr>
            <tr><td className="ps-label">المصروفات</td><td className="ps-value ps-negative">{fmt(shift.expenses)}</td></tr>
            <tr><td className="ps-label">الخصومات</td><td className="ps-value">{fmt(shift.discounts)}</td></tr>
            <tr><td className="ps-label">المرتجعات</td><td className="ps-value ps-negative">{fmt(shift.returns)}</td></tr>
            <tr className="ps-total-row">
              <td className="ps-label ps-total-label">إجمالي المبيعات</td>
              <td className="ps-value ps-total-value">{fmt(shift.totalSales)}</td>
            </tr>
          </tbody>
        </table>

        {/* ═══════ TRI-RECONCILIATION ═══════════════════════════════════ */}
        <table className="ps-section">
          <thead>
            <tr><th colSpan={4} className="ps-section-head">التسوية (Tri-Reconciliation)</th></tr>
            <tr className="ps-tri-subhead">
              <th></th>
              <th>المطلوب</th>
              <th>الفعلي</th>
              <th>الفرق</th>
            </tr>
          </thead>
          <tbody>
            <TriRow label="النقدي" expected={shift.expectedCashInDrawer} actual={shift.actualCash} variance={shift.variance} />
            <TriRow label="البطاقة" expected={shift.expectedCard} actual={shift.actualCard} variance={shift.cardVariance} />
            <TriRow label="كليك" expected={shift.expectedCliq} actual={shift.actualCliq} variance={shift.cliqVariance} />
          </tbody>
        </table>

        {/* ═══════ CASH MOVEMENTS ═══════════════════════════════════════ */}
        <table className="ps-section">
          <thead>
            <tr><th colSpan={2} className="ps-section-head">حركات الصندوق</th></tr>
          </thead>
          <tbody>
            <tr><td className="ps-label">إجمالي الإيداعات</td><td className="ps-value ps-positive">{fmt(shift.cashIn)}</td></tr>
            <tr><td className="ps-label">إجمالي السحوبات</td><td className="ps-value ps-negative">{fmt(shift.cashOut)}</td></tr>
            <tr className="ps-total-row">
              <td className="ps-label ps-total-label">صافي حركة النقد</td>
              <td className="ps-value ps-total-value">{fmt(shift.cashIn - shift.cashOut)}</td>
            </tr>
          </tbody>
        </table>

        {/* ═══════ DRAWER OPENS ═════════════════════════════════════════ */}
        <table className="ps-section">
          <thead>
            <tr><th colSpan={2} className="ps-section-head">فتح الدرج</th></tr>
          </thead>
          <tbody>
            <tr><td className="ps-label">عدد مرات فتح الدرج</td><td className="ps-value">{shift.drawerOpenCount}</td></tr>
          </tbody>
        </table>

        {/* ═══════ DISCREPANCY (conditional) ════════════════════════════ */}
        {hasDiscrepancy && (
          <table className="ps-section">
            <thead>
              <tr><th colSpan={2} className="ps-section-head">ملاحظات الفرق</th></tr>
            </thead>
            <tbody>
              <tr>
                <td className="ps-label">سبب الفرق</td>
                <td className="ps-value">{REASON_LABELS[shift.discrepancyReason] || shift.discrepancyReason || "—"}</td>
              </tr>
              {shift.discrepancyNote && (
                <tr>
                  <td className="ps-label">ملاحظات</td>
                  <td className="ps-value">{shift.discrepancyNote}</td>
                </tr>
              )}
            </tbody>
          </table>
        )}

        {/* ═══════ APPROVAL ═════════════════════════════════════════════ */}
        <table className="ps-section">
          <thead>
            <tr><th colSpan={2} className="ps-section-head">الاعتماد</th></tr>
          </thead>
          <tbody>
            <tr>
              <td className="ps-label">حالة الاعتماد</td>
              <td className="ps-value">
                {shift.approvalStatus === "APPROVED"
                  ? `معتمد${shift.approvedByName ? ` — ${shift.approvedByName}` : ""}`
                  : shift.approvalStatus === "PENDING"
                    ? "بانتظار الاعتماد"
                    : "لا يتطلب اعتماد"}
              </td>
            </tr>
            {shift.closeSource === "ADMIN_RECOVERY" && (
              <tr><td className="ps-label">مصدر الإغلاق</td><td className="ps-value">تسوية إدارية</td></tr>
            )}
            {shift.resolvedByName && (
              <tr><td className="ps-label">تم التسوية بواسطة</td><td className="ps-value">{shift.resolvedByName}</td></tr>
            )}
            {shift.resolutionNote && (
              <tr><td className="ps-label">ملاحظة التسوية</td><td className="ps-value">{shift.resolutionNote}</td></tr>
            )}
          </tbody>
        </table>

        {/* ═══════ SIGN-OFF ═════════════════════════════════════════════ */}
        <table className="ps-signoff">
          <tbody>
            <tr>
              <td className="ps-sig-cell">
                <div className="ps-sig-line" />
                <span>توقيع الكاشير</span>
              </td>
              <td className="ps-sig-cell">
                <div className="ps-sig-line" />
                <span>توقيع المدير / المالك</span>
              </td>
            </tr>
            <tr>
              <td className="ps-date-cell" colSpan={2}>التاريخ: {shift.date}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </>
  );
}

/* ── Sub-components ──────────────────────────────────────────────────────── */

function TriRow({
  label,
  expected,
  actual,
  variance,
}: {
  label: string;
  expected: number;
  actual: number;
  variance: number;
}) {
  const cls =
    variance === 0 ? "ps-tri-ok" : variance > 0 ? "ps-tri-surplus" : "ps-tri-short";
  return (
    <tr>
      <td className="ps-label">{label}</td>
      <td className="ps-value">{fmt(expected)}</td>
      <td className="ps-value">{fmt(actual)}</td>
      <td className={`ps-value ${cls}`}>
        {variance > 0 ? "+" : ""}{fmt(variance)}
      </td>
    </tr>
  );
}

/* ── A4 Print CSS ────────────────────────────────────────────────────────── */

const A4_PRINT_CSS = `
/* ================================================================
   ON-SCREEN: HIDE PRINT ROOT
   ================================================================ */
.print-shift-root,
#shift-print-view {
  display: none !important;
}

/* ================================================================
   PRINT — A4 PORTRAIT ONLY
   ================================================================ */
@media print {
  @page {
    size: A4 portrait;
    margin: 10mm 12mm;
  }

  /* ── Hide admin UI ────────────────────────────────────────────── */
  .no-print,
  [data-radix-portal],
  [role="dialog"],
  [role="presentation"] {
    display: none !important;
  }

  /* ── Show print root ─────────────────────────────────────────── */
  #shift-print-view,
  .print-shift-root {
    display: block !important;
    position: relative !important;
    inset: auto !important;
    z-index: auto !important;
    width: 100% !important;
    max-width: none !important;
    overflow: visible !important;
    background: white !important;
    color: #000 !important;
    font-family: "Tahoma", "Arial", sans-serif !important;
    font-size: 10.5pt !important;
    line-height: 1.45 !important;
  }

  #shift-print-view * {
    visibility: visible !important;
    color: #000 !important;
    background: transparent !important;
    box-shadow: none !important;
    text-shadow: none !important;
  }

  /* ── Header ──────────────────────────────────────────────────── */
  .ps-header {
    width: 100%;
    border-collapse: collapse;
    border-bottom: 2.5pt solid #000;
    margin-bottom: 14pt;
  }

  .ps-header td {
    padding: 2pt 0;
    text-align: center;
  }

  .ps-header-title {
    font-size: 16pt !important;
    font-weight: 900 !important;
    padding-bottom: 4pt !important;
  }

  .ps-header-sub {
    font-size: 10pt !important;
    font-weight: 400 !important;
    color: #333 !important;
  }

  /* ── Section tables ──────────────────────────────────────────── */
  .ps-section {
    width: 100%;
    border-collapse: collapse;
    margin-bottom: 12pt;
    page-break-inside: avoid;
  }

  .ps-section-head {
    text-align: right !important;
    font-size: 11pt !important;
    font-weight: 900 !important;
    padding: 5pt 6pt !important;
    border-bottom: 1.5pt solid #000 !important;
    border-top: 0.5pt solid #999 !important;
    background: #f0f0f0 !important;
    color: #000 !important;
  }

  .ps-section td,
  .ps-section th {
    padding: 3.5pt 6pt !important;
    text-align: right !important;
    vertical-align: middle;
    border-bottom: 0.5pt solid #ccc !important;
  }

  .ps-label {
    font-weight: 600 !important;
    width: 55% !important;
    text-align: right !important;
    color: #222 !important;
  }

  .ps-value {
    font-weight: 400 !important;
    text-align: left !important;
    width: 45% !important;
    font-variant-numeric: tabular-nums !important;
  }

  .ps-positive { color: #166534 !important; }
  .ps-negative { color: #991b1b !important; }

  /* ── Total row ──────────────────────────────────────────────── */
  .ps-total-row td {
    border-top: 1.5pt solid #000 !important;
    border-bottom: 2pt solid #000 !important;
    padding-top: 5pt !important;
    padding-bottom: 5pt !important;
  }

  .ps-total-label { font-weight: 900 !important; font-size: 11pt !important; }
  .ps-total-value { font-weight: 900 !important; font-size: 11pt !important; }

  /* ── Tri-Reconciliation ──────────────────────────────────────── */
  .ps-tri-subhead th {
    font-size: 9pt !important;
    font-weight: 700 !important;
    text-align: center !important;
    color: #444 !important;
    padding: 2pt 6pt !important;
    border-bottom: 0.75pt solid #999 !important;
  }

  .ps-tri-ok       { color: #166534 !important; }
  .ps-tri-surplus  { color: #166534 !important; font-weight: 700 !important; }
  .ps-tri-short    { color: #991b1b !important; font-weight: 700 !important; }

  /* ── Sign-off ────────────────────────────────────────────────── */
  .ps-signoff {
    width: 100%;
    border-collapse: collapse;
    margin-top: 28pt;
    page-break-inside: avoid;
  }

  .ps-sig-cell {
    width: 50%;
    text-align: center !important;
    padding: 0 16pt !important;
    vertical-align: bottom;
  }

  .ps-sig-cell span {
    display: block;
    font-size: 9.5pt !important;
    margin-top: 4pt;
    color: #333 !important;
  }

  .ps-sig-line {
    width: 100%;
    height: 0;
    border-bottom: 1pt solid #000;
    margin-bottom: 2pt;
  }

  .ps-date-cell {
    text-align: center !important;
    font-size: 9pt !important;
    color: #666 !important;
    padding-top: 10pt !important;
  }
}
`;
