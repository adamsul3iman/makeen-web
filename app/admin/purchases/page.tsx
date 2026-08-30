"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Ban,
  CheckCircle2,
  Package,
  PackageCheck,
  Pencil,
  Plus,
  Printer,
  RefreshCw,
  ScanLine,
  Truck,
} from "lucide-react";
import { ListPagination } from "@/components/admin/ListPagination";
import { SearchInput } from "@/components/admin/SearchInput";
import type { AsyncProductOption } from "@/components/admin/AsyncProductCombobox";
import POBuilderModal, { type POBuilderItem } from "@/components/admin/POBuilderModal";
import ReconciliationModal from "@/components/admin/ReconciliationModal";
import PurchaseOrderPrint from "@/components/admin/PurchaseOrderPrint";
import LineCard, { type LineInput } from "@/components/admin/PurchasesLineCard";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { usePurchasesScanner } from "@/hooks/usePurchasesScanner";
import { normalizeArabicText } from "@/lib/arabic";
import { formatMoney } from "@/lib/format";
import { emitPosSound } from "@/lib/posSound";
import type { PurchaseOrderDetail } from "@/lib/purchasesClient";
import {
  createPurchaseOrder,
  fetchPurchaseOrderDetail,
  fetchPurchaseOrders,
  updatePurchaseOrderItems,
} from "@/lib/purchasesClient";
import { getSupabaseBrowser } from "@/lib/supabaseBrowser";
import { getTenantStoreId } from "@/lib/tenantClient";
import {
  createSupplier as createSupplierApi,
  fetchSupplierInvoices,
  fetchSuppliers,
} from "@/lib/suppliersClient";
import EntityCombobox from "@/components/shared/EntityCombobox";
import QuickCreateEntityModal from "@/components/shared/QuickCreateEntityModal";
import { usePosStore } from "@/store/usePosStore";
import type { LocalUnit } from "@/types/pos.types";

/**
 * A purchase order or a goods-in supplier invoice. The legacy PO flow writes
 * `purchase_orders`; the mobile receiving module commits `supplier_invoices`
 * (the same economic event through a different table). Both are surfaced here
 * so a receiving commit is never invisible in the admin purchases list.
 */
interface PurchasesRow {
  id: string;
  source: "po" | "invoice";
  supplierName: string;
  totalAmount: number;
  status: "pending" | "received";
  itemCount: number;
  createdAt: string;
}

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

const RECEIVED_PO_STATUSES = new Set(["received", "RECEIVED"]);

function makeKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `line-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function emptyLine(): LineInput {
  return {
    key: makeKey(),
    productId: "",
    productName: "",
    quantity: "1",
    qtyInUnit: 1,
    unitMultiplier: 1,
    unitCost: "",
    taxPercent: "16",
    taxIncluded: true,
    baseCost: null,
    basePrice: null,
    newSellingPrice: "",
  };
}

/** Item counts for the listed purchase orders (lightweight lookup instead of an embed). */
async function fetchPoItemCounts(orderIds: string[]): Promise<Map<string, number>> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  const counts = new Map<string, number>();
  if (!sb || !storeId || orderIds.length === 0) return counts;
  const { data } = await sb
    .from("purchase_order_items")
    .select("purchase_order_id")
    .eq("store_id", storeId)
    .in("purchase_order_id", orderIds);
  for (const row of (data ?? []) as Array<{ purchase_order_id: string }>) {
    counts.set(row.purchase_order_id, (counts.get(row.purchase_order_id) ?? 0) + 1);
  }
  return counts;
}

export default function AdminPurchasesPage() {
  const adminEmail = usePosStore((state) => state.adminSession?.email ?? "");
  const [orders, setOrders] = useState<PurchasesRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [suppliers, setSuppliers] = useState<{ id: string; name: string }[]>([]);
  const [supplierId, setSupplierId] = useState("");
  const [addingSupplier, setAddingSupplier] = useState(false);
  const [lines, setLines] = useState<LineInput[]>([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<PurchaseOrderDetail | null>(null);
  const [printDetail, setPrintDetail] = useState<PurchaseOrderDetail | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [q, setQ] = useState("");
  const debouncedQ = useDebouncedValue(q.trim(), 300);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [reconcileOpen, setReconcileOpen] = useState(false);
  const [reconcilePoId, setReconcilePoId] = useState<string | null>(null);
  const [reconcilePoNumber, setReconcilePoNumber] = useState<string | null>(null);
  const [manualCode, setManualCode] = useState("");
  const [scannerRecent, setScannerRecent] = useState<string | null>(null);

  const scanInputRef = useRef<HTMLInputElement>(null);

  // Cache-resident scans resolve without any network fetch, so the hot path
  // reads directly from the zustand store snapshot (same O(1) index as POS).
  const handleScan = useCallback((code: string): void => {
    const store = usePosStore.getState();
    const lookup = store.barcodeIndex[code];
    setScannerRecent(lookup ? lookup.name : code);
    if (!lookup) {
      emitPosSound("ERROR");
      setError("رمز الباركود غير معروف — تحقق من الكود");
      return;
    }
    const product = store.products[lookup.product_id];
    const multiplier = lookup.qtyMultiplier && lookup.qtyMultiplier > 0 ? lookup.qtyMultiplier : 1;
    const unitId = lookup.unitId ?? null;
    const unitName = lookup.unitName ?? product?.baseUnit;
    const variantId = lookup.variantId ?? null;
    const variantLabel = lookup.variantLabel;

    setLines((prev) => {
      const existingIdx = prev.findIndex(
        (l) =>
          l.productId === lookup.product_id &&
          (l.variantId ?? null) === (variantId ?? null) &&
          (l.unitId ?? null) === (unitId ?? null),
      );
      if (existingIdx >= 0) {
        const next = prev.slice();
        const cur = next[existingIdx];
        const qtyInUnit =
          (cur.qtyInUnit ?? Math.round((parseInt(cur.quantity, 10) || 0) / (cur.unitMultiplier || 1))) + 1;
        next[existingIdx] = {
          ...cur,
          unitMultiplier: multiplier,
          unitName,
          unitId,
          variantId,
          variantLabel,
          qtyInUnit,
          quantity: String(round2(qtyInUnit * multiplier)),
        };
        return next;
      }
      const baseName = product?.name ?? lookup.name;
      const name =
        variantLabel && variantLabel !== "—" ? `${baseName} — ${variantLabel}` : baseName;
      const newLine: LineInput = {
        key: makeKey(),
        productId: lookup.product_id,
        productName: name,
        quantity: String(multiplier),
        qtyInUnit: 1,
        unitMultiplier: multiplier,
        unitCost:
          product?.costPrice != null && product.costPrice > 0 ? String(product.costPrice) : "",
        taxPercent: product?.taxPercent != null ? String(product.taxPercent) : "16",
        taxIncluded: product?.taxIncluded ?? true,
        baseCost: product?.costPrice ?? null,
        basePrice: product?.price ?? null,
        newSellingPrice: "",
        variantId,
        variantLabel,
        unitId,
        unitName,
      };
      return [...prev, newLine];
    });
    emitPosSound("SCAN_ACCEPTED");
  }, []);

  usePurchasesScanner(handleScan);

  useEffect(() => {
    scanInputRef.current?.focus();
  }, []);

  useEffect(() => {
    let alive = true;
    Promise.all([
      fetchPurchaseOrders()
        .then(async ({ orders }) => {
          const itemCounts = await fetchPoItemCounts(orders.map((o) => o.id));
          return orders.map(
            (o): PurchasesRow => ({
              id: o.id,
              source: "po",
              supplierName: o.supplier_name,
              totalAmount: o.total_amount,
              status: RECEIVED_PO_STATUSES.has(o.status) ? "received" : "pending",
              itemCount: itemCounts.get(o.id) ?? 0,
              createdAt: o.created_at,
            }),
          );
        })
        .catch(() => []),
      fetchSupplierInvoices({})
        .then(({ invoices }) =>
          invoices.map(
            (inv): PurchasesRow => ({
              id: inv.id,
              source: "invoice",
              supplierName: inv.supplierName || "—",
              totalAmount: inv.totalAmount,
              status: "received",
              itemCount: 0,
              createdAt: inv.createdAt ?? new Date().toISOString(),
            }),
          ),
        )
        .catch(() => []),
    ])
      .then(([poRows, invoiceRows]) => {
        if (!alive) return;
        const merged = [...poRows, ...invoiceRows].sort((a, b) =>
          b.createdAt.localeCompare(a.createdAt),
        );
        setOrders(merged);
      })
      .catch(() => setError("تعذر تحميل أوامر الشراء"))
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [refreshKey]);

  const refresh = () => setRefreshKey((k) => k + 1);

  useEffect(() => {
    fetchSuppliers()
      .then((rows) => setSuppliers(rows.map((s) => ({ id: s.id, name: s.name }))))
      .catch(() => {
        setError("تعذر تحميل الموردين");
      });
  }, []);

  // Drop the hidden print document after the dialog closes so a later
  // window.print() elsewhere on this page cannot reprint a stale PO.
  useEffect(() => {
    if (!printDetail) return;
    const clearPrint = () => setPrintDetail(null);
    window.addEventListener("afterprint", clearPrint);
    return () => window.removeEventListener("afterprint", clearPrint);
  }, [printDetail]);

  const addLine = () => {
    setLines((prev) => [...prev, emptyLine()]);
  };

  const handleBuilderConfirm = (items: POBuilderItem[]) => {
    const newLines: LineInput[] = items.map((item) => ({
      key: makeKey(),
      productId: item.productId,
      productName:
        item.variantLabel !== "—" ? `${item.productName} — ${item.variantLabel}` : item.productName,
      quantity: String(item.quantity),
      unitCost: String(item.unitCost),
      taxPercent: "16",
      taxIncluded: true,
      baseCost: item.unitCost,
      basePrice: null,
      newSellingPrice: item.newSellingPrice != null ? String(item.newSellingPrice) : "",
      variantId: item.variantId,
      variantLabel: item.variantLabel,
      unitId: item.unitId,
      unitName: item.unitName,
      unitMultiplier: item.unitMultiplier,
      qtyInUnit: item.qtyInUnit,
    }));
    setLines((prev) => [...prev, ...newLines]);
  };

  const updateLine = useCallback((key: string, patch: Partial<LineInput> | ((line: LineInput) => Partial<LineInput>)) => {
    setLines((prev) =>
      prev.map((line) => (line.key === key ? { ...line, ...(typeof patch === "function" ? patch(line) : patch) } : line)),
    );
  }, []);

  const removeLine = useCallback((key: string) => {
    setLines((prev) => prev.filter((line) => line.key !== key));
  }, []);

  const handleProductPicked = useCallback((key: string, product: AsyncProductOption) => {
    updateLine(key, {
      productId: product.id,
      productName: product.name,
      unitId: null,
      unitName: undefined,
      unitMultiplier: 1,
      qtyInUnit: 1,
      unitCost: product.costPrice != null && product.costPrice > 0 ? String(product.costPrice) : "",
      baseCost: product.costPrice ?? null,
      basePrice: product.sellingPrice ?? null,
    });
  }, [updateLine]);

  const setQtyInUnit = useCallback((key: string, raw: string) => {
    updateLine(key, (line) => {
      const qtyInUnit = parseFloat(raw);
      const m = line.unitMultiplier && line.unitMultiplier > 0 ? line.unitMultiplier : 1;
      const count = Number.isFinite(qtyInUnit) && qtyInUnit > 0 ? Math.round(qtyInUnit * 100) / 100 : 0;
      return { ...line, qtyInUnit: count, quantity: String(round2(count * m)) };
    });
  }, [updateLine]);

  const switchLineUnit = useCallback((key: string, unit: LocalUnit | null) => {
    updateLine(key, (line) => {
      const currentBase = parseInt(line.quantity, 10) || (line.qtyInUnit ?? 1) * (line.unitMultiplier || 1);
      const multiplier = unit ? unit.qtyMultiplier : 1;
      const qtyInUnit = multiplier >= 1 && currentBase > 0 ? Math.ceil(currentBase / multiplier) : 1;
      return {
        ...line,
        ...(unit
          ? { unitId: unit.id, unitName: unit.unitName, unitMultiplier: multiplier, qtyInUnit }
          : { unitId: null, unitName: undefined, unitMultiplier: 1, qtyInUnit: currentBase }),
        quantity: String(round2(qtyInUnit * multiplier)),
      };
    });
  }, [updateLine]);

  const setUnitCost = useCallback((key: string, raw: string) => {
    updateLine(key, { unitCost: raw });
  }, [updateLine]);

  const setSelling = useCallback((key: string, raw: string) => {
    updateLine(key, { newSellingPrice: raw });
  }, [updateLine]);

  const setTaxPercent = useCallback((key: string, raw: string) => {
    updateLine(key, { taxPercent: raw });
  }, [updateLine]);

  const setTaxIncluded = useCallback((key: string, included: boolean) => {
    updateLine(key, { taxIncluded: included });
  }, [updateLine]);

  const submitManualScan = () => {
    const code = manualCode.trim();
    if (!code) return;
    handleScan(code);
    setManualCode("");
    scanInputRef.current?.focus();
  };

  const poTotal = round2(
    lines.reduce((acc, line) => {
      const qty = parseInt(line.quantity, 10) || 0;
      const cost = parseFloat(line.unitCost) || 0;
      return acc + qty * cost;
    }, 0),
  );

  const validLines = lines.filter(
    (line) =>
      line.productId &&
      parseInt(line.quantity, 10) > 0 &&
      (line.unitCost === "" || parseFloat(line.unitCost) >= 0),
  );
  const canSubmit =
    supplierId.trim() !== "" && lines.length > 0 && validLines.length === lines.length && !saving;

  const resetForm = () => {
    setEditing(null);
    setSupplierId("");
    setLines([]);
    setError("");
  };

  const createSupplier = async (data: { name: string; phone: string }) => {
    const supplier = await createSupplierApi({ name: data.name, phone: data.phone });
    setSuppliers((current) =>
      [...current, { id: supplier.id, name: supplier.name }].sort((a, b) =>
        a.name.localeCompare(b.name, "ar"),
      ),
    );
    setSupplierId(supplier.id);
    setAddingSupplier(false);
  };

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setError("");
    setSaving(true);
    try {
      const items = validLines.map((line) => ({
        product_id: line.productId,
        quantity: parseInt(line.quantity, 10) || 0,
        unit_cost: parseFloat(line.unitCost) || 0,
        // Empty tax% falls back to the 16% Jordan default server-side; a blank
        // field means "use default", never an unintended 0% exemption.
        tax_percent: line.taxPercent === "" ? undefined : parseFloat(line.taxPercent) || 0,
        tax_included: line.taxIncluded,
        new_selling_price: parseFloat(line.newSellingPrice) || undefined,
        variant_id: line.variantId || undefined,
        unit_id: line.unitId || undefined,
        qty_in_unit: line.qtyInUnit || undefined,
      }));
      if (editing) {
        await updatePurchaseOrderItems(editing.order.id, { supplier_id: supplierId, items });
        resetForm();
      } else {
        await createPurchaseOrder({ supplier_id: supplierId, items });
        setSupplierId("");
        setLines([]);
      }
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "تعذر حفظ أمر الشراء — تحقق من الاتصال");
    } finally {
      setSaving(false);
    }
  };

  const startEdit = async (row: PurchasesRow) => {
    setError("");
    try {
      const detail = await fetchPurchaseOrderDetail(row.id);
      if (RECEIVED_PO_STATUSES.has(detail.order.status)) {
        setError("أمر الشراء مستلم بالفعل ولا يمكن تعديله");
        return;
      }
      setEditing(detail);
      setSupplierId(detail.order.supplier_id);
      setLines(
        detail.items.map((item) => ({
          key: item.id || makeKey(),
          productId: item.product_id ?? "",
          productName: item.productName,
          quantity: String(item.quantity),
          qtyInUnit: item.quantity,
          unitMultiplier: 1,
          unitCost: String(item.unit_cost),
          taxPercent: String(item.tax_percent ?? 16),
          taxIncluded: item.tax_included ?? true,
          baseCost: item.unit_cost,
          basePrice: null,
          newSellingPrice: item.new_selling_price != null ? String(item.new_selling_price) : "",
        })),
      );
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "تعذر تحميل أمر الشراء للتعديل");
    }
  };

  const handleReceive = async (id: string) => {
    setReconcilePoId(id);
    const row = orders.find((o) => o.id === id);
    setReconcilePoNumber(row?.source === "po" ? id.slice(0, 8) : null);
    setReconcileOpen(true);
  };

  const handlePrint = async (row: PurchasesRow) => {
    setError("");
    try {
      const detail = await fetchPurchaseOrderDetail(row.id);
      setPrintDetail(detail);
      // Two frames so the hidden document paints before the print dialog.
      requestAnimationFrame(() => requestAnimationFrame(() => window.print()));
    } catch (err) {
      setError(err instanceof Error ? err.message : "تعذر تجهيز الطباعة");
    }
  };

  const pendingCount = orders.filter((o) => o.status === "pending").length;
  const receivedValue = round2(
    orders.filter((o) => o.status === "received").reduce((acc, o) => acc + o.totalAmount, 0),
  );
  const productUnits = usePosStore((s) => s.productUnits);

  const filteredOrders = useMemo(() => {
    const needle = normalizeArabicText(debouncedQ);
    if (!needle) return orders;
    return orders.filter((o) => normalizeArabicText(o.supplierName).includes(needle));
  }, [orders, debouncedQ]);

  const totalPages = Math.max(1, Math.ceil(filteredOrders.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pagedOrders = filteredOrders.slice((safePage - 1) * pageSize, safePage * pageSize);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-black text-foreground">أوامر الشراء والاستلام</h1>
        <p className="mt-1 text-sm font-semibold text-muted">
          إنشاء أوامر شراء من الموردين، ثم استلامها لزيادة المخزون وتحديث التكلفة وأسعار البيع وفتح ذمة المورد
        </p>
      </header>

      <section className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        <div className="rounded-2xl border border-border bg-surface p-4">
          <p className="flex items-center gap-1 text-xs font-bold text-muted">
            <Truck className="h-3.5 w-3.5" /> أوامر معلقة
          </p>
          <p className="mt-1 text-2xl font-black tabular-nums text-amber-600">{pendingCount}</p>
        </div>
        <div className="rounded-2xl border border-border bg-surface p-4">
          <p className="flex items-center gap-1 text-xs font-bold text-muted">
            <PackageCheck className="h-3.5 w-3.5" /> قيمة المشتريات المستلمة
          </p>
          <p className="mt-1 text-2xl font-black tabular-nums text-success">
            {formatMoney(receivedValue)}
          </p>
        </div>
      </section>

      <section className="grid gap-6 lg:grid-cols-3">
        <form
          className="h-fit space-y-4 rounded-2xl border border-border bg-surface p-5 shadow-sm lg:col-span-1"
          onSubmit={(e) => {
            e.preventDefault();
            void handleSubmit();
          }}
        >
          {editing ? (
            <div className="flex items-center justify-between gap-2 rounded-xl bg-amber-50 px-3 py-2.5">
              <p className="text-xs font-black text-amber-700">
                تعديل أمر الشراء {editing.order.order_number || editing.order.id.slice(0, 8)} — لم يُستلم بعد
              </p>
              <button
                type="button"
                onClick={resetForm}
                aria-label="إلغاء التعديل"
                className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-amber-700 transition hover:bg-amber-100"
              >
                <Ban className="h-4 w-4" />
              </button>
            </div>
          ) : (
            <h2 className="text-lg font-black text-foreground">أمر شراء جديد</h2>
          )}

          <div className="rounded-xl border border-border bg-white">
            <label className="flex items-center gap-2 px-3 pt-3 pb-1 text-xs font-bold text-muted">
              <ScanLine className="h-3.5 w-3.5 text-primary" />
              ماسح الباركود — امسح لإضافة البند مباشرة
            </label>
            <div className="flex items-center gap-2 px-3 pb-3">
              <input
                ref={scanInputRef}
                type="text"
                value={manualCode}
                onChange={(e) => setManualCode(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    submitManualScan();
                  }
                }}
                placeholder="امسح الباركود أو اكتبه واضغط Enter…"
                dir="ltr"
                className="h-11 w-full rounded-lg border border-border bg-white px-3 text-sm font-bold tabular-nums outline-none focus:border-primary"
              />
              <button
                type="button"
                onClick={submitManualScan}
                aria-label="إضافة المسح"
                className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground transition hover:bg-primary-hover"
              >
                <ScanLine className="h-5 w-5" />
              </button>
            </div>
            {scannerRecent && (
              <p className="px-3 pb-3 text-[11px] font-bold text-muted">
                آخر مسح: <span className="text-foreground">{scannerRecent}</span>
              </p>
            )}
          </div>

          <EntityCombobox
            id="po-supplier"
            label="المورد"
            value={supplierId}
            options={suppliers}
            placeholder="اختر المورد"
            emptyLabel="لا يوجد مورد مطابق"
            addLabel="إضافة مورد جديد"
            onChange={setSupplierId}
            onAdd={() => setAddingSupplier(true)}
            required
          />

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-sm font-bold text-muted">البنود ({lines.length})</p>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={addLine}
                  className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs font-bold text-muted transition hover:bg-surface-muted"
                >
                  <Plus className="h-3.5 w-3.5" />
                  يدوياً
                </button>
                <button
                  type="button"
                  onClick={() => setBuilderOpen(true)}
                  className="inline-flex items-center gap-1 rounded-lg bg-primary px-2.5 py-1.5 text-xs font-black text-primary-foreground transition hover:bg-primary-hover"
                >
                  <Package className="h-3.5 w-3.5" />
                  إضافة أصناف
                </button>
              </div>
            </div>
            {lines.map((line) => (
              <LineCard
                key={line.key}
                line={line}
                units={productUnits[line.productId] ?? []}
                onProductPicked={handleProductPicked}
                onQtyChange={setQtyInUnit}
                onUnitCostChange={setUnitCost}
                onSellingChange={setSelling}
                onTaxPercentChange={setTaxPercent}
                onTaxIncludedChange={setTaxIncluded}
                onSwitchUnit={switchLineUnit}
                onRemove={removeLine}
              />
            ))}
            {lines.length === 0 && (
              <p className="rounded-xl border border-dashed border-border px-3 py-4 text-center text-xs font-semibold text-muted">
                لا بنود بعد — امسح باركوداً أو أضف صنفاً واحداً على الأقل
              </p>
            )}
          </div>

          <div className="flex items-center justify-between rounded-xl bg-surface-muted px-4 py-3">
            <span className="text-sm font-bold text-muted">إجمالي الأمر</span>
            <span className="text-xl font-black tabular-nums">{formatMoney(poTotal)}</span>
          </div>

          {error && <p className="text-sm font-bold text-destructive">{error}</p>}

          <button
            type="submit"
            disabled={!canSubmit}
            className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-primary text-base font-black text-primary-foreground transition hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving ? (
              "جارٍ الحفظ…"
            ) : editing ? (
              <>
                <Pencil className="h-5 w-5" />
                حفظ التعديل
              </>
            ) : (
              <>
                <Plus className="h-5 w-5" />
                إنشاء أمر الشراء
              </>
            )}
          </button>
          <p className="text-[11px] font-semibold leading-4 text-muted">
            إنشاء الأمر مسودة فقط — لا يؤثر على المخزون. عند الضغط على «استلام» تُضاف الكميات وتتحدث التكلفة وأسعار البيع وتُفتح فاتورة المورد في الذمم تلقائياً.
          </p>
        </form>

        <section className="overflow-hidden rounded-2xl border border-border bg-surface shadow-sm lg:col-span-2">
          <div className="flex flex-col gap-3 border-b border-border px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
            <h2 className="text-base font-black text-foreground">سجل أوامر الشراء</h2>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <SearchInput
                value={q}
                onChange={(value) => {
                  setQ(value);
                  setPage(1);
                }}
                placeholder="ابحث باسم المورد…"
                className="sm:w-56"
              />
              <button
                type="button"
                onClick={refresh}
                className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-black text-primary transition hover:bg-primary/10"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                تحديث
              </button>
            </div>
          </div>
          {loading ? (
            <p className="px-5 py-8 text-center text-sm font-semibold text-muted">جارٍ التحميل…</p>
          ) : (
            <div className="scrollbar-hidden overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-surface-muted text-right text-xs font-black text-muted">
                    <th className="px-5 py-3">التاريخ</th>
                    <th className="px-5 py-3">المورد</th>
                    <th className="px-5 py-3">البنود</th>
                    <th className="px-5 py-3">الإجمالي</th>
                    <th className="px-5 py-3">الحالة</th>
                    <th className="px-5 py-3">إجراءات</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedOrders.map((o) => {
                    const isEditablePo = o.source === "po" && o.status === "pending";
                    return (
                      <tr key={o.id} className="border-b border-border/60 text-right">
                        <td className="px-5 py-3 font-bold text-foreground">
                          {new Date(o.createdAt).toLocaleDateString("en-US", {
                            day: "2-digit",
                            month: "2-digit",
                            year: "numeric",
                          })}
                        </td>
                        <td className="px-5 py-3 text-muted">
                          {o.supplierName}
                          {o.source === "invoice" && (
                            <span className="ms-2 rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-black text-blue-700">
                              استلام
                            </span>
                          )}
                        </td>
                        <td className="px-5 py-3 tabular-nums text-muted">{o.itemCount}</td>
                        <td className="px-5 py-3 font-black tabular-nums">{formatMoney(o.totalAmount)}</td>
                        <td className="px-5 py-3">
                          <span
                            className={`rounded-full px-2.5 py-1 text-xs font-black ${
                              o.status === "received"
                                ? "bg-success/10 text-success"
                                : "bg-amber-100 text-amber-700"
                            }`}
                          >
                            {o.status === "received" ? "مستلم" : "معلق"}
                          </span>
                        </td>
                        <td className="px-5 py-3">
                          <div className="flex items-center justify-end gap-1">
                            {isEditablePo && (
                              <>
                                <button
                                  type="button"
                                  onClick={() => void startEdit(o)}
                                  title="تعديل — متاح قبل الاستلام فقط"
                                  className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs font-black text-primary transition hover:bg-primary/10"
                                >
                                  <Pencil className="h-3.5 w-3.5" />
                                  تعديل
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void handleReceive(o.id)}
                                  className="inline-flex items-center gap-1 rounded-lg bg-success px-2.5 py-1.5 text-xs font-black text-success-foreground transition hover:bg-success-hover disabled:opacity-40"
                                >
                                  <CheckCircle2 className="h-3.5 w-3.5" />
                                  استلام
                                </button>
                              </>
                            )}
                            {o.source === "po" && (
                              <button
                                type="button"
                                onClick={() => void handlePrint(o)}
                                title="طباعة أمر الشراء"
                                className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs font-black text-muted transition hover:bg-surface-muted hover:text-foreground"
                              >
                                <Printer className="h-3.5 w-3.5" />
                                طباعة
                              </button>
                            )}
                            {!isEditablePo && o.source !== "po" && (
                              <span className="text-xs font-semibold text-muted">—</span>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                  {orders.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-5 py-8 text-center text-sm font-semibold text-muted">
                        لا توجد أوامر شراء بعد
                      </td>
                    </tr>
                  )}
                  {orders.length > 0 && filteredOrders.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-5 py-8 text-center text-sm font-semibold text-muted">
                        لا أوامر شراء مطابقة للبحث
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
          <ListPagination
            page={safePage}
            totalPages={totalPages}
            total={filteredOrders.length}
            pageSize={pageSize}
            onPageChange={setPage}
            onPageSizeChange={(size) => {
              setPageSize(size);
              setPage(1);
            }}
          />
          <footer className="border-t border-border px-5 py-3 text-xs font-semibold text-muted">
            التعديل متاح قبل الاستلام فقط — الاستلام نهائي: يحدّث المخزون وسجل الحركات والتكلفة وأسعار البيع ويولّد فاتورة المورد في الذمم
          </footer>
        </section>
      </section>

      {printDetail && <PurchaseOrderPrint detail={printDetail} />}

      {addingSupplier && (
        <QuickCreateEntityModal
          title="إضافة مورد جديد"
          nameLabel="اسم المورد"
          namePlaceholder="مثال: شركة الأمانة"
          withPhone
          onClose={() => setAddingSupplier(false)}
          onCreate={createSupplier}
        />
      )}

      {builderOpen && (
        <POBuilderModal
          open={builderOpen}
          onClose={() => setBuilderOpen(false)}
          onConfirm={handleBuilderConfirm}
        />
      )}

      {reconcileOpen && reconcilePoId && (
        <ReconciliationModal
          open={reconcileOpen}
          poId={reconcilePoId}
          poNumber={reconcilePoNumber}
          actorName={adminEmail}
          onClose={() => {
            setReconcileOpen(false);
            setReconcilePoId(null);
            setReconcilePoNumber(null);
          }}
          onConfirmed={() => {
            setReconcileOpen(false);
            setReconcilePoId(null);
            setReconcilePoNumber(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}
