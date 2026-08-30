/**
 * Catalog Excel Export / Import — ERP-grade sync engine.
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
 *   ParentName  SKU  VariantLabel  UnitName  ...UnitCost ...  Cost Price Stock ... ProductID VariantID UnitID
 *
 * Parent-level fields, the variant fields, and one unit's packaging fields are
 * authored together on each unit row. A product with N units × M variants emits
 * M × N rows. Re-import groups rows by ParentName and dedupes units by UnitName
 * and variants by SKU.
 *
 * HIDDEN IDS (pillar 1): the far-right ProductID / VariantID / UnitID columns
 * carry the primary keys. On import, records are matched by ID first; if a
 * ProductID matches the DB it UPDATES even if the user renamed the product.
 * When an ID cell is blank/absent the engine falls back to matching by
 * Name / SKU / UnitName and creates new records as needed.
 *
 * DATA SHIELD (pillar 2): blank cells are treated as "leave unchanged" — they
 * never overwrite an existing DB value with null/0. Stock is applied ONLY as an
 * opening balance for genuinely NEW SKUs (idempotency-keyed OPENING movement);
 * existing SKUs always ignore the Stock column.
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
  "ProductID",
  "VariantID",
  "UnitID",
] as const;

type FlatRow = { [K in (typeof EXCEL_COLUMNS)[number]]: string | number | boolean | null };

const BLANK: FlatRow = Object.fromEntries(EXCEL_COLUMNS.map((c) => [c, null])) as FlatRow;

/**
 * Product scalar Excel columns that can be patched on update (blank = leave).
 * Maps the EXCEL flat column name to its DB column.
 */
const PRODUCT_PATCH_FIELDS: Record<string, string> = {
  BaseUnit: "base_unit",
  TaxPercent: "tax_percent",
  TaxIncluded: "tax_included",
  IsSellable: "is_sellable",
  IsPurchasable: "is_purchasable",
  ShowInPos: "show_in_pos",
  IsQuickKey: "is_quick_key",
  ReorderLevel: "reorder_level",
  AllowPriceChange: "allow_price_change",
  IsActive: "is_active",
  Cost: "cost_price",
  Price: "selling_price",
  WholesalePrice: "wholesale_price",
};

// ---------------------------------------------------------------------------
// Shared row <-> DB helpers
// ---------------------------------------------------------------------------

interface UnitSetRow {
  unitId?: string;
  unitName: string;
  qtyMultiplier: number;
  costPrice: number;
  sellingPrice: number;
  wholesalePrice: number;
  barcode: string | null;
  isDefaultSale: boolean;
  isDefaultPurchase: boolean;
  /** Column names present in the file, so blank cells don't overwrite DB. */
  present: Set<string>;
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

/** True when the raw cell carries a user-authored value (non-empty). */
function present(value: unknown): boolean {
  if (value == null) return false;
  const s = typeof value === "string" ? value.trim() : value;
  if (typeof s === "string") return s !== "";
  return true;
}

/**
 * Sanitize a money field to a non-negative finite number. Prices/costs can
 * never meaningfully be negative; clamping at parse time keeps uploaded rows
 * from ever carrying inverted sign that could poison downstream math.
 */
function sanitizeMoney(value: unknown, fallback: number): number {
  const n = toNum(value, fallback);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Sanitize the qty multiplier of a packaging unit. DB enforces
 * `qty_multiplier > 0` (migration 080), so clamp any absent/non-positive
 * value to 1 to avoid a mid-import CHECK violation. `tooSmall` is set when
 * the user actually authored an invalid (<=0) multiplier so the row can be
 * surfaced as an error instead of silently corrected.
 */
function sanitizeMultiplier(value: unknown, fallback: number, tooSmall?: { value: boolean }): number {
  const n = toNum(value, fallback);
  if (!Number.isFinite(n) || n <= 0) {
    if (present(value) && tooSmall) tooSmall.value = true;
    return 1;
  }
  return n;
}

/** Sanitize a tax percentage into [0, 100] (DB CHECK range from migration 022). */
function sanitizeTax(value: unknown, fallback: number): number {
  const n = toNum(value, fallback);
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, n));
}

// ---------------------------------------------------------------------------
// Paginated catalog reader
// ---------------------------------------------------------------------------

export interface ExportFilters {
  /** Restrict to a brand (by brandId). */
  brandId?: string | null;
  /** Restrict to a category (primary or multi-category link). */
  categoryId?: string | null;
  /** Restrict by active state; undefined = all. */
  status?: "active" | "inactive" | "all" | null;
}

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

/** Filter products + links in memory by the export filters. */
function applyProductFilters(
  products: ExportRow["products"],
  links: ExportRow["links"],
  filters?: ExportFilters,
): { products: ExportRow["products"]; links: ExportRow["links"] } {
  if (!filters) return { products, links };
  const { brandId, categoryId, status } = filters;

  let filtered = products;
  if (brandId) filtered = filtered.filter((p) => p.brand_id === brandId);
  if (status && status !== "all") filtered = filtered.filter((p) => p.is_active === (status === "active"));

  let matchedIds: Set<string> | null = null;
  if (categoryId) {
    matchedIds = new Set(links.filter((l) => l.category_id === categoryId).map((l) => l.product_id));
    filtered = filtered.filter((p) => matchedIds!.has(p.id) || p.category_id === categoryId);
  }

  if (matchedIds) {
    links = links.filter((l) => matchedIds!.has(l.product_id));
  } else if (brandId || categoryId || (status && status !== "all")) {
    const keep = new Set(filtered.map((p) => p.id));
    links = links.filter((l) => keep.has(l.product_id));
  }

  return { products: filtered, links };
}

/** Read the full catalog for a store and build the export row cache. */
async function readCatalog(sb: SupabaseClient, storeId: string, filters?: ExportFilters): Promise<ExportRow> {
  const rawProducts = await fetchAllRows<Record<string, unknown>>(sb, "products", "*", storeId);
  // product_categories has no store_id column, so fetch the whole (typically
  // modest) table via the same pagination pattern and filter in memory. This
  // avoids building a giant `.in()` URL that exceeds URI-length limits.
  const allLinks: Array<{ product_id: string; category_id: string }> = await fetchAllRows<
    { product_id: string; category_id: string }
  >(sb, "product_categories", "product_id,category_id", "", "product_id");

  const { products, links } = applyProductFilters(
    rawProducts as ExportRow["products"],
    allLinks,
    filters,
  );

  return {
    products,
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
  id: string;
  barcode: string;
  variant_label: string;
  total_stock: number;
  cost_price?: unknown;
  selling_price?: unknown;
  wholesale_price?: unknown;
}

/**
 * Build one flat worksheet row per (variant × unit). Parent data, variant
 * fields and hidden DB ids are repeated on every unit row.
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
      unitId: u.id ? String(u.id) : undefined,
      unitName: String(u.unit_name ?? ""),
      qtyMultiplier: Number(u.qty_multiplier ?? 1),
      costPrice: Number(u.cost_price ?? 0),
      sellingPrice: Number(u.selling_price ?? 0),
      wholesalePrice: Number(u.wholesale_price ?? 0),
      barcode: u.barcode ? String(u.barcode) : null,
      isDefaultSale: u.is_default_sale === true,
      isDefaultPurchase: u.is_default_purchase === true,
      present: new Set(),
    });
    unitsByProduct.set(pid, list);
  }
  const variantsByProduct = new Map<string, VariantSlice[]>();
  for (const v of cache.variants) {
    const pid = String(v.product_id);
    const list = variantsByProduct.get(pid) ?? [];
    list.push({
      id: String(v.id ?? ""),
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
        : [{ id: "", barcode: "", variant_label: p.name, total_stock: p.total_stock }];

    const brandName = p.brand_id ? brandById.get(p.brand_id) ?? "" : "";
    const primaryCat = p.category_id ? catById.get(p.category_id) : undefined;
    const department = primaryCat?.parent_id ? (catById.get(primaryCat.parent_id)?.name ?? "") : "";
    const categoryName = primaryCat?.name ?? "";
    const allCatNames = (cache.links.filter((l) => l.product_id === p.id).map((l) => catById.get(l.category_id)?.name).filter(Boolean) as string[]);
    const categoriesCell = [categoryName, ...allCatNames.filter((c) => c !== categoryName)].join(", ");

    const unitSet = unitsByProduct.get(p.id) ?? [];
    // A product with no units emits one row with blank unit fields.
    const unitRows: UnitSetRow[] = unitSet.length > 0 ? unitSet : [{ unitName: "", qtyMultiplier: 1, costPrice: 0, sellingPrice: 0, wholesalePrice: 0, barcode: null, isDefaultSale: false, isDefaultPurchase: false, present: new Set() }];

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

        // Hidden DB ids for future-proof upserts.
        row.ProductID = p.id;
        row.VariantID = v.id || null;
        row.UnitID = u.unitId ?? null;

        rows.push(row);
      }
    }
  }
  return rows;
}

/** Build an xlsx Blob of the given flat rows with the shared sheet/_meta layout. */
async function buildWorkbook(storeId: string, flat: FlatRow[]): Promise<Blob> {
  const XLSX = await import("xlsx");
  // Pass `header` so column order is fixed and an empty dataset still emits a
  // header row (used by the blank template).
  const sheet = XLSX.utils.json_to_sheet(flat, { header: [...EXCEL_COLUMNS] });
  sheet["!cols"] = EXCEL_COLUMNS.map((c) => ({ wch: c === "SKU" ? 18 : c.startsWith("Unit") ? 14 : c.endsWith("ID") ? 34 : 14 }));
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, EXCEL_SHEET_NAME);

  // _meta sheet carries version metadata for tolerant re-imports.
  const meta = XLSX.utils.json_to_sheet([
    { key: "format", value: CATALOG_FORMAT },
    { key: "storeId", value: storeId },
    { key: "exportedAt", value: new Date().toISOString() },
    { key: "grain", value: "one row per variant x unit; hidden ProductID/VariantID/UnitID for upserts" },
  ]);
  XLSX.utils.book_append_sheet(book, meta, "_meta");

  const buffer = XLSX.write(book, { bookType: "xlsx", type: "array" }) as ArrayBuffer;
  return new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

/** Build an xlsx Blob of the flat catalog for the given store. */
export async function exportCatalogToExcel(
  sb: SupabaseClient,
  storeId: string,
  filters?: ExportFilters,
): Promise<Blob> {
  const cache = await readCatalog(sb, storeId, filters);
  return buildWorkbook(storeId, buildFlatRows(cache));
}

/**
 * Build a blank catalog import template: identical columns and _meta sheet to a
 * full export, with zero product rows. Lets users add products without exporting
 * the entire catalog. Accepts a storeId for metadata only.
 */
export async function exportCatalogTemplate(storeId: string): Promise<Blob> {
  return buildWorkbook(storeId, []);
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

interface GroupedVariant {
  variantId?: string;
  barcode: string;
  label: string;
  stock: number;
  costPrice?: number;
  sellingPrice?: number;
  wholesalePrice?: number;
  /** Raw variant scalar columns present in the file (blank = leave unchanged). */
  present: Set<string>;
}

interface GroupedProduct {
  productId?: string;
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
  /** Raw product scalar columns present in the file (blank = leave unchanged). */
  present: Set<string>;
  units: UnitSetRow[];
  variants: GroupedVariant[];
}

/** Result of a pure parse; groups + non-fatal row errors (no DB lookup). */
export interface ParsedCatalog {
  groups: GroupedProduct[];
  errors: string[];
}

/**
 * The only import format the engine accepts. Exported so tests and consumers
 * can reference the canonical version contract.
 */
export const CATALOG_FORMAT = "pos-catalog-v3";

/**
 * Read the flat rows and the declared format from the workbook's `_meta`
 * sheet. Enforces the version contract: if the file carries a `_meta` sheet with
 * a `format` key it must equal CATALOG_FORMAT (`pos-catalog-v3`). Files without
 * a `_meta` sheet (hand-made or pre-meta exports) are tolerated so a manually
 * authored spreadsheet can still import, but any declared older/newer format is
 * rejected.
 */
async function readWorkbook(
  file: File | ArrayBuffer,
): Promise<{ rows: Array<Record<string, unknown>>; format: string | null }> {
  const XLSX = await import("xlsx");
  const data = file instanceof File ? await file.arrayBuffer() : file;
  const book = XLSX.read(data, { type: "array" });
  const dataSheetName = book.SheetNames.find((n) => n === EXCEL_SHEET_NAME) ?? book.SheetNames[0];
  const sheet = book.Sheets[dataSheetName];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null });

  let format: string | null = null;
  const metaName = book.SheetNames.find((n) => n === "_meta");
  if (metaName) {
    const metaRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(book.Sheets[metaName], { defval: null });
    const fmt = metaRows.find((r) => String(r.key ?? "") === "format")?.value;
    if (fmt != null && String(fmt) !== "") format = String(fmt);
    if (format && format !== CATALOG_FORMAT) {
      throw new Error(
        `نسخة الملف غير مدعومة (${format}). الحد الأدنى المقبول: ${CATALOG_FORMAT}. أعد التصدير ثم أعد المحاولة.`,
      );
    }
  }

  return { rows, format };
}

/**
 * Pure parse of the workbook into grouped products. Unlike the throwing parse,
 * this one collects per-row errors (missing required fields, duplicate SKU)
 * instead of aborting, so the caller can show a dry-run preview.
 */
export async function parseCatalogDetailed(file: File | ArrayBuffer): Promise<ParsedCatalog> {
  const { rows: rawRows } = await readWorkbook(file);
  const errors: string[] = [];
  const byParent = new Map<string, GroupedProduct>();
  // SKU -> parent name, to detect a SKU reused across different products.
  const skuOwner = new Map<string, string>();

  for (let ri = 0; ri < rawRows.length; ri++) {
    const raw = rawRows[ri];
    const rowNo = ri + 2; // header is row 1
    const sku = normBarcode(cleanStr(raw.SKU ?? raw["SKU"]));
    const parentName = cleanStr(raw.ParentName ?? raw.ParentName);

    if (!sku && !parentName) continue; // blank guard row
    if (!parentName) {
      errors.push(`صف ${rowNo}: لا يوجد اسم منتج (SKU=${sku})`);
      continue;
    }
    if (!sku) {
      errors.push(`صف ${rowNo}: المنتج "${parentName}" بلا باركود SKU`);
      continue;
    }

    const owner = skuOwner.get(sku);
    if (owner && owner !== parentName) {
      errors.push(`صف ${rowNo}: الباركود ${sku} مكرر في منتجين ("${owner}" / "${parentName}")`);
      continue;
    }
    skuOwner.set(sku, parentName);

    let group = byParent.get(parentName);
    if (!group) {
      const cellPresent = new Set(EXCEL_COLUMNS.filter((c) => present(raw[c])));
      group = {
        productId: cleanStr(raw.ProductID) || undefined,
        productName: parentName,
        brand: cleanStr(raw.Brand),
        department: cleanStr(raw.Department),
        categories: String(raw.Categories ?? "").split(",").map((s) => cleanStr(s)).filter(Boolean),
        baseUnit: cleanStr(raw.BaseUnit) || "قطعة",
        taxPercent: sanitizeTax(raw.TaxPercent, 16),
        taxIncluded: toBool(raw.TaxIncluded, true),
        isSellable: toBool(raw.IsSellable, true),
        isPurchasable: toBool(raw.IsPurchasable, true),
        showInPos: toBool(raw.ShowInPos, true),
        isQuickKey: toBool(raw.IsQuickKey, false),
        reorderLevel: Math.max(0, Math.round(toNum(raw.ReorderLevel, 0))),
        allowPriceChange: toBool(raw.AllowPriceChange, true),
        isActive: toBool(raw.IsActive, true),
        costPrice: sanitizeMoney(raw.Cost, 0),
        sellingPrice: sanitizeMoney(raw.Price, 0),
        wholesalePrice: sanitizeMoney(raw.WholesalePrice, 0),
        present: cellPresent,
        units: [],
        variants: [],
      };
      byParent.set(parentName, group);
    }

    // Unit: one per row; dedupe by UnitName across the group (variant × unit
    // rows repeat units). Only fields present on a row overwrite values.
    const unitName = cleanStr(raw.UnitName);
    if (unitName) {
      let unit = group.units.find((u) => u.unitName === unitName);
      if (!unit) {
        unit = {
          unitId: cleanStr(raw.UnitID) || undefined,
          unitName,
          qtyMultiplier: 1,
          costPrice: 0,
          sellingPrice: 0,
          wholesalePrice: 0,
          barcode: null,
          isDefaultSale: false,
          isDefaultPurchase: false,
          present: new Set(),
        };
        group.units.push(unit);
      }
      if (present(raw.UnitMultiplier)) {
        const invalid = { value: false };
        unit.qtyMultiplier = sanitizeMultiplier(raw.UnitMultiplier, 1, invalid);
        if (invalid.value) errors.push(`صف ${rowNo}: مضاعف الوحدة "${unitName}" يجب أن يكون أكبر من صفر (تم ضبطه إلى 1)`);
      }
      if (present(raw.UnitCost)) unit.costPrice = sanitizeMoney(raw.UnitCost, 0);
      if (present(raw.UnitPrice)) unit.sellingPrice = sanitizeMoney(raw.UnitPrice, 0);
      if (present(raw.UnitWholesale)) unit.wholesalePrice = sanitizeMoney(raw.UnitWholesale, 0);
      if (present(raw.UnitBarcode)) unit.barcode = cleanStr(String(raw.UnitBarcode ?? "")) || null;
      if (present(raw.UnitIsDefaultSale)) unit.isDefaultSale = toBool(raw.UnitIsDefaultSale, false);
      if (present(raw.UnitIsDefaultPurchase)) unit.isDefaultPurchase = toBool(raw.UnitIsDefaultPurchase, false);
      ["UnitMultiplier", "UnitCost", "UnitPrice", "UnitWholesale", "UnitBarcode", "UnitIsDefaultSale", "UnitIsDefaultPurchase"].forEach((k) => {
        if (present(raw[k])) unit!.present.add(k);
      });
    }

    // Variant: dedupe by SKU (repeated on each of the variant's unit rows).
    const variantId = cleanStr(raw.VariantID) || undefined;
    let variant = group.variants.find((v) => v.barcode === sku || (variantId && v.variantId === variantId));
    if (!variant) {
      const variantPresent = new Set<string>();
      for (const k of ["Cost", "Price", "WholesalePrice", "VariantLabel"] as const) {
        if (present(raw[k])) variantPresent.add(k);
      }
      variant = {
        variantId,
        barcode: sku,
        label: cleanStr(raw.VariantLabel) || sku,
        stock: Math.max(0, Math.round(toNum(raw.Stock, 0))),
        costPrice: present(raw.Cost) ? sanitizeMoney(raw.Cost, 0) : undefined,
        sellingPrice: present(raw.Price) ? sanitizeMoney(raw.Price, 0) : undefined,
        wholesalePrice: present(raw.WholesalePrice) ? sanitizeMoney(raw.WholesalePrice, 0) : undefined,
        present: variantPresent,
      };
      group.variants.push(variant);
    }
  }

  return { groups: [...byParent.values()], errors };
}

/** Parse a flat workbook into normalized, grouped products (no DB writes). */
export async function parseCatalogExcel(file: File | ArrayBuffer): Promise<GroupedProduct[]> {
  const { groups, errors } = await parseCatalogDetailed(file);
  if (errors.length > 0) throw new Error(errors[0]);
  return groups;
}

// ---------------------------------------------------------------------------
// DRY-RUN preview
// ---------------------------------------------------------------------------

/** Result of a DB-aware dry-run (no writes performed). */
export interface DryRunResult {
  groups: GroupedProduct[];
  /** Product groups to create. */
  productsToCreate: number;
  /** Product groups to update. */
  productsToUpdate: number;
  /** Human-readable errors from parsing + classification. */
  errors: string[];
  /** Human-readable resolution hint per product (for the preview). */
  productIds: string[];
}

/**
 * Parse a file and classify each product group as NEW or UPDATE by querying the
 * DB (ID match first, then name match). Performs NO writes — used by the
 * dry-run preview modal before a user confirms the actual import.
 */
export async function previewCatalogImport(
  sb: SupabaseClient,
  storeId: string,
  file: File | ArrayBuffer,
  onProgress?: (done: number, total: number) => void,
): Promise<DryRunResult> {
  const parsed = await parseCatalogDetailed(file);

  // Load existing products once for name/id matching.
  const existingProducts = await fetchAllRows<{ id: string; name: string }>(
    sb, "products", "id,name", storeId,
  );
  const byId = new Map(existingProducts.map((p) => [p.id, p.name]));
  const byNameLow = new Map(existingProducts.map((p) => [p.name.toLowerCase(), p.id]));

  const result: DryRunResult = {
    groups: parsed.groups,
    productsToCreate: 0,
    productsToUpdate: 0,
    errors: [...parsed.errors],
    productIds: [],
  };

  const resolvedIds = new Set<string>();
  const groups = parsed.groups;
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    let resolved: string | undefined;
    if (g.productId && byId.has(g.productId)) {
      resolved = g.productId;
    } else {
      resolved = byNameLow.get(g.productName.toLowerCase());
    }

    if (resolved) {
      result.productsToUpdate += 1;
      if (resolvedIds.has(resolved)) {
        result.errors.push(`المنتج "${g.productName}" يتكرر في الملف (تحديث لنفس السجل)`);
      }
      resolvedIds.add(resolved);
    } else {
      result.productsToCreate += 1;
    }
    result.productIds.push(resolved ?? "");
    onProgress?.(i + 1, groups.length);
  }

  return result;
}

// ---------------------------------------------------------------------------
// WRITE (actual import)
// ---------------------------------------------------------------------------

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
      let q = sb.from("categories").select("id").eq("store_id", storeId).eq("name", seg);
      // PostgREST rejects `.eq("parent_id", null)` on a UUID column; a null
      // parent must be expressed with `.is("parent_id", null)` instead.
      if (parentId) q = q.eq("parent_id", parentId);
      else q = q.is("parent_id", null);
      scoped = await q.maybeSingle();
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

/**
 * Idempotently write one product group. Returns counts of created/updated.
 * Round-trip rules:
 *   - Parent matched by ProductID first, then (store_id, lower(name)).
 *   - Variants matched by VariantID first, then (store_id, barcode).
 *   - Units matched by UnitID first, then (store_id, product_id, lower(unit_name)).
 *   - Stock ONLY posted for brand-new SKUs (idempotency-keyed OPENING movement).
 *   - Blank cells (absent from `present`) never overwrite existing DB values.
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

  // Resolve product by hidden ID first, then by name.
  let existingProduct: string | null = null;
  if (g.productId) {
    const byId = await sb.from("products").select("id").eq("store_id", storeId).eq("id", g.productId).maybeSingle();
    if (byId.error) throw new Error(byId.error.message);
    if (byId.data?.id) existingProduct = byId.data.id;
  }
  if (!existingProduct) {
    const byName = await sb.from("products").select("id").eq("store_id", storeId).ilike("name", g.productName).maybeSingle();
    if (byName.error) throw new Error(byName.error.message);
    if (byName.data?.id) existingProduct = byName.data.id;
  }

  let productId: string;
  if (existingProduct) {
    productId = existingProduct;
    // Data Shield: only patch fields the file actually provides.
    const patch: Record<string, unknown> = {};
    const scalarMap: Record<string, unknown> = {
      BaseUnit: g.baseUnit,
      TaxPercent: g.taxPercent,
      TaxIncluded: g.taxIncluded,
      IsSellable: g.isSellable,
      IsPurchasable: g.isPurchasable,
      ShowInPos: g.showInPos,
      IsQuickKey: g.isQuickKey,
      ReorderLevel: g.reorderLevel,
      AllowPriceChange: g.allowPriceChange,
      IsActive: g.isActive,
      Cost: parentCost,
      Price: parentPrice,
      WholesalePrice: parentWholesale,
    };
    for (const col of Object.keys(PRODUCT_PATCH_FIELDS)) {
      if (g.present.has(col)) patch[PRODUCT_PATCH_FIELDS[col]] = scalarMap[col];
    }
    if (Object.keys(patch).length > 0) {
      const upd = await sb.from("products").update(patch).eq("id", productId).eq("store_id", storeId);
      if (upd.error) throw new Error(upd.error.message);
    }
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

  // Units: match by UnitID first, then by (product_id, lower(unit_name)).
  for (let i = 0; i < g.units.length; i++) {
    const u = g.units[i];
    if (u.unitName) {
      const created = await upsertUnit(sb, storeId, productId, u, i);
      if (created) summary.unitsCreated += 1;
      else summary.unitsUpdated += 1;
    }
  }

  // Variants: match by VariantID first, then barcode; stock ONLY on new SKUs.
  for (const v of g.variants) {
    let existingVariant: string | null = null;
    if (v.variantId) {
      const byId = await sb.from("product_variants").select("id").eq("store_id", storeId).eq("id", v.variantId).maybeSingle();
      if (byId.error) throw new Error(byId.error.message);
      if (byId.data?.id) existingVariant = byId.data.id;
    }
    if (!existingVariant) {
      const byBarcode = await sb.from("product_variants").select("id").eq("store_id", storeId).eq("barcode", v.barcode).maybeSingle();
      if (byBarcode.error) throw new Error(byBarcode.error.message);
      if (byBarcode.data?.id) existingVariant = byBarcode.data.id;
    }

    const vp = {
      store_id: storeId,
      product_id: productId,
      barcode: v.barcode,
      variant_label: v.label,
      cost_price: v.costPrice ?? parentCost,
      selling_price: v.sellingPrice ?? parentPrice,
      wholesale_price: v.wholesalePrice ?? parentWholesale,
    };

    if (existingVariant) {
      // Data Shield: only patch variant scalar fields the file actually
      // provides, so blank cells never overwrite stored prices with the
      // parent fallback.
      const vup: Record<string, unknown> = {};
      if (v.present.has("Cost")) vup.cost_price = v.costPrice ?? parentCost;
      if (v.present.has("Price")) vup.selling_price = v.sellingPrice ?? parentPrice;
      if (v.present.has("WholesalePrice")) vup.wholesale_price = v.wholesalePrice ?? parentWholesale;
      const upd = await sb.from("product_variants").update(vup).eq("id", existingVariant).eq("store_id", storeId);
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

async function upsertUnit(
  sb: SupabaseClient,
  storeId: string,
  productId: string,
  u: UnitSetRow,
  sortOrder: number,
): Promise<boolean> {
  const name = cleanStr(u.unitName);

  // Resolve by hidden UnitID first, then by (product_id, lower(unit_name)).
  let existingId: string | null = null;
  if (u.unitId) {
    const byId = await sb.from("product_units").select("id").eq("store_id", storeId).eq("id", u.unitId).maybeSingle();
    if (byId.error) throw new Error(byId.error.message);
    if (byId.data?.id) existingId = byId.data.id;
  }
  if (!existingId) {
    const byName = await sb
      .from("product_units")
      .select("id")
      .eq("store_id", storeId)
      .eq("product_id", productId)
      .ilike("unit_name", name)
      .maybeSingle();
    if (byName.error) throw new Error(byName.error.message);
    if (byName.data?.id) existingId = byName.data.id;
  }

  if (u.isDefaultSale) {
    await sb.from("product_units").update({ is_default_sale: false }).eq("store_id", storeId).eq("product_id", productId).eq("is_default_sale", true);
  }
  if (u.isDefaultPurchase) {
    await sb.from("product_units").update({ is_default_purchase: false }).eq("store_id", storeId).eq("product_id", productId).eq("is_default_purchase", true);
  }

  const values: Record<string, unknown> = {
    store_id: storeId,
    product_id: productId,
    unit_name: name.slice(0, 60),
    // Defensive clamp: DB enforces qty_multiplier > 0 (migration 080).
    qty_multiplier: Number.isFinite(u.qtyMultiplier) && u.qtyMultiplier > 0 ? u.qtyMultiplier : 1,
    cost_price: u.costPrice,
    selling_price: u.sellingPrice,
    wholesale_price: u.wholesalePrice,
    barcode: u.barcode,
    is_default_sale: u.isDefaultSale,
    is_default_purchase: u.isDefaultPurchase,
    sort_order: sortOrder,
  };

  // Data Shield: only patch unit fields that are present in the file.
  const columnMap: Record<string, string> = {
    UnitMultiplier: "qty_multiplier",
    UnitCost: "cost_price",
    UnitPrice: "selling_price",
    UnitWholesale: "wholesale_price",
    UnitBarcode: "barcode",
    UnitIsDefaultSale: "is_default_sale",
    UnitIsDefaultPurchase: "is_default_purchase",
  };
  const updatePayload: Record<string, unknown> = { sort_order: sortOrder };
  for (const key of Object.keys(columnMap)) {
    if (u.present.has(key)) updatePayload[columnMap[key]] = values[columnMap[key]];
  }

  if (existingId) {
    const upd = await sb.from("product_units").update(updatePayload).eq("id", existingId).eq("store_id", storeId);
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
  if (!storeId) throw new Error("لم يتم تحديد المتجر — تعذر الاستيراد (متجر غير معروف)");
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

/** Convenience: read a File/ArrayBuffer, parse, then import (with dry-run-safe groups). */
export async function importCatalogExcel(
  sb: SupabaseClient,
  storeId: string,
  file: File | ArrayBuffer,
  onProgress?: (done: number, total: number) => void,
): Promise<ImportSummary> {
  const groups = await parseCatalogExcel(file);
  return importCatalogGroups(sb, storeId, groups, onProgress);
}
