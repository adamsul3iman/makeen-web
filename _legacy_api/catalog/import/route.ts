import Papa from "papaparse";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import * as XLSX from "xlsx";
import { supabase } from "@/lib/supabase";
import { authorizedCapabilityStoreId } from "@/lib/requestAuth";

/**
 * Bulk import for inventory.
 *
 * Supported sources:
 * - POS canonical CSV:
 *   Category, Product Name, Base Unit, Barcode, Unit Name, Multiplier,
 *   Cost Price, Selling Price, Total Stock, Is Quick Key
 * - Nard product master XLSX:
 *   Arabic Name, Barcode ( , ), Arabic Main Category, Sale Price, Cost Price,
 *   Tax Percentage, Active 0/1, Show In Sale Screen 0/1
 * - Product-sales export XLSX:
 *   name_ar, barcode, item_quantity, total, total_cost, available_quantity
 *
 * Semantics: upsert, not replace. Categories are matched by name,
 * products by (category, name), barcodes by the unique barcode column.
 */

const MAX_ROWS = 20_000;
const PREVIEW_ROWS = 30;

interface ImportRow {
  category: string;
  brand: string;
  productName: string;
  baseUnit: string;
  barcode: string;
  unitName: string;
  multiplier: number;
  costPrice: number;
  sellingPrice: number;
  totalStock: number;
  isQuickKey: boolean;
  taxPercent: number;
  taxIncluded: boolean;
  isActive: boolean;
  showInPos: boolean;
  isSellable: boolean;
  isPurchasable: boolean;
  allowPriceChange: boolean;
  wholesalePrice: number;
}

interface RowError {
  row: number;
  message: string;
}

interface ParsedImport {
  rows: ImportRow[];
  errors: RowError[];
  warnings: RowError[];
  sourceKind: "canonical" | "nard-product-master" | "product-sales-export" | "unknown";
}

type RawRecord = Record<string, unknown>;

const normalizeHeader = (h: string): string =>
  h
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[\s_\-(),/]+/g, "");

const toText = (value: unknown): string => {
  if (value == null) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  return String(value).trim();
};

const toNum = (value: unknown): number | null => {
  const text = toText(value).replace(/,/g, "");
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
};

const toBool = (value: unknown): boolean => {
  const v = toText(value).toLowerCase();
  return ["true", "yes", "1", "y", "on", "نعم"].includes(v);
};

const aliases = (...names: string[]) => names.map(normalizeHeader);

function normalizeRecord(record: RawRecord): RawRecord {
  const out: RawRecord = {};
  for (const [key, value] of Object.entries(record)) {
    out[normalizeHeader(key)] = value;
  }
  return out;
}

function readFirst(record: RawRecord, keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] != null && toText(record[key]) !== "") return record[key];
  }
  return undefined;
}

function splitBarcodes(value: unknown): string[] {
  const text = toText(value)
    .replace(/UPC\s*:/gi, "")
    .replace(/باركود\s*:/gi, "");
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of text.split(/[,\n;|]+/)) {
    const barcode = part.trim().replace(/\s+/g, "");
    if (!barcode || seen.has(barcode)) continue;
    seen.add(barcode);
    out.push(barcode);
  }
  return out;
}

function inferKind(records: RawRecord[]): ParsedImport["sourceKind"] {
  const keys = new Set(Object.keys(records[0] ?? {}));
  if (keys.has("arabicname") && keys.has("barcode") && keys.has("saleprice")) return "nard-product-master";
  if (keys.has("namear") && keys.has("itemquantity") && keys.has("total")) return "product-sales-export";
  if (keys.has("category") && keys.has("productname") && keys.has("barcode")) return "canonical";
  return "unknown";
}

function parseRecords(rawRecords: RawRecord[]): ParsedImport {
  const records = rawRecords.map(normalizeRecord).filter((r) =>
    Object.values(r).some((v) => toText(v) !== ""),
  );
  const sourceKind = inferKind(records);
  const rows: ImportRow[] = [];
  const errors: RowError[] = [];
  const warnings: RowError[] = [];

  const categoryKeys = aliases("Category", "Arabic Main Category", "Arabic Sub Category", "branch_name");
  const brandKeys = aliases("Brand", "Arabic Brand", "Company", "Manufacturer", "Arabic Manufacturer");
  const productNameKeys = aliases("Product Name", "Arabic Name", "name_ar", "Name");
  const barcodeKeys = aliases("Barcode", "Barcode ( , )");
  const baseUnitKeys = aliases("Base Unit", "Unit Name", "Unit 1");
  const unitNameKeys = aliases("Unit Name", "Base Unit", "Unit 1");
  const multiplierKeys = aliases("Multiplier", "Factor Unit 1");
  const costKeys = aliases("Cost Price", "total_cost");
  const saleKeys = aliases("Selling Price", "Sale Price", "total");
  const stockKeys = aliases("Total Stock", "available_quantity");
  const quickKeys = aliases("Is Quick Key", "Show In Sale Screen 0/1");
  const activeKeys = aliases("Active 0/1");
  const taxPercentKeys = aliases("Tax Percentage", "Tax Percent", "VAT Percentage");
  const taxIncludedKeys = aliases("Tax Include 0/1", "Tax Included", "Price Includes Tax");
  const allowPriceChangeKeys = aliases("Allow Change Sale Price 0/1", "Allow Price Change");
  const wholesaleKeys = aliases("Wholesale Price", "Whole Sale Price");
  const productTypeKeys = aliases("product Type (both 0 , selling 1, buy 2)");
  const quantityKeys = aliases("item_quantity");

  records.forEach((r, i) => {
    const rowNum = i + 2;
    const activeValue = readFirst(r, activeKeys);
    const isActive = activeValue == null ? true : toBool(activeValue);
    const productType = toNum(readFirst(r, productTypeKeys));

    const productName = toText(readFirst(r, productNameKeys));
    const barcodes = splitBarcodes(readFirst(r, barcodeKeys));
    const category = toText(readFirst(r, categoryKeys));
    const brand = toText(readFirst(r, brandKeys));

    if (!productName) {
      errors.push({ row: rowNum, message: "اسم المنتج إلزامي" });
      return;
    }
    if (barcodes.length === 0) {
      warnings.push({ row: rowNum, message: "تم تجاهل منتج بلا باركود" });
      return;
    }

    const itemQty = toNum(readFirst(r, quantityKeys));
    const rawCost = toNum(readFirst(r, costKeys));
    const rawSale = toNum(readFirst(r, saleKeys));
    const costPrice =
      sourceKind === "product-sales-export" && itemQty && itemQty > 0 && rawCost != null
        ? rawCost / itemQty
        : rawCost;
    const sellingPrice =
      sourceKind === "product-sales-export" && itemQty && itemQty > 0 && rawSale != null
        ? rawSale / itemQty
        : rawSale;

    if (costPrice == null || sellingPrice == null || costPrice < 0 || sellingPrice < 0) {
      errors.push({ row: rowNum, message: "أسعار غير صالحة أو ناقصة" });
      return;
    }

    const stockRaw = toNum(readFirst(r, stockKeys)) ?? 0;
    if (stockRaw < 0) {
      warnings.push({ row: rowNum, message: "المخزون السالب حُوّل إلى صفر لحماية البيع" });
    }

    const baseUnit = toText(readFirst(r, baseUnitKeys));
    const unitName = toText(readFirst(r, unitNameKeys));
    const multiplier = toNum(readFirst(r, multiplierKeys)) ?? 1;
    const taxPercent = Math.max(0, Math.min(100, toNum(readFirst(r, taxPercentKeys)) ?? 16));
    const taxIncludedValue = readFirst(r, taxIncludedKeys);
    const taxIncluded = taxIncludedValue == null ? true : toBool(taxIncludedValue);
    const showValue = readFirst(r, quickKeys);
    const showInPos = showValue == null ? true : toBool(showValue);
    const isSellable = productType !== 2;
    const isPurchasable = productType !== 1;

    for (const barcode of barcodes) {
      rows.push({
        category,
        brand,
        productName,
        baseUnit: baseUnit && !/^\d+$/.test(baseUnit) ? baseUnit : "حبة",
        barcode,
        unitName: unitName && !/^\d+$/.test(unitName) ? unitName : "حبة",
        multiplier: Math.max(1, multiplier),
        costPrice: Math.round((costPrice + Number.EPSILON) * 100) / 100,
        sellingPrice: Math.round((sellingPrice + Number.EPSILON) * 100) / 100,
        totalStock: Math.max(0, Math.round(stockRaw)),
        isQuickKey: toBool(readFirst(r, quickKeys)),
        taxPercent,
        taxIncluded,
        isActive,
        showInPos,
        isSellable,
        isPurchasable,
        allowPriceChange: toBool(readFirst(r, allowPriceChangeKeys)),
        wholesalePrice: Math.max(0, toNum(readFirst(r, wholesaleKeys)) ?? 0),
      });
    }
  });

  return { rows, errors, warnings, sourceKind };
}

function parseCsv(text: string): ParsedImport {
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: "greedy",
  });
  const records = parsed.data as RawRecord[];
  const result = parseRecords(records);
  for (const err of parsed.errors) {
    result.errors.push({ row: (err.row ?? 0) + 2, message: err.message });
  }
  return result;
}

function parseXlsx(buffer: ArrayBuffer): ParsedImport {
  const workbook = XLSX.read(Buffer.from(buffer), { type: "buffer", cellDates: false });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return { rows: [], errors: [], warnings: [], sourceKind: "unknown" };
  const sheet = workbook.Sheets[sheetName];
  const records = XLSX.utils.sheet_to_json<RawRecord>(sheet, { defval: "" });
  return parseRecords(records);
}

async function parseRequest(req: Request): Promise<ParsedImport> {
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return {
        rows: [],
        errors: [{ row: 0, message: "ملف الاستيراد مطلوب" }],
        warnings: [],
        sourceKind: "unknown",
      };
    }
    const name = file.name.toLowerCase();
    if (name.endsWith(".xlsx") || name.endsWith(".xls")) return parseXlsx(await file.arrayBuffer());
    return parseCsv(await file.text());
  }
  return parseCsv(await req.text());
}

function importSummary(parsed: ParsedImport) {
  const products = new Set(parsed.rows.map((r) => `${r.category}\u0000${r.productName}`));
  const categories = new Set(parsed.rows.map((r) => r.category).filter(Boolean));
  return {
    sourceKind: parsed.sourceKind,
    rows: parsed.rows.length,
    products: products.size,
    categories: categories.size,
    barcodes: new Set(parsed.rows.map((r) => r.barcode)).size,
    warnings: parsed.warnings.length,
    preview: parsed.rows.slice(0, PREVIEW_ROWS),
  };
}

async function importRows(
  client: SupabaseClient,
  storeId: string,
  rows: ImportRow[],
): Promise<{ categoriesCreated: number; productsCreated: number; productsUpdated: number; barcodesUpserted: number; rows: number }> {
  const importBatch = createHash("sha256")
    .update(JSON.stringify(rows.map((row) => [row.productName, row.barcode, row.totalStock])))
    .digest("hex")
    .slice(0, 24);
  const categoryCache = new Map<string, string>();
  const brandCache = new Map<string, string>();
  const productCache = new Map<string, Map<string, string>>();
  const countedUpdates = new Set<string>();

  let categoriesCreated = 0;
  let productsCreated = 0;
  let productsUpdated = 0;
  let barcodesUpserted = 0;

  const getCategoryId = async (name: string): Promise<string | null> => {
    if (!name) return null;
    const cached = categoryCache.get(name);
    if (cached) return cached;
    const { data } = await client
      .from("categories")
      .select("id")
      .eq("name", name)
      .eq("store_id", storeId)
      .maybeSingle();
    const found = data?.id ?? null;
    if (found) {
      categoryCache.set(name, found);
      return found;
    }
    const ins = await client
      .from("categories")
      .insert({ name, store_id: storeId })
      .select("id")
      .single();
    if (ins.error || !ins.data) {
      throw new Error(`إنشاء الفئة «${name}»: ${ins.error?.message ?? "لا استجابة"}`);
    }
    categoryCache.set(name, ins.data.id);
    categoriesCreated += 1;
    return ins.data.id;
  };

  const getBrandId = async (name: string): Promise<string | null> => {
    if (!name) return null;
    const cached = brandCache.get(name);
    if (cached) return cached;
    const found = await client
      .from("product_brands")
      .select("id")
      .eq("store_id", storeId)
      .ilike("name", name)
      .maybeSingle();
    if (found.error) throw new Error(`قراءة الشركة «${name}»: ${found.error.message}`);
    if (found.data?.id) {
      brandCache.set(name, found.data.id);
      return found.data.id;
    }
    const created = await client
      .from("product_brands")
      .insert({ store_id: storeId, name })
      .select("id")
      .single();
    if (created.error || !created.data?.id) {
      throw new Error(`إنشاء الشركة «${name}»: ${created.error?.message ?? "لا استجابة"}`);
    }
    brandCache.set(name, created.data.id);
    return created.data.id;
  };

  const upsertProduct = async (row: ImportRow, categoryId: string | null, brandId: string | null): Promise<string> => {
    const categoryKey = categoryId ?? "__uncategorized__";
    let byName = productCache.get(categoryKey);
    if (!byName) {
      let query = client
        .from("products")
        .select("id,name")
        .eq("store_id", storeId);
      query = categoryId ? query.eq("category_id", categoryId) : query.is("category_id", null);
      const { data } = await query;
      byName = new Map((data ?? []).map((p) => [p.name, p.id]));
      productCache.set(categoryKey, byName);
    }

    const existing = byName.get(row.productName);
    if (existing) {
      const { error } = await client
        .from("products")
        .update({
          base_unit: row.baseUnit,
          brand_id: brandId,
          is_quick_key: row.isQuickKey,
          tax_percent: row.taxPercent,
          tax_included: row.taxIncluded,
          is_active: row.isActive,
          show_in_pos: row.showInPos,
          is_sellable: row.isSellable,
          is_purchasable: row.isPurchasable,
          allow_price_change: row.allowPriceChange,
          cost_price: row.costPrice,
          selling_price: row.sellingPrice,
          wholesale_price: row.wholesalePrice,
        })
        .eq("id", existing)
        .eq("store_id", storeId);
      if (error) throw new Error(`تحديث «${row.productName}»: ${error.message}`);
      if (!countedUpdates.has(existing)) {
        countedUpdates.add(existing);
        productsUpdated += 1;
      }
      return existing;
    }

    const ins = await client
      .from("products")
      .insert({
        category_id: categoryId,
        brand_id: brandId,
        name: row.productName,
        base_unit: row.baseUnit,
        total_stock: 0,
        is_quick_key: row.isQuickKey,
        tax_percent: row.taxPercent,
        tax_included: row.taxIncluded,
        is_active: row.isActive,
        show_in_pos: row.showInPos,
        is_sellable: row.isSellable,
        is_purchasable: row.isPurchasable,
        allow_price_change: row.allowPriceChange,
        cost_price: row.costPrice,
        selling_price: row.sellingPrice,
        wholesale_price: row.wholesalePrice,
        store_id: storeId,
      })
      .select("id")
      .single();
    if (ins.error) throw new Error(`إنشاء «${row.productName}»: ${ins.error.message}`);
    byName.set(row.productName, ins.data.id);
    productsCreated += 1;
    return ins.data.id;
  };

  const upsertBarcode = async (row: ImportRow, productId: string): Promise<void> => {
    const existing = await client
      .from("product_variants")
      .select("barcode,product_id,store_id")
      .eq("barcode", row.barcode)
      .eq("store_id", storeId)
      .maybeSingle();
    if (existing.error) throw new Error(`الباركود ${row.barcode}: ${existing.error.message}`);

    const { error } = await client
      .from("product_variants")
      .upsert(
        {
          product_id: productId,
          barcode: row.barcode,
          variant_label: row.unitName,
          store_id: storeId,
        },
        { onConflict: "store_id,barcode" },
      );
    if (error) throw new Error(`الباركود ${row.barcode}: ${error.message}`);
    barcodesUpserted += 1;
  };

  const targetStockByProduct = new Map<string, number>();
  for (const row of rows) {
    const categoryId = await getCategoryId(row.category);
    const brandId = await getBrandId(row.brand);
    const productId = await upsertProduct(row, categoryId, brandId);
    await upsertBarcode(row, productId);
    targetStockByProduct.set(productId, row.totalStock);
  }
  for (const [productId, targetStock] of targetStockByProduct) {
    const movement = await client.rpc("record_inventory_movement", {
      p_store_id: storeId,
      p_product_id: productId,
      p_quantity_delta: 0,
      p_movement_type: "STOCKTAKE",
      p_idempotency_key: `import:${importBatch}:${productId}`,
      p_reference_type: "CATALOG_IMPORT",
      p_reference_id: importBatch,
      p_reason: "تسوية رصيد من استيراد ملف المنتجات",
      p_target_balance: targetStock,
      p_metadata: { importBatch },
    });
    if (movement.error && !movement.error.message.includes("no_stock_change")) {
      throw new Error(`تسوية مخزون المنتج ${productId}: ${movement.error.message}`);
    }
  }

  return {
    categoriesCreated,
    productsCreated,
    productsUpdated,
    barcodesUpserted,
    rows: rows.length,
  };
}

export async function POST(req: Request): Promise<Response> {
  if (!supabase) {
    return Response.json(
      { error: "Supabase غير مهيأة — أضف مفاتيح البيئة للاستيراد" },
      { status: 503 },
    );
  }

  const storeId = await authorizedCapabilityStoreId(req, "catalog.manage");
  if (storeId instanceof Response) return storeId;

  const parsed = await parseRequest(req);

  if (parsed.errors.length > 0) {
    return Response.json(
      { error: "فشل التحليل — راجع الأخطاء في الأسطر التالية", details: parsed.errors, warnings: parsed.warnings },
      { status: 400 },
    );
  }
  if (parsed.rows.length === 0) {
    return Response.json({ error: "الملف لا يحتوي على بيانات صالحة", warnings: parsed.warnings }, { status: 400 });
  }
  if (parsed.rows.length > MAX_ROWS) {
    return Response.json({ error: `أقصى عدد أسطر باركود مدعوم هو ${MAX_ROWS}` }, { status: 400 });
  }

  if (new URL(req.url).searchParams.get("preview") === "1") {
    return Response.json({ ok: true, preview: true, summary: importSummary(parsed), warnings: parsed.warnings.slice(0, 200) });
  }

  try {
    const summary = await importRows(supabase, storeId, parsed.rows);
    return Response.json({ ok: true, ...summary, warnings: parsed.warnings.length });
  } catch (err) {
    console.error("Catalog import failed:", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "فشل الاستيراد" },
      { status: 500 },
    );
  }
}
