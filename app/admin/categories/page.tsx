"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  Building2,
  Eye,
  EyeOff,
  FolderTree,
  Loader2,
  Package,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  X,
} from "lucide-react";
import EntityCombobox, { type EntityOption } from "@/components/shared/EntityCombobox";
import {
  buildChildrenByParent,
  collectDescendantIds,
  flattenHierarchy,
} from "@/lib/categoryTree";
import { normalizeArabicText } from "@/lib/arabic";
import { posFetch } from "@/lib/tenantClient";

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

type ModalState =
  | null
  | { kind: "category-create"; parentId: string | null }
  | { kind: "category-edit"; categoryId: string }
  | { kind: "brand-create" }
  | { kind: "brand-edit"; brandId: string };

async function fetchReferenceItems<T extends CategoryReferenceItem | BrandReferenceItem>(
  type: "category" | "brand",
): Promise<T[]> {
  const response = await posFetch(`/api/catalog/references?type=${type}`, { cache: "no-store" });
  const data = (await response.json().catch(() => null)) as { items?: T[]; error?: string } | null;
  if (!response.ok || !Array.isArray(data?.items)) {
    const fallback = type === "category" ? "تعذر تحميل التصنيفات" : "تعذر تحميل العلامات التجارية";
    const message =
      data?.error === "admin_session_required"
        ? "انتهت جلسة المدير على هذا الجهاز - سجّل الدخول مجددًا"
        : data?.error ?? fallback;
    throw new Error(message);
  }
  return data.items;
}

async function fetchTaxonomy(): Promise<{
  categories: CategoryReferenceItem[];
  brands: BrandReferenceItem[];
}> {
  const [categories, brands] = await Promise.all([
    fetchReferenceItems<CategoryReferenceItem>("category"),
    fetchReferenceItems<BrandReferenceItem>("brand"),
  ]);
  return { categories, brands };
}

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
  const pathById = useMemo(
    () => new Map(flattened.map((node) => [node.item.id, node.pathNames] as const)),
    [flattened],
  );
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
          description:
            node.depth > 0
              ? `داخل ${node.pathNames.slice(0, -1).join(" / ")}`
              : "جذر رئيسي يظهر مباشرة للكاشير",
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
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/45 p-3 sm:p-5" dir="rtl">
      <div className="flex max-h-[92dvh] w-full max-w-2xl flex-col overflow-hidden rounded-lg bg-surface shadow-overlay">
        <header className="flex items-center justify-between border-b border-border px-4 py-3 sm:px-6">
          <div>
            <h2 className="text-lg font-black text-foreground">
              {initial ? "تعديل تصنيف" : "إضافة تصنيف"}
            </h2>
            <p className="mt-0.5 text-xs font-semibold text-muted">
              حدّد أين سيظهر هذا المسار داخل تصفح الكاشير.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="إغلاق"
            className="grid h-9 w-9 place-items-center rounded-lg text-muted transition hover:bg-surface-muted"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        <form onSubmit={(event) => void handleSubmit(event)} className="space-y-5 px-4 py-4 sm:px-6">
          <label className="block text-sm font-bold text-muted">
            اسم التصنيف <span className="text-destructive">*</span>
            <input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="مثال: أدوات تنظيف"
              className="mt-1.5 h-12 w-full rounded-lg border border-border bg-white px-4 text-base font-bold outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
          </label>

          <EntityCombobox
            id="category-parent"
            label="يظهر تحت أي تصنيف؟"
            value={parentId}
            options={parentOptions}
            placeholder="جذر رئيسي مباشر"
            emptyLabel="لا توجد تصنيفات متاحة للاختيار"
            onChange={setParentId}
          />

          <label className="flex items-center gap-3 rounded-lg border border-border bg-surface-muted/50 px-4 py-3 cursor-pointer select-none transition hover:bg-surface-muted">
            <input
              type="checkbox"
              checked={showInPos}
              onChange={(e) => setShowInPos(e.target.checked)}
              className="h-4 w-4 accent-primary"
            />
            <span className="text-sm font-bold text-foreground">إظهار في نقطة البيع</span>
            <span className="text-xs font-semibold text-muted">-{showInPos ? "مرئي" : "مخفي"} للكاشير</span>
          </label>

          <div className="rounded-xl border border-primary/15 bg-primary/5 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-white px-2.5 py-1 text-[11px] font-black text-primary">
                المستوى {previewNames.length}
              </span>
              <span className="text-xs font-bold text-muted">المسار الذي سيفتحه الكاشير</span>
            </div>
            <p className="mt-2 text-sm font-black text-foreground">{previewNames.join(" / ")}</p>
          </div>

          {error && (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm font-bold text-destructive">
              {error}
            </p>
          )}

          <div className="flex flex-col-reverse gap-2 border-t border-border pt-4 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={onClose}
              className="flex h-11 items-center justify-center rounded-lg border border-border bg-white px-5 text-sm font-black text-foreground transition hover:bg-surface-muted"
            >
              إلغاء
            </button>
            <button
              type="submit"
              disabled={!name.trim() || saving}
              className="flex h-11 items-center justify-center gap-2 rounded-lg bg-primary px-5 text-sm font-black text-primary-foreground transition hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
            >
              {saving ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : initial ? (
                <Save className="h-5 w-5" />
              ) : (
                <Plus className="h-5 w-5" />
              )}
              {initial ? "حفظ التعديل" : "إضافة التصنيف"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

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
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/45 p-3 sm:p-5" dir="rtl">
      <div className="flex w-full max-w-lg flex-col overflow-hidden rounded-lg bg-surface shadow-2xl">
        <header className="flex items-center justify-between border-b border-border px-4 py-3 sm:px-6">
          <div>
            <h2 className="text-lg font-black text-foreground">
              {initial ? "تعديل علامة تجارية" : "إضافة علامة تجارية"}
            </h2>
            <p className="mt-0.5 text-xs font-semibold text-muted">
              للفلترة والتقارير، وليس لمسار تنقل الكاشير.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="إغلاق"
            className="grid h-9 w-9 place-items-center rounded-lg text-muted transition hover:bg-surface-muted"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        <form onSubmit={(event) => void handleSubmit(event)} className="space-y-5 px-4 py-4 sm:px-6">
          <label className="block text-sm font-bold text-muted">
            الاسم <span className="text-destructive">*</span>
            <input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="مثال: Nestle"
              className="mt-1.5 h-12 w-full rounded-lg border border-border bg-white px-4 text-base font-bold outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
          </label>

          {error && (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm font-bold text-destructive">
              {error}
            </p>
          )}

          <div className="flex flex-col-reverse gap-2 border-t border-border pt-4 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={onClose}
              className="flex h-11 items-center justify-center rounded-lg border border-border bg-white px-5 text-sm font-black text-foreground transition hover:bg-surface-muted"
            >
              إلغاء
            </button>
            <button
              type="submit"
              disabled={!name.trim() || saving}
              className="flex h-11 items-center justify-center gap-2 rounded-lg bg-primary px-5 text-sm font-black text-primary-foreground transition hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
            >
              {saving ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : initial ? (
                <Save className="h-5 w-5" />
              ) : (
                <Plus className="h-5 w-5" />
              )}
              {initial ? "حفظ التعديل" : "إضافة العلامة"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function CategoryColumnItem({
  category,
  active,
  childCount,
  saving,
  onSelect,
  onCreateChild,
  onEdit,
  onDelete,
  onToggleVisibility,
}: {
  category: CategoryReferenceItem;
  active: boolean;
  childCount: number;
  saving: boolean;
  onSelect: (categoryId: string) => void;
  onCreateChild: (parentId: string) => void;
  onEdit: (category: CategoryReferenceItem) => void;
  onDelete: (category: CategoryReferenceItem) => void;
  onToggleVisibility: (category: CategoryReferenceItem) => void;
}) {
  return (
    <article
      className={`group flex items-center gap-2 rounded-lg border p-2 transition ${
        active
          ? "border-primary bg-primary/5 ring-1 ring-primary/20"
          : "border-slate-200 bg-white hover:border-slate-300"
      } ${!category.showInPos ? "opacity-50" : ""}`}
    >
      <button
        type="button"
        onClick={() => onSelect(category.id)}
        className="flex min-w-0 flex-1 items-center gap-2 text-start"
      >
        <span
          aria-hidden
          className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-white"
          style={{ backgroundColor: category.bgColor ?? "#2563eb" }}
        >
          <FolderTree className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-black text-foreground">{category.name}</span>
          <span className="block text-[10px] font-bold text-muted">
            {childCount > 0 ? `${childCount.toLocaleString("ar-JO")} أقسام` : `${category.productCount.toLocaleString("ar-JO")} منتجات`}
          </span>
        </span>
      </button>

      <div className="flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          onClick={() => onToggleVisibility(category)}
          aria-label={category.showInPos ? `إخفاء ${category.name} من نقطة البيع` : `إظهار ${category.name} في نقطة البيع`}
          title={category.showInPos ? "إخفاء من نقطة البيع" : "إظهار في نقطة البيع"}
          className={`grid h-8 w-8 place-items-center rounded-md transition ${category.showInPos ? "text-slate-400 hover:bg-slate-100 hover:text-slate-600" : "text-amber-500 hover:bg-amber-50 hover:text-amber-600"}`}
        >
          {category.showInPos ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
        </button>
        <button
          type="button"
          onClick={() => onCreateChild(category.id)}
          aria-label={`إضافة قسم داخل ${category.name}`}
          title="إضافة قسم داخله"
          className="grid h-8 w-8 place-items-center rounded-md text-success hover:bg-success/10"
        >
          <Plus className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => onEdit(category)}
          aria-label={`تعديل ${category.name}`}
          title="تعديل"
          className="grid h-8 w-8 place-items-center rounded-md text-primary hover:bg-primary/10"
        >
          <Pencil className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => onDelete(category)}
          disabled={saving}
          aria-label={`حذف ${category.name}`}
          title="حذف"
          className="grid h-8 w-8 place-items-center rounded-md text-destructive hover:bg-destructive/10 disabled:opacity-40"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
    </article>
  );
}

export default function AdminCategoriesPage() {
  const [categories, setCategories] = useState<CategoryReferenceItem[]>([]);
  const [brands, setBrands] = useState<BrandReferenceItem[]>([]);
  const [categorySearch, setCategorySearch] = useState("");
  const [brandSearch, setBrandSearch] = useState("");
  const [activePanel, setActivePanel] = useState<"categories" | "brands">("categories");
  const [selectedRootId, setSelectedRootId] = useState("");
  const [selectedCategoryId, setSelectedCategoryId] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [pageError, setPageError] = useState("");
  const [modalError, setModalError] = useState("");
  const [notice, setNotice] = useState("");
  const [modalState, setModalState] = useState<ModalState>(null);
  const columnsScrollRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setPageError("");
    try {
      const data = await fetchTaxonomy();
      setCategories(data.categories);
      setBrands(data.brands);
    } catch (reason) {
      setPageError(
        reason instanceof Error ? reason.message : "تعذر تحميل التصنيفات والعلامات التجارية",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const flattenedCategories = useMemo(() => flattenHierarchy(categories), [categories]);
  const pathNamesById = useMemo(
    () => new Map(flattenedCategories.map((node) => [node.item.id, node.pathNames] as const)),
    [flattenedCategories],
  );
  const pathIdsById = useMemo(
    () => new Map(flattenedCategories.map((node) => [node.item.id, node.pathIds] as const)),
    [flattenedCategories],
  );

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
        .filter((item) => !item.parentId)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "ar")),
    [categories],
  );

  const normalizedCategorySearch = normalizeArabicText(categorySearch.trim());
  const normalizedBrandSearch = normalizeArabicText(brandSearch.trim());

  const searchTextById = useMemo(() => {
    const index = new Map<string, string>();

    const build = (id: string): string => {
      const existing = index.get(id);
      if (existing) return existing;

      const pathLabel = pathNamesById.get(id)?.join(" ") ?? "";
      const childrenText = (childrenByParent.get(id) ?? []).map((child) => build(child.id)).join(" ");
      const text = normalizeArabicText(`${pathLabel} ${childrenText}`);
      index.set(id, text);
      return text;
    };

    for (const category of categories) build(category.id);
    return index;
  }, [categories, childrenByParent, pathNamesById]);

  const shouldShowNode = useCallback(
    (id: string) =>
      !normalizedCategorySearch ||
      (searchTextById.get(id) ?? "").includes(normalizedCategorySearch),
    [normalizedCategorySearch, searchTextById],
  );

  const visibleRootCategories = useMemo(
    () => rootCategories.filter((root) => shouldShowNode(root.id)),
    [rootCategories, shouldShowNode],
  );

  const visibleCategoryIds = useMemo(
    () => new Set(categories.filter((category) => shouldShowNode(category.id)).map((category) => category.id)),
    [categories, shouldShowNode],
  );

  const effectiveSelectedRootId =
    visibleRootCategories.some((root) => root.id === selectedRootId)
      ? selectedRootId
      : (visibleRootCategories[0]?.id ?? "");

  const selectedRootCategory = useMemo(
    () =>
      visibleRootCategories.find((root) => root.id === effectiveSelectedRootId) ??
      visibleRootCategories[0] ??
      null,
    [effectiveSelectedRootId, visibleRootCategories],
  );

  const focusedCategory = useMemo(() => {
    if (!selectedRootCategory) return null;

    const candidate = categories.find((category) => category.id === selectedCategoryId) ?? null;
    const candidatePath = candidate ? pathIdsById.get(candidate.id) ?? [] : [];
    const candidateInsideRoot =
      candidate &&
      visibleCategoryIds.has(candidate.id) &&
      candidatePath[0] === selectedRootCategory.id;

    return candidateInsideRoot ? candidate : selectedRootCategory;
  }, [categories, pathIdsById, selectedCategoryId, selectedRootCategory, visibleCategoryIds]);

  const focusedPathItems = useMemo(() => {
    if (!focusedCategory) return [];
    const pathIds = pathIdsById.get(focusedCategory.id) ?? [];
    return pathIds
      .map((id) => categories.find((category) => category.id === id) ?? null)
      .filter((category): category is CategoryReferenceItem => Boolean(category));
  }, [categories, focusedCategory, pathIdsById]);

  const categoryColumns = useMemo(() => {
    const activeIds = focusedPathItems.map((category) => category.id);
    const columns: Array<{
      key: string;
      title: string;
      parent: CategoryReferenceItem | null;
      items: CategoryReferenceItem[];
      activeId: string;
    }> = [
      {
        key: "roots",
        title: "الأقسام الرئيسية",
        parent: null,
        items: visibleRootCategories,
        activeId: activeIds[0] ?? "",
      },
    ];

    for (let index = 0; index < focusedPathItems.length; index += 1) {
      const parent = focusedPathItems[index];
      columns.push({
        key: `children-${parent.id}`,
        title: parent.name,
        parent,
        items: (childrenByParent.get(parent.id) ?? []).filter((category) => shouldShowNode(category.id)),
        activeId: activeIds[index + 1] ?? "",
      });
    }

    return columns;
  }, [childrenByParent, focusedPathItems, shouldShowNode, visibleRootCategories]);

  useEffect(() => {
    const container = columnsScrollRef.current;
    if (!container || !focusedCategory) return;
    const lastColumn = container.lastElementChild;
    if (lastColumn instanceof HTMLElement) {
      lastColumn.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
    }
  }, [focusedCategory]);

  const filteredBrands = useMemo(() => {
    if (!normalizedBrandSearch) return brands;
    return brands.filter((item) => normalizeArabicText(item.name).includes(normalizedBrandSearch));
  }, [brands, normalizedBrandSearch]);

  const modalCategory = useMemo(
    () =>
      modalState?.kind === "category-edit"
        ? categories.find((item) => item.id === modalState.categoryId) ?? null
        : null,
    [categories, modalState],
  );

  const modalBrand = useMemo(
    () =>
      modalState?.kind === "brand-edit"
        ? brands.find((item) => item.id === modalState.brandId) ?? null
        : null,
    [brands, modalState],
  );

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

  const openCategoryEdit = (category: CategoryReferenceItem) => {
    setModalError("");
    setNotice("");
    setModalState({ kind: "category-edit", categoryId: category.id });
  };

  const selectCategory = (category: CategoryReferenceItem) => {
    const rootId = pathIdsById.get(category.id)?.[0] ?? category.id;
    setSelectedRootId(rootId);
    setSelectedCategoryId(category.id);
  };

  const openBrandCreate = () => {
    setModalError("");
    setNotice("");
    setModalState({ kind: "brand-create" });
  };

  const openBrandEdit = (brand: BrandReferenceItem) => {
    setModalError("");
    setNotice("");
    setModalState({ kind: "brand-edit", brandId: brand.id });
  };

  const saveCategory = async (payload: { name: string; parentId: string | null; showInPos: boolean }) => {
    const editing =
      modalState?.kind === "category-edit"
        ? categories.find((item) => item.id === modalState.categoryId) ?? null
        : null;
    const query = new URLSearchParams({ type: "category" });
    if (editing) query.set("id", editing.id);

    setSaving(true);
    setModalError("");
    setPageError("");
    setNotice("");
    try {
      const response = await posFetch(`/api/catalog/references?${query}`, {
        method: editing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json", "x-pos-role": "admin" },
        body: JSON.stringify(payload),
      });
      const data = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) throw new Error(data?.error ?? "تعذر حفظ التصنيف");
      setModalState(null);
      setNotice(editing ? "تم تحديث التصنيف بنجاح" : "تم إنشاء التصنيف بنجاح");
      await load();
    } catch (reason) {
      setModalError(reason instanceof Error ? reason.message : "تعذر حفظ التصنيف");
    } finally {
      setSaving(false);
    }
  };

  const saveBrand = async (payload: { name: string }) => {
    const editing =
      modalState?.kind === "brand-edit"
        ? brands.find((item) => item.id === modalState.brandId) ?? null
        : null;
    const query = new URLSearchParams({ type: "brand" });
    if (editing) query.set("id", editing.id);

    setSaving(true);
    setModalError("");
    setPageError("");
    setNotice("");
    try {
      const response = await posFetch(`/api/catalog/references?${query}`, {
        method: editing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json", "x-pos-role": "admin" },
        body: JSON.stringify(payload),
      });
      const data = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) throw new Error(data?.error ?? "تعذر حفظ العلامة التجارية");
      setModalState(null);
      setNotice(editing ? "تم تحديث العلامة التجارية" : "تمت إضافة العلامة التجارية");
      await load();
    } catch (reason) {
      setModalError(reason instanceof Error ? reason.message : "تعذر حفظ العلامة التجارية");
    } finally {
      setSaving(false);
    }
  };

  const removeCategory = async (item: CategoryReferenceItem) => {
    const impact = [
      item.childCount > 0 ? `${item.childCount.toLocaleString("ar-JO")} تصنيف فرعي` : "",
      item.productCount > 0 ? `${item.productCount.toLocaleString("ar-JO")} منتج مرتبط` : "",
    ]
      .filter(Boolean)
      .join("، ");

    if (!window.confirm(`حذف التصنيف «${item.name}»؟${impact ? ` (${impact})` : ""}`)) return;

    setSaving(true);
    setModalError("");
    setPageError("");
    setNotice("");
    try {
      const query = new URLSearchParams({ type: "category", id: item.id });
      const response = await posFetch(`/api/catalog/references?${query}`, {
        method: "DELETE",
        headers: { "x-pos-role": "admin" },
      });
      const data = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) throw new Error(data?.error ?? "تعذر حذف التصنيف");
      if (modalState?.kind === "category-edit" && modalState.categoryId === item.id) {
        setModalState(null);
      }
      setNotice("تم حذف التصنيف");
      await load();
    } catch (reason) {
      setPageError(reason instanceof Error ? reason.message : "تعذر حذف التصنيف");
    } finally {
      setSaving(false);
    }
  };

  const toggleCategoryVisibility = async (item: CategoryReferenceItem) => {
    const newShowInPos = !item.showInPos;
    setSaving(true);
    setPageError("");
    setNotice("");
    try {
      const query = new URLSearchParams({ type: "category", id: item.id });
      const response = await posFetch(`/api/catalog/references?${query}`, {
        method: "PUT",
        headers: { "x-pos-role": "admin" },
        body: JSON.stringify({ name: item.name, parentId: item.parentId ?? null, showInPos: newShowInPos }),
      });
      const data = (await response.json().catch(() => null)) as { item?: CategoryReferenceItem; error?: string } | null;
      if (!response.ok) throw new Error(data?.error ?? "تعذر تحديث ظهور التصنيف");
      setCategories((prev) =>
        prev.map((c) => (c.id === item.id ? { ...c, showInPos: newShowInPos } : c)),
      );
      setNotice(newShowInPos ? `تم إظهار «${item.name}» في نقطة البيع` : `تم إخفاء «${item.name}» من نقطة البيع`);
    } catch (reason) {
      setPageError(reason instanceof Error ? reason.message : "تعذر تحديث ظهور التصنيف");
    } finally {
      setSaving(false);
    }
  };

  const removeBrand = async (item: BrandReferenceItem) => {
    const impact = item.productCount > 0 ? ` (${item.productCount.toLocaleString("ar-JO")} منتج مرتبط)` : "";
    if (!window.confirm(`حذف العلامة التجارية «${item.name}»؟${impact}`)) return;

    setSaving(true);
    setModalError("");
    setPageError("");
    setNotice("");
    try {
      const query = new URLSearchParams({ type: "brand", id: item.id });
      const response = await posFetch(`/api/catalog/references?${query}`, {
        method: "DELETE",
        headers: { "x-pos-role": "admin" },
      });
      const data = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) throw new Error(data?.error ?? "تعذر حذف العلامة التجارية");
      if (modalState?.kind === "brand-edit" && modalState.brandId === item.id) {
        setModalState(null);
      }
      setNotice("تم حذف العلامة التجارية");
      await load();
    } catch (reason) {
      setPageError(reason instanceof Error ? reason.message : "تعذر حذف العلامة التجارية");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-3 md:h-[calc(100dvh-9rem)] md:min-h-0">
      <header className="flex shrink-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="truncate text-xl font-black text-foreground">التصنيفات والعلامات</h1>
          <p className="mt-0.5 text-xs font-semibold text-muted">
            كل عمود هو مستوى. اختر قسمًا لتظهر محتوياته في العمود التالي.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            aria-label="تحديث"
            title="تحديث"
            className="grid h-10 w-10 place-items-center rounded-lg border border-border bg-surface text-muted hover:bg-surface-muted disabled:opacity-40"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </button>
          <Link
            href="/admin/inventory"
            className="flex h-10 items-center gap-2 rounded-lg border border-border bg-surface px-3 text-xs font-black text-foreground hover:bg-surface-muted"
          >
            <Package className="h-4 w-4 text-primary" />
            المنتجات
          </Link>
          <button
            type="button"
            onClick={activePanel === "categories" ? () => openCategoryCreate() : openBrandCreate}
            className="flex h-10 items-center gap-2 rounded-lg bg-primary px-3 text-xs font-black text-primary-foreground hover:bg-primary-hover"
          >
            <Plus className="h-4 w-4" />
            {activePanel === "categories" ? "قسم رئيسي" : "علامة"}
          </button>
        </div>
      </header>

      {pageError && (
        <p className="shrink-0 rounded-md bg-destructive/10 px-3 py-2 text-xs font-bold text-destructive">{pageError}</p>
      )}
      {notice && (
        <p className="shrink-0 rounded-md bg-success/10 px-3 py-2 text-xs font-bold text-success">{notice}</p>
      )}

      <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-sm">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border p-2.5">
          <div className="inline-flex rounded-lg bg-surface-muted p-1 ring-1 ring-border">
            <button
              type="button"
              onClick={() => setActivePanel("categories")}
              className={`flex h-9 items-center gap-2 rounded-md px-3 text-xs font-black ${
                activePanel === "categories" ? "bg-surface text-foreground shadow-card" : "text-muted"
              }`}
            >
              <FolderTree className="h-4 w-4" />
              التصنيفات
              <span className="tabular-nums text-[10px]">{categories.length.toLocaleString("ar-JO")}</span>
            </button>
            <button
              type="button"
              onClick={() => setActivePanel("brands")}
              className={`flex h-9 items-center gap-2 rounded-md px-3 text-xs font-black ${
                activePanel === "brands" ? "bg-surface text-foreground shadow-card" : "text-muted"
              }`}
            >
              <Building2 className="h-4 w-4" />
              العلامات
              <span className="tabular-nums text-[10px]">{brands.length.toLocaleString("ar-JO")}</span>
            </button>
          </div>

          <label className="w-72 max-w-[42%]">
            <span className="sr-only">بحث</span>
            <input
              value={activePanel === "categories" ? categorySearch : brandSearch}
              onChange={(event) =>
                activePanel === "categories"
                  ? setCategorySearch(event.target.value)
                  : setBrandSearch(event.target.value)
              }
              placeholder={activePanel === "categories" ? "بحث في التصنيفات" : "بحث في العلامات"}
              className="h-9 w-full rounded-lg border border-border bg-surface px-3 text-xs font-bold outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
          </label>
        </div>

        {activePanel === "categories" ? (
          loading ? (
            <div className="grid min-h-0 flex-1 place-items-center text-sm font-bold text-muted">
              <Loader2 className="h-7 w-7 animate-spin text-primary" />
            </div>
          ) : visibleRootCategories.length === 0 ? (
            <div className="grid min-h-0 flex-1 place-items-center px-6 text-center">
              <div>
                <FolderTree className="mx-auto h-9 w-9 text-muted" />
                <p className="mt-2 text-sm font-black text-foreground">
                  {normalizedCategorySearch ? "لا توجد نتائج" : "لا توجد تصنيفات"}
                </p>
              </div>
            </div>
          ) : (
            <>
              <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border px-3">
                <div className="flex min-w-0 items-center gap-1 overflow-x-auto scrollbar-hidden">
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedRootId(visibleRootCategories[0]?.id ?? "");
                      setSelectedCategoryId(visibleRootCategories[0]?.id ?? "");
                    }}
                    className="shrink-0 text-xs font-black text-muted hover:text-primary"
                  >
                    الرئيسية
                  </button>
                  {focusedPathItems.map((category) => (
                    <span key={category.id} className="flex shrink-0 items-center gap-1">
                      <span className="text-slate-300">/</span>
                      <button
                        type="button"
                        onClick={() => selectCategory(category)}
                        className={`max-w-32 truncate text-xs font-black ${
                          category.id === focusedCategory?.id ? "text-foreground" : "text-muted hover:text-primary"
                        }`}
                      >
                        {category.name}
                      </button>
                    </span>
                  ))}
                </div>

                {focusedCategory && (
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => openCategoryCreate(focusedCategory.id)}
                      className="flex h-8 items-center gap-1 rounded-md px-2 text-[11px] font-black text-success hover:bg-success/10"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      إضافة داخله
                    </button>
                    <button
                      type="button"
                      onClick={() => openCategoryEdit(focusedCategory)}
                      aria-label="تعديل القسم المحدد"
                      title="تعديل القسم المحدد"
                      className="grid h-8 w-8 place-items-center rounded-md text-primary hover:bg-primary/10"
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => void removeCategory(focusedCategory)}
                      disabled={saving}
                      aria-label="حذف القسم المحدد"
                      title="حذف القسم المحدد"
                      className="grid h-8 w-8 place-items-center rounded-md text-destructive hover:bg-destructive/10 disabled:opacity-40"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                )}
              </div>

              <div
                ref={columnsScrollRef}
                className="flex min-h-0 flex-1 gap-2 overflow-x-auto bg-surface-muted/60 p-2 scrollbar-hidden"
              >
                {categoryColumns.map((column, index) => (
                  <section
                    key={column.key}
                    className="flex h-full min-w-[250px] max-w-[290px] flex-1 flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-card"
                  >
                    <header className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-slate-200 px-3">
                      <div className="min-w-0">
                        <h2 className="truncate text-xs font-black text-foreground">{column.title}</h2>
                        <p className="text-[10px] font-bold text-muted">
                          {column.items.length.toLocaleString("ar-JO")} قسم
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => openCategoryCreate(column.parent?.id ?? null)}
                        aria-label={column.parent ? `إضافة قسم داخل ${column.parent.name}` : "إضافة قسم رئيسي"}
                        title={column.parent ? "إضافة قسم في هذا المستوى" : "إضافة قسم رئيسي"}
                        className="grid h-8 w-8 place-items-center rounded-md text-success hover:bg-success/10"
                      >
                        <Plus className="h-4 w-4" />
                      </button>
                    </header>

                    <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2">
                      {column.items.length > 0 ? (
                        column.items.map((category) => (
                          <CategoryColumnItem
                            key={category.id}
                            category={category}
                            active={column.activeId === category.id}
                            childCount={(childrenByParent.get(category.id) ?? []).length}
                            saving={saving}
                            onSelect={() => selectCategory(category)}
                            onCreateChild={openCategoryCreate}
                            onEdit={openCategoryEdit}
                            onDelete={(item) => void removeCategory(item)}
                            onToggleVisibility={(item) => void toggleCategoryVisibility(item)}
                          />
                        ))
                      ) : (
                        <div className="grid h-full place-items-center px-4 text-center">
                          <button
                            type="button"
                            onClick={() => openCategoryCreate(column.parent?.id ?? null)}
                            className="text-xs font-black text-primary hover:underline"
                          >
                            + إضافة أول قسم
                          </button>
                        </div>
                      )}
                    </div>

                    {index === categoryColumns.length - 1 && column.parent && (
                      <footer className="shrink-0 border-t border-slate-200 px-3 py-2 text-[10px] font-bold text-muted">
                        {column.parent.productCount.toLocaleString("ar-JO")} منتج مرتبط مباشرة
                      </footer>
                    )}
                  </section>
                ))}
              </div>
            </>
          )
        ) : loading ? (
          <div className="grid h-full min-h-0 place-items-center text-sm font-bold text-muted">
            <div className="text-center">
              <Loader2 className="mx-auto mb-2 h-7 w-7 animate-spin text-primary" />
              جارٍ تحميل العلامات...
            </div>
          </div>
        ) : filteredBrands.length === 0 ? (
          <div className="grid h-full min-h-0 place-items-center px-6 text-center">
            <div>
              <Building2 className="mx-auto mb-3 h-9 w-9 text-muted" />
              <p className="text-sm font-black text-foreground">
                {normalizedBrandSearch ? "لا توجد نتائج مطابقة" : "لا توجد علامات تجارية بعد"}
              </p>
              <p className="mt-1 text-xs font-semibold text-muted">
                {normalizedBrandSearch ? "جرّب اسمًا آخر." : "يمكنك إضافتها عند الحاجة فقط."}
              </p>
            </div>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {filteredBrands.map((brand) => (
                <article
                  key={brand.id}
                  className="rounded-xl border border-border bg-white p-4 transition hover:border-primary/30"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="truncate text-sm font-black text-foreground">{brand.name}</h3>
                      <p className="mt-1 text-xs font-semibold text-muted">
                        مرتبطة بـ {brand.productCount.toLocaleString("ar-JO")} منتج
                      </p>
                    </div>
                    <span className="rounded-full bg-surface-muted px-2.5 py-1 text-[11px] font-black text-muted">
                      علامة
                    </span>
                  </div>
                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      onClick={() => openBrandEdit(brand)}
                      className="flex h-10 flex-1 items-center justify-center gap-1.5 rounded-lg border border-primary/30 bg-primary/5 text-xs font-black text-primary transition hover:bg-primary/10"
                    >
                      <Pencil className="h-4 w-4" />
                      تعديل
                    </button>
                    <button
                      type="button"
                      onClick={() => void removeBrand(brand)}
                      disabled={saving}
                      className="flex h-10 flex-1 items-center justify-center gap-1.5 rounded-lg border border-destructive/30 bg-destructive/5 text-xs font-black text-destructive transition hover:bg-destructive/10 disabled:opacity-40"
                    >
                      <Trash2 className="h-4 w-4" />
                      حذف
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </div>
        )}
      </section>

      {(modalState?.kind === "category-create" || modalState?.kind === "category-edit") && (
        <CategoryModal
          categories={categories}
          initial={modalCategory}
          defaultParentId={modalState.kind === "category-create" ? modalState.parentId : null}
          saving={saving}
          error={modalError}
          onClose={closeModal}
          onSubmit={saveCategory}
        />
      )}

      {(modalState?.kind === "brand-create" || modalState?.kind === "brand-edit") && (
        <BrandModal
          initial={modalBrand}
          saving={saving}
          error={modalError}
          onClose={closeModal}
          onSubmit={saveBrand}
        />
      )}
    </div>
  );
}
