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

function Row({ label, value, total }: { label: string; value: string; total?: boolean }) {
  return (
    <tr>
      <th style={{ width: "60%" }}>{label}</th>
      <td style={{ width: "40%", fontWeight: total ? 700 : 400 }}>{value}</td>
    </tr>
  );
}

function Section({ title }: { title: string }) {
  return (
    <tr>
      <th colSpan={2} style={{ width: "100%", textAlign: "center" }}>{title}</th>
    </tr>
  );
}

function Header({ children }: { children: React.ReactNode }) {
  return (
    <tr>
      <td colSpan={2} style={{ width: "100%", textAlign: "center", border: "none", padding: "2px 0" }}>
        {children}
      </td>
    </tr>
  );
}

export default function ThermalShiftPrintView({
  shift,
  kind = "Z_REPORT",
}: {
  shift: ShiftAudit;
  kind?: "X_REPORT" | "Z_REPORT";
}) {
  const durationMs =
    shift.openedAt && shift.closedAt
      ? new Date(shift.closedAt).getTime() - new Date(shift.openedAt).getTime()
      : 0;
  const dH = Math.floor(durationMs / 3_600_000);
  const dM = Math.floor((durationMs % 3_600_000) / 60_000);
  const duration = durationMs > 0 ? `${dH}س ${dM}د` : "—";

  const hasDiscrepancy =
    shift.variance !== 0 || shift.cardVariance !== 0 || shift.cliqVariance !== 0;

  const openT = formatShiftDateTime(shift.openedAt);
  const closeT = formatShiftDateTime(shift.closedAt);

  const approvalLabel =
    shift.approvalStatus === "APPROVED"
      ? `معتمد${shift.approvedByName ? ` — ${shift.approvedByName}` : ""}`
      : shift.approvalStatus === "PENDING"
        ? "بانتظار الاعتماد"
        : "لا يتطلب اعتماد";

  const recon = (label: string, expected: number, actual: number, variance: number) => {
    const vStr = `${variance > 0 ? "+" : ""}${fmt(variance)}`;
    const flag = variance === 0 ? " ✓" : " ✗";
    return (
      <tr>
        <td colSpan={2} style={{ width: "100%", textAlign: "left", direction: "ltr" }}>
          {label}  {fmt(expected)} / {fmt(actual)} = {vStr}{flag}
        </td>
      </tr>
    );
  };

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: THERMAL_CSS }} />
      <div id="thermal-shift-print" className="thermal-root" dir="rtl">

        {/* ── HEADER (borderless) ────────────────────────────────── */}
        <table className="th-table">
          <tbody>
            <Header><strong>{kind === "X_REPORT" ? "تقرير X" : "تقرير Z"}</strong></Header>
            <Header>وردية {shift.shiftId?.slice(0, 8) ?? "—"}</Header>
            <Header>{shift.cashier || "—"}</Header>
            <Header>{shift.branch || "—"}{shift.terminal ? ` — ${shift.terminal}` : ""}</Header>
            <Header>{shift.date}  {openT} — {closeT}</Header>
            <Header>المدة: {duration}</Header>
          </tbody>
        </table>

        {/* ── DATA (bordered) ────────────────────────────────────── */}
        <table className="th-table th-bordered">
          <thead>
            <tr>
              <th style={{ width: "60%" }}>البيان</th>
              <th style={{ width: "40%" }}>المبلغ</th>
            </tr>
          </thead>
          <tbody>
            <Section title="المال" />
            <Row label="العهدة" value={fmt(shift.startingCash)} />
            <Row label="نقداً" value={fmt(shift.cashSales)} />
            <Row label="بطاقة" value={fmt(shift.visaSales)} />
            <Row label="كليك" value={fmt(shift.cliqSales)} />
            <Row label="ذمم" value={fmt(shift.debtSales)} />
            <Row label="تحصيل الذمم" value={fmt(shift.debtCollections)} />
            <Row label="المصروفات" value={fmt(shift.expenses)} />
            <Row label="خصومات" value={fmt(shift.discounts)} />
            <Row label="مرتجعات" value={fmt(shift.returns)} />
            <Row label="الإجمالي" value={fmt(shift.totalSales)} total />

            <Section title="التسوية" />
            {recon("نقدي", shift.expectedCashInDrawer, shift.actualCash, shift.variance)}
            {recon("بطاقة", shift.expectedCard, shift.actualCard, shift.cardVariance)}
            {recon("كليك", shift.expectedCliq, shift.actualCliq, shift.cliqVariance)}

            <Section title="الصندوق" />
            <Row label="إيداع" value={fmt(shift.cashIn)} />
            <Row label="سحب" value={fmt(shift.cashOut)} />
            <Row label="صافي" value={fmt(shift.cashIn - shift.cashOut)} />
            <Row label="فتح الدرج" value={`${shift.drawerOpenCount} مرة`} />

            {hasDiscrepancy && (
              <>
                <Section title="ملاحظات الفرق" />
                <Row label="السبب" value={REASON_LABELS[shift.discrepancyReason] || shift.discrepancyReason || "—"} />
                {shift.discrepancyNote && (
                  <Row label="ملاحظات" value={shift.discrepancyNote} />
                )}
              </>
            )}

            <Section title="الاعتماد" />
            <Row label="الحالة" value={approvalLabel} />
            {shift.closeSource === "ADMIN_RECOVERY" && (
              <Row label="المصدر" value="تسوية إدارية" />
            )}
            {shift.resolvedByName && (
              <Row label="تم التسوية بواسطة" value={shift.resolvedByName} />
            )}
          </tbody>
        </table>

        {/* ── SIGN-OFF (borderless) ──────────────────────────────── */}
        <table className="th-table">
          <tbody>
            <Header><br /></Header>
            <Header>______________________</Header>
            <Header>توقيع الكاشير</Header>
            <Header><br /><br /></Header>
            <Header>______________________</Header>
            <Header>توقيع المدير</Header>
            <Header><br /></Header>
            <Header>{shift.date}</Header>
          </tbody>
        </table>

      </div>
    </>
  );
}

/* ── CSS ─────────────────────────────────────────────────────────────────── */

const THERMAL_CSS = `
.thermal-root,
#thermal-shift-print {
  display: none !important;
}

@media print {
  @page {
    size: auto;
    margin: 4mm;
  }

  .no-print,
  [data-radix-portal],
  [role="dialog"],
  [role="presentation"] {
    display: none !important;
  }

  #thermal-shift-print,
  .thermal-root {
    display: block !important;
    position: relative !important;
    inset: auto !important;
    z-index: auto !important;
    width: 100% !important;
    max-width: none !important;
    overflow: visible !important;
    background: white !important;
    color: #000 !important;
    font-family: 'Courier New', Consolas, monospace !important;
    font-size: 10px !important;
    line-height: 1.2 !important;
    direction: rtl !important;
  }

  #thermal-shift-print * {
    visibility: visible !important;
    color: #000 !important;
    background: transparent !important;
    box-shadow: none !important;
    text-shadow: none !important;
  }

  .th-table {
    width: 100% !important;
    border-collapse: collapse !important;
    table-layout: fixed !important;
    margin: 0 !important;
  }

  .th-bordered th,
  .th-bordered td {
    border: 1px solid #000 !important;
    padding: 2px !important;
    font-size: 10px !important;
    word-wrap: break-word !important;
    overflow-wrap: break-word !important;
    text-align: right !important;
  }

  .th-bordered th {
    font-weight: 700 !important;
    text-align: center !important;
    background: #f0f0f0 !important;
  }
}
`;
