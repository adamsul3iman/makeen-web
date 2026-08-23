"use client";

import { X, Clock, Banknote, CreditCard, Smartphone, AlertTriangle } from "lucide-react";
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

interface ShiftDetailModalProps {
  shift: ShiftAudit | null;
  open: boolean;
  onClose: () => void;
}

export default function ShiftDetailModal({ shift, open, onClose }: ShiftDetailModalProps) {
  if (!open || !shift) return null;

  const durationMs =
    shift.openedAt && shift.closedAt
      ? new Date(shift.closedAt).getTime() - new Date(shift.openedAt).getTime()
      : 0;
  const durationH = Math.floor(durationMs / 3_600_000);
  const durationM = Math.floor((durationMs % 3_600_000) / 60_000);
  const durationLabel = durationMs > 0 ? `${durationH}س ${durationM}د` : "—";

  const hasDiscrepancy =
    shift.variance !== 0 || shift.cardVariance !== 0 || shift.cliqVariance !== 0;

  const summaryRows: { label: string; value: string; bold?: boolean }[] = [
    { label: "البداية", value: formatShiftDateTime(shift.openedAt) },
    { label: "النهاية", value: formatShiftDateTime(shift.closedAt) },
    { label: "المدة", value: durationLabel },
    { label: "الكاشير", value: shift.cashier || "—" },
    { label: "الفرع", value: shift.branch || "—" },
    { label: "الجهاز", value: shift.terminal || "—" },
    { label: "العهدة", value: formatMoney(shift.startingCash) },
    { label: "نقداً", value: formatMoney(shift.cashSales) },
    { label: "بطاقة", value: formatMoney(shift.visaSales) },
    { label: "كليك", value: formatMoney(shift.cliqSales) },
    { label: "ذمم", value: formatMoney(shift.debtSales) },
    { label: "تحصيل الذمم", value: formatMoney(shift.debtCollections) },
    { label: "إيداعات", value: formatMoney(shift.cashIn) },
    { label: "سحوبات", value: formatMoney(shift.cashOut) },
    { label: "المصروفات", value: formatMoney(shift.expenses) },
    { label: "خصومات", value: formatMoney(shift.discounts) },
    { label: "مرتجعات", value: formatMoney(shift.returns) },
    { label: "الإجمالي", value: formatMoney(shift.totalSales), bold: true },
  ];

  const triReconciliation: {
    label: string;
    icon: React.ReactNode;
    expected: number;
    actual: number;
    variance: number;
  }[] = [
    {
      label: "النقدي",
      icon: <Banknote className="h-4 w-4" />,
      expected: shift.expectedCashInDrawer,
      actual: shift.actualCash,
      variance: shift.variance,
    },
    {
      label: "البطاقة",
      icon: <CreditCard className="h-4 w-4" />,
      expected: shift.expectedCard,
      actual: shift.actualCard,
      variance: shift.cardVariance,
    },
    {
      label: "كليك",
      icon: <Smartphone className="h-4 w-4" />,
      expected: shift.expectedCliq,
      actual: shift.actualCliq,
      variance: shift.cliqVariance,
    },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      dir="rtl"
      onClick={onClose}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-border px-5 py-4">
          <div>
            <h2 className="text-lg font-bold">تفاصيل الوردية المغلقة</h2>
            <p className="text-xs text-muted">
              #{shift.shiftId?.slice(0, 8) ?? "—"} • {shift.cashier || "—"} • {shift.date}
            </p>
          </div>
          <button
            type="button"
            aria-label="إغلاق"
            onClick={onClose}
            className="grid h-11 w-11 cursor-pointer place-items-center rounded-lg text-muted transition hover:bg-surface-muted"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="scrollbar-hidden min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {/* Times Section */}
          <Section icon={<Clock className="h-4 w-4" />} title="الأوقات">
            <DetailRow label="البداية" value={formatShiftDateTime(shift.openedAt)} />
            <DetailRow label="النهاية" value={formatShiftDateTime(shift.closedAt)} />
            <DetailRow label="المدة" value={durationLabel} />
          </Section>

          {/* Sales Section */}
          <Section title="المبيعات">
            {summaryRows.map((r) => (
              <DetailRow
                key={r.label}
                label={r.label}
                value={r.value}
                bold={r.bold}
              />
            ))}
          </Section>

          {/* Tri-Reconciliation */}
          <Section icon={<CreditCard className="h-4 w-4" />} title="التسوية (Tri-Reconciliation)">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs font-bold text-muted">
                    <th className="pb-2 text-right"></th>
                    <th className="pb-2 text-center">المطلوب</th>
                    <th className="pb-2 text-center">الفعلي</th>
                    <th className="pb-2 text-center">الفرق</th>
                  </tr>
                </thead>
                <tbody>
                  {triReconciliation.map((r) => (
                    <tr key={r.label} className="border-t border-border">
                      <td className="flex items-center gap-1.5 py-2 font-bold">
                        {r.icon}
                        {r.label}
                      </td>
                      <td className="py-2 text-center tabular-nums">{formatMoney(r.expected)}</td>
                      <td className="py-2 text-center tabular-nums">{formatMoney(r.actual)}</td>
                      <td className={`py-2 text-center tabular-nums font-bold ${r.variance === 0 ? "text-green-600" : "text-amber-600"}`}>
                        {formatMoney(r.variance)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          {/* Drawer Opens */}
          {shift.drawerOpenCount > 0 && (
            <Section title="فتح الدرج">
              <DetailRow label="مرات فتح الدرج" value={String(shift.drawerOpenCount)} />
            </Section>
          )}

          {/* Discrepancy Notes */}
          {hasDiscrepancy && (
            <Section icon={<AlertTriangle className="h-4 w-4 text-amber-500" />} title="ملاحظات الفرق">
              <DetailRow
                label="السبب"
                value={REASON_LABELS[shift.discrepancyReason] || shift.discrepancyReason || "—"}
              />
              {shift.discrepancyNote && (
                <DetailRow label="الملاحظات" value={shift.discrepancyNote} />
              )}
            </Section>
          )}

          {/* Approval Status */}
          <Section title="الاعتماد">
            <DetailRow
              label="الحالة"
              value={
                shift.approvalStatus === "APPROVED"
                  ? `معتمد${shift.approvedByName ? ` — ${shift.approvedByName}` : ""}`
                  : shift.approvalStatus === "PENDING"
                    ? "بانتظار الاعتماد"
                    : "لا يتطلب اعتماد"
              }
            />
            {shift.closeSource === "ADMIN_RECOVERY" && (
              <DetailRow label="المصدر" value="تسوية إدارية" />
            )}
          </Section>
        </div>

        <footer className="border-t border-border px-5 py-4">
          <p className="text-center text-xs text-muted">
            لطباعة تقرير Z جدولية اضغط على زر «طباعة جدولية» من قائمة الورديات
          </p>
        </footer>
      </div>
    </div>
  );
}

function Section({
  icon,
  title,
  children,
}: {
  icon?: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-4">
      <div className="mb-2 flex items-center gap-1.5 text-sm font-black text-foreground">
        {icon}
        {title}
      </div>
      <div className="rounded-xl border border-border bg-surface-muted/40 px-4 py-3">
        {children}
      </div>
    </div>
  );
}

function DetailRow({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2 py-1">
      <span className="text-sm text-muted">{label}</span>
      <span className={`text-sm tabular-nums ${bold ? "font-black" : "font-bold"}`}>{value}</span>
    </div>
  );
}
