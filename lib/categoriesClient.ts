import { getSupabaseBrowser } from "./supabaseBrowser";
import { getTenantStoreId } from "./tenantClient";

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
  for (const p of productRows) {
    const catId = String(p.category_id ?? "");
    if (catId) productCounts.set(catId, (productCounts.get(catId) ?? 0) + 1);
    const brandId = String(p.brand_id ?? "");
    if (brandId) brandProductCounts.set(brandId, (brandProductCounts.get(brandId) ?? 0) + 1);
  }

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

  return { categories, brands };
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
    return { id: data.id, name: data.name, productCount: 0 };
  }

  const { data: created, error } = await sb.from("product_brands").insert({ store_id: storeId, name: payload.name.trim() }).select("id,name").single();
  if (error || !created) throw new Error(error?.message ?? "تعذر إنشاء العلامة التجارية");
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
}
