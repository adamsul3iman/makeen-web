/**
 * scripts/migrate_legacy_catalog.ts
 *
 * One-off data migration: import a legacy POS Excel catalog (11111111222.xlsx)
 * into Supabase for a single tenant (default alburjhom3@gmail.com).
 *
 * Column mapping (exact headers in the file):
 *   - Arabic Name              -> products.name
 *   - Arabic Main Category     -> "Main//Sub//Brand" (split by "//"). Index 0 is
 *                                 the main category (created if missing); a sub
 *                                 category is stored as a child of the main one;
 *                                 the last part is stored as product_brands.
 *   - Barcode ( , )            -> comma separated; index 0 = primary barcode,
 *                                 the rest are alternate barcodes (all rows in
 *                                 product_variants under the same product).
 *   - Sale Price / Cost Price  -> products.selling_price / cost_price.
 *   - Tax Percentage           -> products.tax_percent (clamped 0..100).
 *   - Tax Include 0/1          -> products.tax_included (1 = VAT included).
 *   - Supplier Name            -> products.default_supplier_id (created when
 *                                 present; null-safe — empty column handled).
 *
 * Also mapped (present in the file): Active 0/1, Show In Sale Screen 0/1,
 * product Type, Sale item method (weight), Reorder Level.
 *
 * Idempotency: UPSERT-style. A product is matched first by any of its barcodes
 * (same store), then by name (same store); existing rows are updated in place,
 * so re-running the script never duplicates data.
 *
 * Usage:
 *   npx tsx scripts/migrate_legacy_catalog.ts [file] [email] [--dry-run]
 * Examples:
 *   npx tsx scripts/migrate_legacy_catalog.ts
 *   npx tsx scripts/migrate_legacy_catalog.ts 11111111222.xlsx alburjhom3@gmail.com --dry-run
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import XLSX from "xlsx";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_TENANT_EMAIL = "alburjhom3@gmail.com";

interface LegacyRow {
  productName: string;
  mainCategory: string;
  subCategory: string;
  brand: string;
  barcodes: string[];
  salePrice: number;
  costPrice: number;
  taxPercent: number;
  taxIncluded: boolean;
  isActive: boolean;
  showInPos: boolean;
  isSellable: boolean;
  isPurchasable: boolean;
  isWeighed: boolean;
  reorderLevel: number;
  supplierName: string;
}

interface RowNote {
  row: number;
  message: string;
}

// ---------------------------------------------------------------- .env loader
function loadEnv(): void {
  const envPath = resolve(ROOT, ".env");
  if (!existsSync(envPath)) return;
  for (const raw of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    let key = line.slice(0, eq).trim();
    if (key.startsWith("export ")) key = key.slice(7).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2) {
      const f = value[0];
      const l = value[value.length - 1];
      if ((f === '"' && l === '"') || (f === "'" && l === "'")) value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

// ------------------------------------------------------------- value helpers
const toText = (v: unknown): string => {
  if (v == null) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  return String(v).trim();
};

const toNum = (v: unknown): number | null => {
  const text = toText(v).replace(/,/g, "");
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
};

const toBool = (v: unknown): boolean => {
  const t = toText(v).toLowerCase();
  return ["true", "yes", "1", "y", "on", "نعم"].includes(t);
};

const normKey = (h: string): string => h.normalize("NFKC").trim().toLowerCase().replace(/[\s_\-(),/]+/g, "");

function splitBarcodes(value: unknown): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of toText(value).split(/[,\n;|]+/)) {
    const code = part.trim().replace(/\s+/g, "");
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  return out;
}

function splitCategory(raw: string): { main: string; sub: string; brand: string } {
  const parts = raw
    .split("//")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return { main: "", sub: "", brand: "" };
  if (parts.length === 1) return { main: parts[0], sub: "", brand: "" };
  if (parts.length === 2) return { main: parts[0], sub: "", brand: parts[1] };
  // 3+ parts: the category model is two-level (main > sub), so only the first
  // middle part becomes the sub; extra middle parts cannot be represented and
  // are dropped. Joining them (parts.slice(1,-1).join(" // ")) previously
  // recreated dirty category names like "علب بلاستيك // كاسات سلش".
  return { main: parts[0], sub: parts[1], brand: parts[parts.length - 1] };
}

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

// ------------------------------------------------------------------ parsing
function parseSheet(rows: Record<string, unknown>[]): { rows: LegacyRow[]; warnings: RowNote[]; errors: RowNote[] } {
  const out: LegacyRow[] = [];
  const warnings: RowNote[] = [];
  const errors: RowNote[] = [];

  const find = (r: Record<string, unknown>, ...names: string[]): unknown => {
    const keys = new Map<string, string>();
    for (const k of Object.keys(r)) keys.set(normKey(k), k);
    for (const name of names) {
      const original = keys.get(normKey(name));
      if (original !== undefined && toText(r[original]) !== "") return r[original];
    }
    return undefined;
  };

  rows.forEach((rawRow, i) => {
    if (!Object.values(rawRow).some((v) => toText(v) !== "")) return;
    const rowNum = i + 2;
    const productName = toText(find(rawRow, "Arabic Name"));
    if (!productName) {
      warnings.push({ row: rowNum, message: "سطر بلا اسم منتج — تم التجاهل" });
      return;
    }

    const barcodes = splitBarcodes(find(rawRow, "Barcode ( , )"));
    if (barcodes.length === 0) {
      warnings.push({ row: rowNum, message: `«${productName}» بلا باركود — تم التجاهل` });
      return;
    }

    const { main, sub, brand } = splitCategory(toText(find(rawRow, "Arabic Main Category")));
    const salePrice = Math.max(0, toNum(find(rawRow, "Sale Price")) ?? 0);
    const costPrice = Math.max(0, toNum(find(rawRow, "Cost Price")) ?? 0);
    const taxPercent = clamp(toNum(find(rawRow, "Tax Percentage")) ?? 16, 0, 100);
    const taxIncluded = toBool(find(rawRow, "Tax Include 0/1"));
    const productType = toNum(find(rawRow, "product Type (both 0 , selling 1, buy 2)"));
    const weightMethod = toNum(find(rawRow, "Sale item method (weight 0 , piece 1)"));

    out.push({
      productName,
      mainCategory: main,
      subCategory: sub,
      brand,
      barcodes,
      salePrice: round2(salePrice),
      costPrice: round2(costPrice),
      taxPercent,
      taxIncluded,
      isActive: toBool(find(rawRow, "Active 0/1")),
      showInPos: toBool(find(rawRow, "Show In Sale Screen 0/1")),
      isSellable: productType !== 2,
      isPurchasable: productType !== 1,
      isWeighed: weightMethod === 0,
      reorderLevel: Math.max(0, toNum(find(rawRow, "Reorder Level")) ?? 0),
      supplierName: toText(find(rawRow, "Supplier Name")),
    });
  });

  return { rows: out, warnings, errors };
}

// ------------------------------------------------------------ store resolver
async function resolveStore(client: SupabaseClient, email: string): Promise<{ id: string; name: string }> {
  const found = new Map<string, string>();
  const byStore = await client.from("stores").select("id,name").ilike("email", email).limit(10);
  if (byStore.error) throw new Error(`قراءة المتاجر: ${byStore.error.message}`);
  for (const s of byStore.data ?? []) if (s.id && !found.has(s.id)) found.set(s.id, s.name ?? "");

  const byCashier = await client
    .from("cashiers")
    .select("store_id")
    .ilike("email", email)
    .eq("role", "admin")
    .not("email", "is", null)
    .limit(10);
  if (byCashier.error) throw new Error(`قراءة المسؤولين: ${byCashier.error.message}`);
  for (const c of byCashier.data ?? []) if (c.store_id && !found.has(c.store_id)) found.set(c.store_id, "");

  if (found.size === 0) {
    throw new Error(
      `لا يوجد متجر مرتبط بالبريد «${email}». أنشئ المستأجر أولاً عبر واجهة المدير العام (` +
        `/super-admin) أو من خلال دالة provision_new_store ثم أعد تشغيل السكربت.`,
    );
  }
  if (found.size > 1) {
    console.warn(`⚠ تم العثور على ${found.size} متاجر للبريد «${email}» — سيتم استخدام أول متجر.`);
  }
  const id = found.keys().next().value as string;
  return { id, name: found.get(id) ?? "" };
}

// -------------------------------------------------------------- import engine
interface Summary {
  categoriesCreated: number;
  brandsCreated: number;
  suppliersCreated: number;
  productsCreated: number;
  productsUpdated: number;
  barcodesUpserted: number;
  skipped: number;
}

interface BarcodeInfo {
  productId: string;
  cost: number;
  sale: number;
  unit: string;
  multiplier: number;
  wholesale: number;
}

async function importCatalog(
  client: SupabaseClient,
  storeId: string,
  rows: LegacyRow[],
  dryRun: boolean,
): Promise<Summary> {
  const summary: Summary = { categoriesCreated: 0, brandsCreated: 0, suppliersCreated: 0, productsCreated: 0, productsUpdated: 0, barcodesUpserted: 0, skipped: 0 };

  const categoryCache = new Map<string, string>();
  const brandCache = new Map<string, string>();
  const supplierCache = new Map<string, string>();
  const barcodeOwner = new Map<string, BarcodeInfo>();
  const globalBarcodes = new Map<string, string>();
  const productsByName = new Map<string, string>();
  const productRows = new Map<string, Record<string, unknown>>();

  /** Page through every row of a table (PostgREST caps responses at max-rows). */
  const fetchAllRows = async <T>(table: string, select: string, storeScope: "store" | "global"): Promise<T[]> => {
    const PAGE = 1000;
    const rows: T[] = [];
    for (let from = 0; ; from += PAGE) {
      let q = client.from(table).select(select).range(from, from + PAGE - 1);
      if (storeScope === "store") q = q.eq("store_id", storeId);
      const { data, error } = await q;
      if (error) throw new Error(`قراءة ${table}: ${error.message}`);
      const batch = (data ?? []) as T[];
      rows.push(...batch);
      if (batch.length < PAGE) break;
    }
    return rows;
  };

  const loadLookups = async (): Promise<void> => {
    const cats = await fetchAllRows<{ id: string; name: string; parent_id: string | null }>("categories", "id,name,parent_id", "store");
    for (const c of cats) {
      const key = c.parent_id ? `${c.parent_id}::${c.name}` : `::${c.name}`;
      categoryCache.set(key, c.id);
    }

    const brands = await fetchAllRows<{ id: string; name: string }>("product_brands", "id,name", "store");
    for (const b of brands) brandCache.set(b.name.toLowerCase(), b.id);

    const suppliers = await fetchAllRows<{ id: string; name: string }>("suppliers", "id,name", "store");
    for (const s of suppliers) supplierCache.set(s.name.toLowerCase(), s.id);

    const codes = await fetchAllRows<{ barcode: string; product_id: string; variant_label: string }>(
      "product_variants",
      "barcode,product_id,variant_label",
      "store",
    );
    const codeProductIds = [...new Set(codes.map((c) => c.product_id).filter(Boolean))];
    const priceMap = new Map<string, { cost: number; sale: number; wholesale: number }>();
    if (codeProductIds.length > 0) {
      const PAGE = 1000;
      for (let start = 0; ; start += PAGE) {
        const chunk = codeProductIds.slice(start, start + PAGE);
        const { data: priceRows } = await client
          .from("products")
          .select("id,cost_price,selling_price,wholesale_price")
          .eq("store_id", storeId)
          .in("id", chunk);
        for (const p of priceRows ?? []) {
          priceMap.set(p.id, { cost: Number(p.cost_price ?? 0), sale: Number(p.selling_price ?? 0), wholesale: Number(p.wholesale_price ?? 0) });
        }
        if (!priceRows || priceRows.length < PAGE) break;
      }
    }
    for (const b of codes) {
      const prices = priceMap.get(b.product_id) ?? { cost: 0, sale: 0, wholesale: 0 };
      barcodeOwner.set(b.barcode, {
        productId: b.product_id,
        cost: prices.cost,
        sale: prices.sale,
        unit: b.variant_label || "حبة",
        multiplier: 1,
        wholesale: prices.wholesale,
      });
    }

    const allCodes = await fetchAllRows<{ barcode: string; store_id: string }>("product_variants", "barcode,store_id", "global");
    for (const b of allCodes) globalBarcodes.set(b.barcode, b.store_id);

    const prods = await fetchAllRows<Record<string, unknown>>(
      "products",
      "id,name,base_unit,category_id,brand_id,is_weighed,tax_percent,tax_included,is_active,show_in_pos,is_sellable,is_purchasable,allow_price_change,reorder_level,default_supplier_id",
      "store",
    );
    for (const p of prods) {
      productsByName.set(p.name as string, p.id as string);
      productRows.set(p.id as string, p);
    }
  };

  const getOrCreateCategory = async (name: string, parentId: string | null): Promise<string | null> => {
    if (!name) return null;
    const key = parentId ? `${parentId}::${name}` : `::${name}`;
    const cached = categoryCache.get(key);
    if (cached) return cached;
    if (dryRun) {
      categoryCache.set(key, `dry-${key}`);
      return categoryCache.get(key)!;
    }
    const { data, error } = await client
      .from("categories")
      .insert({ name, store_id: storeId, parent_id: parentId })
      .select("id")
      .single();
    if (error) {
      const existing = await client.from("categories").select("id").eq("name", name).eq("store_id", storeId);
      if (existing.error || !existing.data?.[0]) throw new Error(`إنشاء الفئة «${name}»: ${error.message}`);
      categoryCache.set(key, existing.data[0].id as string);
      return existing.data[0].id as string;
    }
    categoryCache.set(key, data.id as string);
    summary.categoriesCreated += 1;
    return data.id as string;
  };

  const getOrCreateBrand = async (name: string): Promise<string | null> => {
    if (!name) return null;
    const key = name.toLowerCase();
    const cached = brandCache.get(key);
    if (cached) return cached;
    if (dryRun) {
      brandCache.set(key, `dry-brand-${key}`);
      return brandCache.get(key)!;
    }
    const { data, error } = await client
      .from("product_brands")
      .insert({ name, store_id: storeId })
      .select("id")
      .single();
    if (error) {
      const existing = await client.from("product_brands").select("id").ilike("name", name).eq("store_id", storeId).maybeSingle();
      if (existing.error || !existing.data?.id) throw new Error(`إنشاء الشركة «${name}»: ${error.message}`);
      brandCache.set(key, existing.data.id as string);
      return existing.data.id as string;
    }
    brandCache.set(key, data.id as string);
    summary.brandsCreated += 1;
    return data.id as string;
  };

  const getOrCreateSupplier = async (name: string): Promise<string | null> => {
    if (!name) return null;
    const key = name.toLowerCase();
    const cached = supplierCache.get(key);
    if (cached) return cached;
    if (dryRun) {
      supplierCache.set(key, `dry-supplier-${key}`);
      return supplierCache.get(key)!;
    }
    const { data, error } = await client
      .from("suppliers")
      .insert({ name, store_id: storeId })
      .select("id")
      .single();
    if (error) {
      const existing = await client.from("suppliers").select("id").ilike("name", name).eq("store_id", storeId).maybeSingle();
      if (existing.error || !existing.data?.id) throw new Error(`إنشاء المورد «${name}»: ${error.message}`);
      supplierCache.set(key, existing.data.id as string);
      return existing.data.id as string;
    }
    supplierCache.set(key, data.id as string);
    summary.suppliersCreated += 1;
    return data.id as string;
  };

  const PENDING = "__PENDING__";

  interface NewProduct {
    name: string;
    payload: Record<string, unknown>;
    barcodes: { barcode: string; cost: number; sale: number }[];
  }

  const newProducts: NewProduct[] = [];
  const pendingByName = new Map<string, number>();
  const pendingByBarcode = new Map<string, number>();
  const existingBarcodeRows = new Map<string, { product_id: string; barcode: string; cost: number; sale: number }>();
  const updates = new Map<string, Record<string, unknown>>();

  const needsUpdate = (
    existing: Record<string, unknown>,
    row: LegacyRow,
    categoryId: string | null,
    brandId: string | null,
    supplierId: string | null,
  ): boolean =>
    (existing.category_id ?? null) !== (categoryId ?? null) ||
    (existing.brand_id ?? null) !== (brandId ?? null) ||
    (existing.is_weighed ?? false) !== row.isWeighed ||
    Number(existing.tax_percent ?? 16) !== row.taxPercent ||
    Boolean(existing.tax_included) !== row.taxIncluded ||
    (existing.is_active ?? true) !== row.isActive ||
    (existing.show_in_pos ?? true) !== row.showInPos ||
    (existing.is_sellable ?? true) !== row.isSellable ||
    (existing.is_purchasable ?? true) !== row.isPurchasable ||
    (existing.allow_price_change ?? false) !== false ||
    Number(existing.reorder_level ?? 0) !== row.reorderLevel ||
    (existing.default_supplier_id ?? null) !== (supplierId ?? null);

  const buildChanges = (
    row: LegacyRow,
    categoryId: string | null,
    brandId: string | null,
    supplierId: string | null,
  ): Record<string, unknown> => ({
    category_id: categoryId,
    brand_id: brandId,
    base_unit: row.isWeighed ? "كغ" : "حبة",
    is_weighed: row.isWeighed,
    tax_percent: row.taxPercent,
    tax_included: row.taxIncluded,
    is_active: row.isActive,
    show_in_pos: row.showInPos,
    is_sellable: row.isSellable,
    is_purchasable: row.isPurchasable,
    allow_price_change: false,
    reorder_level: row.reorderLevel,
    default_supplier_id: supplierId,
  });

  const mergeBarcodes = (target: NewProduct, row: LegacyRow, barcodes: string[]): void => {
    for (const barcode of barcodes) {
      if (!target.barcodes.some((x) => x.barcode === barcode)) {
        target.barcodes.push({ barcode, cost: row.costPrice, sale: row.salePrice });
      }
    }
  };

  await loadLookups();

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (i % 500 === 0 || i === rows.length - 1) {
      console.log(`  … ${i + 1}/${rows.length}`);
    }

    const mainId = await getOrCreateCategory(row.mainCategory, null);
    const subId = await getOrCreateCategory(row.subCategory, mainId);
    const categoryId = subId ?? mainId;
    const brandId = await getOrCreateBrand(row.brand);
    const supplierId = await getOrCreateSupplier(row.supplierName);

    const conflicts = row.barcodes.filter((barcode) => globalBarcodes.has(barcode) && globalBarcodes.get(barcode) !== storeId);
    if (conflicts.length > 0) {
      console.warn(`⚠ «${row.productName}»: الباركود ${conflicts.join("، ")} مستخدم في متجر آخر — تم تجاوز هذا الباركود`);
      summary.skipped += 1;
    }
    const barcodes = row.barcodes.filter((barcode) => !globalBarcodes.has(barcode) || globalBarcodes.get(barcode) === storeId);
    if (barcodes.length === 0) continue;

    let productId: string | null = null;
    for (const barcode of barcodes) {
      const owner = barcodeOwner.get(barcode);
      if (owner) {
        productId = owner.productId;
        break;
      }
      const pending = pendingByBarcode.get(barcode);
      if (pending !== undefined) {
        mergeBarcodes(newProducts[pending], row, barcodes);
        productId = PENDING;
        break;
      }
    }
    if (productId === null) {
      const byName = productsByName.get(row.productName);
      if (byName) {
        productId = byName;
      } else if (!dryRun) {
        const pending = pendingByName.get(row.productName);
        if (pending !== undefined) {
          mergeBarcodes(newProducts[pending], row, barcodes);
          productId = PENDING;
        }
      }
    }
    if (productId === PENDING) continue;

    if (productId === null) {
      if (dryRun) {
        productId = `dry-product-${i}`;
        productsByName.set(row.productName, productId);
        summary.productsCreated += 1;
      } else {
        const target: NewProduct = {
          name: row.productName,
          payload: {
            category_id: categoryId,
            brand_id: brandId,
            name: row.productName,
            base_unit: row.isWeighed ? "كغ" : "حبة",
            total_stock: 0,
            is_weighed: row.isWeighed,
            is_quick_key: false,
            tax_percent: row.taxPercent,
            tax_included: row.taxIncluded,
            is_active: row.isActive,
            show_in_pos: row.showInPos,
            is_sellable: row.isSellable,
            is_purchasable: row.isPurchasable,
            allow_price_change: false,
            reorder_level: row.reorderLevel,
            default_supplier_id: supplierId,
            store_id: storeId,
          },
          barcodes: barcodes.map((barcode) => ({ barcode, cost: row.costPrice, sale: row.salePrice })),
        };
        const pendingIdx = newProducts.push(target) - 1;
        pendingByName.set(row.productName, pendingIdx);
        for (const barcode of barcodes) pendingByBarcode.set(barcode, pendingIdx);
        continue;
      }
    }

    const existing = productRows.get(productId);
    if (existing) {
      if (needsUpdate(existing, row, categoryId, brandId, supplierId)) {
        if (!dryRun) updates.set(productId, buildChanges(row, categoryId, brandId, supplierId));
      }
    }
    for (const barcode of barcodes) {
      if (!barcodeOwner.has(barcode)) {
        barcodeOwner.set(barcode, { productId, cost: row.costPrice, sale: row.salePrice, unit: "حبة", multiplier: 1, wholesale: 0 });
        globalBarcodes.set(barcode, storeId);
        if (dryRun) summary.barcodesUpserted += 1;
      }
      if (!dryRun) {
        existingBarcodeRows.set(barcode, { product_id: productId, barcode, cost: row.costPrice, sale: row.salePrice });
      }
    }
  }

  if (dryRun) return summary;

  // bulk-create the new products
  if (newProducts.length > 0) {
    const PRODUCT_CHUNK = 200;
    for (let s = 0; s < newProducts.length; s += PRODUCT_CHUNK) {
      const chunk = newProducts.slice(s, s + PRODUCT_CHUNK);
      const { data, error } = await client
        .from("products")
        .insert(chunk.map((p) => p.payload))
        .select("id,name");
      if (error) throw new Error(`إنشاء دفعة منتجات: ${error.message}`);
      const idByName = new Map<string, string>();
      for (const r of data ?? []) idByName.set(r.name as string, r.id as string);
      chunk.forEach((p) => {
        const pid = idByName.get(p.name);
        if (!pid) throw new Error(`تعذر إعادة قراءة معرف المنتج «${p.name}»`);
        productsByName.set(p.name, pid);
        for (const b of p.barcodes) {
          barcodeOwner.set(b.barcode, { productId: pid, cost: b.cost, sale: b.sale, unit: "حبة", multiplier: 1, wholesale: 0 });
        }
      });
      summary.productsCreated += chunk.length;
      console.log(`  … إنشاء المنتجات ${s + 1}-${Math.min(s + PRODUCT_CHUNK, newProducts.length)}/${newProducts.length}`);
    }
  }

  // assemble variant upsert payloads and product price updates
  const variantRows: Record<string, unknown>[] = [];
  const priceUpdates = new Map<string, Record<string, unknown>>();
  for (const p of newProducts) {
    const pid = productsByName.get(p.name);
    if (!pid) continue;
    p.barcodes.forEach((b) => {
      variantRows.push({
        product_id: pid,
        barcode: b.barcode,
        variant_label: "حبة",
        store_id: storeId,
      });
    });
    if (p.barcodes.length > 0) {
      const first = p.barcodes[0];
      priceUpdates.set(pid, { cost_price: first.cost, selling_price: first.sale, wholesale_price: 0 });
    }
  }
  for (const b of existingBarcodeRows.values()) {
    variantRows.push({
      product_id: b.product_id,
      barcode: b.barcode,
      variant_label: "حبة",
      store_id: storeId,
    });
    priceUpdates.set(b.product_id, { cost_price: b.cost, selling_price: b.sale, wholesale_price: 0 });
  }

  if (variantRows.length > 0) {
    const BARCODE_CHUNK = 500;
    for (let s = 0; s < variantRows.length; s += BARCODE_CHUNK) {
      const chunk = variantRows.slice(s, s + BARCODE_CHUNK);
      const { error } = await client.from("product_variants").upsert(chunk, { onConflict: "store_id,barcode" });
      if (error) throw new Error(`حفظ الباركود ${String(chunk[0]?.barcode ?? "")}: ${error.message}`);
      console.log(`  … حفظ الباركود ${s + 1}-${Math.min(s + BARCODE_CHUNK, variantRows.length)}/${variantRows.length}`);
    }
    summary.barcodesUpserted += variantRows.length;
  }

  // apply price updates to products
  for (const [pid, prices] of priceUpdates) {
    const { error } = await client.from("products").update(prices).eq("id", pid).eq("store_id", storeId);
    if (error) throw new Error(`تحديث أسعار المنتج: ${error.message}`);
  }

  // NOTE: is_default_sale / is_default_purchase no longer exist in the 4-tier
  // schema. Each product_variants row is a standalone SKU.

  // apply in-place updates for pre-existing products (idempotent re-runs)
  for (const [id, changes] of updates) {
    const { error } = await client.from("products").update(changes).eq("id", id).eq("store_id", storeId);
    if (error) throw new Error(`تحديث المنتج: ${error.message}`);
    summary.productsUpdated += 1;
  }

  return summary;
}

// --------------------------------------------------------------------- main
async function main(): Promise<void> {
  loadEnv();
  const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const [fileArg = "11111111222.xlsx", emailArg] = positional;
  const dryRun = process.argv.includes("--dry-run");
  const file = resolve(ROOT, fileArg);
  const tenantEmail = (emailArg ?? process.env.TENANT_EMAIL ?? DEFAULT_TENANT_EMAIL).trim().toLowerCase();

  if (!existsSync(file)) {
    console.error(`خطأ: الملف غير موجود — ${file}`);
    process.exit(1);
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
  if (!url || !key) {
    console.error("خطأ: مفاتيح Supabase غير موجودة في .env (NEXT_PUBLIC_SUPABASE_URL و SUPABASE_SERVICE_ROLE_KEY).");
    process.exit(1);
  }
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  console.log(`قراءة ${file} …`);
  const workbook = XLSX.readFile(file);
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    console.error("خطأ: الملف لا يحتوي على أي ورقة عمل.");
    process.exit(1);
  }
  const sheet = workbook.Sheets[sheetName];
  const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
  console.log(`ورقة «${sheetName}» — ${raw.length} سطراً`);

  const { rows, warnings, errors } = parseSheet(raw);
  for (const w of warnings) console.warn(`⚠ سطر ${w.row}: ${w.message}`);
  if (rows.length === 0) {
    console.error("خطأ: لا توجد بيانات صالحة في الملف.");
    process.exit(1);
  }
  console.log(`\nتم التحليل: ${rows.length} منتجاً، ${warnings.length} تجاوز، ${errors.length} خطأ`);

  console.log(`\nالبحث عن المتجر المرتبط بالبريد «${tenantEmail}» …`);
  const store = await resolveStore(client, tenantEmail);
  console.log(`✓ المتجر: ${store.name || store.id} (${store.id})`);

  console.log(dryRun ? "\n[DRY-RUN] لن تتم أي كتابة على قاعدة البيانات.\n" : "\nبدء الاستيراد …");
  const summary = await importCatalog(client, store.id, rows, dryRun);

  console.log("\n=== الملخص ===");
  console.log(`فئات أنشئت:       ${summary.categoriesCreated}`);
  console.log(`شركات أنشئت:       ${summary.brandsCreated}`);
  console.log(`موردين أنشئوا:     ${summary.suppliersCreated}`);
  console.log(`منتجات أنشئت:      ${summary.productsCreated}`);
  console.log(`منتجات حدّثت:      ${summary.productsUpdated}`);
  console.log(`باركود سُجّل:      ${summary.barcodesUpserted}`);
  console.log(`منتجات تجاوزت:     ${summary.skipped}`);
  console.log(dryRun ? "\n(وضع التجرية — لم يُكتب أي شيء)" : "\nاكتمل الاستيراد بنجاح.");
}

main().catch((err) => {
  console.error("\nفشل الاستيراد:", err instanceof Error ? err.message : err);
  process.exit(1);
});
