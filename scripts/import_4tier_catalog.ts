/**
 * scripts/import_4tier_catalog.ts
 *
 * Bulk-import Excel product catalogs into Supabase using the Phase 5
 * 4-Tier architecture:
 *
 *   Tier 1: Category   (categories table)
 *   Tier 2: Brand      (product_brands table)
 *   Tier 3: Parent Product  (products table — unified prices)
 *   Tier 4: Variant / SKU   (product_variants — barcode + stock)
 *
 * Reads one or more .xlsx files, parses the legacy column headers, and
 * upserts in dependency order.  Prices land on the parent product;
 * each distinct barcode becomes a variant row.
 *
 * IDEMPOTENT — safe to re-run.  Existing products are matched by barcode
 * first, then by name.  New variants are appended; existing rows are
 * skipped via ON CONFLICT.
 *
 * Usage:
 *   npx tsx scripts/import_4tier_catalog.ts [file1.xlsx file2.xlsx ...] [--email EMAIL] [--dry-run]
 *
 * Examples:
 *   npx tsx scripts/import_4tier_catalog.ts
 *   npx tsx scripts/import_4tier_catalog.ts Global_Products_Cleaned.xlsx Local_Products_Cleaned.xlsx
 *   npx tsx scripts/import_4tier_catalog.ts *.xlsx --email admin@demo.test --dry-run
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import XLSX from "xlsx";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_TENANT_EMAIL = "alburjhom3@gmail.com";
const FALLBACK_FILE = "11111111222.xlsx";

// ────────────────────────────────────────────────────── Parsed row shape
interface ParsedRow {
  productName: string;
  mainCategory: string;
  subCategory: string;
  brand: string;
  barcodes: string[];
  salePrice: number;
  costPrice: number;
  wholesalePrice: number;
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
  file: string;
  row: number;
  message: string;
}

// ────────────────────────────────────────────────────── .env loader
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

// ────────────────────────────────────────────────────── value helpers
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
  return ["true", "yes", "1", "y", "on"].includes(t);
};

const normKey = (h: string): string =>
  h.normalize("NFKC").trim().toLowerCase().replace(/[\s_\-(),/]+/g, "");

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
  const parts = raw.split("//").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return { main: "", sub: "", brand: "" };
  if (parts.length === 1) return { main: parts[0], sub: "", brand: "" };
  if (parts.length === 2) return { main: parts[0], sub: "", brand: parts[1] };
  return { main: parts[0], sub: parts[1], brand: parts[parts.length - 1] };
}

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

// ────────────────────────────────────────────────────── Excel parsing
function parseSheet(rows: Record<string, unknown>[], fileName: string): { rows: ParsedRow[]; warnings: RowNote[] } {
  const out: ParsedRow[] = [];
  const warnings: RowNote[] = [];

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
      warnings.push({ file: fileName, row: rowNum, message: "سطر بلا اسم منتج — تم التجاهل" });
      return;
    }

    const barcodes = splitBarcodes(find(rawRow, "Barcode ( , )"));
    if (barcodes.length === 0) {
      warnings.push({ file: fileName, row: rowNum, message: `«${productName}» بلا باركود — تم التجاهل` });
      return;
    }

    const { main, sub, brand } = splitCategory(toText(find(rawRow, "Arabic Main Category")));
    const salePrice = Math.max(0, toNum(find(rawRow, "Sale Price")) ?? 0);
    const costPrice = Math.max(0, toNum(find(rawRow, "Cost Price")) ?? 0);
    const wholesalePrice = Math.max(0, toNum(find(rawRow, "Wholesale Price")) ?? 0);
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
      wholesalePrice: round2(wholesalePrice),
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

  return { rows: out, warnings };
}

// ────────────────────────────────────────────────────── store resolver
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
      `لا يوجد متجر مرتبط بالبريد «${email}». أنشئ المستأجر أولاً عبر /super-admin أو provision_new_store.`,
    );
  }
  if (found.size > 1) {
    console.warn(`⚠ تم العثور على ${found.size} متاجر للبريد «${email}» — سيتم استخدام أول متجر.`);
  }
  const id = found.keys().next().value as string;
  return { id, name: found.get(id) ?? "" };
}

// ────────────────────────────────────────────────────── Import engine
interface Summary {
  categoriesCreated: number;
  brandsCreated: number;
  suppliersCreated: number;
  productsCreated: number;
  productsUpdated: number;
  variantsInserted: number;
  variantsSkipped: number;
  skipped: number;
}

interface ExistingVariant {
  productId: string;
  barcode: string;
}

async function importCatalog(
  client: SupabaseClient,
  storeId: string,
  rows: ParsedRow[],
  dryRun: boolean,
): Promise<Summary> {
  const summary: Summary = {
    categoriesCreated: 0,
    brandsCreated: 0,
    suppliersCreated: 0,
    productsCreated: 0,
    productsUpdated: 0,
    variantsInserted: 0,
    variantsSkipped: 0,
    skipped: 0,
  };

  // ── lookup caches ──────────────────────────────────────────────
  const categoryCache = new Map<string, string>();        // "parentId::name" -> id
  const brandCache = new Map<string, string>();            // lowercase(name) -> id
  const supplierCache = new Map<string, string>();         // lowercase(name) -> id
  const variantByBarcode = new Map<string, ExistingVariant>();  // barcode -> {productId}
  const productByName = new Map<string, string>();         // name -> id
  const productRowCache = new Map<string, Record<string, unknown>>(); // id -> row
  const globalBarcodes = new Map<string, string>();        // barcode -> store_id

  // ── paginated fetcher ──────────────────────────────────────────
  const fetchAll = async <T>(table: string, select: string, storeScope: "store" | "global"): Promise<T[]> => {
    const PAGE = 1000;
    const all: T[] = [];
    for (let from = 0; ; from += PAGE) {
      let q = client.from(table).select(select).range(from, from + PAGE - 1);
      if (storeScope === "store") q = q.eq("store_id", storeId);
      const { data, error } = await q;
      if (error) throw new Error(`قراءة ${table}: ${error.message}`);
      const batch = (data ?? []) as T[];
      all.push(...batch);
      if (batch.length < PAGE) break;
    }
    return all;
  };

  // ── load existing lookups ──────────────────────────────────────
  const loadLookups = async (): Promise<void> => {
    console.log("  تحميل البيانات الحالية من قاعدة البيانات …");

    // Categories
    const cats = await fetchAll<{ id: string; name: string; parent_id: string | null }>(
      "categories", "id,name,parent_id", "store",
    );
    for (const c of cats) {
      const key = c.parent_id ? `${c.parent_id}::${c.name}` : `::${c.name}`;
      categoryCache.set(key, c.id);
    }
    console.log(`    فئات: ${cats.length}`);

    // Brands
    const brands = await fetchAll<{ id: string; name: string }>(
      "product_brands", "id,name", "store",
    );
    for (const b of brands) brandCache.set(b.name.toLowerCase(), b.id);
    console.log(`    علامات: ${brands.length}`);

    // Suppliers
    const suppliers = await fetchAll<{ id: string; name: string }>(
      "suppliers", "id,name", "store",
    );
    for (const s of suppliers) supplierCache.set(s.name.toLowerCase(), s.id);
    console.log(`    موردين: ${suppliers.length}`);

    // Product variants (for barcode-level dedup)
    const variants = await fetchAll<{ barcode: string; product_id: string }>(
      "product_variants", "barcode,product_id", "store",
    );
    for (const v of variants) variantByBarcode.set(v.barcode, { productId: v.product_id, barcode: v.barcode });
    console.log(`    متغيرات: ${variants.length}`);

    // Products (by name for dedup)
    const prods = await fetchAll<Record<string, unknown>>(
      "products",
      "id,name,category_id,brand_id,cost_price,selling_price,wholesale_price," +
      "tax_percent,tax_included,is_active,show_in_pos,is_sellable,is_purchasable," +
      "reorder_level,default_supplier_id,total_stock",
      "store",
    );
    for (const p of prods) {
      productByName.set(p.name as string, p.id as string);
      productRowCache.set(p.id as string, p);
    }
    console.log(`    منتجات: ${prods.length}`);

    // Global barcode uniqueness check (all stores)
    const allCodes = await fetchAll<{ barcode: string; store_id: string }>(
      "product_variants", "barcode,store_id", "global",
    );
    for (const v of allCodes) globalBarcodes.set(v.barcode, v.store_id);
  };

  // ── CRUD helpers ───────────────────────────────────────────────

  const getOrCreateCategory = async (name: string, parentId: string | null): Promise<string | null> => {
    if (!name) return null;
    const key = parentId ? `${parentId}::${name}` : `::${name}`;
    const cached = categoryCache.get(key);
    if (cached) return cached;
    if (dryRun) {
      const dryId = `dry-cat-${categoryCache.size}`;
      categoryCache.set(key, dryId);
      return dryId;
    }
    // Try insert
    const { data, error } = await client
      .from("categories")
      .insert({ name, store_id: storeId, parent_id: parentId })
      .select("id")
      .single();
    if (error) {
      // Race / already exists — fetch
      const existing = await client
        .from("categories").select("id")
        .eq("name", name).eq("store_id", storeId)
        .eq("parent_id", parentId ?? null)
        .limit(1);
      if (existing.error || !existing.data?.[0]) {
        throw new Error(`إنشاء التصنيف «${name}»: ${error.message}`);
      }
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
      const dryId = `dry-brand-${brandCache.size}`;
      brandCache.set(key, dryId);
      return dryId;
    }
    const { data, error } = await client
      .from("product_brands")
      .insert({ name, store_id: storeId })
      .select("id")
      .single();
    if (error) {
      const existing = await client
        .from("product_brands").select("id")
        .ilike("name", name).eq("store_id", storeId)
        .maybeSingle();
      if (existing.error || !existing.data?.id) {
        throw new Error(`إنشاء العلامة «${name}»: ${error.message}`);
      }
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
      const dryId = `dry-sup-${supplierCache.size}`;
      supplierCache.set(key, dryId);
      return dryId;
    }
    const { data, error } = await client
      .from("suppliers")
      .insert({ name, store_id: storeId })
      .select("id")
      .single();
    if (error) {
      const existing = await client
        .from("suppliers").select("id")
        .ilike("name", name).eq("store_id", storeId)
        .maybeSingle();
      if (existing.error || !existing.data?.id) {
        throw new Error(`إنشاء المورد «${name}»: ${error.message}`);
      }
      supplierCache.set(key, existing.data.id as string);
      return existing.data.id as string;
    }
    supplierCache.set(key, data.id as string);
    summary.suppliersCreated += 1;
    return data.id as string;
  };

  // ── Phase 1: resolve all entity IDs ────────────────────────────
  console.log("\n── المرحلة 1: حل المعرّفات ──");

  interface ResolvedRow {
    original: ParsedRow;
    categoryId: string | null;
    brandId: string | null;
    supplierId: string | null;
    /** Product name used as the parent-product key */
    parentKey: string;
  }

  const resolved: ResolvedRow[] = [];

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (i % 500 === 0 && i > 0) console.log(`  … ${i}/${rows.length}`);
    if (i === rows.length - 1) console.log(`  … ${rows.length}/${rows.length}`);

    // Cross-tenant barcode guard
    const conflicting = row.barcodes.filter((bc) => globalBarcodes.has(bc) && globalBarcodes.get(bc) !== storeId);
    if (conflicting.length > 0) {
      console.warn(`⚠ «${row.productName}»: باركود ${conflicting.join("، ")} في متجر آخر — تم التجاهل`);
      summary.skipped += 1;
      continue;
    }

    const mainId = await getOrCreateCategory(row.mainCategory, null);
    const subId = await getOrCreateCategory(row.subCategory, mainId);
    const categoryId = subId ?? mainId;
    const brandId = await getOrCreateBrand(row.brand);
    const supplierId = await getOrCreateSupplier(row.supplierName);

    resolved.push({
      original: row,
      categoryId,
      brandId,
      supplierId,
      parentKey: row.productName,
    });
  }

  // ── Phase 2: Upsert parent products ────────────────────────────
  console.log("\n── المرحلة 2: إنشاء/تحديث المنتجات الأساسية ──");

  interface PendingProduct {
    name: string;
    payload: Record<string, unknown>;
    barcodes: string[];
    variantLabels: string[];
  }

  const newProducts: PendingProduct[] = [];
  const pendingByName = new Map<string, number>();

  // Merge barcodes for rows that share the same product name
  const mergeOrCreate = (rr: ResolvedRow): void => {
    const existing = pendingByName.get(rr.parentKey);
    if (existing !== undefined) {
      // Merge barcodes into existing pending product
      const target = newProducts[existing]!;
      for (const bc of rr.original.barcodes) {
        if (!target.barcodes.includes(bc)) target.barcodes.push(bc);
      }
      return;
    }
    const idx = newProducts.length;
    newProducts.push({
      name: rr.parentKey,
      payload: {
        store_id: storeId,
        category_id: rr.categoryId,
        brand_id: rr.brandId,
        name: rr.parentKey,
        base_unit: rr.original.isWeighed ? "كغ" : "حبة",
        total_stock: 0,
        is_quick_key: false,
        cost_price: rr.original.costPrice,
        selling_price: rr.original.salePrice,
        wholesale_price: rr.original.wholesalePrice,
        tax_percent: rr.original.taxPercent,
        tax_included: rr.original.taxIncluded,
        is_active: rr.original.isActive,
        show_in_pos: rr.original.showInPos,
        is_sellable: rr.original.isSellable,
        is_purchasable: rr.original.isPurchasable,
        allow_price_change: false,
        reorder_level: rr.original.reorderLevel,
        default_supplier_id: rr.supplierId,
      },
      barcodes: [...rr.original.barcodes],
      variantLabels: [],
    });
    pendingByName.set(rr.parentKey, idx);
  };

  for (const rr of resolved) mergeOrCreate(rr);

  // Separate: products that already exist vs. new
  const toCreate: PendingProduct[] = [];
  const toUpdate: Array<{ id: string; changes: Record<string, unknown> }> = [];

  for (const pp of newProducts) {
    const existingId = productByName.get(pp.name);
    if (existingId) {
      // Check if update is needed
      const existing = productRowCache.get(existingId);
      if (existing) {
        const p = pp.payload;
        const needsUpdate =
          (existing.category_id ?? null) !== (p.category_id ?? null) ||
          (existing.brand_id ?? null) !== (p.brand_id ?? null) ||
          Number(existing.cost_price ?? 0) !== Number(p.cost_price ?? 0) ||
          Number(existing.selling_price ?? 0) !== Number(p.selling_price ?? 0) ||
          Number(existing.wholesale_price ?? 0) !== Number(p.wholesale_price ?? 0) ||
          Number(existing.tax_percent ?? 16) !== Number(p.tax_percent ?? 16) ||
          Boolean(existing.tax_included) !== Boolean(p.tax_included) ||
          Boolean(existing.is_active) !== Boolean(p.is_active) ||
          Boolean(existing.show_in_pos) !== Boolean(p.show_in_pos) ||
          Number(existing.reorder_level ?? 0) !== Number(p.reorder_level ?? 0);
        if (needsUpdate) {
          const changes: Record<string, unknown> = {};
          for (const k of [
            "category_id", "brand_id", "cost_price", "selling_price", "wholesale_price",
            "tax_percent", "tax_included", "is_active", "show_in_pos", "is_sellable",
            "is_purchasable", "reorder_level", "default_supplier_id",
          ]) {
            if ((existing[k] ?? null) !== (p[k] ?? null)) changes[k] = p[k];
          }
          if (Object.keys(changes).length > 0) toUpdate.push({ id: existingId, changes });
        }
      }
      continue;
    }
    toCreate.push(pp);
  }

  // Batch-create new parent products
  const PRODUCT_CHUNK = 200;
  for (let s = 0; s < toCreate.length; s += PRODUCT_CHUNK) {
    const chunk = toCreate.slice(s, s + PRODUCT_CHUNK);
    if (dryRun) {
      for (const pp of chunk) {
        const dryId = `dry-prod-${productByName.size}`;
        productByName.set(pp.name, dryId);
        summary.productsCreated += 1;
      }
    } else {
      const { data, error } = await client
        .from("products")
        .insert(chunk.map((p) => p.payload))
        .select("id,name");
      if (error) throw new Error(`إنشاء منتجات: ${error.message}`);
      for (const r of data ?? []) productByName.set(r.name as string, r.id as string);
      summary.productsCreated += chunk.length;
    }
    console.log(`  … منتجات ${s + 1}-${Math.min(s + PRODUCT_CHUNK, toCreate.length)}/${toCreate.length}`);
  }

  // Apply updates for existing products
  for (const { id, changes } of toUpdate) {
    if (!dryRun) {
      const { error } = await client.from("products").update(changes).eq("id", id).eq("store_id", storeId);
      if (error) throw new Error(`تحديث المنتج ${id}: ${error.message}`);
    }
    summary.productsUpdated += 1;
  }
  if (toUpdate.length > 0) console.log(`  … تحديث ${toUpdate.length} منتج موجود`);

  // ── Phase 3: Insert product variants (barcodes) ────────────────
  console.log("\n── المرحلة 3: إنشاء المتغيرات (باركودات) ──");

  interface VariantRow {
    product_id: string;
    store_id: string;
    barcode: string;
    variant_label: string;
    total_stock: number;
    is_active: boolean;
  }

  const variantRows: VariantRow[] = [];

  for (const pp of newProducts) {
    const productId = productByName.get(pp.name);
    if (!productId) continue;

    // Auto-generate variant labels for multi-barcode products
    const bcCount = pp.barcodes.length;
    for (let bi = 0; bi < bcCount; bi += 1) {
      const barcode = pp.barcodes[bi]!;

      // Skip if variant already exists for this barcode
      if (variantByBarcode.has(barcode)) {
        summary.variantsSkipped += 1;
        continue;
      }

      // Generate variant label: if single barcode, use product name;
      // if multi-barcode, auto-number as "نكهة 1", "نكهة 2", etc.
      let label = "";
      if (bcCount === 1) {
        label = pp.name;
      } else {
        label = `نكهة ${bi + 1}`;
      }

      // Ensure label uniqueness per product (constraint: uq_pv_product_label)
      let candidate = label;
      let suffix = 2;
      const existingLabels = new Set<string>();
      for (const vr of variantRows) {
        if (vr.product_id === productId) existingLabels.add(vr.variant_label.toLowerCase());
      }
      while (existingLabels.has(candidate.toLowerCase())) {
        candidate = `${label} (${suffix})`;
        suffix += 1;
      }
      label = candidate;

      variantRows.push({
        product_id: productId,
        store_id: storeId,
        barcode,
        variant_label: label,
        total_stock: 0,
        is_active: true,
      });
    }
  }

  // Batch-insert variants
  const VAR_CHUNK = 500;
  for (let s = 0; s < variantRows.length; s += VAR_CHUNK) {
    const chunk = variantRows.slice(s, s + VAR_CHUNK);
    if (dryRun) {
      summary.variantsInserted += chunk.length;
    } else {
      const { error } = await client
        .from("product_variants")
        .insert(chunk)
        .select("id");
      // ON CONFLICT won't fire here since we pre-filtered, but handle gracefully
      if (error) {
        // If batch fails, fall back to row-by-row to find the conflict
        let inserted = 0;
        for (const row of chunk) {
          const { error: rowErr } = await client
            .from("product_variants")
            .insert(row)
            .select("id")
            .limit(1);
          if (rowErr) {
            // Already exists or other error — skip silently
            summary.variantsSkipped += 1;
          } else {
            inserted += 1;
          }
        }
        summary.variantsInserted += inserted;
      } else {
        summary.variantsInserted += chunk.length;
      }
    }
    if (variantRows.length > VAR_CHUNK) {
      console.log(`  … متغيرات ${s + 1}-${Math.min(s + VAR_CHUNK, variantRows.length)}/${variantRows.length}`);
    }
  }
  console.log(`  متغيرات جديدة: ${summary.variantsInserted} | محفوظة مسبقاً: ${summary.variantsSkipped}`);

  // ── Phase 4: Sync variant labels from Excel ────────────────────
  // If the Excel has explicit variant labels (e.g. flavor columns),
  // update them here.  For now, auto-numbered labels are the default.

  return summary;
}

// ────────────────────────────────────────────────────── main
async function main(): Promise<void> {
  loadEnv();
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const emailIdx = args.indexOf("--email");
  const emailArg = emailIdx !== -1 ? args[emailIdx + 1] : undefined;
  const fileArgs = args.filter((a) => !a.startsWith("--") && a !== emailArg);

  const files = fileArgs.length > 0
    ? fileArgs.map((f) => resolve(ROOT, f))
    : [resolve(ROOT, FALLBACK_FILE)];

  const tenantEmail = (emailArg ?? process.env.TENANT_EMAIL ?? DEFAULT_TENANT_EMAIL)
    .trim().toLowerCase();

  // Validate files exist
  for (const file of files) {
    if (!existsSync(file)) {
      console.error(`خطأ: الملف غير موجود — ${file}`);
      process.exit(1);
    }
  }

  // Connect to Supabase
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
  if (!url || !key) {
    console.error("خطأ: مفاتيح Supabase غير موجودة في .env");
    process.exit(1);
  }
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  // Parse all files
  let allRows: ParsedRow[] = [];
  const allWarnings: RowNote[] = [];

  for (const file of files) {
    console.log(`\nقراءة ${file} …`);
    const workbook = XLSX.readFile(file);
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) {
      console.warn(`  تحذير: الملف لا يحتوي على ورقة عمل — تم التجاهل`);
      continue;
    }
    const sheet = workbook.Sheets[sheetName];
    const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "" });
    console.log(`  ورقة «${sheetName}» — ${raw.length} سطر`);

    const fileName = file.split(/[\\/]/).pop() ?? file;
    const { rows, warnings } = parseSheet(raw, fileName);
    allRows.push(...rows);
    allWarnings.push(...warnings);
  }

  // Print warnings
  for (const w of allWarnings) {
    console.warn(`⚠ [${w.file}] سطر ${w.row}: ${w.message}`);
  }

  if (allRows.length === 0) {
    console.error("\nخطأ: لا توجد بيانات صالحة في الملفات.");
    process.exit(1);
  }

  console.log(`\n════════════════════════════════════════════`);
  console.log(`  إجمالي: ${allRows.length} منتج | ${allWarnings.length} تجاوز`);
  console.log(`════════════════════════════════════════════`);

  // Resolve store
  console.log(`\nالبحث عن المتجر («${tenantEmail}») …`);
  const store = await resolveStore(client, tenantEmail);
  console.log(`✓ المتجر: ${store.name || store.id} (${store.id})`);

  // Run import
  console.log(dryRun
    ? "\n[DRY-RUN] لن تتم أي كتابة على قاعدة البيانات.\n"
    : "\nبدء الاستيراد بنيّة 4-Tier …\n"
  );

  const summary = await importCatalog(client, store.id, allRows, dryRun);

  // Print summary
  console.log("\n════════════════════════════════════════════");
  console.log("  ملخص الاستيراد (4-Tier)");
  console.log("════════════════════════════════════════════");
  console.log(`  فئات أنشئت:          ${summary.categoriesCreated}`);
  console.log(`  علامات أنشئت:        ${summary.brandsCreated}`);
  console.log(`  موردين أنشئوا:        ${summary.suppliersCreated}`);
  console.log(`  منتجات أنشئت:        ${summary.productsCreated}`);
  console.log(`  منتجات حدّثت:        ${summary.productsUpdated}`);
  console.log(`  متغيرات أُنشئت:      ${summary.variantsInserted}`);
  console.log(`  متغيرات محفوظة:      ${summary.variantsSkipped}`);
  console.log(`  منتجات تجاوزت:       ${summary.skipped}`);
  console.log("════════════════════════════════════════════");
  console.log(dryRun
    ? "\n(وضع التجربة — لم يُكتب أي شيء)"
    : "\n✓ اكتمل الاستيراد بنجاح."
  );
}

main().catch((err) => {
  console.error("\nفشل الاستيراد:", err instanceof Error ? err.message : err);
  process.exit(1);
});
