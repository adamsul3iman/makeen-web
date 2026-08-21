"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Filter,
  Package,
  RefreshCw,
  Truck,
} from "lucide-react";
import ShortageAccordion, {
  type CategoryGroup,
  type BrandGroup,
  type ProductGroup,
} from "@/components/admin/shortages/ShortageAccordion";
import {
  computeShortageRadar,
  groupShortagesBySupplier,
  buildShortageWhatsAppText,
  buildWhatsAppUrl,
} from "@/lib/shortages";
import { posFetch } from "@/lib/tenantClient";
import { usePosStore } from "@/store/usePosStore";
import type {
  CategoryMap,
  ProductMap,
  ShortageFlag,
} from "@/types/pos.types";

type FilterMode = "all" | "zero" | "below_reorder";

const FILTER_LABELS: Record<FilterMode, string> = {
  all: "الكل",
  zero: "نافدة المخزون فقط",
  below_reorder: "تحت الحد الأدنى فقط",
};

function mapFlags(raw: unknown[]): ShortageFlag[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((f) => {
    const row = f as Record<string, unknown>;
    return {
      id: String(row.id ?? ""),
      productId: String(row.product_id ?? ""),
      productName: String(row.product_name ?? ""),
      currentStock: Number(row.current_stock ?? 0),
      reason: (row.reason as string) ?? undefined,
      resolved: Boolean(row.resolved),
      createdAt: String(row.created_at ?? ""),
    };
  });
}

function buildHierarchy(
  items: ReturnType<typeof computeShortageRadar>,
  categories: CategoryMap,
  products: ProductMap,
  filter: FilterMode,
): CategoryGroup[] {
  const catMap = new Map<
    string,
    { name: string; brands: Map<string, { name: string; products: ProductGroup[] }> }
  >();

  for (const item of items) {
    const filtered =
      filter === "zero"
        ? item.currentStock === 0
        : filter === "below_reorder"
          ? item.currentStock > 0 && item.currentStock <= item.minStockLevel
          : true;
    if (!filtered) continue;

    const product = products[item.productId];
    const categoryId = product?.categoryId ?? "__unknown__";
    const categoryName =
      categories[categoryId]?.name ?? "تصنيف غير معروف";
    const brandId = product?.brandId ?? "__none__";
    const brandName = product?.brandName ?? "بدون علامة";

    if (!catMap.has(categoryId)) {
      catMap.set(categoryId, {
        name: categoryName,
        brands: new Map(),
      });
    }
    const cat = catMap.get(categoryId)!;

    if (!cat.brands.has(brandId)) {
      cat.brands.set(brandId, { name: brandName, products: [] });
    }
    const brand = cat.brands.get(brandId)!;

    brand.products.push({
      productId: item.productId,
      productName: item.name,
      currentStock: item.currentStock,
      reorderLevel: item.minStockLevel,
      suggestedOrderQty: item.suggestedOrderQty,
      supplierName: item.supplierName,
    });
  }

  const groups: CategoryGroup[] = [];
  for (const [categoryId, cat] of catMap) {
    const brands: BrandGroup[] = [];
    let catItemCount = 0;
    for (const [brandId, brand] of cat.brands) {
      catItemCount += brand.products.length;
      brands.push({
        brandId,
        brandName: brand.name,
        products: brand.products,
        itemCount: brand.products.length,
      });
    }
    brands.sort((a, b) => b.itemCount - a.itemCount);
    groups.push({
      categoryId,
      categoryName: cat.name,
      brands,
      itemCount: catItemCount,
    });
  }

  groups.sort((a, b) => b.itemCount - a.itemCount);
  return groups;
}

export default function AdminShortagesPage() {
  const products = usePosStore((s) => s.products);
  const categories = usePosStore((s) => s.categories);
  const [flags, setFlags] = useState<ShortageFlag[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<FilterMode>("all");
  const [refreshKey, setRefreshKey] = useState(0);
  const [supplierPhones, setSupplierPhones] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await posFetch("/api/shortages", { cache: "no-store" });
      if (!res.ok) throw new Error("load_failed");
      const data = await res.json();
      setFlags(mapFlags(data.flags ?? data.shortage_flags ?? []));
    } catch {
      setError("تعذر تحميل بيانات نقص المخزون — تحقق من الاتصال");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  useEffect(() => {
    posFetch("/api/suppliers", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (Array.isArray(data?.suppliers)) {
          const map: Record<string, string> = {};
          for (const s of data.suppliers) {
            if (s.phone) map[s.id] = s.phone;
          }
          setSupplierPhones(map);
        }
      })
      .catch(() => {});
  }, []);

  const shortageItems = useMemo(
    () => computeShortageRadar(products, flags),
    [products, flags],
  );

  const enhancedItems = useMemo(() => {
    return shortageItems.map((item) => ({
      ...item,
      supplierPhone: item.supplierId ? supplierPhones[item.supplierId] ?? "" : "",
    }));
  }, [shortageItems, supplierPhones]);

  const groups = useMemo(
    () => buildHierarchy(enhancedItems, categories, products, filter),
    [enhancedItems, categories, products, filter],
  );

  const totalShortages = shortageItems.length;
  const zeroStock = shortageItems.filter((i) => i.currentStock === 0).length;
  const belowReorder = shortageItems.filter(
    (i) => i.currentStock > 0 && i.currentStock <= i.minStockLevel,
  ).length;

  const supplierGroups = useMemo(
    () => groupShortagesBySupplier(enhancedItems),
    [enhancedItems],
  );

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-black text-foreground">
            <Truck className="h-6 w-6 text-blue-600" /> نقص المخزون وأوامر
            الشراء
          </h1>
          <p className="mt-1 text-sm font-semibold text-muted">
            الأصناف التي تحتاج توريد عاجل
          </p>
        </div>
        <button
          type="button"
          onClick={() => setRefreshKey((k) => k + 1)}
          className="flex h-10 items-center gap-2 rounded-lg border border-border bg-white px-4 text-sm font-black hover:bg-surface-muted"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />{" "}
          تحديث
        </button>
      </header>

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <div className="rounded-2xl border border-border bg-white p-4 shadow-sm">
          <p className="flex items-center gap-1 text-xs font-bold text-muted">
            <Package className="h-3.5 w-3.5" /> إجمالي الأصناف الناقصة
          </p>
          <p className="mt-1 text-2xl font-black tabular-nums">
            {totalShortages}
          </p>
        </div>
        <div className="rounded-2xl border-l-4 border-red-500 bg-white p-4 shadow-sm">
          <p className="flex items-center gap-1 text-xs font-bold text-muted">
            <AlertTriangle className="h-3.5 w-3.5 text-red-500" /> أصناف نافدة
            المخزون
          </p>
          <p className="mt-1 text-2xl font-black tabular-nums text-red-600">
            {zeroStock}
          </p>
        </div>
        <div className="rounded-2xl border-l-4 border-amber-500 bg-white p-4 shadow-sm">
          <p className="flex items-center gap-1 text-xs font-bold text-muted">
            <AlertTriangle className="h-3.5 w-3.5 text-amber-500" /> أصناف تحت
            الحد الأدنى
          </p>
          <p className="mt-1 text-2xl font-black tabular-nums text-amber-600">
            {belowReorder}
          </p>
        </div>
      </section>

      <section className="flex flex-wrap items-center gap-2">
        <Filter className="h-4 w-4 text-muted" />
        {(Object.keys(FILTER_LABELS) as FilterMode[]).map((mode) => (
          <button
            key={mode}
            type="button"
            onClick={() => setFilter(mode)}
            className={`rounded-lg px-3 py-1.5 text-xs font-black transition ${
              filter === mode
                ? "bg-slate-900 text-white"
                : "border border-border bg-white text-muted hover:bg-surface-muted"
            }`}
          >
            {FILTER_LABELS[mode]}
          </button>
        ))}
      </section>

      {error && (
        <p className="rounded-lg bg-destructive/10 px-4 py-3 text-sm font-bold text-destructive">
          {error}
        </p>
      )}

      {loading ? (
        <div className="rounded-2xl border border-border bg-white p-12 text-center shadow-sm">
          <RefreshCw className="mx-auto h-8 w-8 animate-spin text-muted/40" />
          <p className="mt-3 text-sm font-bold text-muted">
            جارٍ تحميل بيانات المخزون…
          </p>
        </div>
      ) : (
        <ShortageAccordion groups={groups} totalShortages={totalShortages} />
      )}

      {supplierGroups.length > 0 && (
        <section className="space-y-3">
          <h2 className="flex items-center gap-2 text-lg font-black text-foreground">
            <Truck className="h-5 w-5 text-blue-600" /> أوامر التوريد حسب
            المورد
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {supplierGroups.map((group) => {
              const message = buildShortageWhatsAppText(group);
              const url = buildWhatsAppUrl(group.supplierPhone, message);
              return (
                <div
                  key={group.supplierId ?? "__none__"}
                  className="rounded-2xl border border-border bg-white p-4 shadow-sm"
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-black text-foreground">
                        {group.supplierName}
                      </p>
                      <p className="text-xs font-bold text-muted">
                        {group.items.length} أصناف • طلب: {group.totalOrderQty}
                      </p>
                    </div>
                    {url ? (
                      <a
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex h-9 items-center gap-1.5 rounded-lg bg-green-600 px-3 text-xs font-black text-white transition hover:bg-green-700"
                      >
                        طلب توريد عبر واتساب
                      </a>
                    ) : (
                      <span className="text-xs font-bold text-muted">
                        لا هاتف للمورد
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
