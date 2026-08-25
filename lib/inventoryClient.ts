import { getSupabaseBrowser } from "./supabaseBrowser";
import { getTenantStoreId } from "./tenantClient";

export interface InventoryProduct {
  id: string;
  name: string;
  categoryId: string;
  category: string;
  brandId: string;
  brand: string;
  supplierId: string;
  supplier: string;
  baseUnit: string;
  stock: number;
  costPrice: number;
  price: number;
  wholesalePrice: number;
  taxPercent: number;
  taxIncluded: boolean;
  isActive: boolean;
  showInPos: boolean;
  isSellable: boolean;
  isPurchasable: boolean;
  allowPriceChange: boolean;
  isQuickKey: boolean;
  reorderLevel: number;
  parentId: null;
  variantLabel: string;
  isVariantRoot: boolean;
  variants: Array<{
    id: string;
    barcode: string;
    variantLabel: string;
    costPrice: number;
    price: number;
    wholesalePrice: number;
    isDefaultSale: boolean;
  }>;
}

interface ProductRow {
  id: string;
  category_id: string | null;
  name: string;
  base_unit: string;
  total_stock: number;
  is_quick_key: boolean;
  brand_id: string | null;
  default_supplier_id: string | null;
  tax_percent: number;
  tax_included: boolean;
  is_active: boolean;
  show_in_pos: boolean;
  is_sellable: boolean;
  is_purchasable: boolean;
  allow_price_change: boolean;
  reorder_level: number;
  cost_price: number;
  selling_price: number;
  wholesale_price: number;
}

interface VariantRow {
  id: string;
  product_id: string;
  barcode: string;
  variant_label: string;
  total_stock: number;
  is_active: boolean;
  cost_price?: number;
  selling_price?: number;
  wholesale_price?: number;
}

interface CategoryRow {
  id: string;
  name: string;
  parent_id: string | null;
  sort_order: number;
}

interface RefRow {
  id: string;
  name: string;
}

function asNum(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function getProductSelect() {
  return "id,category_id,name,base_unit,total_stock,is_quick_key,brand_id,default_supplier_id,tax_percent,tax_included,is_active,show_in_pos,is_sellable,is_purchasable,allow_price_change,reorder_level,cost_price,selling_price,wholesale_price";
}

function rowToProduct(
  p: ProductRow,
  categoryMap: Record<string, { id: string; name: string }>,
  brandMap: Record<string, { id: string; name: string }>,
  supplierMap: Record<string, { id: string; name: string }>,
  variants: VariantRow[],
): InventoryProduct {
  const productVariants = variants.filter((v) => v.product_id === p.id);
  return {
    id: p.id,
    name: p.name,
    categoryId: p.category_id ?? "",
    category: p.category_id ? categoryMap[p.category_id]?.name ?? "" : "",
    brandId: p.brand_id ?? "",
    brand: p.brand_id ? brandMap[p.brand_id]?.name ?? "" : "",
    supplierId: p.default_supplier_id ?? "",
    supplier: p.default_supplier_id ? supplierMap[p.default_supplier_id]?.name ?? "" : "",
    baseUnit: p.base_unit,
    stock: p.total_stock ?? 0,
    costPrice: asNum(p.cost_price),
    price: asNum(p.selling_price),
    wholesalePrice: asNum(p.wholesale_price),
    taxPercent: asNum(p.tax_percent, 16),
    taxIncluded: p.tax_included ?? false,
    isActive: p.is_active ?? true,
    showInPos: p.show_in_pos ?? true,
    isSellable: p.is_sellable ?? true,
    isPurchasable: p.is_purchasable ?? true,
    allowPriceChange: p.allow_price_change ?? false,
    isQuickKey: p.is_quick_key ?? false,
    reorderLevel: p.reorder_level ?? 0,
    parentId: null,
    variantLabel: "",
    isVariantRoot: false,
    variants: productVariants.map((v) => ({
      id: `v-${v.barcode}`,
      barcode: v.barcode,
      variantLabel: v.variant_label ?? "",
      costPrice: asNum(v.cost_price) || asNum(p.cost_price),
      price: asNum(v.selling_price) || asNum(p.selling_price),
      wholesalePrice: asNum(v.wholesale_price) || asNum(p.wholesale_price),
      isDefaultSale: true,
    })),
  };
}

export interface InventoryFilters {
  search?: string;
  categoryId?: string;
  brandId?: string;
  supplierId?: string;
  /** "active" → is_active=true, "inactive" → false, undefined → all. */
  status?: "active" | "inactive";
  /** Products whose total_stock ≤ reorder_level (reorder_level > 0 only). */
  lowStock?: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyProductFilters(query: any, filters: InventoryFilters): any {
  const { search, categoryId, brandId, supplierId, status, lowStock } = filters;
  let q = query;
  if (search) q = q.ilike("name", `%${search}%`);
  if (categoryId) q = q.eq("category_id", categoryId);
  if (brandId) q = q.eq("brand_id", brandId);
  if (supplierId) q = q.eq("default_supplier_id", supplierId);
  if (status === "active") q = q.eq("is_active", true);
  if (status === "inactive") q = q.eq("is_active", false);
  if (lowStock) q = q.gt("reorder_level", 0);
  return q;
}

export async function fetchPaginatedInventory(opts: {
  storeId?: string | null;
  page: number;
  limit: number;
} & InventoryFilters): Promise<{
  paginated: true;
  page: number;
  limit: number;
  total: number;
  items: InventoryProduct[];
  categories: Record<string, { id: string; name: string; parentId?: string | null; sortOrder?: number }>;
  brands: Record<string, { id: string; name: string }>;
  suppliers: Record<string, { id: string; name: string }>;
}> {
  const sb = getSupabaseBrowser();
  const storeId = opts.storeId || getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");
  const { page, limit, search } = opts;
  const offset = (page - 1) * limit;

  const [categoryRows, brandRows, supplierRows] = await Promise.all([
    sb.from("categories").select("id,name,parent_id,sort_order").eq("store_id", storeId).order("name"),
    sb.from("product_brands").select("id,name").eq("store_id", storeId).order("name"),
    sb.from("suppliers").select("id,name").eq("store_id", storeId).order("name"),
  ]);

  const categoryMap: Record<string, { id: string; name: string; parentId: string | null; sortOrder: number }> = {};
  for (const c of (categoryRows.data ?? []) as CategoryRow[]) {
    categoryMap[c.id] = { id: c.id, name: c.name, parentId: c.parent_id, sortOrder: c.sort_order };
  }
  const brandMap = Object.fromEntries((brandRows.data ?? []).map((b: RefRow) => [b.id, b]));
  const supplierMap = Object.fromEntries((supplierRows.data ?? []).map((s: RefRow) => [s.id, s]));

  let countQ = applyProductFilters(
    sb.from("products").select("id", { count: "exact" }).eq("store_id", storeId),
    opts,
  );
  const { count: total, error: countErr } = await countQ;
  if (countErr) throw countErr;

  let productQ = applyProductFilters(
    sb.from("products").select(getProductSelect()).eq("store_id", storeId),
    opts,
  );
  const { data: products, error: prodErr } = await productQ.order("name").range(offset, offset + limit - 1);
  if (prodErr) throw prodErr;

  const productRows = (products ?? []) as unknown as ProductRow[];
  const productIds = productRows.map((p) => p.id);
  let variantRows: VariantRow[] = [];
  if (productIds.length > 0) {
    const { data: variants, error: vErr } = await sb
      .from("product_variants")
      .select("id,product_id,barcode,variant_label,total_stock,is_active,cost_price,selling_price,wholesale_price")
      .eq("store_id", storeId)
      .in("product_id", productIds)
      .order("barcode");
    if (vErr) throw vErr;
    variantRows = (variants ?? []) as VariantRow[];
  }

  const items = productRows.map((p) =>
    rowToProduct(p, categoryMap, brandMap, supplierMap, variantRows),
  );

  return {
    paginated: true,
    page,
    limit,
    total: total ?? 0,
    items,
    categories: categoryMap,
    brands: brandMap as Record<string, { id: string; name: string }>,
    suppliers: supplierMap as Record<string, { id: string; name: string }>,
  };
}

/**
 * Fetch every product matching the filters with no pagination — used by the
 * Excel export. Low-stock filtering is applied client-side because it compares
 * two columns (total_stock vs reorder_level), which PostgREST cannot express.
 */
export async function fetchAllInventoryForExport(opts: {
  storeId?: string | null;
} & InventoryFilters): Promise<{
  items: InventoryProduct[];
  categories: Record<string, { id: string; name: string; parentId?: string | null; sortOrder?: number }>;
  brands: Record<string, { id: string; name: string }>;
  suppliers: Record<string, { id: string; name: string }>;
}> {
  const sb = getSupabaseBrowser();
  const storeId = opts.storeId || getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  const [categoryRows, brandRows, supplierRows] = await Promise.all([
    sb.from("categories").select("id,name,parent_id,sort_order").eq("store_id", storeId).order("name"),
    sb.from("product_brands").select("id,name").eq("store_id", storeId).order("name"),
    sb.from("suppliers").select("id,name").eq("store_id", storeId).order("name"),
  ]);

  const categoryMap: Record<string, { id: string; name: string; parentId: string | null; sortOrder: number }> = {};
  for (const c of (categoryRows.data ?? []) as CategoryRow[]) {
    categoryMap[c.id] = { id: c.id, name: c.name, parentId: c.parent_id, sortOrder: c.sort_order };
  }
  const brandMap = Object.fromEntries((brandRows.data ?? []).map((b: RefRow) => [b.id, b]));
  const supplierMap = Object.fromEntries((supplierRows.data ?? []).map((s: RefRow) => [s.id, s]));

  const filtered = applyProductFilters(
    sb.from("products").select(getProductSelect()).eq("store_id", storeId),
    opts,
  );
  const PAGE = 1000;
  let from = 0;
  const allProducts: ProductRow[] = [];
  for (;;) {
    const { data, error } = await filtered.order("name").range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as unknown as ProductRow[];
    allProducts.push(...rows);
    if (rows.length < PAGE) break;
    from += PAGE;
  }

  // Client-side low-stock pass (column-vs-column comparison).
  const lowStockRows = opts.lowStock
    ? allProducts.filter((p) => (p.total_stock ?? 0) <= (p.reorder_level ?? 0))
    : allProducts;

  const ids = new Set(lowStockRows.map((p) => p.id));
  const variantRows: VariantRow[] = [];
  const idList = [...ids];
  for (let i = 0; i < idList.length; i += 500) {
    const { data: variants, error: vErr } = await sb
      .from("product_variants")
      .select("id,product_id,barcode,variant_label,total_stock,is_active,cost_price,selling_price,wholesale_price")
      .eq("store_id", storeId)
      .in("product_id", idList.slice(i, i + 500))
      .order("barcode");
    if (vErr) throw vErr;
    variantRows.push(...((variants ?? []) as VariantRow[]));
  }

  const items = lowStockRows.map((p) =>
    rowToProduct(p, categoryMap, brandMap, supplierMap, variantRows),
  );

  return {
    items,
    categories: categoryMap,
    brands: brandMap as Record<string, { id: string; name: string }>,
    suppliers: supplierMap as Record<string, { id: string; name: string }>,
  };
}

/** Build an xlsx worksheet blob for the given inventory rows. */
export async function exportInventoryToExcel(items: InventoryProduct[]): Promise<Blob> {
  const XLSX = await import("xlsx");
  const rows = items.map((p) => ({
    "الاسم": p.name,
    "التصنيف": p.category,
    "العلامة": p.brand,
    "المورد": p.supplier,
    "الوحدة": p.baseUnit,
    "سعر التكلفة": p.costPrice,
    "سعر البيع": p.price,
    "سعر الجملة": p.wholesalePrice,
    "الضريبة %": p.taxPercent,
    "المخزون": p.stock,
    "حد الطلب": p.reorderLevel,
    "الباركودات": p.variants.map((v) => v.barcode).join(", "),
    "نشط": p.isActive ? "نعم" : "لا",
    "ظاهر في الكاشير": p.showInPos ? "نعم" : "لا",
  }));
  const sheet = XLSX.utils.json_to_sheet(rows);
  // Column widths tuned for Arabic headers.
  sheet["!cols"] = [
    { wch: 28 }, { wch: 16 }, { wch: 14 }, { wch: 18 }, { wch: 8 },
    { wch: 11 }, { wch: 10 }, { wch: 12 }, { wch: 9 }, { wch: 9 },
    { wch: 9 }, { wch: 30 }, { wch: 7 }, { wch: 15 },
  ];
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "المخزون");
  const buffer = XLSX.write(book, { bookType: "xlsx", type: "array" }) as ArrayBuffer;
  return new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

export interface CatalogProductPayload {
  name: string;
  categoryId: string;
  category: string;
  brandId: string;
  brand: string;
  supplierId: string;
  supplier: string;
  baseUnit: string;
  stock: number;
  taxPercent: number;
  taxIncluded: boolean;
  isActive: boolean;
  showInPos: boolean;
  isSellable: boolean;
  isPurchasable: boolean;
  allowPriceChange: boolean;
  isQuickKey: boolean;
  reorderLevel: number;
  variants: Array<{
    barcode: string;
    variantLabel: string;
    costPrice: number;
    price: number;
    wholesalePrice: number;
    isDefaultSale: boolean;
    /** Per-barcode opening stock (create only; ledger stays product-scoped). */
    initialStock: number;
  }>;
}

function parseCatalogProductPayload(body: unknown): CatalogProductPayload {
  const input = (body ?? {}) as Record<string, unknown>;
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) throw new Error("اسم المنتج مطلوب");
  const baseUnit = typeof input.baseUnit === "string" && input.baseUnit.trim() ? input.baseUnit.trim() : "حبة";
  const taxPercent = asNum(input.taxPercent, 16);
  const rawVariants = Array.isArray(input.variants) ? input.variants : [];
  if (rawVariants.length === 0) throw new Error("أضف باركوداً واحداً على الأقل");

  const variants = rawVariants
    .map((raw) => {
      const r = (raw ?? {}) as Record<string, unknown>;
      const barcode = typeof r.barcode === "string" ? r.barcode.trim().replace(/\s+/g, "") : "";
      const variantLabel = typeof r.variantLabel === "string" ? r.variantLabel.trim() : "";
      return {
        barcode,
        variantLabel,
        costPrice: asNum(r.costPrice),
        price: asNum(r.price),
        wholesalePrice: asNum(r.wholesalePrice),
        isDefaultSale: typeof r.isDefaultSale === "boolean" ? r.isDefaultSale : false,
        // Opening stock for THIS barcode (QA redesign: per-color entry).
        initialStock: Math.max(0, asNum(r.initialStock)),
      };
    })
    .filter((r) => r.barcode.length > 0);

  if (variants.length === 0) throw new Error("أضف باركوداً واحداً على الأقل");
  if (!variants.some((v) => v.isDefaultSale)) variants[0].isDefaultSale = true;

  const toBool = (v: unknown, fb = false): boolean =>
    typeof v === "boolean" ? v : typeof v === "string" ? ["true", "1", "yes"].includes(v.toLowerCase()) : fb;

  return {
    name,
    categoryId: typeof input.categoryId === "string" ? input.categoryId.trim() : "",
    category: typeof input.category === "string" ? input.category.trim() : "",
    brandId: typeof input.brandId === "string" ? input.brandId.trim() : "",
    brand: typeof input.brand === "string" ? input.brand.trim() : "",
    supplierId: typeof input.supplierId === "string" ? input.supplierId.trim() : "",
    supplier: typeof input.supplier === "string" ? input.supplier.trim() : "",
    baseUnit,
    stock: Math.max(0, Math.round(asNum(input.stock))),
    taxPercent: asNum(input.taxPercent, 16),
    taxIncluded: toBool(input.taxIncluded, true),
    isActive: toBool(input.isActive, true),
    showInPos: toBool(input.showInPos, true),
    isSellable: toBool(input.isSellable, true),
    isPurchasable: toBool(input.isPurchasable, true),
    allowPriceChange: toBool(input.allowPriceChange, false),
    isQuickKey: toBool(input.isQuickKey, false),
    reorderLevel: Math.max(0, Math.round(asNum(input.reorderLevel))),
    variants,
  };
}

async function resolveCategory(sb: ReturnType<typeof getSupabaseBrowser>, storeId: string, id: string, name: string): Promise<string | null> {
  if (!sb) throw new Error("Supabase غير مهيأة");
  if (!id && !name) return null;
  if (!id) {
    const { data: existing } = await sb.from("categories").select("id").eq("store_id", storeId).eq("name", name).maybeSingle();
    if (existing?.id) return existing.id;
    const { data: created, error } = await sb.from("categories").insert({ store_id: storeId, name }).select("id").single();
    if (error || !created?.id) throw new Error(error?.message ?? "تعذر إنشاء الفئة");
    return created.id;
  }
  const { data } = await sb.from("categories").select("id").eq("id", id).eq("store_id", storeId).maybeSingle();
  if (!data) throw new Error("الفئة المحددة غير موجودة");
  return data.id;
}

async function resolveBrand(sb: ReturnType<typeof getSupabaseBrowser>, storeId: string, id: string, name: string): Promise<string | null> {
  if (!sb) throw new Error("Supabase غير مهيأة");
  if (!id && !name) return null;
  if (!id) {
    const { data: existing } = await sb.from("product_brands").select("id").eq("store_id", storeId).ilike("name", name).maybeSingle();
    if (existing?.id) return existing.id;
    const { data: created, error } = await sb.from("product_brands").insert({ store_id: storeId, name }).select("id").single();
    if (error || !created?.id) throw new Error(error?.message ?? "تعذر إنشاء الشركة");
    return created.id;
  }
  const { data } = await sb.from("product_brands").select("id").eq("id", id).eq("store_id", storeId).maybeSingle();
  if (!data) throw new Error("الشركة المحددة غير موجودة");
  return data.id;
}

async function resolveSupplier(sb: ReturnType<typeof getSupabaseBrowser>, storeId: string, id: string): Promise<string | null> {
  if (!sb || !id) return null;
  const { data } = await sb.from("suppliers").select("id").eq("id", id).eq("store_id", storeId).maybeSingle();
  if (!data) throw new Error("المورد المحدد غير موجود");
  return data.id;
}

async function assertNoBarcodeConflict(sb: ReturnType<typeof getSupabaseBrowser>, storeId: string, barcodes: string[], productId?: string): Promise<void> {
  if (!sb || barcodes.length === 0) return;
  const { data, error } = await sb.from("product_variants").select("barcode,product_id,store_id").eq("store_id", storeId).in("barcode", barcodes);
  if (error) throw new Error(error.message);
  const conflict = (data ?? []).find((row: { store_id: string; product_id: string; barcode: string }) => {
    if (row.store_id !== storeId) return false;
    if (!productId) return true;
    return row.product_id !== productId;
  });
  if (conflict) throw new Error(`الباركود مستخدم مسبقاً: ${conflict.barcode}`);
}

export async function createInventoryProduct(body: unknown): Promise<InventoryProduct> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");
  const payload = parseCatalogProductPayload(body);

  const barcodes = payload.variants.map((v) => v.barcode);
  await assertNoBarcodeConflict(sb, storeId, barcodes);
  const categoryId = await resolveCategory(sb, storeId, payload.categoryId, payload.category);
  const brandId = await resolveBrand(sb, storeId, payload.brandId, payload.brand);
  const supplierId = await resolveSupplier(sb, storeId, payload.supplierId);

  const defaultVariant = payload.variants.find((v) => v.isDefaultSale) ?? payload.variants[0];
  const { data: product, error: prodErr } = await sb
    .from("products")
    .insert({
      store_id: storeId,
      category_id: categoryId,
      brand_id: brandId,
      default_supplier_id: supplierId,
      name: payload.name,
      base_unit: payload.baseUnit,
      total_stock: 0,
      is_quick_key: payload.isQuickKey,
      tax_percent: payload.taxPercent,
      tax_included: payload.taxIncluded,
      is_active: payload.isActive,
      show_in_pos: payload.showInPos,
      is_sellable: payload.isSellable,
      is_purchasable: payload.isPurchasable,
      allow_price_change: payload.allowPriceChange,
      reorder_level: payload.reorderLevel,
      cost_price: defaultVariant.costPrice,
      selling_price: defaultVariant.price,
      wholesale_price: defaultVariant.wholesalePrice,
    })
    .select("id")
    .single();
  if (prodErr || !product?.id) throw new Error(prodErr?.message ?? "تعذر إنشاء المنتج");
  const productId = product.id;

  const { error: varErr } = await sb.from("product_variants").insert(
    payload.variants.map((row) => ({
      store_id: storeId,
      product_id: productId,
      barcode: row.barcode,
      variant_label: row.variantLabel,
      cost_price: row.costPrice || 0,
      selling_price: row.price || 0,
      wholesale_price: row.wholesalePrice || 0,
      // Per-barcode opening stock (QA redesign). Single-variant quick-add
      // keeps the legacy behavior: the product-level stock lands on the one
      // variant so both columns agree.
      total_stock:
        row.initialStock > 0
          ? row.initialStock
          : payload.variants.length === 1
            ? payload.stock
            : 0,
    })),
  );
  if (varErr) {
    await sb.from("products").delete().eq("id", productId).eq("store_id", storeId);
    throw new Error(varErr.message);
  }

  // The ledger is product-scoped: one OPENING movement covers the combined
  // per-row stocks. Rows without explicit stock fall back to the legacy
  // product-level field, so old flows behave exactly as before.
  const hasRowStocks = payload.variants.some((v) => v.initialStock > 0);
  const openingTotal = hasRowStocks
    ? payload.variants.reduce((sum, v) => sum + v.initialStock, 0)
    : payload.stock;
  if (openingTotal > 0) {
    const { error: rpcErr } = await sb.rpc("record_inventory_movement", {
      p_store_id: storeId,
      p_product_id: productId,
      p_quantity_delta: openingTotal,
      p_movement_type: "OPENING",
      p_idempotency_key: `opening:${productId}`,
      p_unit_quantity: openingTotal,
      p_reference_type: "PRODUCT",
      p_reference_id: productId,
      p_reason: "رصيد افتتاحي عند إنشاء المنتج",
    });
    if (rpcErr) {
      await sb.from("products").delete().eq("id", productId).eq("store_id", storeId);
      throw new Error(rpcErr.message);
    }
  }

  return {
    id: productId,
    name: payload.name,
    categoryId: payload.categoryId,
    category: payload.category,
    brandId: payload.brandId,
    brand: payload.brand,
    supplierId: payload.supplierId,
    supplier: payload.supplier,
    baseUnit: payload.baseUnit,
    stock: payload.stock,
    taxPercent: payload.taxPercent,
    taxIncluded: payload.taxIncluded,
    isActive: payload.isActive,
    showInPos: payload.showInPos,
    isSellable: payload.isSellable,
    isPurchasable: payload.isPurchasable,
    allowPriceChange: payload.allowPriceChange,
    reorderLevel: payload.reorderLevel,
    isQuickKey: payload.isQuickKey,
    parentId: null,
    variantLabel: "",
    isVariantRoot: false,
    costPrice: defaultVariant.costPrice,
    price: defaultVariant.price,
    wholesalePrice: defaultVariant.wholesalePrice,
    variants: payload.variants.map((v) => ({
      id: `v-${v.barcode}`,
      barcode: v.barcode,
      variantLabel: v.variantLabel,
      costPrice: v.costPrice,
      price: v.price,
      wholesalePrice: v.wholesalePrice,
      isDefaultSale: v.isDefaultSale,
    })),
  };
}

export async function updateInventoryProduct(productId: string, body: unknown): Promise<InventoryProduct> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");
  const payload = parseCatalogProductPayload(body);

  const { data: existing } = await sb.from("products").select("id,total_stock").eq("id", productId).eq("store_id", storeId).maybeSingle();
  if (!existing) throw new Error("المنتج غير موجود");

  const barcodes = payload.variants.map((v) => v.barcode);
  await assertNoBarcodeConflict(sb, storeId, barcodes, productId);
  const categoryId = await resolveCategory(sb, storeId, payload.categoryId, payload.category);
  const brandId = await resolveBrand(sb, storeId, payload.brandId, payload.brand);
  const supplierId = await resolveSupplier(sb, storeId, payload.supplierId);

  const defaultVariant = payload.variants.find((v) => v.isDefaultSale) ?? payload.variants[0];
  const { error: updErr } = await sb
    .from("products")
    .update({
      category_id: categoryId,
      brand_id: brandId,
      default_supplier_id: supplierId,
      name: payload.name,
      base_unit: payload.baseUnit,
      tax_percent: payload.taxPercent,
      tax_included: payload.taxIncluded,
      is_active: payload.isActive,
      show_in_pos: payload.showInPos,
      is_sellable: payload.isSellable,
      is_purchasable: payload.isPurchasable,
      allow_price_change: payload.allowPriceChange,
      is_quick_key: payload.isQuickKey,
      reorder_level: payload.reorderLevel,
      cost_price: defaultVariant.costPrice,
      selling_price: defaultVariant.price,
      wholesale_price: defaultVariant.wholesalePrice,
    })
    .eq("id", productId)
    .eq("store_id", storeId);
  if (updErr) throw new Error(updErr.message);

  const { data: existingVariants } = await sb
    .from("product_variants")
    .select("barcode")
    .eq("product_id", productId)
    .eq("store_id", storeId);
  const nextBarcodes = new Set(barcodes);
  const removed = (existingVariants ?? []).map((r: { barcode: string }) => r.barcode).filter((b) => !nextBarcodes.has(b));
  if (removed.length > 0) {
    await sb.from("product_variants").delete().eq("product_id", productId).eq("store_id", storeId).in("barcode", removed);
  }
  const { error: upsertErr } = await sb.from("product_variants").upsert(
    payload.variants.map((row) => ({
      store_id: storeId,
      product_id: productId,
      barcode: row.barcode,
      variant_label: row.variantLabel,
      cost_price: row.costPrice || 0,
      selling_price: row.price || 0,
      wholesale_price: row.wholesalePrice || 0,
    })),
    { onConflict: "store_id,barcode" },
  );
  if (upsertErr) throw new Error(upsertErr.message);

  return {
    id: productId,
    name: payload.name,
    categoryId: payload.categoryId,
    category: payload.category,
    brandId: payload.brandId,
    brand: payload.brand,
    supplierId: payload.supplierId,
    supplier: payload.supplier,
    baseUnit: payload.baseUnit,
    stock: asNum(existing.total_stock),
    taxPercent: payload.taxPercent,
    taxIncluded: payload.taxIncluded,
    isActive: payload.isActive,
    showInPos: payload.showInPos,
    isSellable: payload.isSellable,
    isPurchasable: payload.isPurchasable,
    allowPriceChange: payload.allowPriceChange,
    reorderLevel: payload.reorderLevel,
    isQuickKey: payload.isQuickKey,
    parentId: null,
    variantLabel: "",
    isVariantRoot: false,
    costPrice: defaultVariant.costPrice,
    price: defaultVariant.price,
    wholesalePrice: defaultVariant.wholesalePrice,
    variants: payload.variants.map((v) => ({
      id: `v-${v.barcode}`,
      barcode: v.barcode,
      variantLabel: v.variantLabel,
      costPrice: v.costPrice,
      price: v.price,
      wholesalePrice: v.wholesalePrice,
      isDefaultSale: v.isDefaultSale,
    })),
  };
}

export async function deleteInventoryProduct(productId: string): Promise<void> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  const { data: existing } = await sb.from("products").select("id").eq("id", productId).eq("store_id", storeId).maybeSingle();
  if (!existing) throw new Error("المنتج غير موجود");

  const { count } = await sb
    .from("inventory_movements")
    .select("id", { count: "exact", head: true })
    .eq("product_id", productId)
    .eq("store_id", storeId);
  if ((count ?? 0) > 0) {
    throw new Error("لا يمكن حذف منتج له حركات مخزون؛ عطّل المنتج للحفاظ على السجل");
  }

  const { error } = await sb.from("products").delete().eq("id", productId).eq("store_id", storeId);
  if (error) throw new Error(error.message);
}

export interface CreateReferenceResult {
  item: { id: string; name: string; productCount?: number; parentId?: string | null; childCount?: number; bgColor?: string | null; sortOrder?: number; showInPos?: boolean };
}

export async function createCatalogReference(
  type: "category" | "brand" | "supplier",
  payload: { name: string; parentId?: string | null; showInPos?: boolean },
): Promise<CreateReferenceResult> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  const table = type === "category" ? "categories" : type === "brand" ? "product_brands" : "suppliers";
  const { data: existing } = await sb.from(table).select("id,name").eq("store_id", storeId);
  const normalizedName = payload.name.trim().toLowerCase();
  const duplicate = (existing ?? []).find((r: { name: string }) => r.name.trim().toLowerCase() === normalizedName);
  if (duplicate) throw new Error(`${type === "category" ? "التصنيف" : type === "brand" ? "العلامة التجارية" : "المورد"} موجودة مسبقاً`);

  if (type === "category") {
    const insertPayload: Record<string, unknown> = { store_id: storeId, name: payload.name.trim() };
    if (payload.parentId) insertPayload.parent_id = payload.parentId;
    if (payload.showInPos !== undefined) insertPayload.show_in_pos = payload.showInPos;
    const { data: created, error } = await sb.from("categories").insert(insertPayload).select("id,name,parent_id,bg_color,sort_order,show_in_pos").single();
    if (error || !created) throw new Error(error?.message ?? "تعذر إنشاء التصنيف");
    return {
      item: {
        id: created.id,
        name: created.name,
        productCount: 0,
        parentId: created.parent_id,
        childCount: 0,
        bgColor: created.bg_color,
        sortOrder: created.sort_order,
        showInPos: created.show_in_pos ?? true,
      },
    };
  }

  const { data: created, error } = await sb.from(table).insert({ store_id: storeId, name: payload.name.trim() }).select("id,name").single();
  if (error || !created) throw new Error(error?.message ?? "تعذر إنشاء السجل");
  return { item: { id: created.id, name: created.name, productCount: 0 } };
}

export interface MergeVariantsResult {
  parent?: { parentName?: string } | null;
}

export async function mergeVariants(payload: {
  parentName: string;
  baseCost: number | null;
  basePrice: number | null;
  productIds: string[];
}): Promise<MergeVariantsResult> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  const { data, error } = await sb.rpc("merge_into_variant_parent", {
    p_store_id: storeId,
    p_parent_name: payload.parentName,
    p_base_cost: payload.baseCost,
    p_base_price: payload.basePrice,
    p_child_ids: payload.productIds,
  });
  if (error) {
    const MERGE_ERRORS: Record<string, string> = {
      parent_name_required: "اسم الصنف الأم مطلوب",
      children_required: "اختر صنفين فرعيين على الأقل",
      too_many_children: "أقصى عدد أصناف للدمج هو 30",
      child_not_found: "أحد الأصناف المختارة غير موجود في هذا المتجر",
      child_is_variant: "اختر أصنافاً قائمة بذاتها فقط",
      child_has_children: "لا يمكن دمج صنف لديه أصناف فرعية",
    };
    throw new Error(MERGE_ERRORS[error.message] ?? error.message);
  }
  return { parent: data as MergeVariantsResult["parent"] };
}

export interface AsyncProductOption {
  id: string;
  name: string;
  baseUnit: string;
  stock: number;
  /** Parent-level unit cost (products.cost_price) for procurement screens. */
  costPrice?: number | null;
  /** Parent-level selling price (products.selling_price). */
  sellingPrice?: number | null;
  barcodes: Array<{
    barcode: string;
    variantLabel: string;
    unitName: string;
    multiplier: number;
  }>;
}

export async function searchProducts(query: string, limit = 15): Promise<AsyncProductOption[]> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) return [];

  let productQ = sb
    .from("products")
    .select("id,name,base_unit,total_stock,cost_price,selling_price")
    .eq("store_id", storeId)
    .eq("is_active", true)
    .order("name");
  if (query.trim()) productQ = productQ.ilike("name", `%${query.trim()}%`);
  const { data: products, error: prodErr } = await productQ.limit(limit);
  if (prodErr || !products?.length) return [];

  const productIds = products.map((p: { id: string }) => p.id);
  const { data: variants } = await sb
    .from("product_variants")
    .select("id,product_id,barcode,variant_label")
    .eq("store_id", storeId)
    .in("product_id", productIds);

  const variantsByProduct = new Map<string, Array<{ barcode: string; variant_label: string }>>();
  for (const v of (variants ?? []) as Array<{ product_id: string; barcode: string; variant_label: string }>) {
    const list = variantsByProduct.get(v.product_id) ?? [];
    list.push(v);
    variantsByProduct.set(v.product_id, list);
  }

  return products.map((p: { id: string; name: string; base_unit: string; total_stock: number; cost_price: number | string | null; selling_price: number | string | null }) => ({
    id: p.id,
    name: p.name,
    baseUnit: p.base_unit,
    stock: p.total_stock,
    costPrice: p.cost_price == null ? null : Number(p.cost_price),
    sellingPrice: p.selling_price == null ? null : Number(p.selling_price),
    barcodes: (variantsByProduct.get(p.id) ?? []).map((v) => ({
      barcode: v.barcode,
      variantLabel: v.variant_label ?? "",
      unitName: p.base_unit,
      multiplier: 1,
    })),
  }));
}

export async function checkBarcodeUnique(barcode: string, excludeProductId?: string): Promise<boolean> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId || !barcode.trim()) return true;

  let q = sb.from("product_variants").select("product_id").eq("store_id", storeId).eq("barcode", barcode.trim());
  const { data } = await q;
  if (!data?.length) return true;
  return data.every((r: { product_id: string }) => r.product_id === excludeProductId);
}

function ean13CheckDigit(data: string): number {
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    const digit = Number(data[i]);
    if (!Number.isInteger(digit)) return 0;
    sum += i % 2 === 0 ? digit : digit * 3;
  }
  return (10 - (sum % 10)) % 10;
}

export function generateEan13(): string {
  const prefix = "625";
  let rest = "";
  for (let i = 0; i < 9; i++) rest += Math.floor(Math.random() * 10);
  const data = prefix + rest;
  return data + ean13CheckDigit(data);
}
