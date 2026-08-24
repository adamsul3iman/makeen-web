"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ChevronDown,
  Download,
  FileUp,
  FilterX,
  FolderTree,
  History,
  Layers,
  PackagePlus,
  Pencil,
  RefreshCw,
  Trash2,
  X,
  Package,
  PackageOpen,
  Tag,
  Barcode,
} from "lucide-react";
import { formatMoney } from "@/lib/format";
import { flattenHierarchy } from "@/lib/categoryTree";
import {
  fetchPaginatedInventory,
  fetchAllInventoryForExport,
  exportInventoryToExcel,
  createCatalogReference,
  createInventoryProduct,
  updateInventoryProduct,
  deleteInventoryProduct,
  mergeVariants,
} from "@/lib/inventoryClient";
import { normalizeArabicText } from "@/lib/arabic";
import { getTenantStoreId } from "@/lib/tenantClient";
import { usePosStore } from "@/store/usePosStore";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import {
  AdminDataTable,
  AdminTableActions,
  type AdminDataTableColumn,
} from "@/components/ui/AdminDataTable";
import { PageHeader, StatCard } from "@/components/ui/Card";
import { ModalShell } from "@/components/ui/ModalShell";
import { Badge } from "@/components/ui/Badge";
import { SearchInput } from "@/components/admin/SearchInput";
import { StatCardSkeleton } from "@/components/ui/Skeleton";
import { ListPagination } from "@/components/admin/ListPagination";
import ProductModal, {
  type InventoryProduct,
  type ProductEntryDefaults,
  type ProductFormPayload,
  type ProductSaveOptions,
} from "@/components/admin/ProductModal";
import UnitsEditorModal from "@/components/admin/UnitsEditorModal";
import type { EntityOption } from "@/components/shared/EntityCombobox";
import EntityCombobox from "@/components/shared/EntityCombobox";

const PAGE_SIZE = 50;

interface ImportPreview {
  file: File;
  summary: {
    sourceKind: string;
    rows: number;
    products: number;
    categories: number;
    barcodes: number;
    warnings: number;
    preview: Array<{
      category: string;
      productName: string;
      barcode: string;
      sellingPrice: number;
      costPrice: number;
      totalStock: number;
    }>;
  };
  warnings: Array<{ row: number; message: string }>;
}

interface InventoryPageData {
  paginated: true;
  page: number;
  limit: number;
  total: number;
  items: InventoryProduct[];
  categories: Record<string, { id: string; name: string; parentId?: string | null; sortOrder?: number }>;
  brands: Record<string, { id: string; name: string }>;
  suppliers: Record<string, { id: string; name: string }>;
}

interface InventoryRefs {
  categories: EntityOption[];
  brands: EntityOption[];
  suppliers: EntityOption[];
}

interface InventoryVisibleRow {
  key: string;
  product: InventoryProduct;
  depth: number;
  isParent: boolean;
  aggregateStock: number;
  childCount: number;
}

type ImportPreviewRow = ImportPreview["summary"]["preview"][number];

const IMPORT_PREVIEW_COLUMNS: AdminDataTableColumn<ImportPreviewRow>[] = [
  { id: "product", header: "المنتج", cell: (row) => <span className="font-bold text-foreground">{row.productName}</span> },
  { id: "category", header: "الفئة", cell: (row) => <span className="text-muted">{row.category}</span> },
  { id: "barcode", header: "الباركود", cell: (row) => <span className="font-mono tabular-nums" dir="ltr">{row.barcode}</span> },
  { id: "price", header: "السعر", cell: (row) => <span className="tabular-nums">{formatMoney(row.sellingPrice)}</span> },
  { id: "cost", header: "التكلفة", cell: (row) => <span className="tabular-nums">{formatMoney(row.costPrice)}</span> },
  { id: "stock", header: "المخزون", cell: (row) => <span className="tabular-nums">{row.totalStock}</span> },
];

function buildRefs(data: InventoryPageData): InventoryRefs {
  const categoryTree = flattenHierarchy(
    Object.values(data.categories).map((item) => ({
      id: item.id,
      name: item.name,
      parentId: item.parentId ?? null,
      sortOrder: item.sortOrder ?? 0,
    })),
  );
  return {
    categories: categoryTree.map((node) => ({
      id: node.item.id,
      name: node.pathNames.join(" / "),
      description: node.depth > 0 ? `داخل ${node.pathNames.slice(0, -1).join(" / ")}` : "تصنيف رئيسي",
    })),
    brands: Object.values(data.brands).map((b) => ({ id: b.id, name: b.name })),
    suppliers: Object.values(data.suppliers).map((s) => ({ id: s.id, name: s.name })),
  };
}

const InventoryMobileCard = memo(function InventoryMobileCard({
  product,
  deletingId,
  onEdit,
  onDelete,
  depth,
  isParent,
  aggregateStock,
  childCount,
  expanded,
  onToggleExpand,
}: {
  product: InventoryProduct;
  deletingId: string | null;
  onEdit: (product: InventoryProduct) => void;
  onDelete: (id: string) => void;
  depth: number;
  isParent: boolean;
  aggregateStock: number;
  childCount: number;
  expanded: boolean;
  onToggleExpand: (id: string) => void;
}) {
  const firstVariant = product.variants[0];
  const expandable = isParent && childCount > 0;
  return (
    <article
      className={`rounded-xl border border-border bg-surface p-4 shadow-sm ${depth > 0 ? "bg-surface-muted/40" : ""}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          {expandable && (
            <button
              type="button"
              aria-expanded={expanded}
              aria-label={`عرض متغيرات ${product.name}`}
              onClick={() => onToggleExpand(product.id)}
              className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-md text-muted transition hover:bg-surface-muted hover:text-foreground"
            >
              <ChevronDown className={`h-4 w-4 transition-transform ${expanded ? "" : "-rotate-90"}`} />
            </button>
          )}
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <h2 className="truncate text-base font-black text-foreground">{product.name}</h2>
              {depth > 0 && product.variantLabel && (
                <Badge tone="primary">{product.variantLabel}</Badge>
              )}
              <Badge tone={product.showInPos ? "success" : "muted"}>
                {product.showInPos ? "POS" : "مخفي"}
              </Badge>
            </div>
            <p className="mt-1 text-xs font-bold text-muted">
              {product.category || "غير مصنف"}{product.brand ? ` • ${product.brand}` : ""}
            </p>
          </div>
        </div>
        <div className="shrink-0 text-end">
          {expandable ? (
            <>
              <span className="rounded-lg bg-surface-muted px-2.5 py-1 text-xs font-black tabular-nums text-foreground">
                {aggregateStock} {product.baseUnit}
              </span>
              <span className="mt-1 block text-xs font-black text-muted">مجموع {childCount} متغير</span>
            </>
          ) : (
            <span className="rounded-lg bg-surface-muted px-2.5 py-1 text-xs font-black tabular-nums text-muted">
              {product.stock} {product.baseUnit}
            </span>
          )}
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 text-xs font-bold text-muted">
        <div className="rounded-lg bg-surface-muted px-3 py-2">
          <span className="block text-xs text-muted">الوحدة</span>
          <span className="text-foreground">{product.baseUnit}</span>
        </div>
        <div className="rounded-lg bg-surface-muted px-3 py-2">
          <span className="block text-xs text-muted">الضريبة</span>
          <span className="tabular-nums text-foreground">
            {product.taxPercent}% {product.taxIncluded ? "شاملة" : "مضافة"}
          </span>
        </div>
      </div>

      {firstVariant && (
        <div className="mt-2 flex items-center justify-between gap-2 rounded-lg bg-surface-muted px-3 py-2 text-xs font-bold">
          <span className="min-w-0 truncate text-muted" dir="ltr">{firstVariant.barcode}</span>
          <span className="shrink-0 tabular-nums text-foreground">{formatMoney(firstVariant.price)}</span>
        </div>
      )}

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          aria-label={`تعديل ${product.name}`}
          onClick={() => onEdit(product)}
          className="flex h-10 flex-1 items-center justify-center gap-2 rounded-lg bg-primary/10 text-sm font-black text-primary transition hover:bg-primary/15"
        >
          <Pencil className="h-4 w-4" />
          تعديل
        </button>
        <button
          type="button"
          aria-label={`حذف ${product.name}`}
          onClick={() => onDelete(product.id)}
          disabled={deletingId === product.id}
          className="grid h-10 w-12 place-items-center rounded-lg bg-destructive/10 text-destructive transition hover:bg-destructive/15 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {deletingId === product.id ? (
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-destructive border-t-transparent" />
          ) : (
            <Trash2 className="h-4 w-4" />
          )}
        </button>
      </div>
    </article>
  );
});

export default function AdminInventoryPage() {
  const adminSession = usePosStore((s) => s.adminSession);
  const hydrateCatalog = usePosStore((s) => s.hydrateCatalog);

  const [page, setPage] = useState(1);
  const [searchQuery, setSearchQuery] = useState("");
  const debouncedSearch = useDebouncedValue(searchQuery, 400);
  const normalizedQuery = normalizeArabicText(debouncedSearch.trim());

  // ── Advanced filters ──────────────────────────────────────────────
  const [filterCategoryId, setFilterCategoryId] = useState("");
  const [filterBrandId, setFilterBrandId] = useState("");
  const [filterSupplierId, setFilterSupplierId] = useState("");
  const [filterStatus, setFilterStatus] = useState<"" | "active" | "inactive">("");
  const [filterLowStock, setFilterLowStock] = useState(false);
  const [exporting, setExporting] = useState(false);

  const [pageData, setPageData] = useState<InventoryPageData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const loadInventory = useCallback(async () => {
    if (!adminSession) return;
    setLoading(true);
    setLoadError(null);
    try {
      const data = await fetchPaginatedInventory({
        page,
        limit: PAGE_SIZE,
        search: normalizedQuery,
        categoryId: filterCategoryId || undefined,
        brandId: filterBrandId || undefined,
        supplierId: filterSupplierId || undefined,
        status: filterStatus || undefined,
        lowStock: filterLowStock || undefined,
      });
      setPageData(data);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "تعذر تحميل البيانات");
    } finally {
      setLoading(false);
    }
  }, [adminSession, page, normalizedQuery, filterCategoryId, filterBrandId, filterSupplierId, filterStatus, filterLowStock]);

  useEffect(() => { void loadInventory(); }, [loadInventory]);

  const data = pageData;
  const refetch = loadInventory;
  const mutate = loadInventory;

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<InventoryProduct | null>(null);
  // Phase 4 (UoM setup): parent product whose packaging tiers are being edited.
  const [unitsProduct, setUnitsProduct] = useState<{ id: string; name: string; baseUnit: string } | null>(null);
  const [entryDefaults, setEntryDefaults] = useState<ProductEntryDefaults | null>(null);
  const [newProductSequence, setNewProductSequence] = useState(0);
  const [importing, setImporting] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [pendingImport, setPendingImport] = useState<ImportPreview | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [importStatus, setImportStatus] = useState<{ tone: "success" | "error"; message: string } | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeParentName, setMergeParentName] = useState("");
  const [mergeBaseCost, setMergeBaseCost] = useState("");
  const [mergeBasePrice, setMergeBasePrice] = useState("");
  const [mergeBusy, setMergeBusy] = useState(false);
  const [mergeError, setMergeError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const productBatchDirtyRef = useRef(false);
  const batchSavedCountRef = useRef(0);

  const products = useMemo(() => data?.items ?? [], [data?.items]);
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const [references, setReferences] = useState<InventoryRefs>({ categories: [], brands: [], suppliers: [] });

  useEffect(() => {
    if (data) setReferences(buildRefs(data));
  }, [data]);

  useEffect(() => {
    setPage(1);
  }, [normalizedQuery, filterCategoryId, filterBrandId, filterSupplierId, filterStatus, filterLowStock]);

  const handleExportExcel = useCallback(async () => {
    if (!adminSession || exporting) return;
    setExporting(true);
    try {
      const all = await fetchAllInventoryForExport({
        search: normalizedQuery,
        categoryId: filterCategoryId || undefined,
        brandId: filterBrandId || undefined,
        supplierId: filterSupplierId || undefined,
        status: filterStatus || undefined,
        lowStock: filterLowStock || undefined,
      });
      const blob = await exportInventoryToExcel(all.items);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `المخزون-${new Date().toISOString().slice(0, 10)}.xlsx`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setImportStatus({
        tone: "error",
        message: err instanceof Error ? err.message : "تعذر تصدير الملف",
      });
    } finally {
      setExporting(false);
    }
  }, [adminSession, exporting, normalizedQuery, filterCategoryId, filterBrandId, filterSupplierId, filterStatus, filterLowStock]);

  const toggleExpand = useCallback((id: string) => {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  }, []);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const catalogModel = useMemo(() => {
    const byId = new Map<string, InventoryProduct>(products.map((p) => [p.id, p]));
    const childrenByParent = new Map<string, InventoryProduct[]>();
    for (const p of products) {
      if (p.parentId && byId.has(p.parentId)) {
        const siblings = childrenByParent.get(p.parentId);
        if (siblings) siblings.push(p);
        else childrenByParent.set(p.parentId, [p]);
      }
    }
    const aggregateByParent = new Map<string, number>();
    for (const [pid, children] of childrenByParent) {
      aggregateByParent.set(
        pid,
        children.reduce((sum, c) => sum + (c.isActive === false ? 0 : c.stock), 0),
      );
    }
    const topLevel = products.filter((p) => !(p.parentId && byId.has(p.parentId)));
    return { topLevel, childrenByParent, aggregateByParent };
  }, [products]);

  const selectableById = useMemo(() => {
    const set = new Set<string>();
    for (const p of catalogModel.topLevel) {
      const children = catalogModel.childrenByParent.get(p.id) ?? [];
      if (children.length === 0 && !p.isVariantRoot && !p.parentId) set.add(p.id);
    }
    return set;
  }, [catalogModel]);

  const visibleRows = useMemo(() => {
    const rows: InventoryVisibleRow[] = [];
    for (const p of catalogModel.topLevel) {
      const children = catalogModel.childrenByParent.get(p.id) ?? [];
      rows.push({
        key: p.id,
        product: p,
        depth: 0,
        isParent: children.length > 0,
        aggregateStock: catalogModel.aggregateByParent.get(p.id) ?? p.stock,
        childCount: children.length,
      });
      if (expanded[p.id] && children.length > 0) {
        for (const c of children) {
          rows.push({
            key: `child:${c.id}`,
            product: c,
            depth: 1,
            isParent: false,
            aggregateStock: c.stock,
            childCount: 0,
          });
        }
      }
    }
    return rows;
  }, [catalogModel, expanded]);

  const refreshEverywhere = useCallback(async () => {
    await mutate();
    await hydrateCatalog();
  }, [mutate, hydrateCatalog]);

  useEffect(() => {
    setSelectedIds((prev) => {
      const next = new Set([...prev].filter((id) => selectableById.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [selectableById]);

  const createReference = async (
    type: "category" | "brand" | "supplier",
    refData: { name: string; phone: string; parentId?: string | null },
  ): Promise<EntityOption> => {
    try {
      const result = await createCatalogReference(type === "supplier" ? "supplier" : type,
        type === "category"
          ? { name: refData.name, parentId: refData.parentId ?? null }
          : { name: refData.name }
      );
      const created = result.item;
      if (type === "category") {
        await mutate();
        return references.categories.find((option) => option.id === created.id) ?? created;
      }
      const targetKey = type === "brand" ? "brands" : "suppliers";
      setReferences((current) => ({
        ...current,
        [targetKey]: [...current[targetKey], created].sort((a, b) => a.name.localeCompare(b.name, "ar")),
      }));
      return created;
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : "تعذر إضافة السجل");
    }
  };

  const previewImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    e.target.value = "";
    setImportStatus({
      tone: "error",
      message: "ميزة الاستيراد ستكون متاحة قريباً — استخدم صفحة التصنيفات لإضافة المنتجات يدوياً",
    });
  };

  const commitImport = async () => {
    setPendingImport(null);
  };

  const openAdd = useCallback(() => {
    setEditing(null);
    setEntryDefaults(null);
    batchSavedCountRef.current = 0;
    productBatchDirtyRef.current = false;
    setNewProductSequence((value) => value + 1);
    setModalOpen(true);
  }, []);

  const openEdit = useCallback((product: InventoryProduct) => {
    setEditing(product);
    setEntryDefaults(null);
    batchSavedCountRef.current = 0;
    productBatchDirtyRef.current = false;
    setModalOpen(true);
  }, []);

  const syncCatalogInBackground = useCallback(() => {
    void hydrateCatalog().catch((error: unknown) => {
      setImportStatus({
        tone: "error",
        message:
          error instanceof Error
            ? `تم الحفظ، لكن تعذر تحديث نقطة البيع: ${error.message}`
            : "تم الحفظ، لكن تعذر تحديث نقطة البيع",
      });
    });
  }, [hydrateCatalog]);

  const closeProductModal = useCallback(() => {
    setModalOpen(false);
    setEditing(null);
    setEntryDefaults(null);
    if (productBatchDirtyRef.current) syncCatalogInBackground();
    productBatchDirtyRef.current = false;
    batchSavedCountRef.current = 0;
  }, [syncCatalogInBackground]);

  const handleDelete = useCallback(
    async (id: string) => {
      const product = products.find((p) => p.id === id);
      if (!product) return;
      if (!window.confirm(`حذف المنتج «${product.name}${product.variantLabel ? ` — ${product.variantLabel}` : ""}»؟`)) return;

    setDeletingId(id);
    setImportStatus(null);
    try {
      await deleteInventoryProduct(id);
      await refreshEverywhere();
      setImportStatus({ tone: "success", message: "تم حذف المنتج وتحديث نقطة البيع" });
    } catch (err) {
      setImportStatus({
        tone: "error",
        message: err instanceof Error ? err.message : "تعذر حذف المنتج",
      });
    } finally {
      setDeletingId(null);
    }
  },
  [products, refreshEverywhere],
);

  const openMergeModal = useCallback(() => {
    setMergeParentName("");
    setMergeBaseCost("");
    setMergeBasePrice("");
    setMergeError("");
    setMergeOpen(true);
  }, []);

  const submitMerge = async () => {
    const name = mergeParentName.trim();
    if (!name) { setMergeError("أدخل اسم الصنف الأم"); return; }
    const ids = [...selectedIds];
    if (ids.length < 2) { setMergeError("اختر صنفين فرعيين على الأقل"); return; }
    const parseMoney = (value: string): number | null => {
      const cleaned = value.trim().replace(/[،]/g, ".");
      if (cleaned === "") return null;
      const n = Number(cleaned);
      return Number.isFinite(n) && n >= 0 ? n : Number.NaN;
    };
    const baseCost = parseMoney(mergeBaseCost);
    const basePrice = parseMoney(mergeBasePrice);
    if (Number.isNaN(baseCost)) { setMergeError("سعر التكلفة الأساسي غير صالح"); return; }
    if (Number.isNaN(basePrice)) { setMergeError("سعر البيع الأساسي غير صالح"); return; }
    setMergeBusy(true);
    setMergeError("");
    try {
      const result = await mergeVariants({ parentName: name, baseCost, basePrice, productIds: ids });
      await refreshEverywhere();
      setMergeOpen(false);
      setSelectedIds(new Set());
      setImportStatus({
        tone: "success",
        message: `تم الدمج — أُنشئ الصنف الأم «${result?.parent?.parentName ?? name}» وربط ${ids.length} أصناف فرعية`,
      });
    } catch (err) {
      setMergeError(err instanceof Error ? err.message : "تعذر دمج الأصناف");
    } finally {
      setMergeBusy(false);
    }
  };

  const handleSave = async (payload: ProductFormPayload, options: ProductSaveOptions) => {
    const editedProduct = editing;
    try {
      const body = editedProduct
        ? { product: await updateInventoryProduct(editedProduct.id, payload) }
        : { product: await createInventoryProduct(payload) };
      if (!body?.product) throw new Error("حُفظ المنتج لكن لم تصل بياناته المحدثة");

      productBatchDirtyRef.current = true;
      batchSavedCountRef.current += 1;

      if (options.addAnother && !editedProduct) {
        setEntryDefaults(options.defaults);
        setEditing(null);
        setNewProductSequence((value) => value + 1);
        setImportStatus({
          tone: "success",
          message: `تم حفظ «${body.product.name}» — أدخل المنتج التالي`,
        });
        return;
      }

      const savedCount = batchSavedCountRef.current;
      setModalOpen(false);
      setEditing(null);
      setEntryDefaults(null);
      syncCatalogInBackground();
      productBatchDirtyRef.current = false;
      batchSavedCountRef.current = 0;
      setImportStatus({
        tone: "success",
        message: editedProduct
          ? "تم تعديل المنتج، ويجري تحديث نقطة البيع في الخلفية"
          : savedCount > 1
            ? `تم حفظ ${savedCount} منتجات، ويجري تحديث نقطة البيع في الخلفية`
            : "تمت إضافة المنتج، ويجري تحديث نقطة البيع في الخلفية",
      });
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : "تعذر حفظ المنتج");
    }
  };

  const inventoryColumns = useMemo<AdminDataTableColumn<InventoryVisibleRow>[]>(() => [
    {
      id: "select",
      header: <span className="sr-only">اختيار للدمج</span>,
      align: "center",
      headerClassName: "w-12",
      cellClassName: "w-12",
      cell: ({ product }) => selectableById.has(product.id) ? (
        <input
          type="checkbox"
          checked={selectedIds.has(product.id)}
          onChange={() => toggleSelect(product.id)}
          aria-label={`اختيار ${product.name} للدمج`}
          className="h-4 w-4 accent-primary"
        />
      ) : null,
    },
    {
      id: "product",
      header: "المنتج",
      cell: (row) => {
        const { product } = row;
        const expandable = row.isParent && row.childCount > 0;
        const isExpanded = Boolean(expanded[product.id]);
        return (
          <div className="flex items-start gap-2" style={{ paddingInlineStart: row.depth * 28 }}>
            {expandable ? (
              <button
                type="button"
                aria-expanded={isExpanded}
                aria-label={`عرض متغيرات ${product.name}`}
                onClick={() => toggleExpand(product.id)}
                className="grid h-9 w-9 shrink-0 place-items-center rounded-md text-muted transition hover:bg-surface-muted hover:text-foreground"
              >
                <ChevronDown className={`h-4 w-4 transition-transform ${isExpanded ? "" : "-rotate-90"}`} />
              </button>
            ) : (
              <span className="w-9 shrink-0" />
            )}
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-bold text-foreground">{product.name}</span>
                {row.depth > 0 && product.variantLabel ? <Badge tone="primary">{product.variantLabel}</Badge> : null}
              </div>
              <Badge tone={product.showInPos ? "success" : "muted"} className="mt-1">
                {product.showInPos ? "يظهر في نقطة البيع" : "مخفي عن نقطة البيع"}
              </Badge>
            </div>
          </div>
        );
      },
    },
    {
      id: "category",
      header: "الفئة",
      cell: ({ product }) => <span className="text-muted">{product.category || "غير مصنف"}</span>,
    },
    {
      id: "base-unit",
      header: "الوحدة الأساسية",
      cell: ({ product }) => <span className="tabular-nums text-muted">{product.baseUnit}</span>,
    },
    {
      id: "variants",
      header: "وحدات الباركود",
      cell: ({ product }) => <Badge tone="default">{product.variants.length} وحدة</Badge>,
    },
    {
      id: "stock",
      header: "إجمالي المخزون",
      cell: (row) => row.isParent && row.childCount > 0 ? (
        <div className="tabular-nums">
          <div className="font-black text-foreground">{row.aggregateStock}</div>
          <div className="mt-0.5 text-xs font-black text-muted">مجموع {row.childCount} متغير</div>
        </div>
      ) : <span className="font-black tabular-nums">{row.product.stock}</span>,
    },
    {
      id: "actions",
      header: "إجراءات",
      action: true,
      cell: (row) => (
        <AdminTableActions>
          <button
            type="button"
            aria-label={`تعديل ${row.product.name}`}
            onClick={() => openEdit(row.product)}
            className="grid h-9 w-9 place-items-center rounded-lg text-primary transition hover:bg-primary/10"
          >
            <Pencil className="h-4 w-4" />
          </button>
          {row.isParent && (
            <button
              type="button"
              aria-label={`وحدات التغليف — ${row.product.name}`}
              title="وحدات التغليف (كرتون / قطعة)"
              onClick={() =>
                setUnitsProduct({ id: row.product.id, name: row.product.name, baseUnit: row.product.baseUnit })
              }
              className="grid h-9 w-9 place-items-center rounded-lg text-primary transition hover:bg-primary/10"
            >
              <PackageOpen className="h-4 w-4" />
            </button>
          )}
          <button
            type="button"
            aria-label={`حذف ${row.product.name}`}
            onClick={() => handleDelete(row.product.id)}
            disabled={deletingId === row.product.id}
            className="grid h-9 w-9 place-items-center rounded-lg text-destructive transition hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {deletingId === row.product.id ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-destructive border-t-transparent" /> : <Trash2 className="h-4 w-4" />}
          </button>
        </AdminTableActions>
      ),
    },
  ], [deletingId, expanded, handleDelete, openEdit, selectableById, selectedIds, toggleExpand, toggleSelect]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="المخزون والمنتجات"
        subtitle="إدارة الأصناف ووحدات التغليف والباركود من قاعدة بيانات المتجر النشط"
        action={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void refetch()}
              disabled={loading}
              className="flex h-10 items-center justify-center gap-2 rounded-lg border border-border bg-surface px-4 text-sm font-black text-muted transition hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
              تحديث
            </button>
            <button
              type="button"
              onClick={openAdd}
              className="flex h-10 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-black text-primary-foreground shadow-sm transition hover:bg-primary-hover"
            >
              <PackagePlus className="h-4 w-4" />
              إضافة منتج
            </button>
          </div>
        }
      />

      {loading && (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => <StatCardSkeleton key={i} />)}
        </div>
      )}

      {data && (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4 animate-pos-pop-in">
          <StatCard
            label="المنتجات"
            value={total.toLocaleString("ar-JO")}
            icon={Package}
            tone="primary"
          />
          <StatCard
            label="المنتجات في الصفحة"
            value={String(products.length)}
            icon={Barcode}
          />
          <StatCard
            label="التصنيفات"
            value={String(references.categories.length)}
            icon={FolderTree}
          />
          <StatCard
            label="العلامات التجارية"
            value={String(references.brands.length)}
            icon={Tag}
          />
        </div>
      )}

      {loadError && !loading && (
        <div className="rounded-2xl border border-destructive/20 bg-destructive/10 p-6 text-sm font-bold text-destructive">
          {loadError}
        </div>
      )}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <SearchInput
          value={searchQuery}
          onChange={setSearchQuery}
          placeholder="ابحث بالاسم أو التصنيف أو العلامة التجارية..."
          className="sm:max-w-md"
        />
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv,.xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
            className="hidden"
            onChange={previewImportFile}
          />
          <button
            type="button"
            onClick={() => void handleExportExcel()}
            disabled={exporting || loading}
            className="flex h-10 items-center justify-center gap-2 rounded-lg border border-primary/20 bg-success/10 px-3 text-sm font-bold text-success transition hover:bg-success/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Download className={`h-4 w-4 ${exporting ? "animate-bounce" : ""}`} />
            تصدير Excel
          </button>
          <Link
            href="/admin/categories"
            className="flex h-10 items-center justify-center gap-2 rounded-lg border border-border bg-surface px-3 text-sm font-bold text-muted transition hover:bg-surface-muted hover:text-foreground"
          >
            <FolderTree className="h-4 w-4" />
            التصنيفات
          </Link>
          <Link
            href="/admin/inventory/movements"
            className="flex h-10 items-center justify-center gap-2 rounded-lg border border-border bg-surface px-3 text-sm font-bold text-muted transition hover:bg-surface-muted hover:text-foreground"
          >
            <History className="h-4 w-4" />
            الحركات
          </Link>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={importing || previewing}
            className="flex h-10 items-center justify-center gap-2 rounded-lg border border-border bg-surface px-3 text-sm font-bold text-muted transition hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            <FileUp className="h-4 w-4" />
            استيراد
          </button>
          <button
            type="button"
            onClick={openMergeModal}
            disabled={selectedIds.size < 2}
            className="flex h-10 items-center justify-center gap-2 rounded-lg border border-border bg-surface px-3 text-sm font-bold text-muted transition hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Layers className="h-4 w-4" />
            دمج
            {selectedIds.size > 0 && (
              <Badge tone="primary" className="ms-1">{selectedIds.size}</Badge>
            )}
          </button>
        </div>
      </div>

      {/* ── Advanced filter bar ─────────────────────────────────────── */}
      <div className="flex flex-wrap items-end gap-2 rounded-xl border border-border bg-surface p-3">
        <div className="flex min-w-36 flex-1 flex-col gap-1">
          <span className="text-xs font-bold text-muted">التصنيف</span>
          <EntityCombobox
            id="filter-category"
            value={filterCategoryId}
            options={references.categories}
            placeholder="كل التصنيفات"
            emptyLabel="لا توجد تصنيفات"
            size="sm"
            onChange={setFilterCategoryId}
          />
        </div>
        <div className="flex min-w-32 flex-1 flex-col gap-1">
          <span className="text-xs font-bold text-muted">العلامة التجارية</span>
          <EntityCombobox
            id="filter-brand"
            value={filterBrandId}
            options={references.brands}
            placeholder="كل العلامات"
            emptyLabel="لا توجد علامات"
            size="sm"
            onChange={setFilterBrandId}
          />
        </div>
        <div className="flex min-w-32 flex-1 flex-col gap-1">
          <span className="text-xs font-bold text-muted">المورد</span>
          <EntityCombobox
            id="filter-supplier"
            value={filterSupplierId}
            options={references.suppliers}
            placeholder="كل الموردين"
            emptyLabel="لا يوجد موردون"
            size="sm"
            onChange={setFilterSupplierId}
          />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs font-bold text-muted">الحالة</span>
          <div className="flex h-9 overflow-hidden rounded-lg border border-border">
            {([
              ["", "الكل"],
              ["active", "نشط"],
              ["inactive", "موقوف"],
            ] as const).map(([value, label]) => (
              <button
                key={value || "all"}
                type="button"
                onClick={() => setFilterStatus(value)}
                className={`px-3 text-xs font-black transition ${
                  filterStatus === value
                    ? "bg-primary text-primary-foreground"
                    : "bg-background text-muted hover:bg-surface-muted"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-border bg-background px-3 py-2">
          <input
            type="checkbox"
            checked={filterLowStock}
            onChange={(e) => setFilterLowStock(e.target.checked)}
            className="h-4 w-4 accent-destructive"
          />
          <span className="text-xs font-black text-destructive">مخزون منخفض فقط</span>
        </label>
        {(filterCategoryId || filterBrandId || filterSupplierId || filterStatus || filterLowStock) && (
          <button
            type="button"
            onClick={() => {
              setFilterCategoryId("");
              setFilterBrandId("");
              setFilterSupplierId("");
              setFilterStatus("");
              setFilterLowStock(false);
            }}
            className="flex h-9 items-center gap-1.5 rounded-lg border border-destructive/20 bg-destructive/5 px-3 text-xs font-black text-destructive transition hover:bg-destructive/10"
          >
            <FilterX className="h-3.5 w-3.5" />
            مسح الفلاتر
          </button>
        )}
      </div>

      {importStatus && (
        <div
          className={`flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold ${
            importStatus.tone === "success"
              ? "bg-success/10 text-success"
              : "bg-destructive/10 text-destructive"
          }`}
        >
          <span className="flex-1">{importStatus.message}</span>
          <button
            type="button"
            onClick={() => setImportStatus(null)}
            className="grid h-6 w-6 place-items-center rounded text-current opacity-60 transition hover:opacity-100"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {pendingImport && (
        <section className="rounded-2xl border border-primary/20 bg-primary/5 p-4 shadow-sm">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <p className="text-sm font-black text-primary">معاينة قبل الاعتماد</p>
              <h2 className="mt-1 text-lg font-black text-foreground">{pendingImport.file.name}</h2>
              <div className="mt-3 flex flex-wrap gap-2 text-xs font-bold text-muted">
                <Badge>منتجات: {pendingImport.summary.products}</Badge>
                <Badge>باركودات: {pendingImport.summary.barcodes}</Badge>
                <Badge>فئات: {pendingImport.summary.categories}</Badge>
                {pendingImport.summary.warnings > 0 && (
                  <Badge tone="warning">تحذيرات: {pendingImport.summary.warnings}</Badge>
                )}
                <span dir="ltr"><Badge tone="muted">{pendingImport.summary.sourceKind}</Badge></span>
              </div>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setPendingImport(null)}
                disabled={importing}
                className="h-10 rounded-lg border border-border bg-surface px-4 text-sm font-bold text-muted transition hover:bg-surface-muted disabled:opacity-50"
              >
                إلغاء
              </button>
              <button
                type="button"
                onClick={() => void commitImport()}
                disabled={importing}
                className="flex h-10 items-center justify-center gap-2 rounded-lg bg-success px-5 text-sm font-black text-success-foreground transition hover:bg-success-hover disabled:opacity-50"
              >
                {importing && <span className="h-4 w-4 animate-spin rounded-full border-2 border-success-foreground border-t-transparent" />}
                اعتماد الاستيراد
              </button>
            </div>
          </div>

          <AdminDataTable
            className="mt-4"
            caption="معاينة المنتجات المستوردة"
            columns={IMPORT_PREVIEW_COLUMNS}
            rows={pendingImport.summary.preview.slice(0, 10)}
            getRowKey={(row, index) => `${row.productName}-${row.barcode}-${index}`}
            density="compact"
            viewportClassName="max-h-64"
            tableClassName="min-w-[680px] text-xs"
          />

          {pendingImport.warnings.length > 0 && (
            <p className="mt-3 text-xs font-bold text-warning-strong">
              أول تحذير: السطر {pendingImport.warnings[0].row} — {pendingImport.warnings[0].message}
            </p>
          )}
        </section>
      )}

      <section className="md:hidden">
        {loading && (
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="rounded-xl border border-border bg-surface p-4">
                <div className="flex items-start gap-3">
                  <div className="h-5 w-5 animate-pulse rounded bg-surface-muted" />
                  <div className="flex-1 space-y-2">
                    <div className="h-4 w-3/4 animate-pulse rounded bg-surface-muted" />
                    <div className="h-3 w-1/2 animate-pulse rounded bg-surface-muted" />
                  </div>
                  <div className="h-6 w-16 animate-pulse rounded bg-surface-muted" />
                </div>
              </div>
            ))}
          </div>
        )}
        {!loading && loadError && (
          <div className="rounded-xl border border-destructive/20 bg-destructive/10 p-6 text-center text-sm font-bold text-destructive">
            {loadError}
          </div>
        )}
        {!loading && !loadError && visibleRows.length === 0 && (
          <div className="rounded-xl border border-border bg-surface p-6 text-center text-sm font-bold text-muted">
            {normalizedQuery ? "لا توجد نتائج مطابقة للبحث" : "لا توجد منتجات محفوظة لهذا المتجر بعد"}
          </div>
        )}
        {!loading && !loadError && visibleRows.length > 0 && (
          <div className="space-y-3">
            {visibleRows.map((row) => (
              <InventoryMobileCard
                key={row.key}
                product={row.product}
                deletingId={deletingId}
                onEdit={openEdit}
                onDelete={handleDelete}
                depth={row.depth}
                isParent={row.isParent}
                aggregateStock={row.aggregateStock}
                childCount={row.childCount}
                expanded={Boolean(expanded[row.product.id])}
                onToggleExpand={toggleExpand}
              />
            ))}
          </div>
        )}
      </section>

      <AdminDataTable
        className="hidden md:block"
        caption="المخزون والمنتجات"
        columns={inventoryColumns}
        rows={visibleRows}
        getRowKey={(row) => row.key}
        loading={loading}
        loadingRows={8}
        viewportClassName="max-h-[calc(100dvh-20rem)]"
        tableClassName="min-w-[920px]"
        rowClassName={(row) => row.depth > 0 ? "bg-surface-muted/40" : ""}
        emptyState={loadError ? <span className="text-destructive">{loadError}</span> : normalizedQuery ? "لا توجد نتائج مطابقة للبحث" : "لا توجد منتجات محفوظة لهذا المتجر بعد"}
        footer={(
          <ListPagination
            page={page}
            totalPages={totalPages}
            total={total}
            pageSize={PAGE_SIZE}
            onPageChange={setPage}
          />
        )}
      />

      {mergeOpen && (
        <ModalShell
          title="دمج كأصناف فرعية"
          description={`إنشاء صنف أم وربط ${selectedIds.size} من الأصناف المختارة تحته`}
          size="lg"
          dismissible={false}
          showClose
          onClose={() => !mergeBusy && setMergeOpen(false)}
          footer={
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setMergeOpen(false)}
                disabled={mergeBusy}
                className="h-11 rounded-lg border border-border bg-white px-4 text-sm font-black text-muted transition hover:bg-surface-muted disabled:opacity-50"
              >
                إلغاء
              </button>
              <button
                type="button"
                onClick={() => void submitMerge()}
                disabled={mergeBusy || selectedIds.size < 2}
                className="flex h-11 items-center justify-center gap-2 rounded-lg bg-primary px-5 text-sm font-black text-primary-foreground transition hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                {mergeBusy && <span className="h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground border-t-transparent" />}
                {mergeBusy ? "جارٍ الدمج..." : `دمج ${selectedIds.size} أصناف`}
              </button>
            </div>
          }
        >
          <div className="space-y-4">
            <div>
              <label className="mb-1.5 block text-xs font-black text-muted">اسم الصنف الأم *</label>
              <input
                type="text"
                value={mergeParentName}
                onChange={(e) => setMergeParentName(e.target.value)}
                placeholder="مثال: معطر جو 300مل"
                className="h-11 w-full rounded-lg border border-border bg-white px-3 text-sm font-bold text-foreground placeholder:text-muted focus:border-primary focus:outline-none"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1.5 block text-xs font-black text-muted">سعر تكلفة أساسي (اختياري)</label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={mergeBaseCost}
                  onChange={(e) => setMergeBaseCost(e.target.value)}
                  placeholder="مثال: 3"
                  className="h-11 w-full rounded-lg border border-border bg-white px-3 text-sm font-bold tabular-nums text-foreground placeholder:text-muted focus:border-primary focus:outline-none"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-black text-muted">سعر بيع أساسي (اختياري)</label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={mergeBasePrice}
                  onChange={(e) => setMergeBasePrice(e.target.value)}
                  placeholder="مثال: 6"
                  className="h-11 w-full rounded-lg border border-border bg-white px-3 text-sm font-bold tabular-nums text-foreground placeholder:text-muted focus:border-primary focus:outline-none"
                />
              </div>
            </div>

            <div>
              <p className="mb-1.5 text-xs font-black text-muted">الأصناف الفرعية المختارة ({selectedIds.size})</p>
              <div className="flex flex-wrap gap-1.5">
                {products
                  .filter((p) => selectedIds.has(p.id))
                  .map((p) => (
                    <Badge key={p.id} tone="primary">{p.name}</Badge>
                  ))}
              </div>
            </div>

            {mergeError && (
              <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm font-bold text-destructive">
                {mergeError}
              </p>
            )}
          </div>
        </ModalShell>
      )}

      {modalOpen && (
        <ProductModal
          key={editing?.id ?? `new-product-${newProductSequence}`}
          initial={editing}
          entryDefaults={editing ? null : entryDefaults}
          referenceOptions={references}
          onCreateReference={createReference}
          onClose={closeProductModal}
          onSave={handleSave}
        />
      )}

      {unitsProduct && (
        <UnitsEditorModal
          key={unitsProduct.id}
          productId={unitsProduct.id}
          productName={unitsProduct.name}
          baseUnit={unitsProduct.baseUnit}
          storeId={getTenantStoreId() ?? ""}
          onClose={() => {
            setUnitsProduct(null);
            // Unit chips in POS re-price from the catalog snapshot; converge.
            void hydrateCatalog();
            void refetch();
          }}
        />
      )}
    </div>
  );
}
