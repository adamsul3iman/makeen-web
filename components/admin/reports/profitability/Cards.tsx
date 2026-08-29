"use client";

import Link from "next/link";
import { PackageCheck, ReceiptText } from "lucide-react";
import { formatMoney } from "@/lib/format";
import type { ProfitabilityTaxPosition } from "@/types/profitability.types";
import type { ProfitabilityPurchases } from "@/types/profitability.types";
import type { ProfitabilityStatementValues } from "@/types/profitability.types";
import { cn } from "@/lib/cn";

export function PurchasesCard({
  purchases,
}: {
  purchases?: ProfitabilityPurchases;
}) {
  return (
    <section className="min-w-0 rounded-2xl border border-border bg-surface p-5 shadow-card">
      <h2 className="flex items-center gap-2 text-sm font-black text-foreground">
        <PackageCheck className="h-4 w-4 shrink-0 text-muted" />
        حركة المشتريات
      </h2>
      <div className="mt-4 grid min-w-0 grid-cols-2 gap-3">
        <div className="min-w-0">
          <p className="text-xs font-bold text-muted">مستلمة خلال الفترة</p>
          <p className="mt-2 text-xl font-black tabular-nums text-foreground">{purchases ? formatMoney(purchases.receivedValue) : "—"}</p>
          <p className="mt-1 text-xs font-bold text-muted">{purchases?.receivedCount ?? 0} أمر</p>
        </div>
        <div className="min-w-0">
          <p className="text-xs font-bold text-muted">التزامات معلقة</p>
          <p className="mt-2 text-xl font-black tabular-nums text-warning-strong">{purchases ? formatMoney(purchases.pendingValue) : "—"}</p>
          <p className="mt-1 text-xs font-bold text-muted">{purchases?.pendingCount ?? 0} أمر</p>
        </div>
      </div>
      <p className="mt-5 rounded-lg bg-info-soft px-3 py-3 text-xs font-bold leading-5 text-info-strong">
        المشتريات تزيد المخزون ولا تُخصم من الربح فوراً؛ الخصم يحدث عند بيع البضاعة ضمن تكلفة البضاعة المباعة.
      </p>
    </section>
  );
}

export function TaxPositionCard({
  taxPosition,
  statement,
}: {
  taxPosition?: ProfitabilityTaxPosition;
  statement?: ProfitabilityStatementValues;
}) {
  const netPayable = taxPosition?.netPayable ?? 0;
  return (
    <section className="min-w-0 rounded-2xl border border-border bg-surface p-5 shadow-card">
      <h2 className="flex items-center gap-2 text-sm font-black text-foreground">
        <ReceiptText className="h-4 w-4 shrink-0 text-muted" />
        الضريبة وجودة الدفتر
      </h2>
      <dl className="mt-4 space-y-3 text-sm">
        <div className="flex min-w-0 justify-between gap-3">
          <dt className="min-w-0 font-bold text-muted">ضريبة مخرجات المبيعات</dt>
          <dd className="shrink-0 font-black tabular-nums text-foreground">{taxPosition ? formatMoney(taxPosition.outputTax) : "—"}</dd>
        </div>
        <div className="flex min-w-0 justify-between gap-3">
          <dt className="min-w-0 font-bold text-muted">(-) ضريبة مدخلات الموردين</dt>
          <dd className="shrink-0 font-black tabular-nums text-info-strong">{taxPosition ? formatMoney(taxPosition.deductibleInputTax) : "—"}</dd>
        </div>
        <div className="flex min-w-0 justify-between gap-3 border-t border-border pt-3">
          <dt className="font-black text-foreground">{taxPosition && netPayable < 0 ? "رصيد ضريبي دائن" : "صافي الضريبة المستحقة"}</dt>
          <dd className={cn("shrink-0 font-black tabular-nums", taxPosition && netPayable < 0 ? "text-success-strong" : "text-warning-strong")}>
            {taxPosition ? formatMoney(Math.abs(netPayable)) : "—"}
          </dd>
        </div>
        <div className="flex min-w-0 justify-between gap-3">
          <dt className="min-w-0 font-bold text-muted">إجمالي المقبوضات مع الضريبة</dt>
          <dd className="shrink-0 font-black tabular-nums text-foreground">{statement ? formatMoney(statement.receiptsIncludingTax) : "—"}</dd>
        </div>
        <div className="flex min-w-0 justify-between gap-3">
          <dt className="min-w-0 font-bold text-muted">فواتير الفترة</dt>
          <dd className="shrink-0 font-black tabular-nums text-foreground">{statement?.invoiceCount ?? 0}</dd>
        </div>
        <div className="flex min-w-0 justify-between gap-3">
          <dt className="min-w-0 font-bold text-muted">مصروفات مسجلة</dt>
          <dd className="shrink-0 font-black tabular-nums text-foreground">{statement?.expenseCount ?? 0}</dd>
        </div>
      </dl>
      <p className="mt-5 rounded-lg bg-info-soft px-3 py-3 text-xs font-bold leading-5 text-info-strong">
        تُحتسب ضريبة المدخلات من بنود فواتير الموردين المسجلة فقط. راجع المستندات والتصنيف الضريبي قبل اعتماد الإقرار النهائي.
        <Link href="/admin/supplier-accounts" className="mr-1 font-black text-info-strong underline underline-offset-2">
          فتح ذمم الموردين
        </Link>
      </p>
    </section>
  );
}