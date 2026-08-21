"use client";

import {
  memo,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ChevronLeft,
  ChevronRight,
  FolderOpen,
  LayoutGrid,
  PackageSearch,
  Search,
  Building2,
  Sparkles,
  X,
} from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { buildChildrenByParent, searchCategoryHierarchy } from "@/lib/categoryTree";
import { formatMoney } from "@/lib/format";
import { usePosStore } from "@/store/usePosStore";
import type { LocalCategory, QuickKeyItem } from "@/types/pos.types";
import PinnedCategories from "./PinnedCategories";

const GRID_GAP = 6;

const QuickKeyCard = memo(function QuickKeyCard({
  item,
  onAdd,
}: {
  item: QuickKeyItem;
  onAdd: (key: QuickKeyItem) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onAdd(item)}
      className="group flex h-full min-h-[84px] w-full flex-col justify-between gap-1.5 overflow-hidden rounded-lg border border-slate-200 bg-white p-2.5 text-start shadow-sm transition hover:border-emerald-300 hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary active:scale-[0.98]"
    >
      <div className="min-h-0">
        {item.variantLabel && (
          <span className="block truncate text-xs font-bold text-slate-500">
            {item.variantLabel}
          </span>
        )}
        <span className="line-clamp-2 text-sm font-bold leading-5 text-slate-800">
          {item.label}
        </span>
      </div>
      <div className="flex items-end justify-between gap-1">
        <span className="max-w-16 truncate text-xs font-semibold text-slate-400">
          {item.unitName ?? ""}
        </span>
        <span className="shrink-0 rounded bg-emerald-50 px-1.5 py-0.5 text-sm font-black tabular-nums text-emerald-600">
          {formatMoney(item.price ?? 0)}
        </span>
      </div>
    </button>
  );
});

const CategoryTile = memo(function CategoryTile({
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
      className="flex min-h-12 min-w-0 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-start shadow-sm transition hover:border-emerald-300 hover:bg-emerald-50/40 active:scale-[0.98]"
    >
      <span
        aria-hidden
        className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-white"
        style={{ backgroundColor: category.bgColor ?? "#64748b" }}
      >
        <FolderOpen className="h-3.5 w-3.5" />
      </span>
      <span className="min-w-0 flex-1 whitespace-normal text-sm font-black leading-snug text-slate-800">
        {category.name}
      </span>
      <ChevronLeft className="h-3.5 w-3.5 shrink-0 text-slate-400" />
    </button>
  );
});

interface BrandTileData {
  brandId: string;
  brandName: string;
  count: number;
  bgColor: string;
}

const BrandTile = memo(function BrandTile({
  brand,
  onSelect,
}: {
  brand: BrandTileData;
  onSelect: (id: string, name: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(brand.brandId, brand.brandName)}
      className="flex min-h-12 min-w-0 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-start shadow-sm transition hover:border-sky-300 hover:bg-sky-50/40 active:scale-[0.98]"
    >
      <span
        aria-hidden
        className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-slate-700 text-white"
      >
        <Building2 className="h-3.5 w-3.5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block whitespace-normal text-sm font-black leading-snug text-slate-800">
          {brand.brandName}
        </span>
        <span className="block text-xs font-bold text-slate-400">
          {brand.count.toLocaleString("ar-JO")} {brand.count === 1 ? "منتج" : "منتجات"}
        </span>
      </span>
      <ChevronLeft className="h-3.5 w-3.5 shrink-0 text-slate-400" />
    </button>
  );
});

function useProductGridMetrics(parentRef: React.RefObject<HTMLDivElement | null>): {
  cols: number;
  tileSize: number;
} {
  const [metrics, setMetrics] = useState({ cols: 2, tileSize: 120 });

  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;

    const update = () => {
      const width = el.clientWidth;
      const cols = width < 260 ? 1 : width < 420 ? 2 : width < 600 ? 3 : width < 800 ? 4 : 5;
      const tileSize = Math.max(
        80,
        Math.floor((width - Math.max(0, cols - 1) * GRID_GAP) / cols),
      );
      setMetrics({ cols, tileSize });
    };

    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [parentRef]);

  return metrics;
}

export default memo(function QuickKeysGrid() {
  const quickKeys = usePosStore((state) => state.quickKeys);
  const categories = usePosStore((state) => state.categories);
  const activeCategoryId = usePosStore((state) => state.activeCategoryId);
  const setActiveCategoryId = usePosStore((state) => state.setActiveCategoryId);
  const addQuickKeyItem = usePosStore((state) => state.addQuickKeyItem);

  const [showPopular, setShowPopular] = useState(false);
  const [focusedBrandId, setFocusedBrandId] = useState<string | null>(null);
  const [focusedBrandName, setFocusedBrandName] = useState<string | null>(null);
  const [categoryQuery, setCategoryQuery] = useState("");
  const [categorySearchOpen, setCategorySearchOpen] = useState(false);
  const [selectedCategoryResult, setSelectedCategoryResult] = useState(0);
  const deferredQuickKeys = useDeferredValue(quickKeys);
  const deferredCategories = useDeferredValue(categories);
  const productScrollRef = useRef<HTMLDivElement>(null);
  const categorySearchRef = useRef<HTMLDivElement>(null);
  const categorySearchInputRef = useRef<HTMLInputElement>(null);
  const { cols, tileSize } = useProductGridMetrics(productScrollRef);

  const directProductCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const key of deferredQuickKeys) {
      counts.set(key.categoryId, (counts.get(key.categoryId) ?? 0) + 1);
    }
    return counts;
  }, [deferredQuickKeys]);

  const childrenByParent = useMemo(() => {
    const result = buildChildrenByParent(Object.values(deferredCategories));
    for (const children of result.values()) {
      children.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "ar"));
    }
    return result;
  }, [deferredCategories]);

  const subtreeProductCounts = useMemo(() => {
    const counts = new Map<string, number>();
    const visit = (id: string): number => {
      const cached = counts.get(id);
      if (cached !== undefined) return cached;
      let total = directProductCounts.get(id) ?? 0;
      for (const child of childrenByParent.get(id) ?? []) total += visit(child.id);
      counts.set(id, total);
      return total;
    };
    for (const id of Object.keys(deferredCategories)) visit(id);
    return counts;
  }, [childrenByParent, deferredCategories, directProductCounts]);

  const categorySearchResults = useMemo(
    () =>
      searchCategoryHierarchy(Object.values(deferredCategories), categoryQuery, {
        limit: 8,
        include: (category) => (subtreeProductCounts.get(category.id) ?? 0) > 0,
      }),
    [categoryQuery, deferredCategories, subtreeProductCounts],
  );

  const focusedCategory =
    activeCategoryId && deferredCategories[activeCategoryId]
      ? deferredCategories[activeCategoryId]
      : null;

  const focusedPath = useMemo<LocalCategory[]>(() => {
    if (!focusedCategory) return [];
    const path: LocalCategory[] = [];
    const visited = new Set<string>();
    let current: LocalCategory | undefined = focusedCategory;
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      path.unshift(current);
      current = current.parentId ? deferredCategories[current.parentId] : undefined;
    }
    return path;
  }, [deferredCategories, focusedCategory]);

  const rootCategories = useMemo(
    () =>
      Object.values(deferredCategories)
        .filter((category) => !category.parentId)
        .filter((category) => category.showInPos !== false)
        .filter((category) => (subtreeProductCounts.get(category.id) ?? 0) > 0)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "ar")),
    [deferredCategories, subtreeProductCounts],
  );

  const visibleFolders = useMemo(
    () =>
      (focusedCategory ? childrenByParent.get(focusedCategory.id) ?? [] : rootCategories)
        .filter((category) => (subtreeProductCounts.get(category.id) ?? 0) > 0),
    [childrenByParent, focusedCategory, rootCategories, subtreeProductCounts],
  );

  const uncategorizedKeys = useMemo(
    () =>
      deferredQuickKeys.filter(
        (key) => !key.categoryId || !deferredCategories[key.categoryId],
      ),
    [deferredCategories, deferredQuickKeys],
  );

  const brandsInCategory = useMemo<BrandTileData[]>(() => {
    if (!focusedCategory || focusedBrandId) return [];
    const keys = deferredQuickKeys.filter((k) => k.categoryId === focusedCategory.id);
    const grouped = new Map<string, BrandTileData>();
    for (const key of keys) {
      const id = key.brandId ?? "__none__";
      const existing = grouped.get(id);
      if (existing) {
        existing.count++;
      } else {
        grouped.set(id, {
          brandId: id,
          brandName: key.brandName ?? "بدون علامة تجارية",
          count: 1,
          bgColor: key.bgColor,
        });
      }
    }
    return Array.from(grouped.values()).sort((a, b) => b.count - a.count || a.brandName.localeCompare(b.brandName, "ar"));
  }, [deferredQuickKeys, focusedCategory, focusedBrandId]);

  const gridKeys = useMemo(() => {
    if (showPopular) return deferredQuickKeys;
    if (focusedCategory && focusedBrandId) {
      const noneBrand = focusedBrandId === "__none__";
      return deferredQuickKeys.filter(
        (key) =>
          key.categoryId === focusedCategory.id &&
          (noneBrand ? !key.brandId : key.brandId === focusedBrandId),
      );
    }
    return rootCategories.length === 0 ? uncategorizedKeys : [];
  }, [deferredQuickKeys, focusedCategory, focusedBrandId, rootCategories.length, showPopular, uncategorizedKeys]);

  const rows = useMemo<QuickKeyItem[][]>(() => {
    const result: QuickKeyItem[][] = [];
    for (let index = 0; index < gridKeys.length; index += cols) {
      result.push(gridKeys.slice(index, index + cols));
    }
    return result;
  }, [cols, gridKeys]);

  // TanStack Virtual owns measurement state internally for the large quick-item catalog.
  // eslint-disable-next-line react-hooks/incompatible-library
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => productScrollRef.current,
    estimateSize: () => tileSize + GRID_GAP,
    overscan: 4,
  });

  useEffect(() => {
    if (productScrollRef.current) productScrollRef.current.scrollTop = 0;
  }, [activeCategoryId, focusedBrandId, showPopular]);

  useEffect(() => {
    setSelectedCategoryResult(0);
  }, [categoryQuery]);

  useEffect(() => {
    if (!categorySearchOpen) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!categorySearchRef.current?.contains(event.target as Node)) {
        setCategorySearchOpen(false);
      }
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    return () => document.removeEventListener("pointerdown", closeOnOutsideClick);
  }, [categorySearchOpen]);

  const openCategory = (id: string) => {
    setShowPopular(false);
    setFocusedBrandId(null);
    setFocusedBrandName(null);
    setActiveCategoryId(id);
  };

  const selectBrand = (id: string, name: string) => {
    setShowPopular(false);
    setFocusedBrandId(id);
    setFocusedBrandName(name);
  };

  const finishCategorySearch = (categoryId?: string) => {
    if (categoryId) openCategory(categoryId);
    setCategoryQuery("");
    setCategorySearchOpen(false);
    categorySearchInputRef.current?.blur();
    requestAnimationFrame(() => document.getElementById("pos-barcode-input")?.focus());
  };

  const selectCategoryResult = (index = selectedCategoryResult) => {
    const result = categorySearchResults[index];
    if (result) finishCategorySearch(result.item.id);
  };

  const handleCategorySearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedCategoryResult((current) =>
        Math.min(current + 1, Math.max(0, categorySearchResults.length - 1)),
      );
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedCategoryResult((current) => Math.max(0, current - 1));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      selectCategoryResult();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      finishCategorySearch();
    }
  };

  const returnOneLevel = () => {
    if (focusedBrandId) {
      setFocusedBrandId(null);
      setFocusedBrandName(null);
    } else if (focusedCategory) {
      setActiveCategoryId(focusedCategory.parentId ?? null);
    }
  };

  const productRows = (
    <div className="relative w-full" style={{ height: rowVirtualizer.getTotalSize() }}>
      {rowVirtualizer.getVirtualItems().map((virtualRow) => {
        const row = rows[virtualRow.index];
        return (
          <div
            key={virtualRow.key}
            className="absolute left-0 top-0 grid w-full gap-1.5"
            style={{
              gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
              transform: `translateY(${virtualRow.start}px)`,
              height: `${virtualRow.size}px`,
              paddingBottom: GRID_GAP,
            }}
          >
            {row.map((key) => (
              <QuickKeyCard key={key.id} item={key} onAdd={addQuickKeyItem} />
            ))}
          </div>
        );
      })}
    </div>
  );

  return (
    <section className="relative flex min-h-0 min-w-0 flex-1 flex-col rounded-xl border border-slate-200 bg-white shadow-sm">
      <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-slate-200 px-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto scrollbar-hidden">
          {focusedCategory && !showPopular ? (
            <>
              <button
                type="button"
                onClick={returnOneLevel}
                aria-label="الرجوع مستوى واحد"
                title="الرجوع مستوى واحد"
                className="grid h-11 w-11 shrink-0 place-items-center rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => { setActiveCategoryId(null); setFocusedBrandId(null); setFocusedBrandName(null); }}
                className="flex h-11 shrink-0 items-center rounded-lg px-2.5 text-xs font-black text-slate-500 hover:bg-slate-50 hover:text-primary"
              >
                التصنيفات
              </button>
              {focusedPath.map((category) => (
                <span key={category.id} className="flex shrink-0 items-center gap-1">
                  <ChevronLeft className="h-3 w-3 text-slate-300" />
                  <button
                    type="button"
                    onClick={() => { openCategory(category.id); setFocusedBrandId(null); }}
                    className={`flex h-11 max-w-28 items-center truncate rounded-lg px-2.5 text-xs font-black ${
                      category.id === focusedCategory.id ? "text-slate-900" : "text-slate-500 hover:text-primary"
                    }`}
                  >
                    {category.name}
                  </button>
                </span>
              ))}
              {focusedBrandId && (
                <span className="flex shrink-0 items-center gap-1">
                  <ChevronLeft className="h-3 w-3 text-slate-300" />
                  <span className="max-w-28 truncate px-1 text-xs font-black text-slate-900">
                    {focusedBrandName || "العلامة"}
                  </span>
                </span>
              )}
            </>
          ) : (
            <span className="flex items-center gap-2 text-sm font-black text-slate-800">
              {showPopular ? <Sparkles className="h-4 w-4 text-amber-500" /> : <LayoutGrid className="h-4 w-4 text-primary" />}
              {showPopular ? "الأكثر طلبًا" : "التصنيفات"}
            </span>
          )}
        </div>

        <div ref={categorySearchRef} className="relative w-36 shrink-0 xl:w-44">
          <div className="flex h-11 items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2 transition focus-within:border-emerald-400 focus-within:bg-white focus-within:ring-2 focus-within:ring-emerald-100">
            <Search className="h-3.5 w-3.5 shrink-0 text-slate-400" />
            <input
              ref={categorySearchInputRef}
              value={categoryQuery}
              onFocus={() => setCategorySearchOpen(true)}
              onChange={(event) => {
                setCategoryQuery(event.target.value);
                setCategorySearchOpen(true);
              }}
              onKeyDown={handleCategorySearchKeyDown}
              autoComplete="off"
              placeholder="بحث فئة..."
              aria-label="البحث في التصنيفات"
              className="min-w-0 flex-1 bg-transparent text-sm font-bold text-slate-800 outline-none placeholder:text-slate-400"
            />
            {categoryQuery && (
              <button
                type="button"
                onClick={() => {
                  setCategoryQuery("");
                  categorySearchInputRef.current?.focus();
                }}
                aria-label="مسح بحث التصنيفات"
                title="مسح البحث"
                className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-slate-400 hover:bg-slate-200 hover:text-slate-700"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>

          {categorySearchOpen && categoryQuery.trim() && (
            <div className="absolute left-0 top-[calc(100%+8px)] z-50 w-72 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-2xl shadow-slate-900/15">
              {categorySearchResults.length > 0 ? (
                <div className="max-h-72 overflow-y-auto p-1.5">
                  {categorySearchResults.map((result, index) => {
                    const parentPath = result.pathNames.slice(0, -1).join(" ← ");
                    return (
                      <button
                        key={result.item.id}
                        type="button"
                        onMouseDown={(event) => event.preventDefault()}
                        onMouseEnter={() => setSelectedCategoryResult(index)}
                        onClick={() => finishCategorySearch(result.item.id)}
                        className={`flex min-h-12 w-full items-center gap-2 rounded-md px-3 py-2 text-start transition ${
                          index === selectedCategoryResult
                            ? "bg-emerald-50 text-emerald-900"
                            : "text-slate-700 hover:bg-slate-50"
                        }`}
                      >
                        <span
                          className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-white"
                          style={{ backgroundColor: result.item.bgColor ?? "#64748b" }}
                        >
                          <FolderOpen className="h-4 w-4" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-black">
                            {result.item.name}
                          </span>
                          <span className="mt-0.5 block truncate text-xs font-semibold text-slate-400">
                            {parentPath || "تصنيف رئيسي"}
                          </span>
                        </span>
                        <ChevronLeft className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="px-3 py-4 text-center text-xs font-bold text-slate-500">
                  لا توجد فئة مطابقة
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex shrink-0 rounded-lg bg-slate-100 p-1">
          <button
            type="button"
            onClick={() => {
              setShowPopular(false);
              setActiveCategoryId(null);
              setFocusedBrandId(null);
            }}
            aria-label="التصنيفات"
            title="التصنيفات"
            className={`grid h-11 w-11 place-items-center rounded-md ${
              !showPopular ? "bg-white text-primary shadow-sm" : "text-slate-500"
            }`}
          >
            <LayoutGrid className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => {
              setShowPopular(true);
              setActiveCategoryId(null);
              setFocusedBrandId(null);
            }}
            aria-label="الأكثر طلبًا"
            title="الأكثر طلبًا"
            className={`grid h-11 w-11 place-items-center rounded-md ${
              showPopular ? "bg-white text-amber-600 shadow-sm" : "text-slate-500"
            }`}
          >
            <Sparkles className="h-4 w-4" />
          </button>
        </div>
      </header>

      {!focusedCategory && !showPopular && <PinnedCategories />}

      {deferredQuickKeys.length === 0 ? (
        <div className="grid min-h-0 flex-1 place-items-center overflow-hidden rounded-b-xl p-4 text-center">
          <div>
            <PackageSearch className="mx-auto h-9 w-9 text-slate-300" />
            <p className="mt-2 text-sm font-black text-slate-700">لا توجد أصناف سريعة</p>
          </div>
        </div>
      ) : showPopular ? (
        <div ref={productScrollRef} className="min-h-0 flex-1 overflow-y-auto rounded-b-xl p-2">
          {productRows}
        </div>
      ) : !focusedCategory ? (
        rootCategories.length > 0 ? (
          <div className="min-h-0 flex-1 overflow-y-auto rounded-b-xl p-2">
            <div className="grid grid-cols-3 gap-1.5 xl:grid-cols-4">
              {rootCategories.map((category) => (
                <CategoryTile key={category.id} category={category} onOpen={openCategory} />
              ))}
            </div>
          </div>
        ) : (
          <div ref={productScrollRef} className="min-h-0 flex-1 overflow-y-auto rounded-b-xl p-2">
            {productRows}
          </div>
        )
      ) : !focusedBrandId ? (
        <div className="min-h-0 flex-1 overflow-y-auto rounded-b-xl p-2">
          {brandsInCategory.length > 0 ? (
            <div className="grid grid-cols-3 gap-1.5 xl:grid-cols-4">
              {brandsInCategory.map((brand) => (
                <BrandTile key={brand.brandId} brand={brand} onSelect={selectBrand} />
              ))}
            </div>
          ) : (
            <div className="grid h-full place-items-center text-center">
              <div>
                <Building2 className="mx-auto h-8 w-8 text-slate-300" />
                <p className="mt-2 text-xs font-bold text-slate-500">
                  لا توجد علامات تجارية في هذا التصنيف
                </p>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-b-xl">
          {visibleFolders.length > 0 && !focusedBrandId && (
            <div className="max-h-[140px] shrink-0 overflow-y-auto border-b border-slate-200 bg-slate-50/70 p-2">
              <div className="grid grid-cols-3 gap-1.5 xl:grid-cols-4">
                {visibleFolders.map((category) => (
                  <CategoryTile key={category.id} category={category} onOpen={openCategory} />
                ))}
              </div>
            </div>
          )}

          <div ref={productScrollRef} className="min-h-0 flex-1 overflow-y-auto p-2">
            {rows.length > 0 ? (
              productRows
            ) : (
              <div className="grid h-full place-items-center text-center">
                <div>
                  <PackageSearch className="mx-auto h-8 w-8 text-slate-300" />
                  <p className="mt-2 text-xs font-bold text-slate-500">
                    {visibleFolders.length > 0 ? "اختر قسمًا" : "لا توجد أصناف هنا"}
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
});
