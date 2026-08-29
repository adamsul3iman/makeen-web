"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentPropsWithRef, type CSSProperties, type FormEvent } from "react";
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ArrowUpRight,
  Barcode,
  Building2,
  Check,
  CheckCheck,
  ChevronLeft,
  Eye,
  EyeOff,
  FolderTree,
  GripVertical,
  LayoutGrid,
  List,
  Loader2,
  Menu,
  Package,
  PackageOpen,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Tags,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import { buildChildrenByParent, collectDescendantIds, flattenHierarchy } from "@/lib/categoryTree";
import { normalizeArabicText } from "@/lib/arabic";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Input } from "@/components/ui/Input";
import { ModalShell } from "@/components/ui/ModalShell";
import ConfirmDialog from "@/components/ui/ConfirmDialog";
import { PageHeader, StatCard } from "@/components/ui/Card";
import EntityCombobox, { type EntityOption } from "@/components/shared/EntityCombobox";
import { formatMoney } from "@/lib/format";
import {
  fetchTaxonomy,
  fetchCategoryProducts,
  saveCategory,
  deleteCategory,
  toggleCategoryVisibility,
  reorderCategories,
  saveBrand,
  deleteBrand,
  renameCategory,
  renameBrand,
  toggleCategoriesVisibility,
  deleteCategories,
  deleteBrands,
  type CategoryProductItem,
} from "@/lib/categoriesClient";

interface CategoryReferenceItem {
  id: string;
  name: string;
  productCount: number;
  parentId: string | null;
  childCount: number;
  bgColor: string | null;
  sortOrder: number;
  showInPos: boolean;
}

interface BrandReferenceItem {
  id: string;
  name: string;
  productCount: number;
}

type Panel = "categories" | "brands";
type BrandSort = "name" | "products";

interface ItemSelection {
  ids: Set<string>;
  set: (id: string, on: boolean) => void;
  toggle: (id: string) => void;
  clear: () => void;
}

const CATEGORY_FALLBACK_COLORS = ["#2563eb", "#0d9488", "#7c3aed", "#d97706"];

function useSelection(): ItemSelection {
  const [ids, setIds] = useState<Set<string>>(new Set());
  const set = useCallback((id: string, on: boolean) => {
    setIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const toggle = useCallback((id: string) => {
    setIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const clear = useCallback(() => setIds(new Set()), []);
  return { ids, set, toggle, clear };
}

/* ─────────────────────────── Inline renamable name ─────────────────────── */

function InlineRename({
  value,
  saving,
  onSave,
  onCancel,
}: {
  value: string;
  saving: boolean;
  onSave: (next: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const commit = () => {
    const next = draft.trim();
    if (next && next !== value) onSave(next);
    else onCancel();
  };

  const handleKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") commit();
    else if (e.key === "Escape") onCancel();
  };

  return (
    <span className="flex min-w-0 flex-1 items-center gap-1.5">
      <Input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={handleKey}
        className="h-8 flex-1 rounded-lg px-2 text-sm font-black"
        disabled={saving}
      />
      {saving && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />}
    </span>
  );
}

/* ───────────────────────────── Category tree row ───────────────────────── */

interface CategoryRowProps {
  category: CategoryReferenceItem;
  depth: number;
  expanded: boolean;
  expandable: boolean;
  selected: boolean;
  editing: boolean;
  saving: boolean;
  renameSaving: boolean;
  isDragging?: boolean;
  rowRef?: (element: HTMLElement | null) => void;
  rowStyle?: CSSProperties;
  handleProps?: ComponentPropsWithRef<"button">;
  onToggleExpand: (category: CategoryReferenceItem) => void;
  onSelect: (category: CategoryReferenceItem) => void;
  onAddChild: (parentId: string) => void;
  onStartEdit: (category: CategoryReferenceItem) => void;
  onDelete: (category: CategoryReferenceItem) => void;
  onToggleVisibility: (category: CategoryReferenceItem) => void;
  onRename: (category: CategoryReferenceItem, name: string) => void;
  onCancelRename: () => void;
}

function CategoryRow({
  category,
  depth,
  expanded,
  expandable,
  selected,
  editing,
  saving,
  renameSaving,
  isDragging = false,
  rowRef,
  rowStyle,
  handleProps,
  onToggleExpand,
  onSelect,
  onAddChild,
  onStartEdit,
  onDelete,
  onToggleVisibility,
  onRename,
  onCancelRename,
}: CategoryRowProps) {
  const hasChildren = category.childCount > 0;
  const indent = Math.min(depth, 6);

  return (
    <div
      ref={rowRef}
      style={rowStyle}
      className={cn(
        "group flex min-w-0 items-center gap-1.5 rounded-xl border px-2 py-2 transition-colors",
        selected
          ? "border-primary/40 bg-primary/5 ring-1 ring-primary/20"
          : "border-slate-200 bg-white hover:border-primary/30",
        !category.showInPos ? "opacity-60" : "",
        isDragging ? "relative z-10 border-primary/60 shadow-lg" : "",
      )}
    >
      {indent > 0 && <span aria-hidden className="h-px w-3 shrink-0 bg-slate-200" style={{ marginInlineStart: indent * 0.75 }} />}

      <button
        type="button"
        onClick={() => onSelect(category)}
        title={selected ? "إلغاء التحديد" : "تحديد للعمليات الجماعية"}
        aria-label={selected ? `إلغاء تحديد ${category.name}` : `تحديد ${category.name}`}
        className={cn(
          "grid h-6 w-6 shrink-0 place-items-center rounded-md border transition",
          selected ? "border-primary bg-primary text-primary-foreground" : "border-slate-300 bg-white hover:border-primary",
        )}
      >
        {selected && <Check className="h-3.5 w-3.5" />}
      </button>

      {handleProps && (
        <button
          type="button"
          aria-label={`إعادة ترتيب ${category.name}`}
          title="اسحب للترتيب"
          className="grid h-8 w-5 shrink-0 cursor-grab touch-none place-items-center rounded-md text-slate-300 transition hover:bg-slate-100 hover:text-slate-500 active:cursor-grabbing"
          {...handleProps}
        >
          <GripVertical className="h-4 w-4" />
        </button>
      )}

      <button
        type="button"
        onClick={() => expandable && onToggleExpand(category)}
        aria-label={expanded ? `طيّ ${category.name}` : `توسيع ${category.name}`}
        className={cn(
          "grid h-7 w-7 shrink-0 place-items-center rounded-md transition",
          expandable ? "text-muted hover:bg-slate-100 hover:text-foreground" : "cursor-default text-transparent hover:text-slate-300",
        )}
      >
        <ChevronLeft className={cn("h-4 w-4 transition-transform", expanded ? "-rotate-90" : "")} />
      </button>

      <span
        aria-hidden
        className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-white"
        style={{ backgroundColor: category.bgColor ?? CATEGORY_FALLBACK_COLORS[depth % CATEGORY_FALLBACK_COLORS.length] }}
      >
        <FolderTree className="h-4 w-4" />
      </span>

      {editing ? (
        <InlineRename value={category.name} saving={renameSaving} onSave={(n) => onRename(category, n)} onCancel={onCancelRename} />
      ) : (
        <button
          type="button"
          onClick={() => expandable && onToggleExpand(category)}
          className="flex min-w-0 flex-1 items-center gap-2 text-start"
        >
          <span className="min-w-0">
            <span className="block truncate text-sm font-black text-foreground">{category.name}</span>
            {!category.showInPos && (
              <span className="mt-0.5 block text-[10px] font-bold text-amber-600">مخفي عن نقطة البيع</span>
            )}
          </span>
        </button>
      )}

      <div className="flex shrink-0 items-center gap-1.5">
        {!editing && (
          <>
            <Badge tone={hasChildren ? "primary" : "default"}>
              {hasChildren ? (
                <>
                  <Tags className="h-3 w-3" />
                  {category.childCount.toLocaleString("ar-JO")} أقسام
                </>
              ) : (
                <>
                  <Package className="h-3 w-3" />
                  {category.productCount.toLocaleString("ar-JO")} منتجات
                </>
              )}
            </Badge>

            <button
              type="button"
              onClick={() => onToggleVisibility(category)}
              aria-label={category.showInPos ? `إخفاء ${category.name} من نقطة البيع` : `إظهار ${category.name} في نقطة البيع`}
              title={category.showInPos ? "إخفاء من نقطة البيع" : "إظهار في نقطة البيع"}
              className={cn(
                "grid h-9 w-9 place-items-center rounded-lg transition",
                category.showInPos ? "text-slate-400 hover:bg-slate-100 hover:text-slate-600" : "text-amber-500 hover:bg-amber-50 hover:text-amber-600",
              )}
            >
              {category.showInPos ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>

            <button
              type="button"
              onClick={() => onAddChild(category.id)}
              aria-label={`إضافة قسم داخل ${category.name}`}
              title="إضافة قسم داخله"
              className="grid h-9 w-9 place-items-center rounded-lg text-success transition hover:bg-success/10"
            >
              <Plus className="h-4 w-4" />
            </button>

            <button
              type="button"
              onClick={() => onStartEdit(category)}
              aria-label={`تعديل ${category.name}`}
              title="تعديل"
              className="grid h-9 w-9 place-items-center rounded-lg text-primary transition hover:bg-primary/10"
            >
              <Pencil className="h-4 w-4" />
            </button>

            <button
              type="button"
              onClick={() => onDelete(category)}
              disabled={saving}
              aria-label={`حذف ${category.name}`}
              title="حذف"
              className="grid h-9 w-9 place-items-center rounded-lg text-destructive transition hover:bg-destructive/10 disabled:opacity-40"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function SortableCategoryRow(props: Omit<CategoryRowProps, "isDragging" | "rowRef" | "rowStyle" | "handleProps">) {
  const { attributes, isDragging, listeners, setNodeRef, setActivatorNodeRef, transform, transition } = useSortable({
    id: props.category.id,
    disabled: props.editing,
  });
  const handleProps: ComponentPropsWithRef<"button"> = {
    ref: setActivatorNodeRef,
    ...attributes,
    ...(listeners ?? {}),
  };
  return (
    <CategoryRow
      {...props}
      isDragging={isDragging}
      rowRef={setNodeRef}
      rowStyle={{ transform: CSS.Translate.toString(transform), transition }}
      handleProps={handleProps}
    />
  );
}

/* ─────────────────────────── Recursive tree node ───────────────────────── */

interface TreeNodeProps {
  category: CategoryReferenceItem;
  depth: number;
  expandedIds: Set<string>;
  editingId: string | null;
  selectedIds: Set<string>;
  saving: boolean;
  renameSaving: boolean;
  hasActiveSearch: boolean;
  childrenByParent: Map<string, CategoryReferenceItem[]>;
  sensors: ReturnType<typeof useSensors>;
  leafProductsByCategory: Record<string, CategoryProductItem[]>;
  leafLoadingId: string | null;
  onToggleExpand: (category: CategoryReferenceItem) => void;
  onSelect: (category: CategoryReferenceItem) => void;
  onAddChild: (parentId: string) => void;
  onStartEdit: (category: CategoryReferenceItem) => void;
  onDelete: (category: CategoryReferenceItem) => void;
  onToggleVisibility: (category: CategoryReferenceItem) => void;
  onRename: (category: CategoryReferenceItem, name: string) => void;
  onCancelRename: () => void;
  onDragEnd: (event: DragEndEvent) => void;
}

function TreeNode({
  category,
  depth,
  expandedIds,
  editingId,
  selectedIds,
  saving,
  renameSaving,
  hasActiveSearch,
  childrenByParent,
  sensors,
  leafProductsByCategory,
  leafLoadingId,
  onToggleExpand,
  onSelect,
  onAddChild,
  onStartEdit,
  onDelete,
  onToggleVisibility,
  onRename,
  onCancelRename,
  onDragEnd,
}: TreeNodeProps) {
  const expanded = expandedIds.has(category.id);
  const children = (childrenByParent.get(category.id) ?? []).slice();
  const isLeaf = children.length === 0 && category.childCount === 0;
  const expandable = children.length > 0 || isLeaf;
  const showChildren = hasActiveSearch || expanded;

  // Direct products of THIS node (not inherited from children). Loaded on
  // demand via leafProductsByCategory keyed by category id.
  const nodeProducts = leafProductsByCategory[category.id] ?? null;
  const nodeLoading = leafLoadingId === category.id;
  const hasDirectProducts = (nodeProducts ?? []).length > 0;

  // Show the inline product list for any visible node that is a leaf (always)
  // OR that has direct products loaded/loading — so a parent's products never
  // vanish from view once a sub-category is added under it.
  const renderProductList = showChildren && (isLeaf || hasDirectProducts || nodeLoading);

  const rowProps = {
    category,
    depth,
    expanded,
    expandable,
    selected: selectedIds.has(category.id),
    editing: editingId === category.id,
    saving,
    renameSaving,
    onToggleExpand,
    onSelect,
    onAddChild,
    onStartEdit,
    onDelete,
    onToggleVisibility,
    onRename,
    onCancelRename,
  };

  return (
    <li className="flex flex-col gap-1.5">
      <SortableCategoryRow {...rowProps} />
      {showChildren && children.length > 0 && (
        <ul className="animate-pos-accordion flex flex-col gap-1.5 border-r-2 border-slate-100 pr-1.5 ms-3" role="group">
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={children.map((c) => c.id)} strategy={verticalListSortingStrategy}>
              {children.map((child) => (
                <TreeNode
                  key={child.id}
                  category={child}
                  depth={depth + 1}
                  expandedIds={expandedIds}
                  editingId={editingId}
                  selectedIds={selectedIds}
                  saving={saving}
                  renameSaving={renameSaving}
                  hasActiveSearch={hasActiveSearch}
                  childrenByParent={childrenByParent}
                  sensors={sensors}
                  leafProductsByCategory={leafProductsByCategory}
                  leafLoadingId={leafLoadingId}
                  onToggleExpand={onToggleExpand}
                  onSelect={onSelect}
                  onAddChild={onAddChild}
                  onStartEdit={onStartEdit}
                  onDelete={onDelete}
                  onToggleVisibility={onToggleVisibility}
                  onRename={onRename}
                  onCancelRename={onCancelRename}
                  onDragEnd={onDragEnd}
                />
              ))}
            </SortableContext>
          </DndContext>
        </ul>
      )}
      {renderProductList && (
        <ProductSubList
          products={nodeProducts}
          loading={nodeLoading}
          categoryName={category.name}
        />
      )}
    </li>
  );
}

/* ─────────────────────────── Inline product sub-list ───────────────────── */

const PRODUCTS_PER_PAGE = 10;

function ProductSubList({
  products,
  loading,
  categoryName,
}: {
  products: CategoryProductItem[] | null;
  loading: boolean;
  categoryName: string;
}) {
  const [limit, setLimit] = useState(PRODUCTS_PER_PAGE);

  if (loading) {
    return (
      <div className="animate-pos-accordion ms-9 flex items-center gap-2 rounded-xl border border-dashed border-slate-300 bg-surface-muted/40 px-4 py-3 text-xs font-bold text-muted">
        <Loader2 className="h-4 w-4 animate-spin text-primary" />
        جارٍ تحميل منتجات «{categoryName}»…
      </div>
    );
  }

  if (!products || products.length === 0) {
    return (
      <div className="animate-pos-accordion ms-9 flex items-center gap-2 rounded-xl border border-dashed border-slate-200 bg-surface-muted/40 px-4 py-2.5 text-xs font-semibold text-muted">
        <PackageOpen className="h-4 w-4 text-slate-400" />
        لا توجد منتجات مرتبطة مباشرة بهذا التصنيف.
      </div>
    );
  }

  const shown = products.slice(0, limit);
  const hasMore = products.length > limit;

  return (
    <div className="ms-9 flex flex-col gap-2">
      <div className="flex items-center justify-between px-1">
        <span className="text-[11px] font-black text-muted">
          {products.length.toLocaleString("ar-JO")} منتج
        </span>
      </div>
      <div className="animate-pos-accordion flex flex-col gap-1.5 overflow-y-auto rounded-xl border border-slate-200 bg-surface-muted/40 p-1.5" style={{ maxHeight: "min(320px, 40vh)" }}>
        {shown.map((product) => (
          <div
            key={product.id}
            className={cn(
              "flex items-center gap-2 rounded-lg border px-3 py-2 transition-colors",
              product.isActive ? "border-slate-200 bg-white" : "border-slate-200 bg-white opacity-55",
            )}
          >
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
              <Package className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-black text-foreground">{product.name}</p>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] font-semibold text-muted">
                {product.barcode ? (
                  <span className="inline-flex items-center gap-1">
                    <Barcode className="h-3 w-3" />
                    {product.barcode}
                  </span>
                ) : null}
                <span>الرصيد: {product.stock.toLocaleString("ar-JO")}</span>
              </div>
            </div>
            <span className="shrink-0 text-xs font-black tabular-nums text-primary">
              {formatMoney(product.price)}
            </span>
            <a
              href="/admin/inventory"
              title="إدارة المنتج في المخزون"
              aria-label={`فتح ${product.name} في المخزون`}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-slate-400 transition hover:bg-primary/10 hover:text-primary"
            >
              <ArrowUpRight className="h-4 w-4" />
            </a>
          </div>
        ))}
      </div>
      {hasMore && (
        <Button variant="outline" size="sm" className="self-start" onClick={() => setLimit((l) => l + PRODUCTS_PER_PAGE)}>
          عرض {Math.min(PRODUCTS_PER_PAGE, products.length - limit).toLocaleString("ar-JO")} منتج إضافي
        </Button>
      )}
    </div>
  );
}

/* ─────────────────────────────── Brand card ────────────────────────────── */

function BrandCard({
  brand,
  selected,
  editing,
  saving,
  renameSaving,
  onSelect,
  onStartEdit,
  onDelete,
  onRename,
  onCancelRename,
}: {
  brand: BrandReferenceItem;
  selected: boolean;
  editing: boolean;
  saving: boolean;
  renameSaving: boolean;
  onSelect: (brand: BrandReferenceItem) => void;
  onStartEdit: (brand: BrandReferenceItem) => void;
  onDelete: (brand: BrandReferenceItem) => void;
  onRename: (brand: BrandReferenceItem, name: string) => void;
  onCancelRename: () => void;
}) {
  return (
    <article
      className={cn(
        "group rounded-2xl border bg-surface p-4 shadow-sm transition hover:shadow-md",
        selected ? "border-primary/50 ring-2 ring-primary/20" : "border-border hover:border-primary/30",
      )}
    >
      <div className="flex items-start gap-3">
        <button
          type="button"
          onClick={() => onSelect(brand)}
          aria-label={selected ? `إلغاء تحديد ${brand.name}` : `تحديد ${brand.name}`}
          className={cn(
            "mt-1 grid h-6 w-6 shrink-0 place-items-center rounded-md border transition",
            selected ? "border-primary bg-primary text-primary-foreground" : "border-slate-300 bg-white hover:border-primary",
          )}
        >
          {selected && <Check className="h-3.5 w-3.5" />}
        </button>
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
          <Building2 className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          {editing ? (
            <InlineRename value={brand.name} saving={renameSaving} onSave={(n) => onRename(brand, n)} onCancel={onCancelRename} />
          ) : (
            <h3 className="truncate text-sm font-black text-foreground">{brand.name}</h3>
          )}
          <p className="mt-1 text-xs font-semibold text-muted">
            مرتبطة بـ {brand.productCount.toLocaleString("ar-JO")} منتج
          </p>
        </div>
      </div>

      {!editing && (
        <div className="mt-3 flex items-center gap-2 border-t border-border pt-3">
          <Button variant="outline" size="sm" className="flex-1" onClick={() => onStartEdit(brand)}>
            <Pencil className="h-3.5 w-3.5" />
            تعديل
          </Button>
          <Button variant="ghost" size="sm" className="text-destructive hover:bg-destructive/10" onClick={() => onDelete(brand)} disabled={saving}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
    </article>
  );
}

/* ─────────────────────────────── Create/Edit modals ────────────────────── */

const CATEGORY_MODAL_ID = "category-modal";

function CategoryModal({
  categories,
  initial,
  defaultParentId,
  saving,
  error,
  onClose,
  onSubmit,
}: {
  categories: CategoryReferenceItem[];
  initial: CategoryReferenceItem | null;
  defaultParentId: string | null;
  saving: boolean;
  error: string;
  onClose: () => void;
  onSubmit: (payload: { name: string; parentId: string | null; showInPos: boolean }) => Promise<void> | void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [parentId, setParentId] = useState(initial?.parentId ?? defaultParentId ?? "");
  const [showInPos, setShowInPos] = useState(initial?.showInPos ?? true);

  const flattened = useMemo(() => flattenHierarchy(categories), [categories]);
  const pathById = useMemo(() => new Map(flattened.map((node) => [node.item.id, node.pathNames] as const)), [flattened]);
  const blockedIds = useMemo(
    () =>
      initial
        ? collectDescendantIds(
            categories.map((item) => ({ id: item.id, parentId: item.parentId })),
            initial.id,
          )
        : new Set<string>(),
    [categories, initial],
  );

  const parentOptions = useMemo<EntityOption[]>(
    () =>
      flattened
        .filter((node) => node.item.id !== initial?.id)
        .filter((node) => !blockedIds.has(node.item.id))
        .map((node) => ({
          id: node.item.id,
          name: node.pathNames.join(" / "),
          description: node.depth > 0 ? `داخل ${node.pathNames.slice(0, -1).join(" / ")}` : "جذر رئيسي يظهر مباشرة للكاشير",
        })),
    [blockedIds, flattened, initial],
  );

  const previewNames = useMemo(() => {
    const draftName = name.trim() || "التصنيف الجديد";
    const parentPath = parentId ? pathById.get(parentId) ?? [] : [];
    return [...parentPath, draftName];
  }, [name, parentId, pathById]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const cleanName = name.trim();
    if (!cleanName || saving) return;
    await onSubmit({ name: cleanName, parentId: parentId || null, showInPos });
  };

  return (
    <ModalShell
      title={initial ? "تعديل تصنيف" : "إضافة تصنيف"}
      description="هذا تصنيف لمنتجات يظهر للكاشير في نقطة البيع. أسماء العلامات التجارية تُدار من لوحة «العلامات» ولا تُضاف هنا."
      icon={<FolderTree className="h-5 w-5 text-primary" />}
      onClose={onClose}
      dismissible={!saving}
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            إلغاء
          </Button>
          <Button type="submit" form={CATEGORY_MODAL_ID} disabled={!name.trim() || saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : initial ? <Check className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
            {initial ? "حفظ التعديل" : "إضافة التصنيف"}
          </Button>
        </div>
      }
    >
      <form id={CATEGORY_MODAL_ID} onSubmit={(event) => void handleSubmit(event)} className="space-y-5">
        <label className="block text-sm font-bold text-muted">
          اسم التصنيف <span className="text-destructive">*</span>
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="مثال: أدوات تنظيف"
            className="mt-1.5"
          />
        </label>

        <EntityCombobox
          id="category-parent"
          value={parentId}
          options={parentOptions}
          placeholder="جذر رئيسي مباشر"
          emptyLabel="لا توجد تصنيفات متاحة للاختيار"
          onChange={setParentId}
          label="يظهر تحت أي تصنيف؟"
        />

        <label className="flex cursor-pointer select-none items-center gap-3 rounded-xl border border-border bg-surface-muted/50 px-4 py-3 transition hover:bg-surface-muted">
          <input type="checkbox" checked={showInPos} onChange={(e) => setShowInPos(e.target.checked)} className="h-4 w-4 accent-primary" />
          <span className="text-sm font-bold text-foreground">إظهار في نقطة البيع</span>
          <span className="text-xs font-semibold text-muted">-{showInPos ? "مرئي" : "مخفي"} للكاشير</span>
        </label>

        <div className="rounded-xl border border-primary/15 bg-primary/5 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="primary">المستوى {previewNames.length}</Badge>
            <span className="text-xs font-bold text-muted">المسار الذي سيفتحه الكاشير</span>
          </div>
          <p className="mt-2 text-sm font-black text-foreground">{previewNames.join(" / ")}</p>
        </div>

        {error && <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm font-bold text-destructive">{error}</p>}
      </form>
    </ModalShell>
  );
}

const BRAND_MODAL_ID = "brand-modal";

function BrandModal({
  initial,
  saving,
  error,
  onClose,
  onSubmit,
}: {
  initial: BrandReferenceItem | null;
  saving: boolean;
  error: string;
  onClose: () => void;
  onSubmit: (payload: { name: string }) => Promise<void> | void;
}) {
  const [name, setName] = useState(initial?.name ?? "");

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const cleanName = name.trim();
    if (!cleanName || saving) return;
    await onSubmit({ name: cleanName });
  };

  return (
    <ModalShell
      title={initial ? "تعديل علامة تجارية" : "إضافة علامة تجارية"}
      description="للفلترة والتقارير، وليس لمسار تنقل الكاشير."
      icon={<Building2 className="h-5 w-5 text-primary" />}
      onClose={onClose}
      dismissible={!saving}
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            إلغاء
          </Button>
          <Button type="submit" form={BRAND_MODAL_ID} disabled={!name.trim() || saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : initial ? <Check className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
            {initial ? "حفظ التعديل" : "إضافة العلامة"}
          </Button>
        </div>
      }
    >
      <form id={BRAND_MODAL_ID} onSubmit={(event) => void handleSubmit(event)} className="space-y-5">
        <label className="block text-sm font-bold text-muted">
          الاسم <span className="text-destructive">*</span>
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="مثال: Nestle" className="mt-1.5" />
        </label>
        {error && <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm font-bold text-destructive">{error}</p>}
      </form>
    </ModalShell>
  );
}

/* ───────────────────────────────── Page ────────────────────────────────── */

type ModalState =
  | null
  | { kind: "category-create"; parentId: string | null }
  | { kind: "brand-create" };

export default function AdminCategoriesPage() {
  const [categories, setCategories] = useState<CategoryReferenceItem[]>([]);
  const [brands, setBrands] = useState<BrandReferenceItem[]>([]);
  const [stats, setStats] = useState({ uncategorizedProductCount: 0, totalProductCount: 0 });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [pageError, setPageError] = useState("");
  const [modalError, setModalError] = useState("");
  const [notice, setNotice] = useState("");
  const [modalState, setModalState] = useState<ModalState>(null);

  const [query, setQuery] = useState("");
  const [panel, setPanel] = useState<Panel>("categories");

  // Tree state
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [renameSaving, setRenameSaving] = useState(false);

  // Inline products shown under expanded leaf categories (keyed by category id).
  const [leafProductsByCategory, setLeafProductsByCategory] = useState<Record<string, CategoryProductItem[]>>({});
  const [leafLoadingId, setLeafLoadingId] = useState<string | null>(null);

  // Brand state
  const [brandSort, setBrandSort] = useState<BrandSort>("name");
  const [brandAsc, setBrandAsc] = useState(true);

  // Batch selection
  const catSelection = useSelection();
  const brandSelection = useSelection();

  // Delete confirmation dialog
  const [confirm, setConfirm] = useState<
    | { kind: "category"; item: CategoryReferenceItem }
    | { kind: "brand"; item: BrandReferenceItem }
    | { kind: "bulk-categories"; ids: string[] }
    | { kind: "bulk-brands"; ids: string[] }
    | null
  >(null);

  const dndSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));
  const searchRef = useRef<HTMLInputElement>(null);

  /**
   * Load taxonomy. `showLoading` gates the full-page spinner (used only for the
   * initial mount and the explicit refresh button). Background/mutation-triggered
   * refreshes run silently (no `loading`), so the tree never flickers or shrinks
   * and existing expanded/leaf state is preserved. `resetLeaves` clears the
   * inline leaf-product cache when a create/delete changed the underlying data.
   */
  const load = useCallback(async (opts?: { showLoading?: boolean; resetLeaves?: boolean }) => {
    if (opts?.showLoading) setLoading(true);
    setPageError("");
    try {
      const data = await fetchTaxonomy();
      setCategories(data.categories);
      setBrands(data.brands);
      setStats({ uncategorizedProductCount: data.uncategorizedProductCount, totalProductCount: data.totalProductCount });
      catSelection.clear();
      brandSelection.clear();
      setEditingId(null);
      if (opts?.resetLeaves) {
        setLeafProductsByCategory({});
        setLeafLoadingId(null);
      }
    } catch (reason) {
      setPageError(reason instanceof Error ? reason.message : "تعذر تحميل التصنيفات والعلامات التجارية");
    } finally {
      if (opts?.showLoading) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load({ showLoading: true, resetLeaves: true }), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  // Load inline products for a leaf category on demand (cached per category).
  const inFlightProducts = useRef<Set<string>>(new Set());
  const loadLeafProducts = useCallback(async (categoryId: string) => {
    if (inFlightProducts.current.has(categoryId)) return;
    inFlightProducts.current.add(categoryId);
    setLeafLoadingId(categoryId);
    try {
      const items = await fetchCategoryProducts(categoryId);
      setLeafProductsByCategory((prev) => (prev[categoryId]?.length === items.length ? prev : { ...prev, [categoryId]: items }));
    } catch (reason) {
      setPageError(reason instanceof Error ? reason.message : "تعذر تحميل منتجات التصنيف");
    } finally {
      inFlightProducts.current.delete(categoryId);
      setLeafLoadingId(null);
    }
  }, []);

  // Keyboard: "/" focuses search from anywhere.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (e.key === "/" && target.tagName !== "INPUT" && target.tagName !== "TEXTAREA") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const childrenByParent = useMemo(() => {
    const map = buildChildrenByParent(categories);
    for (const children of map.values()) {
      children.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "ar"));
    }
    return map;
  }, [categories]);

  const rootCategories = useMemo(
    () =>
      categories
        .filter((item) => !item.parentId || !categories.some((c) => c.id === item.parentId))
        .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "ar")),
    [categories],
  );

  const flattened = useMemo(() => flattenHierarchy(categories), [categories]);

  const normalizedQuery = normalizeArabicText(query.trim());

  // Build a search index: category id -> normalized path text (used to decide
  // whether a node matches, and to show matching paths).
  const searchableMap = useMemo(() => {
    const map = new Map<string, { text: string; pathNames: string[] }>();
    const known = new Set(categories.map((c) => c.id));
    // Fallback entries for orphans whose parent is missing.
    for (const c of categories) {
      if (!c.parentId || !known.has(c.parentId)) {
        map.set(c.id, { text: normalizeArabicText(c.name), pathNames: [c.name] });
      }
    }
    for (const node of flattened) {
      const text = normalizeArabicText([...node.pathNames].join(" "));
      map.set(node.item.id, { text, pathNames: node.pathNames });
    }
    return map;
  }, [categories, flattened]);

  const searchMatches = useCallback(
    (id: string) => {
      if (!normalizedQuery) return true;
      const entry = searchableMap.get(id);
      return entry ? entry.text.includes(normalizedQuery) : false;
    },
    [normalizedQuery, searchableMap],
  );

  const hasActiveSearch = Boolean(normalizedQuery);

  // Eagerly load inline products for every node (leaf or parent) that is
  // expanded or search-visible, so direct products show without a click.
  useEffect(() => {
    if (loading || inFlightProducts.current.size > 0) return;
    for (const c of categories) {
      const visible = hasActiveSearch ? searchMatches(c.id) : expandedIds.has(c.id);
      if (visible && !leafProductsByCategory[c.id] && !inFlightProducts.current.has(c.id)) {
        void loadLeafProducts(c.id);
      }
    }
  }, [loading, categories, hasActiveSearch, searchMatches, expandedIds, leafProductsByCategory, loadLeafProducts]);

  const visibleRootCategories = useMemo(
    () => rootCategories.filter((root) => searchMatches(root.id)),
    [rootCategories, searchMatches],
  );

  const toggleExpand = useCallback((category: CategoryReferenceItem) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(category.id)) next.delete(category.id);
      else next.add(category.id);
      return next;
    });
  }, []);

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const activeId = String(active.id);
      const overId = String(over.id);

      const siblings = (cat: CategoryReferenceItem) => {
        const parentId = cat.parentId;
        if (!parentId) return rootCategories;
        return childrenByParent.get(parentId) ?? [];
      };

      const activeCat = categories.find((c) => c.id === activeId);
      const overCat = categories.find((c) => c.id === overId);
      if (!activeCat || !overCat) return;

      // Only reorder within the same parent group.
      if ((activeCat.parentId ?? null) !== (overCat.parentId ?? null)) return;

      const list = siblings(activeCat);
      const fromIndex = list.findIndex((c) => c.id === activeId);
      const toIndex = list.findIndex((c) => c.id === overId);
      if (fromIndex < 0 || toIndex < 0) return;

      const reordered = arrayMove(list, fromIndex, toIndex);
      const updates = reordered.map((item, index) => ({ id: item.id, sortOrder: index }));

      const snapshot = categories;
      setCategories((prev) =>
        prev.map((category) => {
          const idx = updates.findIndex((u) => u.id === category.id);
          return idx >= 0 ? { ...category, sortOrder: updates[idx].sortOrder } : category;
        }),
      );
      try {
        await reorderCategories(updates);
        setPageError("");
        setNotice("تم تحديث ترتيب التصنيفات");
      } catch (reason) {
        setCategories(snapshot);
        setNotice("");
        setPageError(reason instanceof Error ? reason.message : "تعذر حفظ ترتيب التصنيفات");
      }
    },
    [categories, childrenByParent, rootCategories],
  );

  // Brand filtering + sorting
  const filteredBrands = useMemo(() => {
    let list = brands.slice();
    if (normalizedQuery) {
      list = list.filter((b) => normalizeArabicText(b.name).includes(normalizedQuery));
    }
    list.sort((a, b) => {
      if (brandSort === "name") {
        const byName = a.name.localeCompare(b.name, "ar");
        return brandAsc ? byName : -byName;
      }
      const byCount = a.productCount - b.productCount;
      return brandAsc ? byCount : -byCount;
    });
    return list;
  }, [brands, normalizedQuery, brandSort, brandAsc]);

  // Modal helpers
  const closeModal = () => {
    if (saving) return;
    setModalState(null);
    setModalError("");
  };

  const openCategoryCreate = (parentId: string | null = null) => {
    setModalError("");
    setNotice("");
    setModalState({ kind: "category-create", parentId });
  };
  const openBrandCreate = () => {
    setModalError("");
    setNotice("");
    setModalState({ kind: "brand-create" });
  };

  const saveCategoryHandler = async (payload: { name: string; parentId: string | null; showInPos: boolean }) => {
    setSaving(true);
    setModalError("");
    setPageError("");
    setNotice("");
    try {
      const created = await saveCategory(payload);
      setModalState(null);
      setNotice("تم إنشاء التصنيف بنجاح");
      // Optimistically insert so the tree updates instantly, then silently
      // reconcile (new id, sort order) without a full-page loading gate.
      setCategories((prev) => [...prev, created]);
      void load({ showLoading: false, resetLeaves: false });
    } catch (reason) {
      setModalError(reason instanceof Error ? reason.message : "تعذر حفظ التصنيف");
    } finally {
      setSaving(false);
    }
  };

  const saveBrandHandler = async (payload: { name: string }) => {
    setSaving(true);
    setModalError("");
    setPageError("");
    setNotice("");
    try {
      const created = await saveBrand(payload);
      setModalState(null);
      setNotice("تمت إضافة العلامة التجارية");
      setBrands((prev) => [...prev, created]);
      void load({ showLoading: false, resetLeaves: false });
    } catch (reason) {
      setModalError(reason instanceof Error ? reason.message : "تعذر حفظ العلامة التجارية");
    } finally {
      setSaving(false);
    }
  };

  const startInlineRename = (category: CategoryReferenceItem) => {
    setPageError("");
    setNotice("");
    setEditingId(category.id);
  };
  const cancelRename = () => setEditingId(null);

  const commitCategoryRename = async (category: CategoryReferenceItem, name: string) => {
    setRenameSaving(true);
    setPageError("");
    setNotice("");
    try {
      await renameCategory(category.id, name);
      setCategories((prev) => prev.map((c) => (c.id === category.id ? { ...c, name: name.trim() } : c)));
      setEditingId(null);
      setNotice("تم تحديث اسم التصنيف");
    } catch (reason) {
      setPageError(reason instanceof Error ? reason.message : "تعذر تحديث الاسم");
      setEditingId(null);
    } finally {
      setRenameSaving(false);
    }
  };

  const startBrandRename = (brand: BrandReferenceItem) => {
    setPageError("");
    setNotice("");
    setEditingId(brand.id);
  };

  const commitBrandRename = async (brand: BrandReferenceItem, name: string) => {
    setRenameSaving(true);
    setPageError("");
    setNotice("");
    try {
      await renameBrand(brand.id, name);
      setBrands((prev) => prev.map((b) => (b.id === brand.id ? { ...b, name: name.trim() } : b)));
      setEditingId(null);
      setNotice("تم تحديث اسم العلامة التجارية");
    } catch (reason) {
      setPageError(reason instanceof Error ? reason.message : "تعذر تحديث الاسم");
      setEditingId(null);
    } finally {
      setRenameSaving(false);
    }
  };

  const removeCategory = async (item: CategoryReferenceItem) => {
    setSaving(true);
    setModalError("");
    setPageError("");
    setNotice("");
    try {
      await deleteCategory(item.id);
      setConfirm(null);
      setNotice("تم حذف التصنيف");
      // Optimistically drop the node without collapsing anything, then reconcile.
      setCategories((prev) => prev.filter((c) => c.id !== item.id));
      setLeafProductsByCategory((prev) => {
        if (!(item.id in prev)) return prev;
        const next = { ...prev };
        delete next[item.id];
        return next;
      });
      void load({ showLoading: false, resetLeaves: false });
    } catch (reason) {
      setPageError(reason instanceof Error ? reason.message : "تعذر حذف التصنيف");
      setConfirm(null);
    } finally {
      setSaving(false);
    }
  };

  const removeBrand = async (item: BrandReferenceItem) => {
    setSaving(true);
    setModalError("");
    setPageError("");
    setNotice("");
    try {
      await deleteBrand(item.id);
      setConfirm(null);
      setNotice("تم حذف العلامة التجارية");
      setBrands((prev) => prev.filter((b) => b.id !== item.id));
      void load({ showLoading: false, resetLeaves: false });
    } catch (reason) {
      setPageError(reason instanceof Error ? reason.message : "تعذر حذف العلامة التجارية");
      setConfirm(null);
    } finally {
      setSaving(false);
    }
  };

  const toggleCategoryVisibilityHandler = async (item: CategoryReferenceItem) => {
    const newShowInPos = !item.showInPos;
    setSaving(true);
    setPageError("");
    setNotice("");
    try {
      await toggleCategoryVisibility(item);
      setCategories((prev) => prev.map((c) => (c.id === item.id ? { ...c, showInPos: newShowInPos } : c)));
      setNotice(newShowInPos ? `تم إظهار «${item.name}» في نقطة البيع` : `تم إخفاء «${item.name}» من نقطة البيع`);
    } catch (reason) {
      setPageError(reason instanceof Error ? reason.message : "تعذر تحديث ظهور التصنيف");
    } finally {
      setSaving(false);
    }
  };

  const bulkDeleteCategories = async () => {
    const ids = [...catSelection.ids];
    if (ids.length === 0) return;
    setSaving(true);
    setPageError("");
    setNotice("");
    try {
      await deleteCategories(ids);
      setConfirm(null);
      catSelection.clear();
      setNotice(`تم حذف ${ids.length.toLocaleString("ar-JO")} تصنيف`);
      const idSet = new Set(ids);
      setCategories((prev) => prev.filter((c) => !idSet.has(c.id)));
      setLeafProductsByCategory((prev) => {
        const next = { ...prev };
        for (const id of ids) delete next[id];
        return next;
      });
      void load({ showLoading: false, resetLeaves: false });
    } catch (reason) {
      setPageError(reason instanceof Error ? reason.message : "تعذر حذف التصنيفات");
      setConfirm(null);
    } finally {
      setSaving(false);
    }
  };

  const bulkDeleteBrands = async () => {
    const ids = [...brandSelection.ids];
    if (ids.length === 0) return;
    setSaving(true);
    setPageError("");
    setNotice("");
    try {
      await deleteBrands(ids);
      setConfirm(null);
      brandSelection.clear();
      setNotice(`تم حذف ${ids.length.toLocaleString("ar-JO")} علامة`);
      const idSet = new Set(ids);
      setBrands((prev) => prev.filter((b) => !idSet.has(b.id)));
      void load({ showLoading: false, resetLeaves: false });
    } catch (reason) {
      setPageError(reason instanceof Error ? reason.message : "تعذر حذف العلامات");
      setConfirm(null);
    } finally {
      setSaving(false);
    }
  };

  const bulkHideCategories = async (showInPos: boolean) => {
    const ids = [...catSelection.ids];
    if (ids.length === 0) return;
    setSaving(true);
    setPageError("");
    setNotice("");
    try {
      await toggleCategoriesVisibility(ids, showInPos);
      setCategories((prev) => prev.map((c) => (catSelection.ids.has(c.id) ? { ...c, showInPos } : c)));
      catSelection.clear();
      setNotice(showInPos ? `تم إظهار ${ids.length.toLocaleString("ar-JO")} تصنيف` : `تم إخفاء ${ids.length.toLocaleString("ar-JO")} تصنيف`);
    } catch (reason) {
      setPageError(reason instanceof Error ? reason.message : "تعذر تحديث ظهور التصنيفات");
    } finally {
      setSaving(false);
    }
  };

  const collapseAll = () => setExpandedIds(new Set());
  const expandAll = () => setExpandedIds(new Set(categories.map((c) => c.id)));

  const categoryDeleteImpact = (item: CategoryReferenceItem) =>
    [item.childCount > 0 ? `${item.childCount.toLocaleString("ar-JO")} تصنيف فرعي` : "", item.productCount > 0 ? `${item.productCount.toLocaleString("ar-JO")} منتج مرتبط` : ""]
      .filter(Boolean)
      .join("، ");

  const activeSelectionCount = panel === "categories" ? catSelection.ids.size : brandSelection.ids.size;

  return (
    <div className="mx-auto flex min-w-0 max-w-6xl flex-col gap-5 p-4 sm:p-6">
      <PageHeader
        title="التصنيفات والعلامات"
        subtitle="هيكل شجري سريع وإدارة مريحة لتصنيفاتك وعلاماتك — مع بحث فوري وإجراءات جماعية."
        action={
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void load({ showLoading: true, resetLeaves: true })} disabled={loading} aria-label="تحديث" title="تحديث">
              <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
            </Button>
            <a
              href="/admin/inventory"
              className="inline-flex h-9 items-center gap-2 rounded-xl border border-border bg-surface px-3 text-xs font-black text-foreground shadow-card transition hover:bg-surface-muted"
            >
              <PackageOpen className="h-4 w-4 text-primary" />
              المنتجات
            </a>
            <Button size="sm" onClick={() => (panel === "categories" ? openCategoryCreate() : openBrandCreate())}>
              <Plus className="h-4 w-4" />
              {panel === "categories" ? "قسم رئيسي" : "علامة"}
            </Button>
          </div>
        }
      />

      {/*
        Quick Stats Bar
      */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="إجمالي التصنيفات" value={categories.length.toLocaleString("ar-JO")} icon={FolderTree} tone="primary" subtitle="يشمل الرئيسية والفرعية" />
        <StatCard label="إجمالي العلامات" value={brands.length.toLocaleString("ar-JO")} icon={Building2} tone="default" subtitle="علامات تجارية" />
        <StatCard
          label="منتجات غير مصنفة"
          value={stats.uncategorizedProductCount.toLocaleString("ar-JO")}
          icon={Package}
          tone={stats.uncategorizedProductCount > 0 ? "warning" : "success"}
          subtitle="تحتاج تعيين تصنيف"
        />
        <StatCard label="إجمالي المنتجات" value={stats.totalProductCount.toLocaleString("ar-JO")} icon={LayoutGrid} subtitle="في المتجر" />
      </div>

      {pageError && (
        <div role="alert" className="flex items-center gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm font-bold text-destructive">
          <XCircle className="h-5 w-5 shrink-0" />
          <span className="flex-1">{pageError}</span>
          <button type="button" onClick={() => setPageError("")} aria-label="إغلاق الرسالة" className="rounded-md p-1 hover:bg-destructive/15">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
      {notice && (
        <div role="status" className="flex items-center gap-2 rounded-xl border border-success/30 bg-success/10 px-4 py-3 text-sm font-bold text-success">
          <CheckCheck className="h-5 w-5 shrink-0" />
          <span className="flex-1">{notice}</span>
          <button type="button" onClick={() => setNotice("")} aria-label="إغلاق الرسالة" className="rounded-md p-1 hover:bg-success/15">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/*
        Command / Search bar
      */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute inset-y-0 start-3.5 my-auto h-4 w-4 text-muted" />
          <Input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="بحث فوري في التصنيفات والعلامات… (اضغط / للتركيز)"
            className="h-12 ps-10 text-base"
            aria-label="بحث فوري"
          />
          {normalizedQuery && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="مسح البحث"
              className="absolute inset-y-0 end-3 my-auto grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-surface-muted hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            variant={panel === "categories" ? "default" : "ghost"}
            size="sm"
            onClick={() => setPanel("categories")}
            className={panel === "categories" ? "" : "bg-surface"}
          >
            <FolderTree className="h-4 w-4" />
            التصنيفات
            <Badge tone="muted">{categories.length.toLocaleString("ar-JO")}</Badge>
          </Button>
          <Button
            variant={panel === "brands" ? "default" : "ghost"}
            size="sm"
            onClick={() => setPanel("brands")}
            className={panel === "brands" ? "" : "bg-surface"}
          >
            <Building2 className="h-4 w-4" />
            العلامات
            <Badge tone="muted">{brands.length.toLocaleString("ar-JO")}</Badge>
          </Button>
        </div>
      </div>

      {panel === "categories" ? (
        <section className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
          {/* Tree toolbar */}
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex min-w-0 items-center gap-2 text-xs font-bold text-muted">
                <List className="h-4 w-4 shrink-0" />
                {hasActiveSearch
                  ? `نتائج البحث في التصنيفات (${visibleRootCategories.length.toLocaleString("ar-JO")})`
                  : "الأقسام الرئيسية والفرعية — تصنيفات المنتجات لتنقل الكاشير في نقطة البيع"}
              </span>
              <span className="ps-6 text-[11px] font-semibold text-muted">
                أسماء العلامات التجارية (مثل «ديماس») تُدار من لوحة «العلامات» وتُستخدم للفلترة والتقارير فقط — وليست تصنيفات لنقطة البيع.
              </span>
            </span>
            {!hasActiveSearch && (
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="sm" onClick={expandAll}>
                  <Menu className="h-3.5 w-3.5" />
                  توسيع الكل
                </Button>
                <Button variant="ghost" size="sm" onClick={collapseAll}>
                  طيّ الكل
                </Button>
              </div>
            )}
          </div>

          {loading ? (
            <div className="grid min-h-64 place-items-center text-sm font-bold text-muted">
              <Loader2 className="h-7 w-7 animate-spin text-primary" />
            </div>
          ) : visibleRootCategories.length === 0 ? (
            <div className="grid min-h-64 place-items-center px-6 text-center">
              <div>
                <FolderTree className="mx-auto h-10 w-10 text-muted" />
                <p className="mt-2 text-sm font-black text-foreground">{normalizedQuery ? "لا توجد نتائج" : "لا توجد تصنيفات بعد"}</p>
                <p className="mt-1 text-xs font-semibold text-muted">
                  {normalizedQuery ? "جرّب كلمة أخرى." : "ابدأ بإضافة أول قسم رئيسي."}
                </p>
                {!normalizedQuery && (
                  <Button className="mt-4" size="sm" onClick={() => openCategoryCreate()}>
                    <Plus className="h-4 w-4" />
                    إضافة قسم رئيسي
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              <ul className="flex flex-col gap-1.5">
                <DndContext sensors={dndSensors} collisionDetection={closestCenter} onDragEnd={(e) => void handleDragEnd(e)}>
                  <SortableContext items={visibleRootCategories.map((c) => c.id)} strategy={verticalListSortingStrategy}>
                    {visibleRootCategories.map((root) => (
                      <TreeNode
                        key={root.id}
                        category={root}
                        depth={0}
                        expandedIds={expandedIds}
                        editingId={editingId}
                        selectedIds={catSelection.ids}
                        saving={saving}
                        renameSaving={renameSaving}
                        hasActiveSearch={hasActiveSearch}
                        childrenByParent={childrenByParent}
                        sensors={dndSensors}
                        leafProductsByCategory={leafProductsByCategory}
                        leafLoadingId={leafLoadingId}
                        onToggleExpand={toggleExpand}
                        onSelect={(c) => catSelection.toggle(c.id)}
                        onAddChild={openCategoryCreate}
                        onStartEdit={startInlineRename}
                        onDelete={(c) => setConfirm({ kind: "category", item: c })}
                        onToggleVisibility={(c) => void toggleCategoryVisibilityHandler(c)}
                        onRename={(c, n) => void commitCategoryRename(c, n)}
                        onCancelRename={cancelRename}
                        onDragEnd={(e) => void handleDragEnd(e)}
                      />
                    ))}
                  </SortableContext>
                </DndContext>
              </ul>
            </div>
          )}
        </section>
      ) : (
        <BrandsPanel
          brands={filteredBrands}
          totalVisible={filteredBrands.length}
          hasSearch={hasActiveSearch}
          loading={loading}
          saving={saving}
          renameSaving={renameSaving}
          editingId={editingId}
          selection={brandSelection}
          sort={brandSort}
          asc={brandAsc}
          onSortChange={(s) => setBrandSort(s)}
          onToggleSort={() => setBrandAsc((a) => !a)}
          onSelect={(b) => brandSelection.toggle(b.id)}
          onStartEdit={startBrandRename}
          onDelete={(b) => setConfirm({ kind: "brand", item: b })}
          onRename={(b, n) => void commitBrandRename(b, n)}
          onCancelRename={cancelRename}
          onAdd={() => openBrandCreate()}
        />
      )}

      {/*
        Batch actions bar (floating)
      */}
      {activeSelectionCount > 0 && (
        <div className="sticky bottom-4 z-30 mx-auto flex w-fit max-w-full flex-wrap items-center gap-2 rounded-2xl border border-border bg-surface px-4 py-3 shadow-overlay">
          <Badge tone="primary" className="px-3 py-1">
            {activeSelectionCount.toLocaleString("ar-JO")} محدد
          </Badge>
          {panel === "categories" ? (
            <>
              <Button variant="outline" size="sm" onClick={() => bulkHideCategories(true)}>
                <Eye className="h-4 w-4" />
                إظهار
              </Button>
              <Button variant="outline" size="sm" onClick={() => bulkHideCategories(false)}>
                <EyeOff className="h-4 w-4" />
                إخفاء
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setConfirm({ kind: "bulk-categories", ids: [...catSelection.ids] })}
                disabled={saving}
              >
                <Trash2 className="h-4 w-4" />
                حذف
              </Button>
            </>
          ) : (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setConfirm({ kind: "bulk-brands", ids: [...brandSelection.ids] })}
              disabled={saving}
            >
              <Trash2 className="h-4 w-4" />
              حذف
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => (panel === "categories" ? catSelection.clear() : brandSelection.clear())}>
            <X className="h-4 w-4" />
            إلغاء التحديد
          </Button>
        </div>
      )}

      {/* Modals */}
      {modalState?.kind === "category-create" && (
        <CategoryModal
          categories={categories}
          initial={null}
          defaultParentId={modalState.parentId}
          saving={saving}
          error={modalError}
          onClose={closeModal}
          onSubmit={saveCategoryHandler}
        />
      )}
      {modalState?.kind === "brand-create" && (
        <BrandModal initial={null} saving={saving} error={modalError} onClose={closeModal} onSubmit={saveBrandHandler} />
      )}

      {/* Delete confirmations */}
      {confirm?.kind === "category" && (
        <ConfirmDialog
          open
          title={`حذف التصنيف «${confirm.item.name}»؟`}
          message={
            categoryDeleteImpact(confirm.item)
              ? `هذا سيحذف التصنيف نهائياً. ملاحظة: (${categoryDeleteImpact(confirm.item)})`
              : "هذا سيحذف التصنيف نهائياً ولا يمكن التراجع عنه."
          }
          confirmLabel="حذف"
          onClose={() => setConfirm(null)}
          onConfirm={() => void removeCategory(confirm.item)}
        />
      )}
      {confirm?.kind === "brand" && (
        <ConfirmDialog
          open
          title={`حذف العلامة التجارية «${confirm.item.name}»؟`}
          message={
            confirm.item.productCount > 0
              ? `مرتبطة بـ ${confirm.item.productCount.toLocaleString("ar-JO")} منتج. لا يمكن الحذف ما لم تُعد توجيه المنتجات أولاً.`
              : "هذا سيحذف العلامة التجارية نهائياً ولا يمكن التراجع عنه."
          }
          confirmLabel="حذف"
          onClose={() => setConfirm(null)}
          onConfirm={() => void removeBrand(confirm.item)}
        />
      )}
      {confirm?.kind === "bulk-categories" && (
        <ConfirmDialog
          open
          title={`حذف ${confirm.ids.length.toLocaleString("ar-JO")} تصنيف؟`}
          message="ستُحذف التصنيفات المحددة نهائياً إن لم تكن مرتبطة بمنتجات أو تحتوي تصنيفات فرعية."
          confirmLabel="حذف الكل"
          onClose={() => setConfirm(null)}
          onConfirm={() => void bulkDeleteCategories()}
        />
      )}
      {confirm?.kind === "bulk-brands" && (
        <ConfirmDialog
          open
          title={`حذف ${confirm.ids.length.toLocaleString("ar-JO")} علامة؟`}
          message="ستُحذف العلامات المحددة نهائياً إن لم تكن مرتبطة بمنتجات."
          confirmLabel="حذف الكل"
          onClose={() => setConfirm(null)}
          onConfirm={() => void bulkDeleteBrands()}
        />
      )}
    </div>
  );
}

/* ─────────────────────────────── Brands panel ──────────────────────────── */

function BrandsPanel({
  brands,
  totalVisible,
  hasSearch,
  loading,
  saving,
  renameSaving,
  editingId,
  selection,
  sort,
  asc,
  onSortChange,
  onToggleSort,
  onSelect,
  onStartEdit,
  onDelete,
  onRename,
  onCancelRename,
  onAdd,
}: {
  brands: BrandReferenceItem[];
  totalVisible: number;
  hasSearch: boolean;
  loading: boolean;
  saving: boolean;
  renameSaving: boolean;
  editingId: string | null;
  selection: ItemSelection;
  sort: BrandSort;
  asc: boolean;
  onSortChange: (sort: BrandSort) => void;
  onToggleSort: () => void;
  onSelect: (brand: BrandReferenceItem) => void;
  onStartEdit: (brand: BrandReferenceItem) => void;
  onDelete: (brand: BrandReferenceItem) => void;
  onRename: (brand: BrandReferenceItem, name: string) => void;
  onCancelRename: () => void;
  onAdd: () => void;
}) {
  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
        <span className="flex min-w-0 flex-1 items-center gap-2 text-xs font-bold text-muted">
          <Building2 className="h-4 w-4" />
          العلامات التجارية ({totalVisible.toLocaleString("ar-JO")})
        </span>
        <div className="flex items-center gap-1">
          <Button
            variant={sort === "name" ? "default" : "ghost"}
            size="sm"
            onClick={() => (sort === "name" ? onToggleSort() : onSortChange("name"))}
            title="ترتيب حسب الاسم"
          >
            الاسم
            {sort === "name" && <span className="text-xs">{asc ? "↑" : "↓"}</span>}
          </Button>
          <Button
            variant={sort === "products" ? "default" : "ghost"}
            size="sm"
            onClick={() => (sort === "products" ? onToggleSort() : onSortChange("products"))}
            title="ترتيب حسب عدد المنتجات"
          >
            المنتجات
            {sort === "products" && <span className="text-xs">{asc ? "↑" : "↓"}</span>}
          </Button>
        </div>
        <Button variant="outline" size="sm" onClick={onAdd}>
          <Plus className="h-4 w-4" />
          علامة
        </Button>
      </div>

      {loading ? (
        <div className="grid min-h-64 place-items-center text-sm font-bold text-muted">
          <Loader2 className="h-7 w-7 animate-spin text-primary" />
        </div>
      ) : brands.length === 0 ? (
        <div className="grid min-h-64 place-items-center px-6 text-center">
          <div>
            <Building2 className="mx-auto h-10 w-10 text-muted" />
            <p className="mt-2 text-sm font-black text-foreground">{hasSearch ? "لا توجد نتائج مطابقة" : "لا توجد علامات تجارية بعد"}</p>
            <p className="mt-1 text-xs font-semibold text-muted">{hasSearch ? "جرّب اسمًا آخر." : "يمكنك إضافة علامة جديدة."}</p>
            {!hasSearch && (
              <Button className="mt-4" size="sm" onClick={onAdd}>
                <Plus className="h-4 w-4" />
                إضافة علامة
              </Button>
            )}
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {brands.map((brand) => (
              <BrandCard
                key={brand.id}
                brand={brand}
                selected={selection.ids.has(brand.id)}
                editing={editingId === brand.id}
                saving={saving}
                renameSaving={renameSaving}
                onSelect={onSelect}
                onStartEdit={onStartEdit}
                onDelete={onDelete}
                onRename={onRename}
                onCancelRename={onCancelRename}
              />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
