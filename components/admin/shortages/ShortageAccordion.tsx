"use client";

import { useMemo, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Layers,
  Package,
  Tag,
} from "lucide-react";

export interface CategoryGroup {
  categoryId: string;
  categoryName: string;
  brands: BrandGroup[];
  itemCount: number;
}

export interface BrandGroup {
  brandId: string;
  brandName: string;
  products: ProductGroup[];
  itemCount: number;
}

export interface ProductGroup {
  productId: string;
  productName: string;
  currentStock: number;
  reorderLevel: number;
  suggestedOrderQty: number;
  supplierName?: string;
}

interface ShortageAccordionProps {
  groups: CategoryGroup[];
  totalShortages: number;
}

export default function ShortageAccordion({
  groups,
  totalShortages,
}: ShortageAccordionProps) {
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(
    () => {
      const first = groups[0]?.categoryId;
      return first ? new Set([first]) : new Set();
    },
  );
  const [expandedBrands, setExpandedBrands] = useState<Set<string>>(new Set());

  const toggleCategory = (id: string) =>
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleBrand = (id: string) =>
    setExpandedBrands((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const urgencyBadge = (product: ProductGroup) => {
    if (product.currentStock === 0) {
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-black text-red-700">
          <AlertTriangle className="h-3 w-3" />
          نفد المخزون
        </span>
      );
    }
    if (product.currentStock <= product.reorderLevel) {
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-black text-amber-700">
          <AlertTriangle className="h-3 w-3" />
          مخزون منخفض
        </span>
      );
    }
    return null;
  };

  if (groups.length === 0) {
    return (
      <div className="rounded-2xl border border-border bg-white p-8 text-center shadow-sm">
        <Package className="mx-auto h-12 w-12 text-muted/40" />
        <p className="mt-3 text-sm font-bold text-muted">
          لا توجد أصناف تحتاج توريد حالياً
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 rounded-2xl border border-border bg-white px-4 py-3 shadow-sm">
        <div className="grid h-10 w-10 place-items-center rounded-xl bg-red-50">
          <AlertTriangle className="h-5 w-5 text-red-600" />
        </div>
        <div>
          <p className="text-sm font-bold text-muted">إجمالي الأصناف الناقصة</p>
          <p className="text-xl font-black tabular-nums text-foreground">
            {totalShortages}
            <span className="me-1 text-sm font-bold text-muted">صنف تحتاج توريد</span>
          </p>
        </div>
      </div>

      {groups.map((cat) => {
        const catExpanded = expandedCategories.has(cat.categoryId);
        return (
          <div
            key={cat.categoryId}
            className="overflow-hidden rounded-2xl border border-border bg-white shadow-sm"
          >
            <button
              type="button"
              onClick={() => toggleCategory(cat.categoryId)}
              className="flex w-full items-center justify-between gap-3 px-4 py-3 transition hover:bg-surface-muted"
            >
              <div className="flex items-center gap-3">
                <div className="grid h-9 w-9 place-items-center rounded-lg bg-blue-50">
                  <Layers className="h-4.5 w-4.5 text-blue-600" />
                </div>
                <div className="text-right">
                  <p className="text-sm font-black text-foreground">
                    {cat.categoryName}
                  </p>
                  <p className="text-xs font-bold text-muted">
                    {cat.itemCount} أصناف
                  </p>
                </div>
              </div>
              {catExpanded ? (
                <ChevronUp className="h-5 w-5 text-muted" />
              ) : (
                <ChevronDown className="h-5 w-5 text-muted" />
              )}
            </button>

            {catExpanded && (
              <div className="divide-y divide-border border-t border-border">
                {cat.brands.map((brand) => {
                  const brandKey = `${cat.categoryId}-${brand.brandId}`;
                  const brandExpanded = expandedBrands.has(brandKey);
                  return (
                    <div key={brand.brandId}>
                      <button
                        type="button"
                        onClick={() => toggleBrand(brandKey)}
                        className="flex w-full items-center justify-between gap-3 px-6 py-2.5 transition hover:bg-surface-muted"
                      >
                        <div className="flex items-center gap-3">
                          <div className="grid h-8 w-8 place-items-center rounded-lg bg-green-50">
                            <Tag className="h-4 w-4 text-green-600" />
                          </div>
                          <div className="text-right">
                            <p className="text-sm font-bold text-foreground">
                              {brand.brandName}
                            </p>
                            <p className="text-xs font-semibold text-muted">
                              {brand.itemCount} أصناف
                            </p>
                          </div>
                        </div>
                        {brandExpanded ? (
                          <ChevronUp className="h-4 w-4 text-muted" />
                        ) : (
                          <ChevronDown className="h-4 w-4 text-muted" />
                        )}
                      </button>

                      {brandExpanded && (
                        <div className="divide-y divide-border/60 bg-gray-50">
                          {brand.products.map((product) => (
                            <div
                              key={product.productId}
                              className="flex items-center justify-between gap-3 px-8 py-3"
                            >
                              <div className="flex items-center gap-3 min-w-0">
                                <div className="grid h-8 w-8 place-items-center rounded-lg bg-slate-100">
                                  <Package className="h-4 w-4 text-slate-500" />
                                </div>
                                <div className="min-w-0">
                                  <p className="truncate text-sm font-bold text-foreground">
                                    {product.productName}
                                  </p>
                                  <p className="text-xs font-semibold text-muted">
                                    المخزون: {product.currentStock} • الحد الأدنى:{" "}
                                    {product.reorderLevel}
                                    {product.supplierName && (
                                      <span>
                                        {" • "}المورد: {product.supplierName}
                                      </span>
                                    )}
                                  </p>
                                </div>
                              </div>
                              <div className="flex items-center gap-3 shrink-0">
                                {urgencyBadge(product)}
                                <div className="text-left">
                                  <p className="text-sm font-black tabular-nums text-blue-700">
                                    {product.suggestedOrderQty > 0
                                      ? `طلب: ${product.suggestedOrderQty}`
                                      : "—"}
                                  </p>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
