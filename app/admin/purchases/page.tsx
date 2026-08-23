"use client";

import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, PackageCheck, Plus, RefreshCw, Trash2, Truck } from "lucide-react";
import { ListPagination } from "@/components/admin/ListPagination";
import { SearchInput } from "@/components/admin/SearchInput";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { normalizeArabicText } from "@/lib/arabic";
import { formatMoney } from "@/lib/format";
import {
  createPurchaseOrder,
  fetchPurchaseOrders,
  receivePurchaseOrder,
} from "@/lib/purchasesClient";
import { getSupabaseBrowser } from "@/lib/supabaseBrowser";
import {
  createSupplier as createSupplierApi,
  fetchSupplierInvoices,
  fetchSuppliers,
} from "@/lib/suppliersClient";
import { getTenantStoreId } from "@/lib/tenantClient";
import EntityCombobox from "@/components/shared/EntityCombobox";
import QuickCreateEntityModal from "@/components/shared/QuickCreateEntityModal";
import { usePosStore } from "@/store/usePosStore";

interface LineInput {
  productId: string;
  productName: string;
  quantity: string;
  unitCost: string;
}

interface ProductOption {
  id: string;
  name: string;
  costPrice?: number;
}

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
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [suppliers, setSuppliers] = useState<{ id: string; name: string }[]>([]);
  const [supplierId, setSupplierId] = useState("");
  const [addingSupplier, setAddingSupplier] = useState(false);
  const [lines, setLines] = useState<LineInput[]>([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [receivingId, setReceivingId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [q, setQ] = useState("");
  const debouncedQ = useDebouncedValue(q.trim(), 300);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

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
    const loadCatalogProducts = async () => {
      const sb = getSupabaseBrowser();
      const storeId = getTenantStoreId();
      if (!sb || !storeId) return;
      const { data } = await sb
        .from("products")
        .select("id,name,cost_price")
        .eq("store_id", storeId)
        .order("name", { ascending: true });
      setProducts(
        ((data ?? []) as Array<{ id: string; name: string; cost_price: number | string | null }>).map((p) => ({
          id: p.id,
          name: p.name,
          costPrice: Number(p.cost_price) || 0,
        })),
      );
    };
    loadCatalogProducts().catch(() => {
      /* keep empty product picker */
    });
    fetchSuppliers()
      .then((rows) => setSuppliers(rows.map((s) => ({ id: s.id, name: s.name }))))
      .catch(() => {
        setError("تعذر تحميل الموردين");
      });
  }, []);

  const addLine = () => {
    setLines((prev) => [
      ...prev,
      { productId: "", productName: "", quantity: "1", unitCost: "" },
    ]);
  };

  const updateLine = (index: number, patch: Partial<LineInput>) => {
    setLines((prev) => prev.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  };

  const removeLine = (index: number) => {
    setLines((prev) => prev.filter((_, i) => i !== index));
  };

  const poTotal = round2(
    lines.reduce((acc, line) => {
      const qty = parseInt(line.quantity, 10) || 0;
      const cost = parseFloat(line.unitCost) || 0;
      return acc + qty * cost;
    }, 0),
  );

  const canCreate = supplierId.trim() !== "" && lines.length > 0 && !saving;

  const createSupplier = async (data: { name: string; phone: string }) => {
    const supplier = await createSupplierApi({ name: data.name, phone: data.phone });
    setSuppliers((current) =>
      [...current, { id: supplier.id, name: supplier.name }].sort((a, b) => a.name.localeCompare(b.name, "ar")),
    );
    setSupplierId(supplier.id);
    setAddingSupplier(false);
  };

  const handleCreate = async () => {
    if (!canCreate) return;
    setError("");
    setSaving(true);
    try {
      const items = lines
        .map((line) => ({
          product_id: line.productId,
          quantity: parseInt(line.quantity, 10) || 0,
          unit_cost: parseFloat(line.unitCost) || 0,
        }))
        .filter((it) => it.product_id && it.quantity > 0 && it.unit_cost >= 0);
      if (items.length === 0) {
        setError("أضف بنوداً صالحة بأصناف وكماًيات ومبالغ");
        return;
      }
      await createPurchaseOrder({ supplier_id: supplierId, items });
      setSupplierId("");
      setLines([]);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "تعذر إنشاء أمر الشراء — تحقق من الاتصال");
    } finally {
      setSaving(false);
    }
  };

  const handleReceive = async (id: string) => {
    setReceivingId(id);
    setError("");
    try {
      await receivePurchaseOrder(id, { actorName: adminEmail });
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "تعذر استلام الأمر — تحقق من الاتصال");
    } finally {
      setReceivingId(null);
    }
  };

  const pendingCount = orders.filter((o) => o.status === "pending").length;
  const receivedValue = round2(
    orders.filter((o) => o.status === "received").reduce((acc, o) => acc + o.totalAmount, 0),
  );

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
          إنشاء أوامر شراء من الموردين واستلامها لزيادة المخزون وتحديث تكلفة الوحدة
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
            void handleCreate();
          }}
        >
          <h2 className="text-lg font-black text-foreground">أمر شراء جديد</h2>

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
              <p className="text-sm font-bold text-muted">البنود</p>
              <button
                type="button"
                onClick={addLine}
                className="inline-flex items-center gap-1 rounded-lg bg-primary px-2.5 py-1.5 text-xs font-black text-primary-foreground transition hover:bg-primary-hover"
              >
                <Plus className="h-3.5 w-3.5" />
                إضافة صنف
              </button>
            </div>
            {lines.map((line, i) => (
              <div key={i} className="rounded-xl border border-border bg-white p-3">
                <div className="flex items-start justify-between gap-2">
                  <select
                    value={line.productId}
                    onChange={(e) => {
                      const product = products.find((p) => p.id === e.target.value);
                      updateLine(i, {
                        productId: e.target.value,
                        productName: product?.name ?? "",
                        unitCost:
                          line.unitCost || (product?.costPrice ? String(product.costPrice) : ""),
                      });
                    }}
                    className="w-full rounded-lg border border-border bg-white px-3 py-2 text-sm font-bold outline-none focus:border-primary"
                  >
                    <option value="">الصنف…</option>
                    {products.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => removeLine(i)}
                    aria-label="حذف الصنف"
                    className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted transition hover:bg-destructive/10 hover:text-destructive"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <label className="block text-xs font-bold text-muted">
                    الكمية
                    <input
                      type="number"
                      min={1}
                      value={line.quantity}
                      onChange={(e) => updateLine(i, { quantity: e.target.value })}
                      className="mt-1 w-full rounded-lg border border-border bg-white px-3 py-2 text-sm font-bold tabular-nums outline-none focus:border-primary"
                    />
                  </label>
                  <label className="block text-xs font-bold text-muted">
                    تكلفة الوحدة
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      inputMode="decimal"
                      dir="ltr"
                      value={line.unitCost}
                      onChange={(e) => updateLine(i, { unitCost: e.target.value })}
                      className="mt-1 w-full rounded-lg border border-border bg-white px-3 py-2 text-left text-sm font-bold tabular-nums outline-none focus:border-primary"
                    />
                  </label>
                </div>
              </div>
            ))}
            {lines.length === 0 && (
              <p className="rounded-xl border border-dashed border-border px-3 py-4 text-center text-xs font-semibold text-muted">
                لا بنود بعد — أضف صنفاً واحداً على الأقل
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
            disabled={!canCreate}
            className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-primary text-base font-black text-primary-foreground transition hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving ? (
              "جارٍ الإنشاء…"
            ) : (
              <>
                <Plus className="h-5 w-5" />
                إنشاء أمر الشراء
              </>
            )}
          </button>
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
                    <th className="px-5 py-3"></th>
                  </tr>
                </thead>
                <tbody>
                  {pagedOrders.map((o) => (
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
                      <td className="px-5 py-3 text-left">
                        {o.status === "pending" && o.source === "po" ? (
                          <button
                            type="button"
                            onClick={() => void handleReceive(o.id)}
                            disabled={receivingId === o.id}
                            className="inline-flex items-center gap-1 rounded-lg bg-success px-2.5 py-1.5 text-xs font-black text-success-foreground transition hover:bg-success-hover disabled:opacity-40"
                          >
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            {receivingId === o.id ? "جارٍ الاستلام…" : "استلام"}
                          </button>
                        ) : (
                          <span className="text-xs font-semibold text-muted">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
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
            استلام أمر الشراء يزيد كميات المنتجات ويحدّث تكلفة الوحدة تلقائياً — فواتير الاستلام من جهاز الكاشير تظهر هنا أيضاً
          </footer>
        </section>
      </section>
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
    </div>
  );
}
