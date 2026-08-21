import { collectDescendantIds } from "@/lib/categoryTree";
import { normalizeArabicText } from "@/lib/arabic";
import { authorizedAnyCapabilityStoreId } from "@/lib/requestAuth";
import { fetchAllRows, supabase, detectColumnExists } from "@/lib/supabase";

type ReferenceType = "category" | "brand" | "supplier";

interface ReferenceConfig {
  type: ReferenceType;
  table: "categories" | "product_brands" | "suppliers";
  productField: "category_id" | "brand_id" | "default_supplier_id";
  label: string;
  max: number;
}

interface CategoryDirectoryRow {
  id: string;
  name: string;
  parent_id: string | null;
  bg_color: string | null;
  sort_order: number;
  show_in_pos?: boolean;
}

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

class ReferenceValidationError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "ReferenceValidationError";
    this.status = status;
  }
}

function referenceConfig(type: string | null): ReferenceConfig | null {
  if (type === "category") {
    return { type, table: "categories", productField: "category_id", label: "التصنيف", max: 100 };
  }
  if (type === "brand") {
    return { type, table: "product_brands", productField: "brand_id", label: "العلامة التجارية", max: 120 };
  }
  if (type === "supplier") {
    return { type, table: "suppliers", productField: "default_supplier_id", label: "المورد", max: 150 };
  }
  return null;
}

async function readBody(
  request: Request,
  config: ReferenceConfig,
): Promise<{ name?: string; parentId: string | null; showInPos: boolean; error?: Response }> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { parentId: null, showInPos: true, error: Response.json({ error: "invalid_json" }, { status: 400 }) };
  }

  const input = (body ?? {}) as { name?: unknown; parentId?: unknown; showInPos?: unknown };
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const parentId = config.type === "category" && typeof input.parentId === "string"
    ? input.parentId.trim() || null
    : null;
  const showInPos = config.type === "category" ? Boolean(input.showInPos ?? true) : true;

  if (!name) {
    return { parentId, showInPos, error: Response.json({ error: "الاسم مطلوب" }, { status: 400 }) };
  }
  if (name.length > config.max) {
    return { parentId, showInPos, error: Response.json({ error: "الاسم طويل جداً" }, { status: 400 }) };
  }

  return { name, parentId, showInPos };
}

async function fetchCategoryRows(storeId: string): Promise<CategoryDirectoryRow[]> {
  const hasShowInPos = await detectColumnExists(supabase!, "categories", "show_in_pos");
  const select = hasShowInPos
    ? "id,name,parent_id,bg_color,sort_order,show_in_pos"
    : "id,name,parent_id,bg_color,sort_order";
  return fetchAllRows<CategoryDirectoryRow>(
    supabase!,
    "categories",
    select,
    storeId,
    "name",
  );
}

async function duplicateId(table: string, storeId: string, name: string): Promise<string | null> {
  const rows = await fetchAllRows<{ id: string; name: string }>(supabase!, table, "id,name", storeId, "name");
  const normalized = normalizeArabicText(name);
  return rows.find((item) => normalizeArabicText(String(item.name)) === normalized)?.id ?? null;
}

async function resolveCategoryParentId(
  storeId: string,
  parentId: string | null,
  currentId?: string,
): Promise<string | null> {
  if (!parentId) return null;

  const categories = await fetchCategoryRows(storeId);
  const parent = categories.find((row) => row.id === parentId);
  if (!parent) {
    throw new ReferenceValidationError("التصنيف الأب المحدد غير موجود");
  }

  if (currentId) {
    if (parentId === currentId) {
      throw new ReferenceValidationError("لا يمكن ربط التصنيف بنفسه");
    }

    const descendants = collectDescendantIds(
      categories.map((row) => ({ id: row.id, parentId: row.parent_id })),
      currentId,
    );
    if (descendants.has(parentId)) {
      throw new ReferenceValidationError("لا يمكن نقل التصنيف داخل أحد فروعه");
    }
  }

  return parentId;
}

async function categoryProductCount(storeId: string, categoryId: string): Promise<number> {
  const products = await fetchAllRows<{ category_id?: string | null }>(
    supabase!,
    "products",
    "category_id",
    storeId,
  );
  return products.filter((product) => product.category_id === categoryId).length;
}

function toCategoryReferenceItem(
  row: CategoryDirectoryRow,
  productCount: number,
  childCount: number,
): CategoryReferenceItem {
  return {
    id: row.id,
    name: row.name,
    productCount,
    parentId: row.parent_id,
    childCount,
    bgColor: row.bg_color,
    sortOrder: row.sort_order,
    showInPos: row.show_in_pos ?? true,
  };
}

export async function GET(request: Request): Promise<Response> {
  if (!supabase) return Response.json({ error: "Supabase غير مهيأة" }, { status: 503 });
  // The mobile camera form reads the category/brand dropdowns, so the narrow
  // catalog.add role shares this read with the full catalog.manage role;
  // creating/renaming/deleting references stays catalog.manage-only below.
  const storeId = await authorizedAnyCapabilityStoreId(request, ["catalog.manage", "catalog.add"]);
  if (storeId instanceof Response) return storeId;

  const config = referenceConfig(new URL(request.url).searchParams.get("type"));
  if (!config) return Response.json({ error: "نوع المرجع غير صالح" }, { status: 400 });

  const [products, rows] = await Promise.all([
    fetchAllRows<{ category_id?: string | null; brand_id?: string | null; default_supplier_id?: string | null }>(
      supabase!,
      "products",
      "category_id,brand_id,default_supplier_id",
      storeId,
    ),
    config.type === "category"
      ? fetchCategoryRows(storeId)
      : fetchAllRows<{ id: string; name: string }>(supabase!, config.table, "id,name", storeId, "name"),
  ]);

  const productCounts = new Map<string, number>();
  for (const product of products) {
    const referenceId = String(product[config.productField] ?? "");
    if (referenceId) {
      productCounts.set(referenceId, (productCounts.get(referenceId) ?? 0) + 1);
    }
  }

  if (config.type === "category") {
    const childCounts = new Map<string, number>();
    for (const row of rows as CategoryDirectoryRow[]) {
      if (!row.parent_id) continue;
      childCounts.set(row.parent_id, (childCounts.get(row.parent_id) ?? 0) + 1);
    }

    return Response.json({
      items: (rows as CategoryDirectoryRow[]).map((row) =>
        toCategoryReferenceItem(row, productCounts.get(row.id) ?? 0, childCounts.get(row.id) ?? 0),
      ),
    });
  }

  const items: BrandReferenceItem[] = (rows as Array<{ id: string; name: string }>).map((row) => ({
    id: row.id,
    name: row.name,
    productCount: productCounts.get(row.id) ?? 0,
  }));
  return Response.json({ items });
}

export async function POST(request: Request): Promise<Response> {
  if (!supabase) return Response.json({ error: "Supabase غير مهيأة" }, { status: 503 });
  const storeId = await authorizedAnyCapabilityStoreId(request, ["catalog.manage"]);
  if (storeId instanceof Response) return storeId;

  const config = referenceConfig(new URL(request.url).searchParams.get("type"));
  if (!config) return Response.json({ error: "نوع المرجع غير صالح" }, { status: 400 });

  const parsed = await readBody(request, config);
  if (parsed.error || !parsed.name) return parsed.error!;

  try {
    if (await duplicateId(config.table, storeId, parsed.name)) {
      return Response.json({ error: `${config.label} موجودة مسبقاً` }, { status: 409 });
    }

    if (config.type === "category") {
      const parentId = await resolveCategoryParentId(storeId, parsed.parentId);
      const hasShowInPos = await detectColumnExists(supabase!, "categories", "show_in_pos");
      const insertPayload: Record<string, unknown> = { store_id: storeId, name: parsed.name, parent_id: parentId };
      if (hasShowInPos) insertPayload.show_in_pos = parsed.showInPos;
      const selectCols = hasShowInPos
        ? "id,name,parent_id,bg_color,sort_order,show_in_pos"
        : "id,name,parent_id,bg_color,sort_order";
      const result = await supabase
        .from("categories")
        .insert(insertPayload)
        .select(selectCols)
        .single();
      if (result.error || !result.data) {
        return Response.json({ error: result.error?.message ?? "تعذر إنشاء التصنيف" }, { status: 500 });
      }

      const row = result.data as unknown as CategoryDirectoryRow;
      return Response.json({
        item: toCategoryReferenceItem(row, 0, 0),
      }, { status: 201 });
    }

    const result = await supabase
      .from("product_brands")
      .insert({ store_id: storeId, name: parsed.name })
      .select("id,name")
      .single();
    if (result.error) return Response.json({ error: result.error.message }, { status: 500 });
    return Response.json({ item: result.data }, { status: 201 });
  } catch (error) {
    if (error instanceof ReferenceValidationError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return Response.json({
      error: error instanceof Error ? error.message : `تعذر إنشاء ${config.label}`,
    }, { status: 500 });
  }
}

export async function PUT(request: Request): Promise<Response> {
  if (!supabase) return Response.json({ error: "Supabase غير مهيأة" }, { status: 503 });
  const storeId = await authorizedAnyCapabilityStoreId(request, ["catalog.manage"]);
  if (storeId instanceof Response) return storeId;

  const url = new URL(request.url);
  const config = referenceConfig(url.searchParams.get("type"));
  const id = url.searchParams.get("id")?.trim() ?? "";
  if (!config || !id) {
    return Response.json({ error: "نوع المرجع ومعرّفه مطلوبان" }, { status: 400 });
  }

  const parsed = await readBody(request, config);
  if (parsed.error || !parsed.name) return parsed.error!;

  try {
    const duplicate = await duplicateId(config.table, storeId, parsed.name);
    if (duplicate && duplicate !== id) {
      return Response.json({ error: `${config.label} موجودة مسبقاً` }, { status: 409 });
    }

    if (config.type === "category") {
      const parentId = await resolveCategoryParentId(storeId, parsed.parentId, id);
      const hasShowInPos = await detectColumnExists(supabase!, "categories", "show_in_pos");
      const updatePayload: Record<string, unknown> = { name: parsed.name, parent_id: parentId };
      if (hasShowInPos) updatePayload.show_in_pos = parsed.showInPos;
      const selectCols = hasShowInPos
        ? "id,name,parent_id,bg_color,sort_order,show_in_pos"
        : "id,name,parent_id,bg_color,sort_order";
      const result = await supabase
        .from("categories")
        .update(updatePayload)
        .eq("id", id)
        .eq("store_id", storeId)
        .select(selectCols)
        .maybeSingle();
      if (result.error) return Response.json({ error: result.error.message }, { status: 500 });
      if (!result.data) return Response.json({ error: "التصنيف غير موجود" }, { status: 404 });

      const rows = await fetchCategoryRows(storeId);
      const row = result.data as unknown as CategoryDirectoryRow;
      return Response.json({
        item: toCategoryReferenceItem(
          row,
          await categoryProductCount(storeId, row.id),
          rows.filter((item) => item.parent_id === row.id).length,
        ),
      });
    }

    const result = await supabase
      .from("product_brands")
      .update({ name: parsed.name })
      .eq("id", id)
      .eq("store_id", storeId)
      .select("id,name")
      .maybeSingle();
    if (result.error) return Response.json({ error: result.error.message }, { status: 500 });
    if (!result.data) return Response.json({ error: "الشركة غير موجودة" }, { status: 404 });
    return Response.json({ item: result.data });
  } catch (error) {
    if (error instanceof ReferenceValidationError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return Response.json({
      error: error instanceof Error ? error.message : `تعذر تعديل ${config.label}`,
    }, { status: 500 });
  }
}

export async function DELETE(request: Request): Promise<Response> {
  if (!supabase) return Response.json({ error: "Supabase غير مهيأة" }, { status: 503 });
  const storeId = await authorizedAnyCapabilityStoreId(request, ["catalog.manage"]);
  if (storeId instanceof Response) return storeId;

  const url = new URL(request.url);
  const config = referenceConfig(url.searchParams.get("type"));
  const id = url.searchParams.get("id")?.trim() ?? "";
  if (!config || !id) {
    return Response.json({ error: "نوع المرجع ومعرّفه مطلوبان" }, { status: 400 });
  }

  if (config.type === "category") {
    const child = await supabase
      .from("categories")
      .select("id")
      .eq("store_id", storeId)
      .eq("parent_id", id)
      .limit(1)
      .maybeSingle();
    if (child.error) return Response.json({ error: child.error.message }, { status: 500 });
    if (child.data) {
      return Response.json({ error: "انقل الفئات الفرعية أو احذفها أولاً" }, { status: 409 });
    }
  }

  if (config.type === "category" || config.type === "brand" || config.type === "supplier") {
    const columnName = config.type === "category" ? "category_id"
      : config.type === "brand" ? "brand_id"
      : "default_supplier_id";
    const productCheck = await supabase
      .from("products")
      .select("id", { count: "exact", head: true })
      .eq("store_id", storeId)
      .eq(columnName, id);
    if (productCheck.error) return Response.json({ error: productCheck.error.message }, { status: 500 });
    if ((productCheck.count ?? 0) > 0) {
      const label = config.type === "category" ? "تصنيف"
        : config.type === "brand" ? "ماركة"
        : "مورد";
      return Response.json({
        error: `لا يمكن حذف ال${label} لأنه مرتبط بـ ${productCheck.count} منتج. عطّل ال${label} أو غيّر ارتباط المنتجات أولاً`,
      }, { status: 409 });
    }
  }

  const result = await supabase
    .from(config.table)
    .delete()
    .eq("id", id)
    .eq("store_id", storeId)
    .select("id")
    .maybeSingle();
  if (result.error) return Response.json({ error: result.error.message }, { status: 500 });
  if (!result.data) return Response.json({ error: `${config.label} غير موجودة` }, { status: 404 });
  return Response.json({ ok: true });
}
