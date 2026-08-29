"use client";

import { memo, useCallback, useEffect, useDeferredValue, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  ChevronLeft,
  Clock,
  FolderOpen,
  PackageSearch,
  Search,
  X,
  Zap,
} from "lucide-react";
import { usePosStore } from "@/store/usePosStore";
import { categoryPath } from "@/lib/categoryTree";
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
        <span className="mt-0.5 block text-[12px] font-semibold text-slate-400 tabular-nums">
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

  // ─────────────────────────────────────────────────────────────────────────
  // Category tree (nested, brands are NEVER part of it).
  //
  // Only genuine product categories visible to the cashier participate in
  // navigation. Hidden categories (showInPos === false — e.g. brand/supplier
  // names that were accidentally entered as category rows) are excluded so no
  // brand name can act as a category, sub-category, or navigation node.
  // ─────────────────────────────────────────────────────────────────────────
  const categoryArray = useMemo(
    () => Object.values(categories).filter((c) => c.showInPos !== false),
    [categories],
  );

  const rootCategories = useMemo(
    () => categoryArray.filter((c) => !c.parentId || !categories[c.parentId]),
    [categoryArray, categories],
  );

  // Direct children of any category id → for nested drill-down.
  const childrenByCategory = useMemo(() => {
    const map = new Map<string, LocalCategory[]>();
    for (const cat of categoryArray) {
      if (!cat.parentId) continue;
      const list = map.get(cat.parentId) ?? [];
      list.push(cat);
      map.set(cat.parentId, list);
    }
    // Stable ordering: sortOrder then name.
    for (const list of map.values()) {
      list.sort((a, b) => {
        const bySort = (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
        if (bySort !== 0) return bySort;
        return a.name.localeCompare(b.name, "ar");
      });
    }
    return map;
  }, [categoryArray]);

  const subCategories = useMemo(
    () => (focusedCategory ? childrenByCategory.get(focusedCategory) ?? [] : []),
    [focusedCategory, childrenByCategory],
  );

  const isLeafCategory = subCategories.length === 0;

  const focusedCategoryName = focusedCategory ? categories[focusedCategory]?.name ?? null : null;

  // Direct products of the focused category (leaf -> products).
  const categoryProducts = useMemo(() => {
    if (!focusedCategory) return [];
    return quickKeys.filter((kq) => kq.categoryId === focusedCategory);
  }, [focusedCategory, quickKeys]);

  // Top quick-key products for the "frequent items" zero-typing view
  const frequentItems = useMemo(
    () => quickKeys.filter((k) => k.productId).slice(0, 8),
    [quickKeys],
  );

  // Deferred search query — eliminates typing lag
  const deferredQuery = useDeferredValue(searchQuery);
  const trimmedQuery = deferredQuery.trim().toLowerCase();

  // Category name lookup (visible categories only)
  const categoryNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const cat of categoryArray) map.set(cat.id, cat.name);
    return map;
  }, [categoryArray]);

  // Search results: matching products + matching categories. Brands never
  // appear as searchable navigation nodes.
  const searchResults = useMemo(() => {
    if (!trimmedQuery) return [];
    const matchedProductIds = new Set<string>();
    const matchedCategoryIds = new Set<string>();

    for (const kq of quickKeys) {
      if (kq.label.toLowerCase().includes(trimmedQuery)) { matchedProductIds.add(kq.id); continue; }
      if (kq.barcode && kq.barcode.toLowerCase().includes(trimmedQuery)) { matchedProductIds.add(kq.id); continue; }
      const catName = categoryNameMap.get(kq.categoryId);
      if (catName && catName.toLowerCase().includes(trimmedQuery)) {
        matchedCategoryIds.add(kq.categoryId);
      }
    }

    // Also match visible category names directly from the tree.
    for (const cat of categoryArray) {
      if (cat.name.toLowerCase().includes(trimmedQuery)) matchedCategoryIds.add(cat.id);
    }

    const results: Array<{ type: "product" | "category"; id: string; label: string; item?: QuickKeyItem }> = [];

    for (const catId of matchedCategoryIds) {
      results.push({ type: "category", id: catId, label: categoryNameMap.get(catId) ?? catId });
    }
    for (const kq of quickKeys) {
      if (matchedProductIds.has(kq.id)) {
        results.push({ type: "product", id: kq.id, label: kq.label, item: kq });
      }
    }
    return results;
  }, [trimmedQuery, quickKeys, categoryArray, categoryNameMap]);

  const isSearching = trimmedQuery.length > 0;

  const handleAddProduct = useCallback(
    (item: QuickKeyItem) => {
      // Keep the drawer open so the cashier can add multiple products
      // consecutively. It closes only via the X button, backdrop, or Esc.
      usePosStore.getState().addQuickKeyItem(item);
    },
    [],
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
    },
    [recordSearch, searchQuery],
  );

  const handleClearRecent = useCallback(() => {
    setRecentSearches([]);
    saveRecentSearches([]);
  }, []);

  // Step up one level in the nested tree (or back to home for a root category).
  const handleBack = useCallback(() => {
    setFocusedCategory((prev) => {
      if (!prev) return prev;
      return categories[prev]?.parentId ?? null;
    });
  }, [categories]);

  // Clickable breadcrumb trail: الرئيسية › root › … › leaf
  const breadcrumbTrail = useMemo(() => {
    const crumbs: Array<{ label: string; onClick?: () => void }> = [
      { label: "الرئيسية", onClick: () => setFocusedCategory(null) },
    ];
    if (focusedCategory) {
      const pathNames = categoryPath(focusedCategory, categories);
      pathNames.forEach((label, i) => {
        const isLast = i === pathNames.length - 1;
        if (isLast) {
          crumbs.push({ label });
        } else {
          // Walk the chain so clicking an ancestor returns to that level.
          let target = focusedCategory;
          let steps = pathNames.length - 1 - i;
          while (steps > 0 && target) {
            target = categories[target]?.parentId ?? target;
            steps -= 1;
          }
          crumbs.push({ label, onClick: () => setFocusedCategory(target) });
        }
      });
    }
    return crumbs;
  }, [focusedCategory, categories]);

  return (
    <>
      {/* Backdrop */}
      <div
        ref={backdropRef}
        onClick={onClose}
        className={`fixed inset-0 z-[80] bg-slate-900/20 backdrop-blur-sm transition-opacity duration-200 ${
          isOpen ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      />

      {/* Drawer */}
      <div
        className={`fixed inset-y-0 right-0 z-[80] flex w-full max-w-lg flex-col bg-white shadow-2xl border-l border-slate-200/80 transition-transform duration-200 ease-out ${
          isOpen ? "translate-x-0" : "translate-x-full"
        }`}
      >
        {/* Header */}
        <div className="sticky top-0 z-10 flex shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-5 py-4">
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
              : focusedCategoryName ?? "تصفح الأصناف"}
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

        {/* Breadcrumb navigation bar — clickable nested category path */}
        {focusedCategory && (
          <nav
            aria-label="مسار التصنيف"
            className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-slate-100 bg-slate-50/70 px-4 py-2 scrollbar-hidden"
          >
            {breadcrumbTrail.map((crumb, i) => {
              const isLast = i === breadcrumbTrail.length - 1;
              return (
                <span key={`${crumb.label}-${i}`} className="flex shrink-0 items-center gap-1">
                  {i > 0 && <ChevronLeft className="h-3.5 w-3.5 shrink-0 text-slate-300" aria-hidden="true" />}
                  {isLast || !crumb.onClick ? (
                    <span className="truncate text-[13px] font-black text-slate-800">{crumb.label}</span>
                  ) : (
                    <button
                      type="button"
                      onClick={crumb.onClick}
                      className="truncate rounded-md px-1 text-[13px] font-bold text-slate-500 transition hover:bg-white hover:text-primary"
                    >
                      {crumb.label}
                    </button>
                  )}
                </span>
              );
            })}
          </nav>
        )}

        {/* Content */}
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {isSearching ? (
            // Search results: products + categories only (no brands).
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
          ) : (
            // Nested view: if the category has sub-categories, show them (and
            // any of its direct products below). A leaf category shows its
            // products directly. Brands are never a navigation step.
            <div className="space-y-5">
              {subCategories.length > 0 && (
                <div>
                  <div className="mb-2.5 flex items-center gap-2">
                    <FolderOpen className="h-4 w-4 text-slate-400" />
                    <h3 className="text-[15px] font-black text-slate-700">الأقسام الفرعية</h3>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {subCategories.map((cat) => (
                      <CategoryCard
                        key={cat.id}
                        category={cat}
                        onOpen={setFocusedCategory}
                      />
                    ))}
                  </div>
                </div>
              )}

              {categoryProducts.length > 0 && (
                <div>
                  <div className="mb-2.5 flex items-center gap-2">
                    <PackageSearch className="h-4 w-4 text-slate-400" />
                    <h3 className="text-[15px] font-black text-slate-700">
                      {isLeafCategory ? "المنتجات" : "منتجات التصنيف"}
                    </h3>
                  </div>
                  <div className="grid grid-cols-1 gap-2">
                    {categoryProducts.map((item) => (
                      <ProductCard key={item.id} item={item} onAdd={handleAddProduct} />
                    ))}
                  </div>
                </div>
              )}

              {subCategories.length === 0 && categoryProducts.length === 0 && (
                <div className="grid h-40 place-items-center text-center">
                  <div>
                    <PackageSearch className="mx-auto h-10 w-10 text-slate-300" />
                    <p className="mt-3 text-[15px] font-bold text-slate-500">
                      لا توجد منتجات في هذا التصنيف
                    </p>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
});
