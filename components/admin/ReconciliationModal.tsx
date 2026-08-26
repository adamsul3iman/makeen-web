"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, PackageCheck } from "lucide-react";
import { ModalShell } from "@/components/ui/ModalShell";
import { formatMoney } from "@/lib/format";
import {
  fetchPurchaseOrderDetail,
  receivePurchaseOrderWithReconciliation,
  type PurchaseOrderItem,
  type ReconciliationLineOverride,
} from "@/lib/purchasesClient";

interface ReconciliationLine {
  poItemId: string;
  productId: string | null;
  productName: string;
  orderedQty: number;
  receivedQty: number;
  unitCost: number;
  baseCost: number;
  newSellingPrice: string;
  baseSellingPrice: number | null;
  variantId: string | null;
  unitId: string | null;
  qtyInUnit: number | null;
}

interface Props {
  open: boolean;
  poId: string;
  poNumber?: string | null;
  actorName?: string;
  onClose: () => void;
  onConfirmed: () => void;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export default function ReconciliationModal({
  open,
  poId,
  poNumber,
  actorName,
  onClose,
  onConfirmed,
}: Props) {
  const [lines, setLines] = useState<ReconciliationLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open || !poId) return;
    let alive = true;
    setLoading(true);
    setError("");
    fetchPurchaseOrderDetail(poId)
      .then((detail) => {
        if (!alive) return;
        setLines(
          detail.items.map((item) => ({
            poItemId: item.id,
            productId: item.product_id,
            productName: item.productName,
            orderedQty: item.quantity,
            receivedQty: item.quantity,
            unitCost: item.unit_cost,
            baseCost: item.unit_cost,
            newSellingPrice: item.new_selling_price != null ? String(item.new_selling_price) : "",
            baseSellingPrice: item.new_selling_price,
            variantId: item.variant_id ?? null,
            unitId: item.unit_id ?? null,
            qtyInUnit: item.qty_in_unit ?? null,
          })),
        );
      })
      .catch((err) => {
        if (alive) setError(err instanceof Error ? err.message : "تعذر تحميل تفاصيل أمر الشراء");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [open, poId]);

  const updateLine = (poItemId: string, patch: Partial<ReconciliationLine>) => {
    setLines((prev) => prev.map((l) => (l.poItemId === poItemId ? { ...l, ...patch } : l)));
  };

  const totalReceived = round2(
    lines.reduce((acc, l) => acc + l.receivedQty * l.unitCost, 0),
  );

  const hasDiscrepancy = lines.some(
    (l) => l.receivedQty !== l.orderedQty || round2(l.unitCost) !== round2(l.baseCost),
  );

  const handleConfirm = async () => {
    const validLines = lines.filter((l) => l.productId && l.receivedQty >= 0 && l.unitCost >= 0);
    if (validLines.length === 0) {
      setError("لا بنود صالحة للاستلام");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const overrides: ReconciliationLineOverride[] = validLines.map((l) => ({
        poItemId: l.poItemId,
        productId: l.productId,
        receivedQty: l.receivedQty,
        unitCost: l.unitCost,
        newSellingPrice:
          l.newSellingPrice !== "" && parseFloat(l.newSellingPrice) > 0
            ? round2(parseFloat(l.newSellingPrice))
            : null,
        variantId: l.variantId,
        unitId: l.unitId,
        qtyInUnit: l.qtyInUnit,
        productName: l.productName,
      }));
      await receivePurchaseOrderWithReconciliation(poId, overrides, { actorName });
      onConfirmed();
    } catch (err) {
      setError(err instanceof Error ? err.message : "تعذر استلام أمر الشراء");
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell
      open={open}
      title="تسوية الاستلام"
      description={
        poNumber
          ? `أمر شراء رقم ${poNumber} — عدّل الكميات والأسعار حسب ما وصل فعلياً`
          : "عدّل الكميات والأسعار حسب ما وصل فعلياً"
      }
      icon={<PackageCheck className="h-5 w-5 text-primary" />}
      size="xl"
      onClose={onClose}
      dismissible={!saving}
      footer={
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 text-sm font-bold text-muted">
            {hasDiscrepancy && (
              <span className="inline-flex items-center gap-1 text-amber-600">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                تغيّرت الكميات أو الأسعار
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="h-11 rounded-lg border border-border bg-white px-4 text-sm font-black text-muted transition hover:bg-surface-muted disabled:opacity-50"
            >
              إلغاء
            </button>
            <button
              type="button"
              onClick={() => void handleConfirm()}
              disabled={saving || lines.length === 0}
              className="flex h-11 items-center justify-center gap-2 rounded-lg bg-success px-5 text-sm font-black text-success-foreground transition hover:bg-success-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? (
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-success-foreground border-t-transparent" />
              ) : (
                <CheckCircle2 className="h-4 w-4" />
              )}
              {saving ? "جارٍ الاستلام…" : `استلام — ${formatMoney(totalReceived)}`}
            </button>
          </div>
        </div>
      }
    >
      {loading && (
        <div className="flex items-center justify-center py-12">
          <span className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      )}

      {error && !loading && (
        <p className="mb-4 rounded-lg bg-destructive/10 px-3 py-2 text-sm font-bold text-destructive">
          {error}
        </p>
      )}

      {!loading && lines.length === 0 && (
        <p className="py-8 text-center text-sm font-semibold text-muted">
          لا بنود في أمر الشراء
        </p>
      )}

      {!loading && lines.length > 0 && (
        <div className="space-y-3">
          {/* Summary row */}
          <div className="flex items-center gap-4 rounded-xl bg-surface-muted px-4 py-2.5 text-xs font-bold text-muted">
            <span>{lines.length} بنود</span>
            <span>
              مطلوب:{" "}
              <span className="tabular-nums text-foreground">
                {lines.reduce((a, l) => a + l.orderedQty, 0)}
              </span>
            </span>
            <span>
              مستلم:{" "}
              <span className="tabular-nums text-foreground">
                {lines.reduce((a, l) => a + l.receivedQty, 0)}
              </span>
            </span>
            {hasDiscrepancy && (
              <span className="inline-flex items-center gap-1 text-amber-600">
                <AlertTriangle className="h-3 w-3" />
                تفاوت
              </span>
            )}
          </div>

          {/* Line items */}
          {lines.map((line) => {
            const qtyChanged = line.receivedQty !== line.orderedQty;
            const costChanged = round2(line.unitCost) !== round2(line.baseCost);
            const highlighted = qtyChanged || costChanged;
            return (
              <div
                key={line.poItemId}
                className={`rounded-xl border p-4 transition ${
                  highlighted
                    ? "border-amber-300 bg-amber-50/60"
                    : "border-border bg-white"
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-black text-foreground">
                      {line.productName}
                    </p>
                    {line.variantId && (
                      <span className="mt-0.5 inline-block rounded-md bg-primary/10 px-1.5 py-0.5 text-[10px] font-black text-primary">
                        متغير
                      </span>
                    )}
                  </div>
                  {highlighted && (
                    <span className="shrink-0 rounded-md bg-amber-100 px-2 py-0.5 text-[10px] font-black text-amber-700">
                      تفاوت
                    </span>
                  )}
                </div>

                <div className="mt-3 grid grid-cols-3 gap-3">
                  {/* Received Qty */}
                  <label className="block text-xs font-bold text-muted">
                    الكمية المستلمة
                    <div className="relative mt-1">
                      <input
                        type="number"
                        min={0}
                        value={line.receivedQty}
                        onChange={(e) =>
                          updateLine(line.poItemId, {
                            receivedQty: Math.max(0, parseInt(e.target.value, 10) || 0),
                          })
                        }
                        className={`w-full rounded-lg border bg-white px-2 py-2 text-sm font-bold tabular-nums outline-none focus:border-primary ${
                          qtyChanged ? "border-amber-400" : "border-border"
                        }`}
                      />
                      <span className="pointer-events-none absolute inset-y-0 end-2 flex items-center text-[10px] font-bold text-muted/60">
                        / {line.orderedQty}
                      </span>
                    </div>
                    {qtyChanged && (
                      <span className="mt-0.5 block text-[10px] font-bold text-amber-600">
                        {line.receivedQty > line.orderedQty
                          ? `+${line.receivedQty - line.orderedQty} زيادة`
                          : `${line.receivedQty - line.orderedQty} نقص`}
                      </span>
                    )}
                  </label>

                  {/* Unit Cost */}
                  <label className="block text-xs font-bold text-muted">
                    تكلفة الوحدة
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      inputMode="decimal"
                      dir="ltr"
                      value={line.unitCost}
                      onChange={(e) =>
                        updateLine(line.poItemId, {
                          unitCost: Math.max(0, parseFloat(e.target.value) || 0),
                        })
                      }
                      className={`mt-1 w-full rounded-lg border bg-white px-2 py-2 text-left text-sm font-bold tabular-nums outline-none focus:border-primary ${
                        costChanged ? "border-amber-400" : "border-border"
                      }`}
                    />
                    {costChanged && (
                      <span className="mt-0.5 block text-[10px] font-bold text-amber-600">
                        كان {formatMoney(line.baseCost)}
                      </span>
                    )}
                  </label>

                  {/* Selling Price */}
                  <label className="block text-xs font-bold text-muted">
                    سعر البيع الجديد
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      inputMode="decimal"
                      dir="ltr"
                      placeholder={line.baseSellingPrice != null ? String(line.baseSellingPrice) : "اختياري"}
                      value={line.newSellingPrice}
                      onChange={(e) =>
                        updateLine(line.poItemId, { newSellingPrice: e.target.value })
                      }
                      className="mt-1 w-full rounded-lg border border-border bg-white px-2 py-2 text-left text-sm font-bold tabular-nums outline-none focus:border-primary placeholder:text-muted/60"
                    />
                  </label>
                </div>

                <p className="mt-2 text-xs font-semibold text-muted tabular-nums">
                  الإجمالي:{" "}
                  <span className="font-black text-foreground">
                    {formatMoney(round2(line.receivedQty * line.unitCost))}
                  </span>
                </p>
              </div>
            );
          })}
        </div>
      )}
    </ModalShell>
  );
}
