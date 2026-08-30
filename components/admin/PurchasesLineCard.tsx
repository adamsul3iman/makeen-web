"use client";

import { memo } from "react";
import { Trash2 } from "lucide-react";
import type { AsyncProductOption } from "@/components/admin/AsyncProductCombobox";
import AsyncProductCombobox from "@/components/admin/AsyncProductCombobox";
import { formatMoney } from "@/lib/format";
import type { LocalUnit } from "@/types/pos.types";

/** Minimum acceptable gross margin before a line is flagged as unprofitable. */
const MIN_MARGIN = 0.1;

export interface LineInput {
  key: string;
  productId: string;
  productName: string;
  /** Base pieces persisted to the backend (qtyInUnit × unitMultiplier). */
  quantity: string;
  /** Unit cost per base piece. */
  unitCost: string;
  /** Input VAT % for this line (0 = exempt). Jordan standard default 16. */
  taxPercent: string;
  /** True when `unitCost` already includes VAT; false when VAT is added on top. */
  taxIncluded: boolean;
  /** Parent-level reference cost captured when the product was picked. */
  baseCost: number | null;
  /** Parent-level reference selling price captured when the product was picked. */
  basePrice: number | null;
  /** Optional updated selling price (per base piece) pushed at receive time. */
  newSellingPrice: string;
  /** Tier 3.5 enrichment — variant tracking */
  variantId?: string | null;
  variantLabel?: string;
  /** Owning product_units row for package barcodes. */
  unitId?: string | null;
  unitName?: string;
  /** Pieces per selected unit (1/undefined = base piece). */
  unitMultiplier?: number;
  /** Quantity expressed in the selected unit. */
  qtyInUnit?: number;
}

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

interface LineCardProps {
  line: LineInput;
  units: LocalUnit[];
  onProductPicked: (key: string, product: AsyncProductOption) => void;
  onQtyChange: (key: string, raw: string) => void;
  onUnitCostChange: (key: string, raw: string) => void;
  onSellingChange: (key: string, raw: string) => void;
  onTaxPercentChange: (key: string, raw: string) => void;
  onTaxIncludedChange: (key: string, included: boolean) => void;
  onSwitchUnit: (key: string, unit: LocalUnit | null) => void;
  onRemove: (key: string) => void;
}

function LineCardInner({
  line,
  units,
  onProductPicked,
  onQtyChange,
  onUnitCostChange,
  onSellingChange,
  onTaxPercentChange,
  onTaxIncludedChange,
  onSwitchUnit,
  onRemove,
}: LineCardProps) {
  // Effective per-piece numbers used for margin analysis (base-unit basis).
  const newCost = parseFloat(line.unitCost) || 0;
  const taxPercent = parseFloat(line.taxPercent) || 0;
  // Net cost (VAT-exclusive) — the true landed COGS after recovering input VAT.
  const netCost = line.taxIncluded && taxPercent > 0
    ? round2(newCost / (1 + taxPercent / 100))
    : newCost;
  const inputTaxPerUnit = round2(line.taxIncluded ? newCost - netCost : (netCost * taxPercent) / 100);
  const sellingRaw =
    line.newSellingPrice !== "" && !Number.isNaN(parseFloat(line.newSellingPrice))
      ? parseFloat(line.newSellingPrice)
      : line.basePrice;
  const selling = sellingRaw != null ? sellingRaw : null;
  const qtyInUnit = line.qtyInUnit != null ? line.qtyInUnit : parseInt(line.quantity, 10) || 0;
  const multiplier = line.unitMultiplier && line.unitMultiplier > 0 ? line.unitMultiplier : 1;
  const baseQty = round2(qtyInUnit * multiplier);
  const lineTotal = round2(baseQty * newCost);
  const lineInputTax = round2(baseQty * inputTaxPerUnit);

  let margin: number | null = null;
  let sellingChanged = false;
  if (selling != null && selling > 0) {
    margin = (selling - newCost) / selling;
    sellingChanged =
      line.newSellingPrice !== "" &&
      line.basePrice != null &&
      Math.abs(parseFloat(line.newSellingPrice) - line.basePrice) > 0.009;
  }

  const marginTone =
    selling == null || margin == null || newCost <= 0
      ? "text-muted"
      : margin < 0
        ? "bg-destructive/10 text-destructive"
        : margin < MIN_MARGIN
          ? "bg-amber-100 text-amber-700"
          : "bg-success/10 text-success";

  const marginLabel =
    newCost <= 0
      ? "—"
      : selling == null || margin == null
        ? "لا سعر بيع"
        : `${Math.round(margin * 100)}%`;

  const activeUnit = units.find((u) => u.id === line.unitId) ?? null;
  const unitLabel = activeUnit?.unitName ?? line.unitName ?? "حبة";

  return (
    <div className="rounded-xl border border-border bg-white p-3">
      <div className="flex items-start justify-between gap-2">
        <AsyncProductCombobox
          id={`po-product-${line.key}`}
          label="الصنف"
          value={line.productId}
          selectedLabel={line.productName || undefined}
          placeholder="ابحث بالاسم…"
          required
          onChange={(product) => onProductPicked(line.key, product)}
        />
        <span
          className={`mt-6 shrink-0 rounded-md px-2 py-0.5 text-[10px] font-black ${marginTone}`}
        >
          هامش {marginLabel}
        </span>
      </div>

      {(line.baseCost != null || line.basePrice != null) && (
        <p className="mt-1.5 flex flex-wrap gap-x-3 text-[11px] font-bold text-muted">
          {line.baseCost != null && (
            <span>
              التكلفة السابقة: <span className="tabular-nums">{formatMoney(line.baseCost)}</span>
            </span>
          )}
          {line.basePrice != null && (
            <span>
              سعر البيع الحالي: <span className="tabular-nums">{formatMoney(line.basePrice)}</span>
            </span>
          )}
          {line.baseCost != null && newCost > 0 && line.baseCost !== newCost && (
            <span className={newCost > line.baseCost ? "text-destructive" : "text-success"}>
              التكلفة الجديدة:{" "}
              <span className="tabular-nums">
                {formatMoney(newCost)} {newCost > line.baseCost ? "↑" : "↓"}
              </span>
            </span>
          )}
        </p>
      )}

      {units.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => onSwitchUnit(line.key, null)}
            className={`rounded-lg px-2 py-1 text-[11px] font-black transition ${
              !activeUnit
                ? "bg-primary text-primary-foreground"
                : "bg-surface-muted text-muted hover:bg-surface"
            }`}
          >
            حبة
          </button>
          {units.map((u) => (
            <button
              key={u.id}
              type="button"
              onClick={() => onSwitchUnit(line.key, u)}
              className={`rounded-lg px-2 py-1 text-[11px] font-black transition ${
                activeUnit?.id === u.id
                  ? "bg-primary text-primary-foreground"
                  : "bg-surface-muted text-muted hover:bg-surface"
              }`}
            >
              {u.unitName} (×{u.qtyMultiplier})
            </button>
          ))}
        </div>
      )}

      <div className="mt-2 grid grid-cols-3 gap-2">
        <label className="block text-xs font-bold text-muted">
          الكمية ({unitLabel})
          <input
            type="number"
            min={1}
            value={qtyInUnit}
            onChange={(e) => onQtyChange(line.key, e.target.value)}
            className="mt-1 w-full rounded-lg border border-border bg-white px-2 py-2 text-sm font-bold tabular-nums outline-none focus:border-primary"
          />
        </label>
        <label className="block text-xs font-bold text-muted">
          تكلفة الحبة
          <input
            type="number"
            min={0}
            step="0.01"
            inputMode="decimal"
            dir="ltr"
            value={line.unitCost}
            onChange={(e) => onUnitCostChange(line.key, e.target.value)}
            className="mt-1 w-full rounded-lg border border-border bg-white px-2 py-2 text-left text-sm font-bold tabular-nums outline-none focus:border-primary"
          />
        </label>
        <label className="block text-xs font-bold text-muted">
          سعر بيع جديد / حبة
          <input
            type="number"
            min={0}
            step="0.01"
            inputMode="decimal"
            dir="ltr"
            placeholder={line.basePrice != null ? String(line.basePrice) : "اختياري"}
            value={line.newSellingPrice}
            onChange={(e) => onSellingChange(line.key, e.target.value)}
            className="mt-1 w-full rounded-lg border border-border bg-white px-2 py-2 text-left text-sm font-bold tabular-nums outline-none focus:border-primary placeholder:text-muted/60"
          />
        </label>
      </div>

      {/* Input VAT: inclusive/exclusive toggle + rate. The gross unit cost is
          what's entered; this split controls whether recoverable input VAT is
          extracted out of it (inclusive) or added on top (exclusive). */}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className="text-xs font-bold text-muted">الضريبة:</span>
        <button
          type="button"
          onClick={() => onTaxIncludedChange(line.key, false)}
          className={`rounded-lg px-2 py-1 text-[11px] font-black transition ${
            !line.taxIncluded
              ? "bg-primary text-primary-foreground"
              : "bg-surface-muted text-muted hover:bg-surface"
          }`}
        >
          غير شاملة
        </button>
        <button
          type="button"
          onClick={() => onTaxIncludedChange(line.key, true)}
          className={`rounded-lg px-2 py-1 text-[11px] font-black transition ${
            line.taxIncluded
              ? "bg-primary text-primary-foreground"
              : "bg-surface-muted text-muted hover:bg-surface"
          }`}
        >
          شاملة
        </button>
        <div className="flex items-center gap-1.5">
          <input
            type="number"
            min={0}
            max={100}
            step="0.01"
            inputMode="decimal"
            dir="ltr"
            value={line.taxPercent}
            onChange={(e) => onTaxPercentChange(line.key, e.target.value)}
            className="w-20 rounded-lg border border-border bg-white px-2 py-1.5 text-left text-sm font-bold tabular-nums outline-none focus:border-primary"
          />
          <span className="text-xs font-bold text-muted">%</span>
        </div>
      </div>

      {newCost > 0 && taxPercent > 0 && (
        <p className="mt-1.5 text-[11px] font-semibold text-muted">
          صافي التكلفة:{" "}
          <span className="font-black tabular-nums text-foreground">{formatMoney(netCost)}</span>
          {" / "}
          ضريبة مدخلات:{" "}
          <span className="font-black tabular-nums text-foreground">
            {formatMoney(inputTaxPerUnit)} / وحدة • {formatMoney(lineInputTax)} إجمالي
          </span>
        </p>
      )}

      {multiplier > 1 && (
        <p className="mt-1.5 text-[11px] font-semibold text-muted">
          {qtyInUnit} {unitLabel} × {multiplier} حبة ={" "}
          <span className="font-black tabular-nums text-foreground">{baseQty}</span> حبة
        </p>
      )}

      {sellingChanged && (
        <p className="mt-1.5 text-[11px] font-bold text-amber-700">
          تغيّر سعر البيع من {formatMoney(line.basePrice as number)} إلى{" "}
          {formatMoney(parseFloat(line.newSellingPrice))} عند الاستلام
        </p>
      )}

      <div className="mt-2 flex items-center justify-between">
        <p className="text-xs font-semibold text-muted">
          إجمالي البند:{" "}
          <span className="font-black tabular-nums text-foreground">{formatMoney(lineTotal)}</span>
        </p>
        <button
          type="button"
          onClick={() => onRemove(line.key)}
          aria-label="حذف الصنف"
          className="grid h-8 w-8 place-items-center rounded-lg text-muted transition hover:bg-destructive/10 hover:text-destructive"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

const LineCard = memo(LineCardInner);

export default LineCard;
