import { getSupabaseBrowser } from "./supabaseBrowser";
import { getTenantStoreId } from "./tenantClient";
import { notifyLocalCatalogWrite } from "./catalogInvalidation";
import { normalizeArabicText } from "@/lib/arabic";

export interface CategoryReferenceItem {
  id: string;
  name: string;
  productCount: number;
  parentId: string | null;
  childCount: number;
  bgColor: string | null;
  sortOrder: number;
  showInPos: boolean;
}

export interface BrandReferenceItem {
  id: string;
  name: string;
  productCount: number;
}

/**
 * Guard: a category name must never collide with an existing brand/supplier
 * name. Brand names are for reporting/filtering only (the Brands panel), not
 * for POS navigation categories. Throws a descriptive error so an admin can't
 * accidentally turn "ديماس" or "الفجر" into a category that navigates the
 * cashier. Comparison is Arabic-normalized and case-insensitive.
 */
async function assertCategoryNameIsNotBrand(sb: ReturnType<typeof getSupabaseBrowser>, storeId: string, name: string): Promise<void> {
  if (!sb) throw new Error("Supabase غير مهيأة");
  const clean = name.trim();
  if (!clean) return;
  const normalized = normalizeArabicText(clean);
  const { data: brandRows, error } = await sb
    .from("product_brands")
    .select("name")
    .eq("store_id", storeId);
  if (error) {
    // Failing to verify should not silently allow a collision; surface it.
    throw new Error(error.message);
  }
  const match = (brandRows ?? []).find((row: { name: string }) => normalizeArabicText(row.name) === normalized);
  if (match) {
    throw new Error(
      `«${clean}» اسم علامة تجارية وليست تصنيفاً. أُلغيت لأنه يُستخدم كتصنيف في نقطة البيع — أدخل أسماء العلامات من لوحة «العلامات», وليست من هنا.`,
    );
  }
}

async function fetchAllRows<T>(
  sb: ReturnType<typeof getSupabaseBrowser>,
  table: string,
  select: string,
  storeId: string,
  order?: string,
): Promise<T[]> {
  if (!sb) return [];
  const PAGE = 1000;
  const rows: T[] = [];
  for (let start = 0; ; start += PAGE) {
    let q = sb.from(table).select(select).eq("store_id", storeId).range(start, start + PAGE - 1);
    if (order) q = q.order(order);
    const { data, error } = await q;
    if (error) throw error;
    rows.push(...((data ?? []) as T[]));
    if (!data || data.length < PAGE) break;
  }
  return rows;
}

export async function fetchTaxonomy(): Promise<{
  categories: CategoryReferenceItem[];
  brands: BrandReferenceItem[];
  uncategorizedProductCount: number;
  totalProductCount: number;
}> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  const [categoryRows, productRows] = await Promise.all([
    fetchAllRows<{ id: string; name: string; parent_id: string | null; bg_color: string | null; sort_order: number; show_in_pos?: boolean }>(
      sb, "categories", "id,name,parent_id,bg_color,sort_order,show_in_pos", storeId, "name",
    ),
    fetchAllRows<{ category_id?: string | null; brand_id?: string | null }>(
      sb, "products", "category_id,brand_id", storeId,
    ),
  ]);

  const productCounts = new Map<string, number>();
  const brandProductCounts = new Map<string, number>();
  let uncategorized = 0;
  for (const p of productRows) {
    const catId = String(p.category_id ?? "");
    if (catId) productCounts.set(catId, (productCounts.get(catId) ?? 0) + 1);
    else uncategorized += 1;
    const brandId = String(p.brand_id ?? "");
    if (brandId) brandProductCounts.set(brandId, (brandProductCounts.get(brandId) ?? 0) + 1);
  }
  const totalProductCount = productRows.length;

  const childCounts = new Map<string, number>();
  for (const row of categoryRows) {
    if (!row.parent_id) continue;
    childCounts.set(row.parent_id, (childCounts.get(row.parent_id) ?? 0) + 1);
  }

  const categories: CategoryReferenceItem[] = categoryRows.map((row) => ({
    id: row.id,
    name: row.name,
    productCount: productCounts.get(row.id) ?? 0,
    parentId: row.parent_id,
    childCount: childCounts.get(row.id) ?? 0,
    bgColor: row.bg_color,
    sortOrder: row.sort_order,
    showInPos: row.show_in_pos ?? true,
  }));

  const brandRows = await fetchAllRows<{ id: string; name: string }>(
    sb, "product_brands", "id,name", storeId, "name",
  );
  const brands: BrandReferenceItem[] = brandRows.map((row) => ({
    id: row.id,
    name: row.name,
    productCount: brandProductCounts.get(row.id) ?? 0,
  }));

  return { categories, brands, uncategorizedProductCount: uncategorized, totalProductCount };
}

export async function saveCategory(payload: {
  name: string;
  parentId: string | null;
  showInPos: boolean;
}, editingId?: string): Promise<CategoryReferenceItem> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  const normalizedName = payload.name.trim().toLowerCase();
  const { data: existing } = await sb.from("categories").select("id,name").eq("store_id", storeId);
  const duplicate = (existing ?? []).find(
    (r: { id: string; name: string }) => r.name.trim().toLowerCase() === normalizedName && r.id !== editingId,
  );
  if (duplicate) throw new Error("التصنيف موجود مسبقاً");
  await assertCategoryNameIsNotBrand(sb, storeId, payload.name);

  const updatePayload: Record<string, unknown> = { name: payload.name.trim(), parent_id: payload.parentId, show_in_pos: payload.showInPos };

  if (editingId) {
    const { data, error } = await sb
      .from("categories")
      .update(updatePayload)
      .eq("id", editingId)
      .eq("store_id", storeId)
      .select("id,name,parent_id,bg_color,sort_order,show_in_pos")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error("التصنيف غير موجود");
    notifyLocalCatalogWrite(storeId);
    return {
      id: data.id, name: data.name, productCount: 0, parentId: data.parent_id, childCount: 0,
      bgColor: data.bg_color, sortOrder: data.sort_order, showInPos: data.show_in_pos ?? true,
    };
  }

  const { data: siblings } = await sb
    .from("categories")
    .select("sort_order")
    .eq("store_id", storeId)
    .order("sort_order", { ascending: false })
    .limit(50);
  const siblingOrders = (siblings ?? [])
    .map((r: { sort_order: number | null }) => Number(r.sort_order ?? 0));
  const maxSortOrder = siblingOrders.length > 0 ? Math.max(...siblingOrders) : -1;

  const insertPayload: Record<string, unknown> = {
    store_id: storeId,
    name: payload.name.trim(),
    parent_id: payload.parentId,
    show_in_pos: payload.showInPos,
    sort_order: maxSortOrder + 1,
  };
  const { data: created, error } = await sb
    .from("categories")
    .insert(insertPayload)
    .select("id,name,parent_id,bg_color,sort_order,show_in_pos")
    .single();
  if (error || !created) throw new Error(error?.message ?? "تعذر إنشاء التصنيف");
  notifyLocalCatalogWrite(storeId);
  return {
    id: created.id, name: created.name, productCount: 0, parentId: created.parent_id, childCount: 0,
    bgColor: created.bg_color, sortOrder: created.sort_order, showInPos: created.show_in_pos ?? true,
  };
}

export async function reorderCategories(items: { id: string; sortOrder: number }[]): Promise<void> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");
  if (items.length === 0) return;

  for (const item of items) {
    const { error } = await sb
      .from("categories")
      .update({ sort_order: item.sortOrder })
      .eq("id", item.id)
      .eq("store_id", storeId);
    if (error) throw new Error(error.message);
  }
  notifyLocalCatalogWrite(storeId);
}

export async function deleteCategory(id: string): Promise<void> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  const { data: child } = await sb.from("categories").select("id").eq("store_id", storeId).eq("parent_id", id).limit(1).maybeSingle();
  if (child) throw new Error("انقل الفئات الفرعية أو احذفها أولاً");

  const { count } = await sb.from("products").select("id", { count: "exact", head: true }).eq("store_id", storeId).eq("category_id", id);
  if ((count ?? 0) > 0) {
    throw new Error(`لا يمكن حذف التصنيف لأنه مرتبط بـ ${count} منتج. عطّل التصنيف أو غيّر ارتباط المنتجات أولاً`);
  }

  const { error } = await sb.from("categories").delete().eq("id", id).eq("store_id", storeId);
  if (error) throw new Error(error.message);
  notifyLocalCatalogWrite(storeId);
}

export async function toggleCategoryVisibility(item: CategoryReferenceItem): Promise<boolean> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  const newShowInPos = !item.showInPos;
  const { error } = await sb
    .from("categories")
    .update({ show_in_pos: newShowInPos })
    .eq("id", item.id)
    .eq("store_id", storeId);
  if (error) throw new Error(error.message);
  notifyLocalCatalogWrite(storeId);
  return newShowInPos;
}

export async function saveBrand(payload: { name: string }, editingId?: string): Promise<BrandReferenceItem> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  const normalizedName = payload.name.trim().toLowerCase();
  const { data: existing } = await sb.from("product_brands").select("id,name").eq("store_id", storeId);
  const duplicate = (existing ?? []).find(
    (r: { id: string; name: string }) => r.name.trim().toLowerCase() === normalizedName && r.id !== editingId,
  );
  if (duplicate) throw new Error("العلامة التجارية موجودة مسبقاً");

  if (editingId) {
    const { data, error } = await sb.from("product_brands").update({ name: payload.name.trim() }).eq("id", editingId).eq("store_id", storeId).select("id,name").maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error("العلامة التجارية غير موجودة");
    notifyLocalCatalogWrite(storeId);
    return { id: data.id, name: data.name, productCount: 0 };
  }

  const { data: created, error } = await sb.from("product_brands").insert({ store_id: storeId, name: payload.name.trim() }).select("id,name").single();
  if (error || !created) throw new Error(error?.message ?? "تعذر إنشاء العلامة التجارية");
  notifyLocalCatalogWrite(storeId);
  return { id: created.id, name: created.name, productCount: 0 };
}

export async function deleteBrand(id: string): Promise<void> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  const { count } = await sb.from("products").select("id", { count: "exact", head: true }).eq("store_id", storeId).eq("brand_id", id);
  if ((count ?? 0) > 0) {
    throw new Error(`لا يمكن حذف العلامة التجارية لأنها مرتبط بـ ${count} منتج. غيّر ارتباط المنتجات أولاً`);
  }

  const { error } = await sb.from("product_brands").delete().eq("id", id).eq("store_id", storeId);
  if (error) throw new Error(error.message);
  notifyLocalCatalogWrite(storeId);
}

/** Inline rename — updates only the name for an existing category. */
export async function renameCategory(id: string, name: string): Promise<void> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  const clean = name.trim();
  if (!clean) throw new Error("الاسم لا يمكن أن يكون فارغاً");

  const { data: existing } = await sb.from("categories").select("id,name").eq("store_id", storeId);
  const duplicate = (existing ?? []).find(
    (r: { id: string; name: string }) =>
      r.name.trim().toLowerCase() === clean.toLowerCase() && r.id !== id,
  );
  if (duplicate) throw new Error("يوجد تصنيف آخر بنفس الاسم");
  await assertCategoryNameIsNotBrand(sb, storeId, clean);

  const { error } = await sb
    .from("categories")
    .update({ name: clean })
    .eq("id", id)
    .eq("store_id", storeId);
  if (error) throw new Error(error.message);
  notifyLocalCatalogWrite(storeId);
}

/** Inline rename — updates only the name for an existing brand. */
export async function renameBrand(id: string, name: string): Promise<void> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  const clean = name.trim();
  if (!clean) throw new Error("الاسم لا يمكن أن يكون فارغاً");

  const { data: existing } = await sb.from("product_brands").select("id,name").eq("store_id", storeId);
  const duplicate = (existing ?? []).find(
    (r: { id: string; name: string }) =>
      r.name.trim().toLowerCase() === clean.toLowerCase() && r.id !== id,
  );
  if (duplicate) throw new Error("يوجد اسم آخر بنفس الاسم");

  const { error } = await sb
    .from("product_brands")
    .update({ name: clean })
    .eq("id", id)
    .eq("store_id", storeId);
  if (error) throw new Error(error.message);
  notifyLocalCatalogWrite(storeId);
}

/** Batch toggle `show_in_pos` for many categories at once. */
export async function toggleCategoriesVisibility(ids: string[], showInPos: boolean): Promise<void> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");
  if (ids.length === 0) return;

  const { error } = await sb
    .from("categories")
    .update({ show_in_pos: showInPos })
    .in("id", ids)
    .eq("store_id", storeId);
  if (error) throw new Error(error.message);
  notifyLocalCatalogWrite(storeId);
}

/**
 * Batch delete of categories. Individual per-item guards (blocked when it has
 * children or linked products) still apply; throws on the first failure with a
 * descriptive message so the caller can report what went wrong.
 */
export async function deleteCategories(ids: string[]): Promise<void> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");
  if (ids.length === 0) return;

  for (const id of ids) {
    const { data: child } = await sb
      .from("categories").select("id").eq("store_id", storeId).eq("parent_id", id).limit(1).maybeSingle();
    if (child) throw new Error("حدد التصنيفات الفرعية أو احذفها أولاً");

    const { count } = await sb
      .from("products").select("id", { count: "exact", head: true }).eq("store_id", storeId).eq("category_id", id);
    if ((count ?? 0) > 0) {
      throw new Error(`لا يمكن حذف تصنيف مرتبط بـ ${count} منتج`);
    }
  }

  const { error } = await sb.from("categories").delete().in("id", ids).eq("store_id", storeId);
  if (error) throw new Error(error.message);
  notifyLocalCatalogWrite(storeId);
}

/** Batch delete of brands. Throws if any brand still has linked products. */
export async function deleteBrands(ids: string[]): Promise<void> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");
  if (ids.length === 0) return;

  for (const id of ids) {
    const { count } = await sb
      .from("products").select("id", { count: "exact", head: true }).eq("store_id", storeId).eq("brand_id", id);
    if ((count ?? 0) > 0) {
      throw new Error(`لا يمكن حذف علامة مرتبطة بـ ${count} منتج`);
    }
  }

  const { error } = await sb.from("product_brands").delete().in("id", ids).eq("store_id", storeId);
  if (error) throw new Error(error.message);
  notifyLocalCatalogWrite(storeId);
}

/** A lightweight product row shown when a leaf category is expanded inline. */
export interface CategoryProductItem {
  id: string;
  name: string;
  price: number;
  barcode: string;
  stock: number;
  isActive: boolean;
}

function toNumber(value: string | number | null | undefined, fallback = 0): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

/**
 * Fetch the products directly linked to a category and list them inline.
 *
 * A category's products are sourced from TWO places and unioned together so
 * nothing is ever hidden:
 *   1. the additive `product_categories` join table (multi-category links), and
 *   2. the primary/denormalized `products.category_id` FK (what the Inventory
 *      screen and other single-category editors update).
 * This keeps the inline list consistent with the tree badge even when a product
 * was assigned through only one of the two paths. Barcodes come from each
 * product's first available variant.
 */
export async function fetchCategoryProducts(categoryId: string): Promise<CategoryProductItem[]> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  // Source 1: products explicitly linked via the join table.
  const { data: links, error: linkError } = await sb
    .from("product_categories")
    .select("product_id")
    .eq("category_id", categoryId);
  if (linkError) throw new Error(linkError.message);

  const productIds = new Set((links ?? []).map((l: { product_id: string }) => l.product_id));

  // Source 2: products whose primary `category_id` FK points at this category
  // (the path Inventory writes to). Unioned so no direct product vanishes.
  const { data: fkRows, error: fkError } = await sb
    .from("products")
    .select("id")
    .eq("store_id", storeId)
    .eq("category_id", categoryId);
  if (fkError) throw new Error(fkError.message);
  for (const row of fkRows ?? []) productIds.add((row as { id: string }).id);

  if (productIds.size === 0) return [];

  const { data: productRows, error: productError } = await sb
    .from("products")
    .select("id,name,selling_price,total_stock,is_active")
    .eq("store_id", storeId)
    .in("id", [...productIds]);
  if (productError) throw new Error(productError.message);

  if (!productRows || productRows.length === 0) return [];

  // Barcode for each product — pick the first available variant's barcode.
  const { data: variantRows, error: variantError } = await sb
    .from("product_variants")
    .select("product_id,barcode")
    .in("product_id", [...productIds]);
  if (variantError) throw new Error(variantError.message);

  const barcodeByProduct = new Map<string, string>();
  for (const v of (variantRows ?? []) as Array<{ product_id: string; barcode: string }>) {
    if (!barcodeByProduct.has(v.product_id) && v.barcode != null) {
      barcodeByProduct.set(v.product_id, v.barcode);
    }
  }

  return (productRows ?? []).map((p: { id: string; name: string; selling_price: string | number | null; total_stock: string | number | null; is_active: boolean | null }) => ({
    id: p.id,
    name: p.name,
    price: toNumber(p.selling_price),
    barcode: barcodeByProduct.get(p.id) ?? "",
    stock: toNumber(p.total_stock),
    isActive: p.is_active ?? true,
  }));
}
