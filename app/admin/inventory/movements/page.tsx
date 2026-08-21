"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpFromLine,
  ClipboardCheck,
  History,
  Loader2,
  Package,
  RefreshCw,
  Save,
} from "lucide-react";
import { ListPagination } from "@/components/admin/ListPagination";
import AsyncProductCombobox from "@/components/admin/AsyncProductCombobox";
import type { AsyncProductOption } from "@/components/admin/AsyncProductCombobox";
import { posFetch } from "@/lib/tenantClient";
import { usePosStore } from "@/store/usePosStore";

type AdjustmentMode = "IN" | "OUT" | "COUNT" | "DAMAGE";

interface InventoryMovement {
  id: string;
  product_id: string;
  product_name: string;
  base_unit: string;
  movement_type: string;
  quantity_delta: number;
  unit_quantity: number;
  unit_name: string;
  multiplier: number;
  balance_before: number;
  balance_after: number;
  barcode: string | null;
  variant_label: string;
  reference_type: string | null;
  reference_id: string | null;
  actor_name: string;
  reason: string;
  occurred_at: string;
}

const MOVEMENT_LABELS: Record<string, string> = {
  OPENING: "رصيد افتتاحي",
  SALE: "بيع",
  RETURN: "مرتجع بيع",
  PURCHASE_RECEIPT: "استلام مشتريات",
  ADJUSTMENT_IN: "إضافة يدوية",
  ADJUSTMENT_OUT: "سحب يدوي",
  STOCKTAKE: "تسوية جرد",
  DAMAGE: "تالف",
  TRANSFER_IN: "تحويل وارد",
  TRANSFER_OUT: "تحويل صادر",
};

function quantity(value: number): string {
  return new Intl.NumberFormat("ar-JO", { maximumFractionDigits: 3 }).format(Number(value) || 0);
}

function movementTone(delta: number): string {
  return delta > 0 ? "text-emerald-700 bg-emerald-50" : "text-red-700 bg-red-50";
}

export default function InventoryMovementsPage() {
  const adminEmail = usePosStore((state) => state.adminSession?.email ?? "");
  const requestKey = useRef("");
  const [movements, setMovements] = useState<InventoryMovement[]>([]);
  const [filterProductId, setFilterProductId] = useState("");
  const [filterProductName, setFilterProductName] = useState("");
  const [filterType, setFilterType] = useState("");
  const [productId, setProductId] = useState("");
  const [selectedProduct, setSelectedProduct] = useState<AsyncProductOption | null>(null);
  const [barcode, setBarcode] = useState("");
  const [mode, setMode] = useState<AdjustmentMode>("IN");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [total, setTotal] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const movementParams = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      if (filterProductId) movementParams.set("productId", filterProductId);
      if (filterType) movementParams.set("type", filterType);
      const movementsResponse = await posFetch(`/api/inventory/movements?${movementParams}`, { cache: "no-store" });
      const movementData = (await movementsResponse.json().catch(() => null)) as { movements?: InventoryMovement[]; total?: number; page?: number; pageSize?: number; error?: string } | null;
      if (!movementsResponse.ok || !Array.isArray(movementData?.movements)) {
        throw new Error(movementData?.error ?? "تعذر تحميل حركات المخزون");
      }
      setMovements(movementData.movements);
      setTotal(movementData.total ?? movementData.movements.length);
    } catch (reasonValue) {
      setError(reasonValue instanceof Error ? reasonValue.message : "تعذر تحميل دفتر المخزون");
    } finally {
      setLoading(false);
    }
  }, [filterProductId, filterType, page, pageSize]);

  useEffect(() => { setPage(1); }, [filterType]);

  const handleFilterProductChange = useCallback((id: string, name: string) => {
    setFilterProductId(id);
    setFilterProductName(name);
    setPage(1);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const selectedBarcode = selectedProduct?.barcodes.find((entry) => entry.barcode === barcode);
  const increases = movements.filter((movement) => Number(movement.quantity_delta) > 0).length;
  const decreases = movements.filter((movement) => Number(movement.quantity_delta) < 0).length;

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);

  const saveAdjustment = async () => {
    if (!productId || !amount || reason.trim().length < 3 || saving) return;
    if (!requestKey.current) requestKey.current = crypto.randomUUID();
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const response = await posFetch("/api/inventory/movements", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-pos-role": "admin",
          "x-pos-admin-email": adminEmail,
        },
        body: JSON.stringify({
          productId,
          barcode: mode === "COUNT" ? "" : barcode,
          mode,
          quantity: Number(amount),
          reason: reason.trim(),
          idempotencyKey: requestKey.current,
        }),
      });
      const data = (await response.json().catch(() => null)) as { movement?: InventoryMovement; error?: string } | null;
      if (!response.ok || !data?.movement) throw new Error(data?.error ?? "تعذر تسجيل حركة المخزون");
      requestKey.current = "";
      setAmount("");
      setReason("");
      setNotice("تم تسجيل الحركة وتحديث الرصيد");
      await load();
    } catch (reasonValue) {
      setError(reasonValue instanceof Error ? reasonValue.message : "تعذر تسجيل حركة المخزون");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-black text-foreground">حركات المخزون وبطاقة الصنف</h1>
          <p className="mt-1 text-sm font-semibold text-muted">سجل الرصيد قبل وبعد كل بيع أو استلام أو جرد أو تسوية</p>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={() => void load()} disabled={loading} aria-label="تحديث" title="تحديث" className="grid h-11 w-11 place-items-center rounded-lg border border-border bg-white text-muted hover:bg-surface-muted disabled:opacity-40">
            <RefreshCw className={`h-5 w-5 ${loading ? "animate-spin" : ""}`} />
          </button>
          <Link href="/admin/inventory" className="flex h-11 items-center gap-2 rounded-lg border border-border bg-white px-4 text-sm font-black text-foreground hover:bg-surface-muted">
            <Package className="h-5 w-5 text-primary" /> المنتجات والمخزون
          </Link>
        </div>
      </header>

      <section className="grid grid-cols-3 gap-3">
        <div className="rounded-lg border border-border bg-white p-4"><p className="text-xs font-bold text-muted">إجمالي الحركات</p><p className="mt-1 text-2xl font-black tabular-nums">{total.toLocaleString("ar-JO")}</p></div>
        <div className="rounded-lg border border-emerald-100 bg-emerald-50 p-4"><p className="text-xs font-bold text-emerald-700">واردة (صفحة الحالية)</p><p className="mt-1 text-2xl font-black tabular-nums text-emerald-700">{increases.toLocaleString("ar-JO")}</p></div>
        <div className="rounded-lg border border-red-100 bg-red-50 p-4"><p className="text-xs font-bold text-red-700">صادرة (صفحة الحالية)</p><p className="mt-1 text-2xl font-black tabular-nums text-red-700">{decreases.toLocaleString("ar-JO")}</p></div>
      </section>

      <section className="grid gap-5 xl:grid-cols-[360px_minmax(0,1fr)]">
        <form onSubmit={(event) => { event.preventDefault(); void saveAdjustment(); }} className="h-fit space-y-4 rounded-lg border border-border bg-white p-5 shadow-sm">
          <div><h2 className="text-base font-black">تسجيل تسوية</h2><p className="mt-1 text-xs font-semibold text-muted">كل تعديل يحتاج سبباً ويُسجّل باسم المدير</p></div>
          <div className="grid grid-cols-4 gap-1 rounded-lg bg-surface-muted p-1">
            {([
              ["IN", "إضافة"], ["OUT", "سحب"], ["COUNT", "جرد"], ["DAMAGE", "تالف"],
            ] as Array<[AdjustmentMode, string]>).map(([value, label]) => (
              <button key={value} type="button" onClick={() => { setMode(value); if (value === "COUNT") setBarcode(""); }} className={`h-9 rounded-md text-xs font-black transition ${mode === value ? "bg-white text-primary shadow-sm" : "text-muted"}`}>{label}</button>
            ))}
          </div>

          <AsyncProductCombobox id="movement-product" label="المنتج" value={productId} selectedLabel={selectedProduct?.name} placeholder="اختر المنتج" required onChange={(product) => { setProductId(product.id); setSelectedProduct(product); setBarcode(""); }} />

          {mode !== "COUNT" && selectedProduct && (
            <label className="block text-sm font-bold text-muted">الباركود / الوحدة
              <select value={barcode} onChange={(event) => setBarcode(event.target.value)} className="mt-1.5 h-11 w-full rounded-lg border border-border bg-white px-3 text-sm font-bold outline-none focus:border-primary">
                <option value="">{selectedProduct.baseUnit} بدون باركود</option>
                {selectedProduct.barcodes.map((entry) => (
                  <option key={entry.barcode} value={entry.barcode}>{[entry.variantLabel, entry.unitName, `×${quantity(entry.multiplier)}`, entry.barcode].filter(Boolean).join(" | ")}</option>
                ))}
              </select>
            </label>
          )}

          {selectedProduct && (
            <div className="rounded-lg border border-border bg-surface-muted px-3 py-2 text-xs font-bold text-muted">
              الرصيد الحالي: <span className="text-base font-black tabular-nums text-foreground">{quantity(selectedProduct.stock)} {selectedProduct.baseUnit}</span>
              {selectedBarcode && <span className="mt-1 block">الوحدة المختارة: {selectedBarcode.variantLabel ? `${selectedBarcode.variantLabel}، ` : ""}{selectedBarcode.unitName} = {quantity(selectedBarcode.multiplier)} {selectedProduct.baseUnit}</span>}
            </div>
          )}

          <label className="block text-sm font-bold text-muted">{mode === "COUNT" ? "الكمية الفعلية بوحدة الأساس" : "الكمية بالوحدة المختارة"}
            <input value={amount} onChange={(event) => { setAmount(event.target.value); }} type="number" min="0" step="0.001" dir="ltr" className="mt-1.5 h-12 w-full rounded-lg border border-border px-3 text-lg font-black tabular-nums outline-none focus:border-primary focus:ring-2 focus:ring-primary/20" />
          </label>
          <label className="block text-sm font-bold text-muted">السبب
            <textarea value={reason} onChange={(event) => { setReason(event.target.value); }} rows={3} maxLength={500} placeholder="مثال: فرق جرد فعلي بتاريخ اليوم" className="mt-1.5 w-full resize-none rounded-lg border border-border px-3 py-2.5 text-sm font-bold outline-none focus:border-primary focus:ring-2 focus:ring-primary/20" />
          </label>
          {error && <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm font-bold text-destructive">{error}</p>}
          {notice && <p className="rounded-md bg-success/10 px-3 py-2 text-sm font-bold text-success">{notice}</p>}
          <button type="submit" disabled={!productId || !amount || reason.trim().length < 3 || saving} className="flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-primary text-sm font-black text-primary-foreground disabled:opacity-40">
            {saving ? <Loader2 className="h-5 w-5 animate-spin" /> : <Save className="h-5 w-5" />} تسجيل الحركة
          </button>
        </form>

        <div className="min-w-0 overflow-hidden rounded-lg border border-border bg-white shadow-sm">
          <div className="grid gap-3 border-b border-border p-4 sm:grid-cols-[1fr_220px]">
            <AsyncProductCombobox id="movement-filter-product" label="تصفية حسب المنتج" value={filterProductId} selectedLabel={filterProductName} placeholder="كل المنتجات" onChange={(product) => { handleFilterProductChange(product.id, product.name); }} />
            <label className="block text-sm font-bold text-muted">نوع الحركة
              <select value={filterType} onChange={(event) => setFilterType(event.target.value)} className="mt-1.5 h-11 w-full rounded-lg border border-border bg-white px-3 text-sm font-bold outline-none focus:border-primary">
                <option value="">كل الحركات</option>
                {Object.entries(MOVEMENT_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
          </div>

          {loading ? (
            <div className="grid min-h-72 place-items-center text-sm font-bold text-muted"><div className="text-center"><Loader2 className="mx-auto mb-2 h-7 w-7 animate-spin text-primary" />جارٍ تحميل الحركات...</div></div>
          ) : movements.length === 0 ? (
            <div className="grid min-h-72 place-items-center px-6 text-center"><div><History className="mx-auto mb-3 h-10 w-10 text-muted" /><p className="font-black">لا توجد حركات مطابقة</p><p className="mt-1 text-xs font-semibold text-muted">ستظهر المبيعات والاستلامات والتسويات هنا</p></div></div>
          ) : (
            <>
              <div className="grid gap-2 p-3 md:hidden">
                {movements.map((movement) => <MovementCard key={movement.id} movement={movement} />)}
              </div>
              <div className="hidden overflow-x-auto md:block">
                <table className="w-full min-w-[920px] text-sm">
                  <thead className="bg-surface-muted text-right text-xs font-black text-muted"><tr><th className="px-4 py-3">الوقت</th><th className="px-4 py-3">المنتج</th><th className="px-4 py-3">العملية</th><th className="px-4 py-3">الباركود</th><th className="px-4 py-3">التغير</th><th className="px-4 py-3">الرصيد</th><th className="px-4 py-3">المستخدم والسبب</th></tr></thead>
                  <tbody>{movements.map((movement) => (
                    <tr key={movement.id} className="border-t border-border/70">
                      <td className="whitespace-nowrap px-4 py-3 text-xs font-semibold text-muted">{new Date(movement.occurred_at).toLocaleString("ar-JO")}</td>
                      <td className="px-4 py-3"><p className="font-black">{movement.product_name}</p>{movement.variant_label && <p className="text-xs font-bold text-primary">{movement.variant_label}</p>}</td>
                      <td className="px-4 py-3 font-bold">{MOVEMENT_LABELS[movement.movement_type] ?? movement.movement_type}</td>
                      <td className="px-4 py-3 text-xs"><span dir="ltr" className="font-mono">{movement.barcode ?? "—"}</span><span className="block text-muted">{movement.unit_name}</span></td>
                      <td className="px-4 py-3"><span className={`inline-flex rounded-full px-2.5 py-1 font-black tabular-nums ${movementTone(Number(movement.quantity_delta))}`}>{Number(movement.quantity_delta) > 0 ? "+" : ""}{quantity(movement.quantity_delta)}</span></td>
                      <td className="px-4 py-3 font-black tabular-nums">{quantity(movement.balance_after)} {movement.base_unit}</td>
                      <td className="max-w-56 px-4 py-3"><p className="truncate text-xs font-bold">{movement.actor_name || "النظام"}</p><p className="truncate text-xs text-muted" title={movement.reason}>{movement.reason || "—"}</p></td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
              <ListPagination
                page={safePage}
                totalPages={totalPages}
                total={total}
                pageSize={pageSize}
                onPageChange={setPage}
                pageSizeOptions={[10, 25, 50, 100, 200, 300]}
                onPageSizeChange={(size) => {
                  setPageSize(size);
                  setPage(1);
                }}
              />
            </>
          )}
        </div>
      </section>
    </div>
  );
}

function MovementCard({ movement }: { movement: InventoryMovement }) {
  const delta = Number(movement.quantity_delta);
  const Icon = movement.movement_type === "DAMAGE" ? AlertTriangle : delta > 0 ? ArrowDownToLine : movement.movement_type === "STOCKTAKE" ? ClipboardCheck : ArrowUpFromLine;
  return (
    <article className="rounded-lg border border-border p-3">
      <div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="truncate font-black">{movement.product_name}</p><p className="mt-0.5 text-xs font-bold text-muted">{MOVEMENT_LABELS[movement.movement_type] ?? movement.movement_type}{movement.variant_label ? ` • ${movement.variant_label}` : ""}</p></div><span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs font-black tabular-nums ${movementTone(delta)}`}><Icon className="h-3.5 w-3.5" />{delta > 0 ? "+" : ""}{quantity(delta)}</span></div>
      <div className="mt-3 flex items-end justify-between gap-3 text-xs"><div className="min-w-0 text-muted"><p className="truncate">{movement.reason || "دون ملاحظة"}</p><p className="mt-0.5">{new Date(movement.occurred_at).toLocaleString("ar-JO")} • {movement.actor_name || "النظام"}</p></div><p className="shrink-0 font-black tabular-nums">الرصيد {quantity(movement.balance_after)}</p></div>
    </article>
  );
}
