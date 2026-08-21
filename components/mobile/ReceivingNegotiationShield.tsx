"use client";

import { AlertTriangle, Check, ShieldCheck, X } from "lucide-react";
import type { NegotiationShield } from "@/types/receiving.types";

function formatCost(value: number): string {
  return (Number.isFinite(value) ? value : 0).toFixed(2);
}

function formatPercent(value: number): string {
  return `${(Number.isFinite(value) ? value * 100 : 0).toFixed(1)}%`;
}

/**
 * The Negotiation Shield card shown per draft line. Surfaces the last 3
 * purchase costs with their vendor names, the cost comparison, the margin-floor
 * hard block (with a confirm-override action), and — when the entered cost
 * rises above every known purchase — the "update retail to maintain margin?"
 * prompt with the exact suggested price.
 */
export default function ReceivingNegotiationShield({
  shield,
  promptOpen,
  acceptedRetail,
  marginOverridden,
  onAcceptRetail,
  onDeclineRetail,
  onOverrideMargin,
}: {
  shield: NegotiationShield;
  promptOpen: boolean;
  acceptedRetail: number | null;
  marginOverridden: boolean;
  onAcceptRetail: () => void;
  onDeclineRetail: () => void;
  onOverrideMargin: () => void;
}) {
  return (
    <div className="mt-3 overflow-hidden rounded-xl border border-emerald-200 bg-emerald-50">
      <div className="flex items-center gap-1.5 border-b border-emerald-200 bg-emerald-100 px-3 py-2">
        <ShieldCheck className="h-4 w-4 shrink-0 text-emerald-700" />
        <p className="text-xs font-black text-emerald-900">استشعار التفاوض</p>
        {shield.isCostIncrease && (
          <span className="ml-auto flex items-center gap-1 rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-black text-rose-700">
            <AlertTriangle className="h-3 w-3" />
            ارتفاع في السعر
          </span>
        )}
      </div>

      <div className="space-y-2 px-3 py-2.5">
        {shield.hasHistory && (
          <ul className="space-y-1.5">
            {shield.lastPurchases.map((purchase, index) => (
              <li key={`${purchase.purchasedAt}-${index}`} className="flex items-center justify-between gap-2 text-xs">
                <span className="min-w-0 flex-1 truncate font-bold text-emerald-950">
                  {purchase.supplierName || "مورد"}
                </span>
                <span className="shrink-0 font-mono font-black text-emerald-900">
                  {formatCost(purchase.cost)}
                </span>
              </li>
            ))}
          </ul>
        )}

        {shield.hasHistory && (
          <div className="flex items-center gap-2 rounded-lg bg-white/70 px-2 py-1.5 text-[11px] font-bold text-emerald-900">
            <span>الأدنى {formatCost(shield.lowestCost)}</span>
            <span className="text-emerald-300">•</span>
            <span>الأعلى {formatCost(shield.highestCost)}</span>
            <span className="text-emerald-300">•</span>
            <span>متوسط {formatCost(shield.averageCost)}</span>
          </div>
        )}

        {shield.isCostIncrease && (
          <div className="flex items-start gap-1.5 rounded-lg border border-rose-200 bg-rose-50 px-2 py-1.5 text-[11px] font-bold text-rose-800">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              التكلفة المدخلة {formatCost(shield.enteredCost)} أعلى من آخر سعر شراء
              {shield.highestCost > 0 ? ` (الأعلى سابقاً ${formatCost(shield.highestCost)})` : ""}
            </span>
          </div>
        )}

        {shield.belowFloor && !marginOverridden && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-2">
            <div className="flex items-start gap-1.5 text-[11px] font-bold text-amber-800">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                الحد الأدنى لهامش الربح {formatPercent(shield.marginFloor)}
                {shield.proposedMarginPercent != null
                  ? ` — الهامش المتوقع ${formatPercent(shield.proposedMarginPercent)}`
                  : ""} بالحفاظ على سعر البيع الحالي
              </span>
            </div>
            <button
              type="button"
              onClick={onOverrideMargin}
              className="mt-2 flex h-9 w-full items-center justify-center gap-1 rounded-lg bg-amber-600 text-xs font-black text-white transition hover:bg-amber-700"
            >
              <Check className="h-4 w-4" />
              تأكيد تجاوز الحد الأدنى
            </button>
          </div>
        )}

        {marginOverridden && (
          <div className="flex items-center gap-1.5 rounded-lg bg-emerald-100 px-2 py-1.5 text-[11px] font-black text-emerald-800">
            <Check className="h-3.5 w-3.5 shrink-0" />
            تم تأكيد تجاوز الحد الأدنى لهامش الربح لهذا الصنف
          </div>
        )}

        {shield.shouldPromptRetailUpdate && !promptOpen && acceptedRetail == null && (
          <div className="flex items-start gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] font-bold text-amber-800">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              التكلفة ارتفعت — حدّث سعر البيع إلى {formatCost(shield.suggestedRetail)} للحفاظ على هامش الربح؟
            </span>
          </div>
        )}

        {promptOpen && (
          <div className="rounded-lg border border-emerald-300 bg-white px-2.5 py-2">
            <p className="text-[11px] font-black text-emerald-900">
              سعر البيع المقترح للحفاظ على الهامش
            </p>
            <p className="mt-0.5 font-mono text-lg font-black text-emerald-700">
              {formatCost(shield.suggestedRetail)}
            </p>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={onAcceptRetail}
                className="flex h-9 flex-1 items-center justify-center gap-1 rounded-lg bg-emerald-600 text-xs font-black text-white transition hover:bg-emerald-700"
              >
                <Check className="h-4 w-4" />
                تطبيق السعر
              </button>
              <button
                type="button"
                onClick={onDeclineRetail}
                className="flex h-9 flex-1 items-center justify-center gap-1 rounded-lg bg-surface-muted text-xs font-black text-foreground transition hover:bg-border"
              >
                <X className="h-4 w-4" />
                إبقاء الحالي
              </button>
            </div>
          </div>
        )}

        {acceptedRetail != null && (
          <div className="flex items-center gap-1.5 rounded-lg bg-emerald-100 px-2 py-1.5 text-[11px] font-black text-emerald-800">
            <Check className="h-3.5 w-3.5 shrink-0" />
            تم اعتماد سعر البيع الجديد {formatCost(acceptedRetail)}
          </div>
        )}
      </div>
    </div>
  );
}
