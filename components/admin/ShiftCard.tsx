"use client";

import { memo } from "react";
import {
  CheckCircle2,
  Printer,
  ReceiptText,
  ShieldCheck,
  Store,
  TriangleAlert,
} from "lucide-react";
import { formatMoney } from "@/lib/format";
import { formatShiftTime } from "@/lib/dateTime";
import type { ShiftAudit } from "@/types/shifts.types";

function VarianceBadge({ variance }: { variance: number }) {
  const tone =
    variance > 0
      ? "bg-success/10 text-success"
      : variance < 0
        ? "bg-destructive/10 text-destructive"
        : "bg-surface-muted text-muted";
  const label = variance > 0 ? "زيادة" : variance < 0 ? "عجز" : "مطابق";
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-black tabular-nums ${tone}`}>
      {label} {formatMoney(Math.abs(variance))}
    </span>
  );
}

function Metric({
  label,
  value,
  tone = "",
}: {
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <div className="rounded-lg bg-surface px-2.5 py-2">
      <p className="text-[11px] font-bold text-muted">{label}</p>
      <p className={`mt-0.5 text-sm font-black tabular-nums ${tone}`}>{value}</p>
    </div>
  );
}

export interface ShiftCardProps {
  shift: ShiftAudit;
  /** Show the owner approval action for PENDING shifts. */
  canApprove: boolean;
  onOpenDetails: (shift: ShiftAudit) => void;
  onPrint: (shift: ShiftAudit, mode: "a4" | "thermal") => void;
  onApprove: (shift: ShiftAudit) => void;
  nextCashier?: string;
}

/**
 * Card-based closed-shift row: header → grouped metrics
 * (المبيعات / التسوية النقدية) → actions.
 */
const ShiftCard = memo(function ShiftCard({
  shift,
  canApprove,
  onOpenDetails,
  onPrint,
  onApprove,
  nextCashier,
}: ShiftCardProps) {
  const varianceTone = (v: number) =>
    v === 0 ? "text-muted" : v > 0 ? "text-success" : "text-destructive";

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpenDetails(shift)}
      onKeyDown={(e) => e.key === "Enter" && onOpenDetails(shift)}
      className="cursor-pointer rounded-xl border border-border bg-surface p-4 shadow-sm transition hover:border-primary/30 hover:shadow-md"
    >
      {/* ── Header: cashier, time, location, badges ─────────────────── */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-base font-black text-foreground">{shift.cashier || "—"}</span>
        <span className="inline-flex items-center gap-1 rounded-lg bg-surface-muted px-2.5 py-1 text-xs font-bold tabular-nums text-muted">
          {formatShiftTime(shift.openedAt)} ← {formatShiftTime(shift.closedAt)}
        </span>
        <span className="inline-flex items-center gap-1 rounded-lg bg-surface-muted px-2.5 py-1 text-xs font-bold text-muted">
          <Store className="h-3.5 w-3.5" />
          {shift.branch || "—"}
          {shift.terminal ? ` • ${shift.terminal}` : ""}
        </span>
        <span className="ms-auto">
          <VarianceBadge variance={shift.variance} />
        </span>
        {shift.closeSource === "ADMIN_RECOVERY" && (
          <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-1 text-xs font-black text-amber-800">
            <ShieldCheck className="h-3.5 w-3.5" /> تسوية إدارية
          </span>
        )}
        {shift.approvalStatus === "APPROVED" ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2.5 py-1 text-xs font-black text-success">
            <CheckCircle2 className="h-3.5 w-3.5" />
            معتمد{shift.approvedByName ? ` • ${shift.approvedByName}` : ""}
          </span>
        ) : shift.approvalStatus === "PENDING" ? (
          canApprove ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onApprove(shift);
              }}
              className="inline-flex h-8 items-center gap-1 rounded-lg bg-amber-500 px-3 text-xs font-black text-white transition hover:bg-amber-600"
            >
              <TriangleAlert className="h-3.5 w-3.5" />
              اعتماد الفرق
            </button>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-1 text-xs font-black text-amber-800">
              <TriangleAlert className="h-3.5 w-3.5" /> بانتظار المالك
            </span>
          )
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full bg-surface-muted px-2.5 py-1 text-xs font-black text-muted">
            <CheckCircle2 className="h-3.5 w-3.5" /> لا يحتاج اعتماداً
          </span>
        )}
      </div>

      {/* ── Metrics: two clearly separated groups ───────────────────── */}
      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <div className="rounded-xl border border-border/60 bg-surface-muted/40 p-2.5">
          <p className="mb-2 text-[11px] font-black uppercase tracking-wide text-primary">المبيعات</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
            <Metric label="الإجمالي" value={formatMoney(shift.totalSales)} />
            <Metric label="نقداً" value={formatMoney(shift.cashSales)} tone="text-success" />
            <Metric label="بطاقة" value={formatMoney(shift.visaSales)} tone="text-primary" />
            <Metric label="كليك" value={formatMoney(shift.cliqSales)} tone="text-primary" />
            <Metric label="خصومات" value={formatMoney(shift.discounts)} tone="text-amber-600" />
            <Metric label="مصروفات" value={formatMoney(shift.expenses)} tone="text-amber-600" />
          </div>
        </div>
        <div className="rounded-xl border border-border/60 bg-surface-muted/40 p-2.5">
          <p className="mb-2 text-[11px] font-black uppercase tracking-wide text-muted">التسوية</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
            <Metric label="العهدة" value={formatMoney(shift.startingCash)} />
            <Metric label="نقد متوقع" value={formatMoney(shift.expectedCashInDrawer)} />
            <Metric label="نقد فعلي" value={formatMoney(shift.actualCash)} tone={varianceTone(shift.variance)} />
            <Metric label="فرق الصندوق" value={formatMoney(shift.variance)} tone={varianceTone(shift.variance)} />
            <Metric label="فرق البطاقة" value={formatMoney(shift.cardVariance)} tone={varianceTone(shift.cardVariance)} />
            <Metric label="فرق كليك" value={formatMoney(shift.cliqVariance)} tone={varianceTone(shift.cliqVariance)} />
          </div>
        </div>
      </div>

      {/* ── Footnote: drawer events + formula ──────────────────────── */}
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] font-bold text-muted">
        {shift.drawerOpenCount > 0 && (
          <span className="text-amber-600">فتح الصندوق: {shift.drawerOpenCount} مرة</span>
        )}
        {(shift.cashIn > 0 || shift.cashOut > 0) && (
          <span>
            إيداع: <span className="tabular-nums text-success">{formatMoney(shift.cashIn)}</span> • سحب:{" "}
            <span className="tabular-nums text-destructive">{formatMoney(shift.cashOut)}</span>
          </span>
        )}
        <span>التفاوت = الفعلي − (العهدة + النقد + تحصيل الذمم − المصروفات)</span>
      </div>

      {/* ── Actions ────────────────────────────────────────────────── */}
      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border/50 pt-3">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onOpenDetails(shift);
          }}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-xs font-black text-foreground transition hover:bg-surface-muted"
        >
          <ReceiptText className="h-3.5 w-3.5" />
          التفاصيل
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onPrint(shift, "a4");
          }}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-xs font-black text-foreground transition hover:bg-surface-muted"
        >
          <Printer className="h-3.5 w-3.5" />
          طباعة A4
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onPrint(shift, "thermal");
          }}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-xs font-black text-foreground transition hover:bg-surface-muted"
        >
          <Printer className="h-3.5 w-3.5" />
          طباعة حرارية
        </button>
        {nextCashier && (
          <span className="ms-auto text-xs font-black text-primary">
            ← تسليم الوردية إلى: {nextCashier}
          </span>
        )}
      </div>
    </div>
  );
});

export default ShiftCard;
