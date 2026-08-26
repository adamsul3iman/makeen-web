"use client";

import { memo, useCallback, useEffect, useDeferredValue, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  ChevronLeft,
  Clock,
  FolderOpen,
  LayoutGrid,
  PackageSearch,
  Search,
  Building2,
  X,
  Tag,
  Zap,
} from "lucide-react";
import { usePosStore } from "@/store/usePosStore";
import { buildChildrenByParent } from "@/lib/categoryTree";
import { formatMoney } from "@/lib/format";
import type { LocalCategory, QuickKeyItem } from "@/types/pos.types";

interface CategoryDrawerProps {
  isOpen: boolean;
  onClose: () => void;
}

const RECENT_SEARCHES_KEY = "pos-recent-drawer-searches";
const MAX_RECENT = 4;

function loadRecentSearches(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_SEARCHES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveRecentSearches(queries: string[]): void {
  try {
    localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(queries));
  } catch {
    // storage unavailable
  }
}

const CategoryCard = memo(function CategoryCard({
  category,
  onOpen,
}: {
  category: LocalCategory;
  onOpen: (id: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(category.id)}
      className="flex min-h-[56px] items-center gap-2.5 rounded-xl border border-slate-100 bg-white p-3 text-start shadow-sm transition hover:border-green-200 hover:shadow-md active:scale-[0.97]"
    >
      <span
        className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-white shadow-sm"
        style={{ backgroundColor: category.bgColor ?? "#64748b" }}
      >
        <FolderOpen className="h-4.5 w-4.5" />
      </span>
      <span className="min-w-0 flex-1 truncate text-[15px] font-bold text-slate-800">
        {category.name}
      </span>
      <ChevronLeft className="h-4 w-4 shrink-0 text-slate-300" />
    </button>
  );
});

const BrandCard = memo(function BrandCard({
  brandId,
  brandName,
  count,
  onSelect,
}: {
  brandId: string;
  brandName: string;
  count: number;
  onSelect: (id: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(brandId)}
      className="flex min-h-[56px] items-center gap-2.5 rounded-xl border border-slate-100 bg-white p-3 text-start shadow-sm transition hover:border-sky-200 hover:shadow-md active:scale-[0.97]"
    >
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-slate-700 text-white shadow-sm">
        <Building2 className="h-4.5 w-4.5" />
      </span>
      <div className="min-w-0 flex-1">
        <span className="block truncate text-[15px] font-bold text-slate-800">
          {brandName}
        </span>
        <span className="block text-[12px] font-semibold text-slate-400">
          {count.toLocaleString("ar-JO")} {count === 1 ? "منتج" : "منتجات"}
        </span>
      </div>
      <ChevronLeft className="h-4 w-4 shrink-0 text-slate-300" />
    </button>
  );
});

const ProductCard = memo(function ProductCard({
  item,
  onAdd,
}: {
  item: QuickKeyItem;
  onAdd: (item: QuickKeyItem) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onAdd(item)}
      className="flex min-h-[56px] items-center gap-2.5 rounded-xl border border-slate-100 bg-white p-3 text-start shadow-sm transition hover:border-green-200 hover:shadow-md active:scale-[0.97]"
    >
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-green-50 text-green-600">
        <PackageSearch className="h-4.5 w-4.5" />
      </span>
      <div className="min-w-0 flex-1">
        <span className="block truncate text-[15px] font-bold text-slate-800">
          {item.label}
        </span>
        <span className="block text-[12px] font-semibold text-slate-400 tabular-nums">
          {formatMoney(item.price ?? 0)}
        </span>
      </div>
    </button>
  );
});

export default memo(function CategoryDrawer({ isOpen, onClose }: CategoryDrawerProps) {
  const categories = usePosStore((s) => s.categories);
  const quickKeys = usePosStore((s) => s.quickKeys);

  const [focusedCategory, setFocusedCategory] = useState<string | null>(null);
  const [focusedBrandId, setFocusedBrandId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [recentSearches, setRecentSearches] = useState<string[]>([]);

  // Load recent searches from localStorage on mount
  useEffect(() => {
    if (isOpen) {
      setRecentSearches(loadRecentSearches());
    }
  }, [isOpen]);

  const searchRef = useRef<HTMLInputElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);

  // Auto-focus search on open
  useEffect(() => {
    if (isOpen) {
      // Small delay to allow slide-in animation to start
      const t = setTimeout(() => searchRef.current?.focus(), 100);
      return () => clearTimeout(t);
    }
    // Reset state on close
    setFocusedCategory(null);
    setFocusedBrandId(null);
    setSearchQuery("");
  }, [isOpen]);

  // Escape to close
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOpen, onClose]);

  const categoryArray = useMemo(() => Object.values(categories), [categories]);

  const childrenByParent = useMemo(
    () => buildChildrenByParent(categoryArray),
    [categoryArray],
  );

  const rootCategories = useMemo(
    () => categoryArray.filter((c) => !c.parentId || !categories[c.parentId]),
    [categoryArray, categories],
  );

  // Top quick-key products for the "frequent items" zero-typing view
  const frequentItems = useMemo(
    () => quickKeys.filter((k) => k.productId).slice(0, 8),
    [quickKeys],
  );

  // Brands in focused category (grouped by brandId from quickKeys)
  const brandsInCategory = useMemo(() => {
    if (!focusedCategory) return [];
    const brandMap = new Map<string, { brandId: string; brandName: string; count: number }>();
    for (const kq of quickKeys) {
      if (kq.categoryId !== focusedCategory) continue;
      const bid = kq.brandId ?? "__none__";
      const bname = kq.brandName ?? "بدون علامة تجارية";
      const existing = brandMap.get(bid);
      if (existing) {
        existing.count++;
      } else {
        brandMap.set(bid, { brandId: bid, brandName: bname, count: 1 });
      }
    }
    return Array.from(brandMap.values());
  }, [focusedCategory, quickKeys]);

  // Products in focused category + brand (or just category)
  const productsInView = useMemo(() => {
    if (!focusedCategory) return [];
    return quickKeys.filter((kq) => {
      if (kq.categoryId !== focusedCategory) return false;
      if (focusedBrandId) {
        const bid = kq.brandId ?? "__none__";
        return bid === focusedBrandId;
      }
      return true;
    });
  }, [focusedCategory, focusedBrandId, quickKeys]);

  // Deferred search query — eliminates typing lag
  const deferredQuery = useDeferredValue(searchQuery);
  const trimmedQuery = deferredQuery.trim().toLowerCase();

  // Build lookups for category + brand names
  const categoryNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const cat of categoryArray) map.set(cat.id, cat.name);
    return map;
  }, [categoryArray]);

  const brandNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const kq of quickKeys) {
      if (kq.brandId && kq.brandName) map.set(kq.brandId, kq.brandName);
    }
    return map;
  }, [quickKeys]);

  // Unified search results: products + category matches + brand matches
  const searchResults = useMemo(() => {
    if (!trimmedQuery) return [];
    const matchedProductIds = new Set<string>();
    const matchedCategoryIds = new Set<string>();
    const matchedBrandKeys = new Map<string, string>(); // brandId → first categoryId

    for (const kq of quickKeys) {
      if (kq.label.toLowerCase().includes(trimmedQuery)) { matchedProductIds.add(kq.id); continue; }
      if (kq.barcode && kq.barcode.toLowerCase().includes(trimmedQuery)) { matchedProductIds.add(kq.id); continue; }
      if (kq.brandName && kq.brandName.toLowerCase().includes(trimmedQuery) && kq.brandId) {
        if (!matchedBrandKeys.has(kq.brandId)) matchedBrandKeys.set(kq.brandId, kq.categoryId);
      }
      const catName = categoryNameMap.get(kq.categoryId);
      if (catName && catName.toLowerCase().includes(trimmedQuery)) {
        matchedCategoryIds.add(kq.categoryId);
      }
    }

    const results: Array<{ type: "product" | "category" | "brand"; id: string; label: string; categoryId?: string; item?: QuickKeyItem }> = [];

    for (const catId of matchedCategoryIds) {
      results.push({ type: "category", id: catId, label: categoryNameMap.get(catId) ?? catId });
    }
    for (const [brandId, catId] of matchedBrandKeys) {
      results.push({ type: "brand", id: brandId, label: brandNameMap.get(brandId) ?? brandId, categoryId: catId });
    }
    for (const kq of quickKeys) {
      if (matchedProductIds.has(kq.id)) {
        results.push({ type: "product", id: kq.id, label: kq.label, item: kq });
      }
    }
    return results;
  }, [trimmedQuery, quickKeys, categoryNameMap, brandNameMap]);

  const isSearching = trimmedQuery.length > 0;

  const handleAddProduct = useCallback(
    (item: QuickKeyItem) => {
      usePosStore.getState().addQuickKeyItem(item);
      onClose();
    },
    [onClose],
  );

  const recordSearch = useCallback((query: string) => {
    const trimmed = query.trim();
    if (!trimmed) return;
    setRecentSearches((prev) => {
      const next = [trimmed, ...prev.filter((q) => q !== trimmed)].slice(0, MAX_RECENT);
      saveRecentSearches(next);
      return next;
    });
  }, []);

  const handleAddFromSearch = useCallback(
    (item: QuickKeyItem) => {
      recordSearch(searchQuery);
      usePosStore.getState().addQuickKeyItem(item);
      onClose();
    },
    [onClose, recordSearch, searchQuery],
  );

  const handleClearRecent = useCallback(() => {
    setRecentSearches([]);
    saveRecentSearches([]);
  }, []);

  const handleBack = useCallback(() => {
    if (focusedBrandId) {
      setFocusedBrandId(null);
    } else if (focusedCategory) {
      setFocusedCategory(null);
    }
  }, [focusedBrandId, focusedCategory]);

  const breadcrumb = useMemo(() => {
    const crumbs: Array<{ label: string; onClick?: () => void }> = [];
    if (focusedCategory) {
      const cat = categories[focusedCategory];
      crumbs.push({
        label: cat?.name ?? "التصنيفات",
        onClick: () => setFocusedCategory(null),
      });
    }
    if (focusedBrandId) {
      const brand = brandsInCategory.find((b) => b.brandId === focusedBrandId);
      crumbs.push({ label: brand?.brandName ?? "العلامة التجارية" });
    }
    return crumbs;
  }, [focusedCategory, focusedBrandId, categories, brandsInCategory]);

  // Grid: 2 cols for categories/brands, 1 col for products (wider cards)
  const gridCols = focusedCategory && !focusedBrandId && !isSearching
    ? "grid-cols-2"
    : "grid-cols-1";

  return (
    <>
      {/* Backdrop */}
      <div
        ref={backdropRef}
        onClick={onClose}
        className={`fixed inset-0 z-50 bg-slate-900/20 backdrop-blur-sm transition-opacity duration-200 ${
          isOpen ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      />

      {/* Drawer */}
      <div
        className={`fixed inset-y-0 right-0 z-50 flex w-full max-w-lg flex-col bg-white shadow-2xl border-l border-slate-200/80 transition-transform duration-200 ease-out ${
          isOpen ? "translate-x-0" : "translate-x-full"
        }`}
      >
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-slate-200 px-5 py-4">
          {focusedCategory && (
            <button
              type="button"
              onClick={handleBack}
              className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-slate-100 text-slate-600 transition hover:bg-slate-200 active:scale-95"
            >
              <ArrowRight className="h-5 w-5" />
            </button>
          )}
          <h2 className="min-w-0 flex-1 text-[17px] font-black text-slate-800">
            {isSearching
              ? `نتائج البحث: "${searchQuery}"`
              : focusedCategory
                ? breadcrumb.map((c) => c.label).join(" → ")
                : "تصفح الأصناف"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-slate-400 transition hover:bg-slate-100 hover:text-slate-600 active:scale-95"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Search */}
        <div className="border-b border-slate-100 px-5 py-3">
          <div className="flex h-11 items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-2.5 transition-all focus-within:border-slate-300 focus-within:bg-white">
            <Search className="h-5 w-5 shrink-0 text-slate-400" />
            <input
              ref={searchRef}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="ابحث بالاسم أو الباركود أو التصنيف..."
              className="min-w-0 flex-1 bg-transparent text-[15px] font-bold text-slate-800 outline-none placeholder:text-slate-400"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-slate-400 transition hover:bg-slate-200 hover:text-slate-600"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          {/* Recent searches chips */}
          {!searchQuery && recentSearches.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <Clock className="h-3 w-3 shrink-0 text-slate-300" />
              {recentSearches.map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => setSearchQuery(q)}
                  className="flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[12px] font-bold text-slate-600 transition hover:border-slate-300 hover:bg-slate-50 active:scale-95"
                >
                  {q}
                </button>
              ))}
              <button
                type="button"
                onClick={handleClearRecent}
                className="rounded-full px-2 py-1 text-[12px] font-bold text-slate-400 transition hover:text-rose-500"
              >
                مسح
              </button>
            </div>
          )}
        </div>

        {/* Content grid */}
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {isSearching ? (
            // Unified search results
            searchResults.length > 0 ? (
              <div className="grid grid-cols-1 gap-2">
                {searchResults.map((result) => {
                  if (result.type === "category") {
                    return (
                      <button
                        key={`cat-${result.id}`}
                        type="button"
                        onClick={() => { recordSearch(searchQuery); setFocusedCategory(result.id); setSearchQuery(""); }}
                        className="flex min-h-[56px] items-center gap-2.5 rounded-xl border border-amber-100 bg-amber-50 p-3 text-start shadow-sm transition hover:border-amber-200 hover:shadow-md active:scale-[0.97]"
                      >
                        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-amber-100 text-amber-600">
                          <FolderOpen className="h-4.5 w-4.5" />
                        </span>
                        <span className="min-w-0 flex-1 text-[15px] font-bold text-slate-800">{result.label}</span>
                        <span className="shrink-0 rounded-md bg-amber-100 px-2 py-0.5 text-[11px] font-bold text-amber-600">تصنيف</span>
                      </button>
                    );
                  }
                  if (result.type === "brand") {
                    return (
                      <button
                        key={`brand-${result.id}`}
                        type="button"
                        onClick={() => { recordSearch(searchQuery); if (result.categoryId) setFocusedCategory(result.categoryId); setFocusedBrandId(result.id); setSearchQuery(""); }}
                        className="flex min-h-[56px] items-center gap-2.5 rounded-xl border border-sky-100 bg-sky-50 p-3 text-start shadow-sm transition hover:border-sky-200 hover:shadow-md active:scale-[0.97]"
                      >
                        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-sky-100 text-sky-600">
                          <Building2 className="h-4.5 w-4.5" />
                        </span>
                        <span className="min-w-0 flex-1 text-[15px] font-bold text-slate-800">{result.label}</span>
                        <span className="shrink-0 rounded-md bg-sky-100 px-2 py-0.5 text-[11px] font-bold text-sky-600">علامة تجارية</span>
                      </button>
                    );
                  }
                  return result.item ? (
                    <ProductCard key={result.id} item={result.item} onAdd={handleAddFromSearch} />
                  ) : null;
                })}
              </div>
            ) : (
              <div className="grid h-full place-items-center text-center">
                <div>
                  <PackageSearch className="mx-auto h-10 w-10 text-slate-300" />
                  <p className="mt-3 text-[15px] font-bold text-slate-500">
                    لا توجد نتائج مطابقة
                  </p>
                </div>
              </div>
            )
          ) : !focusedCategory ? (
            // Default: frequent items + root categories
            <div className="space-y-5">
              {/* Frequent / Popular items — zero-typing quick-add */}
              {frequentItems.length > 0 && (
                <div>
                  <div className="mb-2.5 flex items-center gap-2">
                    <Zap className="h-4 w-4 text-amber-500" />
                    <h3 className="text-[15px] font-black text-slate-700">الأصناف الأكثر طلباً</h3>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {frequentItems.map((item) => (
                      <ProductCard key={item.id} item={item} onAdd={handleAddProduct} />
                    ))}
                  </div>
                </div>
              )}

              {/* Root categories */}
              <div>
                <div className="mb-2.5 flex items-center gap-2">
                  <FolderOpen className="h-4 w-4 text-slate-400" />
                  <h3 className="text-[15px] font-black text-slate-700">التصنيفات</h3>
                </div>
                {rootCategories.length > 0 ? (
                  <div className="grid grid-cols-2 gap-2">
                    {rootCategories.map((cat) => (
                      <CategoryCard
                        key={cat.id}
                        category={cat}
                        onOpen={setFocusedCategory}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="grid h-32 place-items-center text-center">
                    <div>
                      <FolderOpen className="mx-auto h-10 w-10 text-slate-300" />
                      <p className="mt-3 text-[15px] font-bold text-slate-500">
                        لا توجد تصنيفات
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : !focusedBrandId ? (
            // Brands in category
            brandsInCategory.length > 0 ? (
              <div className="grid grid-cols-2 gap-2">
                {brandsInCategory.map((brand) => (
                  <BrandCard
                    key={brand.brandId}
                    brandId={brand.brandId}
                    brandName={brand.brandName}
                    count={brand.count}
                    onSelect={setFocusedBrandId}
                  />
                ))}
              </div>
            ) : (
              // No brands — show products directly
              <div className="grid grid-cols-1 gap-2">
                {productsInView.map((item) => (
                  <ProductCard key={item.id} item={item} onAdd={handleAddProduct} />
                ))}
              </div>
            )
          ) : (
            // Products in brand
            <div className="grid grid-cols-1 gap-2">
              {productsInView.map((item) => (
                <ProductCard key={item.id} item={item} onAdd={handleAddProduct} />
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
});
