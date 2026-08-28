/**
 * Catalog Excel Export / Import — hierarchical round-trip.
 *
 * The DB hierarchy (4-tier + packaging) is:
 *   Department  →  Category  →  Brand  →  Product(parent)  →  Variants(SKU)
 *                                                      └──  Units (packaging, 080)
 *
 * IMPORTANT AXIOM (verified against migration 080): packaging `product_units`
 * belong to the PRODUCT, not to a variant. They are shared across all of a
 * product's variants. There is no per-variant unit row.
 *
 * FLAT FILE GRAIN — one row per (VARIANT × UNIT). Every unit gets its own row:
 *
 *   ParentName  SKU  VariantLabel  UnitName  ...UnitCost UnitPrice ...  Cost Price Stock ...
 *
 * Parent-level fields, the variant fields, and one unit's packaging fields are
 * authored together on each unit row. A product with N units × M variants emits
 * M × N rows. When a product has no units a single row (with blank unit fields)
 * is emitted so it still round-trips. Re-import groups rows by ParentName and
 * dedupes units by UnitName and variants by SKU, so re-import never duplicates
 * a unit or a variant.
 *
 * STOCK SEMANTICS (approved): opening stock is applied ONLY to genuinely NEW
 * SKUs (idempotency-keyed OPENING movement). Re-importing the same file does
 * not re-post stock.
 *
 * PRICE PRECEDENCE (approved): when a unit/variant price cell is blank it
 * inherits from the parent product; an explicit value wins.
 *
 * PAGINATION: catalog reads use a ranged fetch (.range/.order) loop so exports
 * include ALL rows beyond Supabase's 1000-row-per-request response cap.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { notifyLocalCatalogWrite } from "./catalogInvalidation";

export const EXCEL_SHEET_NAME = "المنتجات";

/** How many rows to pull per ranged request while reading a table. */
const PAGE_SIZE = 1000;

/** Canonical flat columns (EN header used as the machine key). */
export const EXCEL_COLUMNS = [
  "SKU",
  "VariantLabel",
  "ParentName",
  "Brand",
  "Department",
  "Categories",
  "BaseUnit",
  "UnitName",
  "UnitMultiplier",
  "UnitBarcode",
  "UnitCost",
  "UnitPrice",
  "UnitWholesale",
  "UnitIsDefaultSale",
  "UnitIsDefaultPurchase",
  "Cost",
  "Price",
  "WholesalePrice",
  "Stock",
  "TaxIncluded",
  "TaxPercent",
  "IsSellable",
  "IsPurchasable",
  "ShowInPos",
  "IsQuickKey",
  "ReorderLevel",
  "AllowPriceChange",
  "IsActive",
] as const;

type FlatRow = { [K in (typeof EXCEL_COLUMNS)[number]]: string | number | boolean | null };

const BLANK: FlatRow = Object.fromEntries(EXCEL_COLUMNS.map((c) => [c, null])) as FlatRow;

// ---------------------------------------------------------------------------
// Shared row <-> DB helpers
// ---------------------------------------------------------------------------

interface UnitSetRow {
  unitName: string;
  qtyMultiplier: number;
  costPrice: number;
  sellingPrice: number;
  wholesalePrice: number;
  barcode: string | null;
  isDefaultSale: boolean;
  isDefaultPurchase: boolean;
}

function toBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (["true", "1", "yes", "نعم"].includes(v)) return true;
    if (["false", "0", "no", "لا"].includes(v)) return false;
  }
  return fallback;
}

function toNum(value: unknown, fallback: number): number {
  if (value == null) return fallback;
  const raw = typeof value === "string" ? value.trim() : value;
  if (raw === "") return fallback;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function cleanStr(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function normBarcode(value: string): string {
  return value.replace(/\s+/g, "");
}

// ---------------------------------------------------------------------------
// Paginated catalog reader
// ---------------------------------------------------------------------------

interface ExportRow {
  products: Array<{
    id: string;
    name: string;
    base_unit: string;
    cost_price: number;
    selling_price: number;
    wholesale_price: number;
    total_stock: number;
    tax_percent: number;
    tax_included: boolean;
    is_active: boolean;
    show_in_pos: boolean;
    is_sellable: boolean;
    is_purchasable: boolean;
    allow_price_change: boolean;
    reorder_level: number;
    is_quick_key: boolean;
    category_id: string | null;
    brand_id: string | null;
  }>;
  categories: Array<{ id: string; name: string; parent_id: string | null }>;
  brands: Array<{ id: string; name: string }>;
  variants: Array<Record<string, unknown>>;
  units: Array<Record<string, unknown>>;
  links: Array<{ product_id: string; category_id: string }>;
}

/**
 * Fetch every row of a store-scoped table by looping over `.range(from, to)`
 * pages. Enables exports exceeding Supabase's 1000-row-per-request response cap.
 * The join table `product_categories` has no `id` column, so callers can pass
 * an alternative ordering column via `orderByColumn`.
 */
async function fetchAllRows<T>(
  sb: SupabaseClient,
  table: string,
  select: string,
  storeId: string,
  orderByColumn = "id",
): Promise<T[]> {
  const all: T[] = [];
  let from = 0;
  while (true) {
    // stable ordering so ranges don't shift between pages
    let q = sb.from(table).select(select).order(orderByColumn, { ascending: true });
    if (storeId) q = q.eq("store_id", storeId);
    const { data, error } = await q.range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    const rows = (data ?? []) as T[];
    all.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return all;
}

/** Read the full catalog for a store and build the export row cache. */
async function readCatalog(sb: SupabaseClient, storeId: string): Promise<ExportRow> {
  const products = await fetchAllRows<Record<string, unknown>>(sb, "products", "*", storeId);
  // product_categories has no store_id column, so fetch the whole (typically
  // modest) table via the same pagination pattern and filter in memory. This
  // avoids building a giant `.in()` URL that exceeds URI-length limits.
  const links: Array<{ product_id: string; category_id: string }> = await fetchAllRows<
    { product_id: string; category_id: string }
  >(sb, "product_categories", "product_id,category_id", "", "product_id");

  return {
    products: products as ExportRow["products"],
    categories: await fetchAllRows<ExportRow["categories"][number]>(sb, "categories", "id,name,parent_id", storeId),
    brands: await fetchAllRows<ExportRow["brands"][number]>(sb, "product_brands", "id,name", storeId),
    variants: await fetchAllRows<Record<string, unknown>>(sb, "product_variants", "*", storeId),
    units: await fetchAllRows<Record<string, unknown>>(sb, "product_units", "*", storeId),
    links,
  };
}

// ---------------------------------------------------------------------------
// EXPORT
// ---------------------------------------------------------------------------

interface VariantSlice {
  barcode: string;
  variant_label: string;
  total_stock: number;
  cost_price?: unknown;
  selling_price?: unknown;
  wholesale_price?: unknown;
}

/**
 * Build one flat worksheet row per (variant × unit). Parent data and variant
 * fields are repeated on every unit row so no data is hidden in a single cell.
 */
function buildFlatRows(cache: ExportRow): FlatRow[] {
  const rows: FlatRow[] = [];
  const brandById = new Map(cache.brands.map((b) => [b.id, b.name]));
  const catById = new Map(cache.categories.map((c) => [c.id, c]));
  const unitsByProduct = new Map<string, UnitSetRow[]>();
  for (const u of cache.units) {
    const pid = String(u.product_id);
    const list = unitsByProduct.get(pid) ?? [];
    list.push({
      unitName: String(u.unit_name ?? ""),
      qtyMultiplier: Number(u.qty_multiplier ?? 1),
      costPrice: Number(u.cost_price ?? 0),
      sellingPrice: Number(u.selling_price ?? 0),
      wholesalePrice: Number(u.wholesale_price ?? 0),
      barcode: u.barcode ? String(u.barcode) : null,
      isDefaultSale: u.is_default_sale === true,
      isDefaultPurchase: u.is_default_purchase === true,
    });
    unitsByProduct.set(pid, list);
  }
  const variantsByProduct = new Map<string, VariantSlice[]>();
  for (const v of cache.variants) {
    const pid = String(v.product_id);
    const list = variantsByProduct.get(pid) ?? [];
    list.push({
      barcode: String(v.barcode ?? ""),
      variant_label: String(v.variant_label ?? ""),
      total_stock: Number(v.total_stock ?? 0),
      cost_price: v.cost_price,
      selling_price: v.selling_price,
      wholesale_price: v.wholesale_price,
    });
    variantsByProduct.set(pid, list);
  }

  for (const p of cache.products) {
    const variants = variantsByProduct.get(p.id) ?? [];
    // A product with no variant rows still gets rows so it exports.
    const variantList: VariantSlice[] =
      variants.length > 0
        ? variants
        : [{ barcode: "", variant_label: p.name, total_stock: p.total_stock }];

    const brandName = p.brand_id ? brandById.get(p.brand_id) ?? "" : "";
    const primaryCat = p.category_id ? catById.get(p.category_id) : undefined;
    const department = primaryCat?.parent_id ? (catById.get(primaryCat.parent_id)?.name ?? "") : "";
    const categoryName = primaryCat?.name ?? "";
    const allCatNames = (cache.links.filter((l) => l.product_id === p.id).map((l) => catById.get(l.category_id)?.name).filter(Boolean) as string[]);
    const categoriesCell = [categoryName, ...allCatNames.filter((c) => c !== categoryName)].join(", ");

    const unitSet = unitsByProduct.get(p.id) ?? [];
    // A product with no units emits one row with blank unit fields.
    const unitRows: UnitSetRow[] = unitSet.length > 0 ? unitSet : [{ unitName: "", qtyMultiplier: 1, costPrice: 0, sellingPrice: 0, wholesalePrice: 0, barcode: null, isDefaultSale: false, isDefaultPurchase: false }];

    for (const v of variantList) {
      for (let ui = 0; ui < unitRows.length; ui++) {
        const u = unitRows[ui];
        const row: FlatRow = { ...BLANK };
        row.SKU = normBarcode(cleanStr(v.barcode));
        row.VariantLabel = cleanStr(v.variant_label);
        row.Stock = toNum(v.total_stock, 0);
        row.Cost = toNum(v.cost_price, p.cost_price);
        row.Price = toNum(v.selling_price, p.selling_price);
        row.WholesalePrice = toNum(v.wholesale_price, p.wholesale_price);

        row.ParentName = p.name;
        row.Brand = brandName;
        row.Department = department;
        row.Categories = categoriesCell;
        row.BaseUnit = p.base_unit;
        row.TaxIncluded = p.tax_included;
        row.TaxPercent = p.tax_percent;
        row.IsSellable = p.is_sellable;
        row.IsPurchasable = p.is_purchasable;
        row.ShowInPos = p.show_in_pos;
        row.IsQuickKey = p.is_quick_key;
        row.ReorderLevel = p.reorder_level;
        row.AllowPriceChange = p.allow_price_change;
        row.IsActive = p.is_active;

        row.UnitName = u.unitName;
        row.UnitMultiplier = u.qtyMultiplier;
        row.UnitBarcode = u.barcode ?? "";
        row.UnitCost = u.costPrice;
        row.UnitPrice = u.sellingPrice;
        row.UnitWholesale = u.wholesalePrice;
        row.UnitIsDefaultSale = u.isDefaultSale ? "1" : "0";
        row.UnitIsDefaultPurchase = u.isDefaultPurchase ? "1" : "0";

        rows.push(row);
      }
    }
  }
  return rows;
}

/** Build an xlsx Blob of the flat catalog for the given store. */
export async function exportCatalogToExcel(sb: SupabaseClient, storeId: string): Promise<Blob> {
  const XLSX = await import("xlsx");
  const cache = await readCatalog(sb, storeId);
  const flat = buildFlatRows(cache);

  const sheet = XLSX.utils.json_to_sheet(flat);
  sheet["!cols"] = EXCEL_COLUMNS.map((c) => ({ wch: c === "SKU" ? 18 : c.startsWith("Unit") ? 14 : 14 }));
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, EXCEL_SHEET_NAME);

  // _meta sheet carries version metadata for tolerant re-imports.
  const meta = XLSX.utils.json_to_sheet([
    { key: "format", value: "pos-catalog-v2" },
    { key: "storeId", value: storeId },
    { key: "exportedAt", value: new Date().toISOString() },
    { key: "grain", value: "one row per variant x unit (units flattened to their own row)" },
  ]);
  XLSX.utils.book_append_sheet(book, meta, "_meta");

  const buffer = XLSX.write(book, { bookType: "xlsx", type: "array" }) as ArrayBuffer;
  return new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

// ---------------------------------------------------------------------------
// IMPORT
// ---------------------------------------------------------------------------

export interface ImportSummary {
  parsedRows: number;
  productsCreated: number;
  productsUpdated: number;
  variantsCreated: number;
  variantsUpdated: number;
  unitsCreated: number;
  unitsUpdated: number;
  categoriesCreated: number;
  errors: string[];
}

interface GroupedProduct {
  productName: string;
  brand: string;
  department: string;
  categories: string[];
  baseUnit: string;
  taxPercent: number;
  taxIncluded: boolean;
  isSellable: boolean;
  isPurchasable: boolean;
  showInPos: boolean;
  isQuickKey: boolean;
  reorderLevel: number;
  allowPriceChange: boolean;
  isActive: boolean;
  costPrice: number;
  sellingPrice: number;
  wholesalePrice: number;
  units: UnitSetRow[];
  variants: Array<{
    barcode: string;
    label: string;
    stock: number;
    costPrice?: number;
    sellingPrice?: number;
    wholesalePrice?: number;
  }>;
}

/** Parse a flat workbook into normalized, grouped products (no DB writes). */
export async function parseCatalogExcel(file: File | ArrayBuffer): Promise<GroupedProduct[]> {
  const XLSX = await import("xlsx");
  const data = file instanceof File ? await file.arrayBuffer() : file;
  const book = XLSX.read(data, { type: "array" });

  const dataSheetName = book.SheetNames.find((n) => n === EXCEL_SHEET_NAME) ?? book.SheetNames[0];
  const sheet = book.Sheets[dataSheetName];
  const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null });

  const byParent = new Map<string, GroupedProduct>();

  for (const raw of rawRows) {
    const sku = normBarcode(cleanStr(raw.SKU ?? raw["SKU"]));
    const parentName = cleanStr(raw.ParentName ?? raw.ParentName);
    if (!sku && !parentName) continue; // blank guard row
    if (!parentName) throw new Error(`صف بلا اسم منتج (SKU=${sku})`);
    if (!sku) throw new Error(`المنتج "${parentName}" بلا باركود SKU`);

    let group = byParent.get(parentName);
    if (!group) {
      group = {
        productName: parentName,
        brand: cleanStr(raw.Brand),
        department: cleanStr(raw.Department),
        categories: String(raw.Categories ?? "").split(",").map((s) => cleanStr(s)).filter(Boolean),
        baseUnit: cleanStr(raw.BaseUnit) || "قطعة",
        taxPercent: toNum(raw.TaxPercent, 16),
        taxIncluded: toBool(raw.TaxIncluded, true),
        isSellable: toBool(raw.IsSellable, true),
        isPurchasable: toBool(raw.IsPurchasable, true),
        showInPos: toBool(raw.ShowInPos, true),
        isQuickKey: toBool(raw.IsQuickKey, false),
        reorderLevel: Math.max(0, Math.round(toNum(raw.ReorderLevel, 0))),
        allowPriceChange: toBool(raw.AllowPriceChange, true),
        isActive: toBool(raw.IsActive, true),
        costPrice: toNum(raw.Cost, 0),
        sellingPrice: toNum(raw.Price, 0),
        wholesalePrice: toNum(raw.WholesalePrice, 0),
        units: [],
        variants: [],
      };
      byParent.set(parentName, group);
    }

    // Unit: one per row; dedupe by UnitName across the product group so the
    // flattened (variant × unit) rows never create duplicate units. Only
    // fields explicitly present on a row overwrite an existing unit's values,
    // so a later unit row that omits a flag doesn't clobber it with a default.
    const unitName = cleanStr(raw.UnitName);
    if (unitName) {
      let unit = group.units.find((u) => u.unitName === unitName);
      if (!unit) {
        unit = {
          unitName,
          qtyMultiplier: 1,
          costPrice: 0,
          sellingPrice: 0,
          wholesalePrice: 0,
          barcode: null,
          isDefaultSale: false,
          isDefaultPurchase: false,
        };
        group.units.push(unit);
      }
      const has = (key: string) => raw[key] != null && cleanStr(raw[key]) !== "";
      if (has("UnitMultiplier")) unit.qtyMultiplier = toNum(raw.UnitMultiplier, 1);
      if (has("UnitCost")) unit.costPrice = toNum(raw.UnitCost, 0);
      if (has("UnitPrice")) unit.sellingPrice = toNum(raw.UnitPrice, 0);
      if (has("UnitWholesale")) unit.wholesalePrice = toNum(raw.UnitWholesale, 0);
      if (has("UnitBarcode")) unit.barcode = cleanStr(String(raw.UnitBarcode ?? "")) || null;
      if (has("UnitIsDefaultSale")) unit.isDefaultSale = toBool(raw.UnitIsDefaultSale, false);
      if (has("UnitIsDefaultPurchase")) unit.isDefaultPurchase = toBool(raw.UnitIsDefaultPurchase, false);
    }

    // Variant: dedupe by SKU (repeated on each of the variant's unit rows).
    const dup = group.variants.find((v) => v.barcode === sku);
    if (!dup) {
      group.variants.push({
        barcode: sku,
        label: cleanStr(raw.VariantLabel) || sku,
        stock: Math.max(0, Math.round(toNum(raw.Stock, 0))),
        costPrice: raw.Cost == null || cleanStr(raw.Cost) === "" ? undefined : toNum(raw.Cost, 0),
        sellingPrice: raw.Price == null || cleanStr(raw.Price) === "" ? undefined : toNum(raw.Price, 0),
        wholesalePrice:
          raw.WholesalePrice == null || cleanStr(raw.WholesalePrice) === "" ? undefined : toNum(raw.WholesalePrice, 0),
      });
    }
  }

  return [...byParent.values()];
}

/**
 * Resolve a department/category path into category ids, creating categories
 * as needed. Returns [primaryId, allIds]. Handles "قسم > تصنيف" via ">".
 */
async function resolveCategoryPath(
  sb: SupabaseClient,
  storeId: string,
  path: string,
  createdCount: { current: number },
): Promise<{ primary: string | null; all: string[] }> {
  const ids: string[] = [];
  const segments = path.split(">").map((s) => cleanStr(s)).filter(Boolean);
  if (segments.length === 0) return { primary: null, all: [] };

  let parentId: string | null = null;
  for (const seg of segments) {
    let id: string | null = null;

    let scoped;
    try {
      scoped = await sb
        .from("categories")
        .select("id")
        .eq("store_id", storeId)
        .eq("name", seg)
        .eq("parent_id", parentId)
        .maybeSingle();
    } catch {
      scoped = null;
    }
    if (scoped?.error) throw new Error(scoped.error.message);
    if (scoped?.data?.id) id = scoped.data.id;

    // Fallback: match by name only (parent-scoped lookup may have missed).
    if (!id) {
      const loose = await sb.from("categories").select("id").eq("store_id", storeId).eq("name", seg).maybeSingle();
      if (loose.error) throw new Error(loose.error.message);
      if (loose.data?.id) id = loose.data.id;
    }

    if (!id) {
      const insertPayload: Record<string, unknown> = { store_id: storeId, name: seg };
      if (parentId) insertPayload.parent_id = parentId;
      const inserted = await sb.from("categories").insert(insertPayload).select("id").single();
      if (inserted.error || !inserted.data?.id) throw new Error(inserted.error?.message ?? "تعذر إنشاء الفئة");
      id = inserted.data.id;
      createdCount.current += 1;
    }

    const resolvedId = id as string;
    if (!resolvedId) throw new Error("تعذر تحليل الفئة");
    ids.push(resolvedId);
    parentId = resolvedId;
  }
  return { primary: ids[0], all: ids };
}

async function resolveBrandId(sb: SupabaseClient, storeId: string, name: string): Promise<string | null> {
  if (!name) return null;
  const found = await sb.from("product_brands").select("id").eq("store_id", storeId).ilike("name", name).maybeSingle();
  if (found.error) throw new Error(found.error.message);
  if (found.data?.id) return found.data.id;
  const inserted = await sb.from("product_brands").insert({ store_id: storeId, name }).select("id").single();
  if (inserted.error || !inserted.data?.id) throw new Error(inserted.error?.message ?? "تعذر إنشاء الشركة");
  return inserted.data.id;
}

async function assertBarcodesFree(
  sb: SupabaseClient,
  storeId: string,
  barcodes: string[],
  productId?: string,
): Promise<void> {
  if (barcodes.length === 0) return;
  const { data, error } = await sb
    .from("product_variants")
    .select("barcode,product_id,store_id")
    .eq("store_id", storeId)
    .in("barcode", barcodes);
  if (error) throw new Error(error.message);
  const conflict = (data ?? []).find((r) => {
    if (!productId) return true;
    return r.product_id !== productId;
  });
  if (conflict) throw new Error(`الباركود مستخدم مسبقاً: ${conflict.barcode}`);
}

/**
 * Idempotently write one product group. Returns counts of created/updated.
 * Round-trip rules:
 *   - Parent matched by (store_id, lower(name)); update in place or create.
 *   - Variants matched by (store_id, barcode); stock ONLY on brand-new SKUs.
 *   - Units matched by (store_id, product_id, lower(unit_name)).
 */
async function upsertProductGroup(
  sb: SupabaseClient,
  storeId: string,
  g: GroupedProduct,
  createdCount: { current: number },
  summary: ImportSummary,
): Promise<void> {
  const cat = await resolveCategoryPath(sb, storeId, [g.department, ...g.categories].filter(Boolean).join(">"), createdCount);
  const brandId = await resolveBrandId(sb, storeId, g.brand);
  const allBarcodes = g.variants.map((v) => v.barcode);
  const unitBarcodes = g.units.map((u) => u.barcode).filter((b): b is string => !!b);
  await assertBarcodesFree(sb, storeId, [...allBarcodes, ...unitBarcodes]);
  await assertUnitBarcodesFree(sb, storeId, unitBarcodes);

  const defaultUnit = g.units.find((u) => u.isDefaultSale) ?? g.units[0] ?? null;
  const parentCost = defaultUnit ? defaultUnit.costPrice : g.costPrice;
  const parentPrice = defaultUnit ? defaultUnit.sellingPrice : g.sellingPrice;
  const parentWholesale = defaultUnit ? defaultUnit.wholesalePrice : g.wholesalePrice;

  const existing = await sb.from("products").select("id").eq("store_id", storeId).ilike("name", g.productName).maybeSingle();
  if (existing.error) throw new Error(existing.error.message);

  let productId: string;
  if (existing.data?.id) {
    productId = existing.data.id;
    const upd = await sb
      .from("products")
      .update({
        category_id: cat.primary,
        brand_id: brandId,
        base_unit: g.baseUnit,
        tax_percent: g.taxPercent,
        tax_included: g.taxIncluded,
        is_active: g.isActive,
        show_in_pos: g.showInPos,
        is_sellable: g.isSellable,
        is_purchasable: g.isPurchasable,
        allow_price_change: g.allowPriceChange,
        is_quick_key: g.isQuickKey,
        reorder_level: g.reorderLevel,
        cost_price: parentCost,
        selling_price: parentPrice,
        wholesale_price: parentWholesale,
      })
      .eq("id", productId)
      .eq("store_id", storeId);
    if (upd.error) throw new Error(upd.error.message);
    summary.productsUpdated += 1;
  } else {
    const inserted = await sb
      .from("products")
      .insert({
        store_id: storeId,
        category_id: cat.primary,
        brand_id: brandId,
        name: g.productName,
        base_unit: g.baseUnit,
        total_stock: 0,
        is_quick_key: g.isQuickKey,
        tax_percent: g.taxPercent,
        tax_included: g.taxIncluded,
        is_active: g.isActive,
        show_in_pos: g.showInPos,
        is_sellable: g.isSellable,
        is_purchasable: g.isPurchasable,
        allow_price_change: g.allowPriceChange,
        reorder_level: g.reorderLevel,
        cost_price: parentCost,
        selling_price: parentPrice,
        wholesale_price: parentWholesale,
      })
      .select("id")
      .single();
    if (inserted.error || !inserted.data?.id) {
      throw new Error(inserted.error?.message ?? "تعذر إنشاء المنتج");
    }
    productId = inserted.data.id;
    summary.productsCreated += 1;
  }

  // Primary + multi-category join rows (merge).
  const replaceLinks = async () => {
    await sb.from("product_categories").delete().eq("product_id", productId);
    if (cat.all.length > 0) {
      const rows = cat.all.map((cid) => ({ product_id: productId, category_id: cid }));
      const ins = await sb.from("product_categories").insert(rows);
      if (ins.error) throw new Error(ins.error.message);
    }
  };
  await replaceLinks();

  // Units: upsert by (product_id, lower(unit_name)).
  for (let i = 0; i < g.units.length; i++) {
    const u = g.units[i];
    if (u.unitName) {
      const created = await upsertUnit(sb, storeId, productId, u, i);
      if (created) summary.unitsCreated += 1;
      else summary.unitsUpdated += 1;
    }
  }

  // Variants: upsert by barcode; stock on NEW skus only.
  for (const v of g.variants) {
    const existingVariant = await sb
      .from("product_variants")
      .select("id")
      .eq("store_id", storeId)
      .eq("barcode", v.barcode)
      .maybeSingle();
    if (existingVariant.error) throw new Error(existingVariant.error.message);

    const vp = {
      store_id: storeId,
      product_id: productId,
      barcode: v.barcode,
      variant_label: v.label,
      cost_price: v.costPrice ?? parentCost,
      selling_price: v.sellingPrice ?? parentPrice,
      wholesale_price: v.wholesalePrice ?? parentWholesale,
    };

    if (existingVariant.data?.id) {
      const upd = await sb.from("product_variants").update({
        variant_label: v.label,
        cost_price: vp.cost_price,
        selling_price: vp.selling_price,
        wholesale_price: vp.wholesale_price,
      }).eq("id", existingVariant.data.id).eq("store_id", storeId);
      if (upd.error) throw new Error(upd.error.message);
      summary.variantsUpdated += 1;
    } else {
      const ins = await sb.from("product_variants").insert(vp);
      if (ins.error) throw new Error(ins.error.message);
      summary.variantsCreated += 1;
      if (v.stock > 0) {
        const opening = await sb.rpc("record_inventory_movement", {
          p_store_id: storeId,
          p_product_id: productId,
          p_quantity_delta: v.stock,
          p_movement_type: "OPENING",
          p_idempotency_key: `excel-import:${v.barcode}`,
          p_unit_quantity: v.stock,
          p_reference_type: "PRODUCT",
          p_reference_id: productId,
          p_reason: "رصيد افتتاحي من استيراد إكسل",
        });
        if (opening.error) throw new Error(opening.error.message);
      }
    }
  }
}

async function assertUnitBarcodesFree(
  sb: SupabaseClient,
  storeId: string,
  barcodes: string[],
): Promise<void> {
  if (barcodes.length === 0) return;
  const { data, error } = await sb.from("product_units").select("barcode").eq("store_id", storeId).in("barcode", barcodes);
  if (error) throw new Error(error.message);
  if ((data ?? []).length > 0) throw new Error(`باركود وحدة مستخدم مسبقاً: ${data[0].barcode}`);
}

async function upsertUnit(
  sb: SupabaseClient,
  storeId: string,
  productId: string,
  u: UnitSetRow,
  sortOrder: number,
): Promise<boolean> {
  const name = cleanStr(u.unitName);
  const existing = await sb
    .from("product_units")
    .select("id")
    .eq("store_id", storeId)
    .eq("product_id", productId)
    .ilike("unit_name", name)
    .maybeSingle();
  if (existing.error) throw new Error(existing.error.message);

  if (u.isDefaultSale) {
    await sb.from("product_units").update({ is_default_sale: false }).eq("store_id", storeId).eq("product_id", productId).eq("is_default_sale", true);
  }
  if (u.isDefaultPurchase) {
    await sb.from("product_units").update({ is_default_purchase: false }).eq("store_id", storeId).eq("product_id", productId).eq("is_default_purchase", true);
  }

  const values = {
    store_id: storeId,
    product_id: productId,
    unit_name: name.slice(0, 60),
    qty_multiplier: u.qtyMultiplier,
    cost_price: u.costPrice,
    selling_price: u.sellingPrice,
    wholesale_price: u.wholesalePrice,
    barcode: u.barcode,
    is_default_sale: u.isDefaultSale,
    is_default_purchase: u.isDefaultPurchase,
    sort_order: sortOrder,
  };

  if (existing.data?.id) {
    const upd = await sb.from("product_units").update(values).eq("id", existing.data.id).eq("store_id", storeId);
    if (upd.error) throw new Error(upd.error.message);
    return false;
  }
  const ins = await sb.from("product_units").insert(values);
  if (ins.error) throw new Error(ins.error.message);
  return true;
}

/** Import a parsed/grouped catalog into the store (idempotent round-trip). */
export async function importCatalogGroups(
  sb: SupabaseClient,
  storeId: string,
  groups: GroupedProduct[],
  onProgress?: (done: number, total: number) => void,
): Promise<ImportSummary> {
  const summary: ImportSummary = {
    parsedRows: groups.reduce((n, g) => n + g.variants.length, 0),
    productsCreated: 0,
    productsUpdated: 0,
    variantsCreated: 0,
    variantsUpdated: 0,
    unitsCreated: 0,
    unitsUpdated: 0,
    categoriesCreated: 0,
    errors: [],
  };
  const createdCount = { current: 0 };

  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    try {
      await upsertProductGroup(sb, storeId, g, createdCount, summary);
    } catch (error) {
      summary.errors.push(`"${g.productName}": ${error instanceof Error ? error.message : "خطأ"}`);
    }
    onProgress?.(i + 1, groups.length);
  }

  if (groups.length > 0) notifyLocalCatalogWrite(storeId);
  return summary;
}

/** Convenience: read a File/ArrayBuffer, parse, then import. */
export async function importCatalogExcel(
  sb: SupabaseClient,
  storeId: string,
  file: File | ArrayBuffer,
  onProgress?: (done: number, total: number) => void,
): Promise<ImportSummary> {
  const groups = await parseCatalogExcel(file);
  return importCatalogGroups(sb, storeId, groups, onProgress);
}
