#!/usr/bin/env npx tsx
/**
 * scripts/deploy_phase5.ts
 *
 * Full Phase 5 deployment pipeline:
 *   1. Apply 062_four_tier_architecture.sql migration to local PostgreSQL
 *   2. Parse Global_Products_Cleaned.xlsx + Local_Products_Cleaned.xlsx
 *   3. Ingest 4-tier hierarchy into hosted Supabase via service-role
 *
 * New Excel schema (27 columns):
 *   ERP Variant ID, Parent ID, Source Row, Category, Category Confidence,
 *   Brand / Company, Brand Confidence, Parent Product, Variant Label,
 *   Variant Type, Barcode, Barcode Raw, Barcode Type, Barcode Valid GTIN,
 *   Barcode Recovery Status, GS1 Prefix, Sale Price, Cost Price,
 *   Purchase Price, Whole Price, Tax Percentage, Legacy Arabic Name,
 *   Legacy Main Category, Variant Source, Variant Confidence,
 *   Needs Review, Review Reason
 *
 * Usage:
 *   npx tsx scripts/deploy_phase5.ts                          # full pipeline
 *   npx tsx scripts/deploy_phase5.ts --skip-migration         # skip step 1
 *   npx tsx scripts/deploy_phase5.ts --dry-run                # no writes
 *   npx tsx scripts/deploy_phase5.ts --files x.xlsx y.xlsx   # override files
 *   npx tsx scripts/deploy_phase5.ts --email admin@demo.test  # tenant email
 *   npx tsx scripts/deploy_phase5.ts --local-only             # ingest to local PG
 */

import { readFileSync, existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import XLSX from "xlsx";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
// @ts-expect-error — pg lacks bundled types; used only for migration runner
import pg from "pg";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = join(ROOT, "db", "migrations");
const DEFAULT_TENANT_EMAIL = "alburjhom3@gmail.com";

// ────────────────────────────────────────── .env loader ────────────────────

function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  const envPath = resolve(ROOT, ".env");
  if (!existsSync(envPath)) return out;
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
    out[key] = value;
  }
  return out;
}

// ────────────────────────────────────────── CLI args ───────────────────────

interface CliArgs {
  skipMigration: boolean;
  dryRun: boolean;
  localOnly: boolean;
  files: string[];
  email: string;
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  const args: CliArgs = {
    skipMigration: argv.includes("--skip-migration"),
    dryRun: argv.includes("--dry-run"),
    localOnly: argv.includes("--local-only"),
    files: [],
    email: DEFAULT_TENANT_EMAIL,
  };

  const fileIdx = argv.indexOf("--files");
  if (fileIdx !== -1) {
    for (let i = fileIdx + 1; i < argv.length; i++) {
      if (argv[i].startsWith("--")) break;
      args.files.push(argv[i]);
    }
  }

  const emailIdx = argv.indexOf("--email");
  if (emailIdx !== -1 && argv[emailIdx + 1]) args.email = argv[emailIdx + 1];

  if (args.files.length === 0) {
    const candidates = [
      resolve(ROOT, "Global_Products_Cleaned.xlsx"),
      resolve(ROOT, "Local_Products_Cleaned.xlsx"),
    ];
    for (const c of candidates) {
      if (existsSync(c)) args.files.push(c);
    }
  }

  return args;
}

// ────────────────────────────────────────── value helpers ──────────────────

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

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
const clampStock = (n: number | null | undefined): number => Math.max(0, Math.round((n ?? 0) * 1000) / 1000);

// ────────────────────────────────────────── Pre-flight sanitization ────────

/**
 * Clamps every numeric field that could violate a DB constraint to safe
 * non-negative values.  Called ONCE after all Excel files are parsed and
 * merged, before any data touches the network.
 *
 * Guarantee: after this call, every `total_stock`, `salePrice`, `costPrice`,
 * `wholePrice`, and `taxPercent` across all parents and variants is >= 0.
 */
function sanitizeInventory(parents: Map<string, ExcelParent>): { fixed: number } {
  let fixed = 0;
  for (const [, p] of parents) {
    // Parent-level prices — clamp to >= 0
    if (p.costPrice < 0) { p.costPrice = 0; fixed += 1; }
    if (p.salePrice < 0) { p.salePrice = 0; fixed += 1; }
    if (p.wholePrice < 0) { p.wholePrice = 0; fixed += 1; }
    if (p.taxPercent < 0 || p.taxPercent > 100) { p.taxPercent = 16; fixed += 1; }

    // Parent-level stock — clamp
    const clampedParentStock = Math.max(0, parseFloat(String(p.totalStock)) || 0);
    if (clampedParentStock !== p.totalStock) { p.totalStock = clampedParentStock; fixed += 1; }

    // Variant-level — clamp every field
    for (const v of p.variants) {
      if (v.salePrice < 0) { v.salePrice = 0; fixed += 1; }
      if (v.costPrice < 0) { v.costPrice = 0; fixed += 1; }
      if (v.wholePrice < 0) { v.wholePrice = 0; fixed += 1; }
      if (v.taxPercent < 0 || v.taxPercent > 100) { v.taxPercent = 16; fixed += 1; }

      const clampedStock = Math.max(0, parseFloat(String(v.totalStock)) || 0);
      if (clampedStock !== v.totalStock) { v.totalStock = clampedStock; fixed += 1; }
    }
  }
  return { fixed };
}

// ────────────────────────────────────────── Excel parsing (new format) ─────

interface ExcelVariant {
  erpVariantId: string;
  parentId: string;
  sourceRow: number;
  category: string;
  brand: string;
  parentProduct: string;
  variantLabel: string;
  barcode: string;
  salePrice: number;
  costPrice: number;
  wholePrice: number;
  taxPercent: number;
  totalStock: number;
}

interface ExcelParent {
  parentId: string;
  name: string;
  category: string;
  brand: string;
  taxPercent: number;
  costPrice: number;
  salePrice: number;
  wholePrice: number;
  totalStock: number;
  variants: ExcelVariant[];
}

function parseCleanedExcel(filePath: string): { parents: Map<string, ExcelParent>; warnings: string[] } {
  const parents = new Map<string, ExcelParent>();
  const warnings: string[] = [];
  const fileName = filePath.split(/[\\/]/).pop() ?? filePath;

  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) { warnings.push(`${fileName}: no sheet found`); return { parents, warnings }; }

  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: "" });
  console.log(`  ${fileName}: ${rows.length} rows`);

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const rowNum = i + 2;

    const parentId = toText(r["Parent ID"]);
    const parentProduct = toText(r["Parent Product"]);
    const category = toText(r["Category"]);
    const brand = toText(r["Brand / Company"]);
    const barcode = toText(r["Barcode"]);

    if (!parentProduct) {
      warnings.push(`${fileName} row ${rowNum}: empty Parent Product — skipped`);
      continue;
    }
    if (!barcode) {
      warnings.push(`${fileName} row ${rowNum}: «${parentProduct}» has no barcode — skipped`);
      continue;
    }

    const salePrice = Math.max(0, toNum(r["Sale Price"]) ?? 0);
    const costPrice = Math.max(0, toNum(r["Cost Price"]) ?? 0);
    const wholePrice = Math.max(0, toNum(r["Whole Price"]) ?? 0);
    const taxPercent = Math.max(0, Math.min(100, toNum(r["Tax Percentage"]) ?? 16));

    // Parse stock from any column name that could carry it (defensive)
    const totalStock = Math.max(0,
      toNum(r["Total Stock"]) ??
      toNum(r["total_stock"]) ??
      toNum(r["Stock"]) ??
      toNum(r["stock"]) ??
      toNum(r["Qty"]) ??
      toNum(r["qty"]) ??
      toNum(r["Quantity"]) ??
      toNum(r["quantity"]) ??
      toNum(r["Current Stock"]) ??
      toNum(r["current_stock"]) ??
      0,
    );

    const variant: ExcelVariant = {
      erpVariantId: toText(r["ERP Variant ID"]),
      parentId,
      sourceRow: rowNum,
      category,
      brand,
      parentProduct,
      variantLabel: toText(r["Variant Label"]) || "قياسي",
      barcode,
      salePrice: round2(salePrice),
      costPrice: round2(costPrice),
      wholePrice: round2(wholePrice),
      taxPercent,
      totalStock,
    };

    let p = parents.get(parentId);
    if (!p) {
      p = {
        parentId,
        name: parentProduct,
        category,
        brand,
        taxPercent,
        costPrice,
        salePrice,
        wholePrice,
        totalStock: 0,
        variants: [],
      };
      parents.set(parentId, p);
    }

    // Merge prices: use the lowest cost, highest sale, highest whole across variants
    if (costPrice > 0 && (p.costPrice === 0 || costPrice < p.costPrice)) p.costPrice = costPrice;
    if (salePrice > 0 && salePrice > p.salePrice) p.salePrice = salePrice;
    if (wholePrice > 0 && wholePrice > p.wholePrice) p.wholePrice = wholePrice;
    // Aggregate stock across variants of the same parent
    p.totalStock = clampStock(p.totalStock + totalStock);

    p.variants.push(variant);
  }

  return { parents, warnings };
}

// ────────────────────────────────────────── Migration runner ───────────────

const BENIGN_DUPLICATE_CODES = new Set(["42P07", "42701", "42710", "42723", "42P04", "42P06"]);

async function applyMigrationToPg(connectionString: string, label: string): Promise<boolean> {
  const cleanUrl = connectionString.replace(/[?&]sslmode=[^&#]*/, "");
  const sslMode = (connectionString.match(/[?&]sslmode=([^&#]+)/) || [])[1];
  const client = new pg.Client({
    connectionString: cleanUrl,
    ssl: sslMode !== "disable" ? { rejectUnauthorized: false } : false,
  });

  await client.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);

    const { rows: applied } = await client.query("SELECT version FROM schema_migrations");
    const appliedSet = new Set(applied.map((r: { version: string }) => r.version));

    const migrationFile = "062_four_tier_architecture.sql";
    const migrationPath = join(MIGRATIONS_DIR, migrationFile);
    const version = migrationFile.replace(/\.sql$/, "");

    if (appliedSet.has(version)) {
      console.log(`  ✓ [${label}] Migration ${version} already applied`);
      return true;
    }

    if (!existsSync(migrationPath)) {
      console.error(`  ✗ Migration file not found: ${migrationPath}`);
      return false;
    }

    const sql = await readFile(migrationPath, "utf8");
    console.log(`  ▶ [${label}] Applying ${version} …`);

    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [version]);
      await client.query("COMMIT");
      console.log(`  ✓ [${label}] Migration ${version} applied successfully`);
      return true;
    } catch (err) {
      await client.query("ROLLBACK");
      const e = err as { code?: string; message?: string };
      if (e.code && BENIGN_DUPLICATE_CODES.has(e.code)) {
        await client.query("INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING", [version]);
        console.log(`  ✓ [${label}] Migration ${version} already present (tolerated: ${e.code})`);
        return true;
      }
      console.error(`  ✗ [${label}] Migration ${version} failed: ${e.message}`);
      return false;
    }
  } finally {
    await client.end();
  }
}

async function runMigration(env: Record<string, string>): Promise<void> {
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  STEP 1: Database Migration (062_four_tier)");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  const localUrl = env.DATABASE_URL;
  if (localUrl) {
    console.log("\n  → Local PostgreSQL:");
    await applyMigrationToPg(localUrl, "local");
  } else {
    console.warn("  ⚠ DATABASE_URL not found — skipping local migration");
  }

  const hostedUrl = env.SUPABASE_DB_URL;
  if (hostedUrl) {
    console.log("\n  → Hosted Supabase PostgreSQL:");
    await applyMigrationToPg(hostedUrl, "hosted");
  } else {
    console.log("\n  ⚠ SUPABASE_DB_URL not set — skipping hosted migration");
    console.log("    To apply on hosted, add to .env:");
    console.log('    SUPABASE_DB_URL="postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres"');
  }
}

// ────────────────────────────────────────── Store resolver ─────────────────

async function resolveStore(client: SupabaseClient, email: string): Promise<{ id: string; name: string }> {
  const found = new Map<string, string>();

  const byStore = await client.from("stores").select("id,name").ilike("email", email).limit(10);
  if (byStore.error) throw new Error(`reading stores: ${byStore.error.message}`);
  for (const s of byStore.data ?? []) if (s.id && !found.has(s.id)) found.set(s.id, s.name ?? "");

  const byCashier = await client
    .from("cashiers").select("store_id")
    .ilike("email", email).eq("role", "admin")
    .not("email", "is", null).limit(10);
  if (byCashier.error) throw new Error(`reading cashiers: ${byCashier.error.message}`);
  for (const c of byCashier.data ?? []) if (c.store_id && !found.has(c.store_id)) found.set(c.store_id, "");

  if (found.size === 0) {
    throw new Error(
      `No store found for email "${email}". Create the tenant first via /super-admin.`,
    );
  }
  if (found.size > 1) {
    console.warn(`  ⚠ ${found.size} stores found for "${email}" — using first`);
  }

  const id = found.keys().next().value as string;
  return { id, name: found.get(id) ?? "" };
}

// ────────────────────────────────────────── Import engine ──────────────────

interface Summary {
  categoriesCreated: number;
  brandsCreated: number;
  productsCreated: number;
  productsUpdated: number;
  variantsInserted: number;
  variantsSkipped: number;
  warningsCount: number;
}

async function importCatalog(
  client: SupabaseClient,
  storeId: string,
  allParents: Map<string, ExcelParent>,
  dryRun: boolean,
): Promise<Summary> {
  const summary: Summary = {
    categoriesCreated: 0,
    brandsCreated: 0,
    productsCreated: 0,
    productsUpdated: 0,
    variantsInserted: 0,
    variantsSkipped: 0,
    warningsCount: 0,
  };

  // ── Caches ──
  const categoryCache = new Map<string, string>();      // name -> id
  const brandCache = new Map<string, string>();          // lowercase(name) -> id
  const productByName = new Map<string, string>();       // name -> id
  const productRowCache = new Map<string, Record<string, unknown>>(); // id -> row
  const variantByBarcode = new Map<string, string>();    // barcode -> product_id

  // ── Paginated fetcher ──
  const fetchAll = async <T>(table: string, select: string, storeScope: "store" | "global"): Promise<T[]> => {
    const PAGE = 1000;
    const all: T[] = [];
    for (let from = 0; ; from += PAGE) {
      let q = client.from(table).select(select).range(from, from + PAGE - 1);
      if (storeScope === "store") q = q.eq("store_id", storeId);
      const { data, error } = await q;
      if (error) {
        // Gracefully handle missing table (postgrest error PGRST205 / 42P01)
        if (error.message?.includes("Could not find the table") || error.message?.includes("does not exist")) {
          console.warn(`    ⚠ Table "${table}" not found — treating as empty`);
          return [];
        }
        throw new Error(`reading ${table}: ${error.message}`);
      }
      const batch = (data ?? []) as T[];
      all.push(...batch);
      if (batch.length < PAGE) break;
    }
    return all;
  };

  // ── Load existing lookups ──
  console.log("  Loading existing data from database …");

  const cats = await fetchAll<{ id: string; name: string }>("categories", "id,name", "store");
  for (const c of cats) categoryCache.set(c.name.toLowerCase(), c.id);
  console.log(`    categories: ${cats.length}`);

  const brands = await fetchAll<{ id: string; name: string }>("product_brands", "id,name", "store");
  for (const b of brands) brandCache.set(b.name.toLowerCase(), b.id);
  console.log(`    brands: ${brands.length}`);

  const variants = await fetchAll<{ barcode: string; product_id: string }>(
    "product_variants", "barcode,product_id", "store",
  );
  for (const v of variants) variantByBarcode.set(v.barcode, v.product_id);
  console.log(`    variants: ${variants.length}`);

  // Try full 062 schema first; fall back to pre-062 columns if price columns missing
  let prods: Record<string, unknown>[] = [];
  try {
    prods = await fetchAll<Record<string, unknown>>(
      "products",
      "id,name,category_id,brand_id,cost_price,selling_price,wholesale_price," +
      "tax_percent,is_active,show_in_pos,is_sellable,is_purchasable," +
      "reorder_level,default_supplier_id,total_stock",
      "store",
    );
  } catch {
    console.log("    ⚠ Price columns not found — fetching base columns only (pre-062 schema)");
    prods = await fetchAll<Record<string, unknown>>(
      "products",
      "id,name,category_id,brand_id,tax_percent,is_active,show_in_pos," +
      "is_sellable,is_purchasable,reorder_level,default_supplier_id,total_stock",
      "store",
    );
  }
  for (const p of prods) {
    productByName.set(p.name as string, p.id as string);
    productRowCache.set(p.id as string, p);
  }
  console.log(`    products: ${prods.length}`);

  // Detect whether 062 price columns exist
  const hasPriceColumns = prods.length === 0 || "cost_price" in (prods[0] ?? {});
  if (!hasPriceColumns) console.log("    ⚠ Pre-062 schema detected — price columns will be set on INSERT only");

  // ── CRUD helpers ──

  const getOrCreateCategory = async (name: string): Promise<string | null> => {
    if (!name) return null;
    const key = name.toLowerCase();
    const cached = categoryCache.get(key);
    if (cached) return cached;
    if (dryRun) {
      const dryId = `dry-cat-${categoryCache.size}`;
      categoryCache.set(key, dryId);
      return dryId;
    }
    const { data, error } = await client
      .from("categories")
      .insert({ name, store_id: storeId })
      .select("id")
      .single();
    if (error) {
      const existing = await client
        .from("categories").select("id")
        .eq("name", name).eq("store_id", storeId)
        .limit(1);
      if (existing.error || !existing.data?.[0]) {
        throw new Error(`creating category "${name}": ${error.message}`);
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
        throw new Error(`creating brand "${name}": ${error.message}`);
      }
      brandCache.set(key, existing.data.id as string);
      return existing.data.id as string;
    }
    brandCache.set(key, data.id as string);
    summary.brandsCreated += 1;
    return data.id as string;
  };

  // ── Phase 1: Resolve tier 1 (categories) and tier 2 (brands) ──
  console.log("\n── Phase 1: Resolve categories & brands ──");

  interface ResolvedParent {
    excel: ExcelParent;
    categoryId: string | null;
    brandId: string | null;
  }

  const resolved: ResolvedParent[] = [];
  let idx = 0;
  for (const [parentId, excel] of allParents) {
    idx += 1;
    if (idx % 500 === 0) console.log(`  … ${idx}/${allParents.size}`);

    // Cross-tenant barcode guard
    const conflictingVariants = excel.variants.filter(
      (v) => variantByBarcode.has(v.barcode) && variantByBarcode.get(v.barcode) !== undefined,
    );
    if (conflictingVariants.length > 0) {
      const existingPid = conflictingVariants[0] ? variantByBarcode.get(conflictingVariants[0].barcode) : undefined;
      if (existingPid && existingPid !== "dry") {
        console.warn(`  ⚠ "${excel.name}": barcodes already exist in another product — variants may be skipped`);
      }
    }

    const categoryId = await getOrCreateCategory(excel.category);
    const brandId = await getOrCreateBrand(excel.brand);
    resolved.push({ excel, categoryId, brandId });
  }
  console.log(`  Resolved ${resolved.length} parent products`);

  // ── Phase 2: Upsert parent products (tier 3) ──
  console.log("\n── Phase 2: Upsert parent products ──");

  const toCreate: Array<{ name: string; payload: Record<string, unknown> }> = [];
  const toUpdate: Array<{ id: string; changes: Record<string, unknown> }> = [];

  for (const { excel, categoryId, brandId } of resolved) {
    const existingId = productByName.get(excel.name);

    const payload: Record<string, unknown> = {
      store_id: storeId,
      category_id: categoryId,
      brand_id: brandId,
      name: excel.name,
      base_unit: "حبة",
      total_stock: clampStock(excel.totalStock),
      is_quick_key: false,
      tax_percent: excel.taxPercent,
      tax_included: false,
      is_active: true,
      show_in_pos: true,
      is_sellable: true,
      is_purchasable: true,
      allow_price_change: false,
      reorder_level: 0,
    };

    // Only include price columns if they exist in the schema (post-062)
    if (hasPriceColumns) {
      payload.cost_price = excel.costPrice;
      payload.selling_price = excel.salePrice;
      payload.wholesale_price = excel.wholePrice;
    }

    if (existingId) {
      const existing = productRowCache.get(existingId);
      if (existing) {
        const priceCols = hasPriceColumns
          ? ["cost_price", "selling_price", "wholesale_price"]
          : [];
        const changes: Record<string, unknown> = {};
        for (const k of [
          "category_id", "brand_id", ...priceCols,
          "tax_percent", "is_active", "show_in_pos", "is_sellable", "is_purchasable",
          "reorder_level", "default_supplier_id",
        ]) {
          const oldVal = existing[k] ?? null;
          const newVal = payload[k] ?? null;
          if (oldVal !== newVal) changes[k] = newVal;
        }
        if (Object.keys(changes).length > 0) toUpdate.push({ id: existingId, changes });
      }
      continue;
    }
    toCreate.push({ name: excel.name, payload });
  }

  // Batch create
  const PRODUCT_CHUNK = 200;
  for (let s = 0; s < toCreate.length; s += PRODUCT_CHUNK) {
    const chunk = toCreate.slice(s, s + PRODUCT_CHUNK);
    if (dryRun) {
      for (const pp of chunk) {
        productByName.set(pp.name, `dry-prod-${productByName.size}`);
        summary.productsCreated += 1;
      }
    } else {
      const { data, error } = await client
        .from("products")
        .insert(chunk.map((p) => p.payload))
        .select("id,name");
      if (error) throw new Error(`batch insert products: ${error.message}`);
      for (const r of data ?? []) productByName.set(r.name as string, r.id as string);
      summary.productsCreated += chunk.length;
    }
    if (toCreate.length > PRODUCT_CHUNK) {
      console.log(`  … products ${s + 1}-${Math.min(s + PRODUCT_CHUNK, toCreate.length)}/${toCreate.length}`);
    }
  }

  // Apply updates
  for (const { id, changes } of toUpdate) {
    if (!dryRun) {
      const { error } = await client.from("products").update(changes).eq("id", id).eq("store_id", storeId);
      if (error) throw new Error(`update product ${id}: ${error.message}`);
    }
    summary.productsUpdated += 1;
  }
  if (toUpdate.length > 0) console.log(`  Updated ${toUpdate.length} existing products`);

  // ── Phase 3: Insert variants (tier 4) ──
  console.log("\n── Phase 3: Insert product variants ──");

  interface VariantRow {
    product_id: string;
    store_id: string;
    barcode: string;
    variant_label: string;
    total_stock: number;
    is_active: boolean;
  }

  const variantRows: VariantRow[] = [];

  for (const { excel } of resolved) {
    const productId = productByName.get(excel.name);
    if (!productId) continue;

    const bcCount = excel.variants.length;
    const usedLabels = new Set<string>();

    for (let vi = 0; vi < bcCount; vi += 1) {
      const v = excel.variants[vi];
      if (!v) continue;

      if (variantByBarcode.has(v.barcode)) {
        summary.variantsSkipped += 1;
        continue;
      }

      // Use the Excel variant label, fall back to auto-numbering
      let label = v.variantLabel || "قياسي";

      // Ensure uniqueness per product
      let candidate = label;
      let suffix = 2;
      while (usedLabels.has(candidate.toLowerCase())) {
        candidate = `${label} (${suffix})`;
        suffix += 1;
      }
      label = candidate;
      usedLabels.add(label.toLowerCase());

      variantRows.push({
        product_id: productId,
        store_id: storeId,
        barcode: v.barcode,
        variant_label: label,
        total_stock: clampStock(v.totalStock),
        is_active: true,
      });
    }
  }

  // Batch insert variants
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
      if (error) {
        // Fallback to row-by-row for conflicts
        let inserted = 0;
        for (const row of chunk) {
          const { error: rowErr } = await client
            .from("product_variants")
            .insert(row)
            .select("id")
            .limit(1);
          if (rowErr) summary.variantsSkipped += 1;
          else inserted += 1;
        }
        summary.variantsInserted += inserted;
      } else {
        summary.variantsInserted += chunk.length;
      }
    }
  }

  // ── Phase 4: Sync parent total_stock from variants ──
  console.log("\n── Phase 4: Sync parent stock aggregates ──");
  if (dryRun) {
    console.log("  (dry-run — skipped)");
  } else {
    // Trigger trg_pv_stock_sync handles this on INSERT, but we do a
    // catch-up for any products that were updated (not just inserted).
    const { error } = await client.rpc("fn_sync_parent_stock" as never);
    // RPC may not exist as a direct call — fall back to manual sync
    if (error) {
      console.log("  Using manual stock sync …");
      // Fetch all products with variants, compute sum
      const allProds = await fetchAll<{ id: string }>("products", "id", "store");
      for (const p of allProds) {
        const { data: vars } = await client
          .from("product_variants")
          .select("total_stock")
          .eq("product_id", p.id)
          .eq("store_id", storeId)
          .eq("is_active", true);
        const totalStock = clampStock((vars ?? []).reduce((sum: number, v: { total_stock: number }) => sum + (v.total_stock ?? 0), 0));
        if (!dryRun) {
          await client.from("products").update({ total_stock: totalStock }).eq("id", p.id).eq("store_id", storeId);
        }
      }
    }
    console.log("  ✓ Stock aggregates synced");
  }

  return summary;
}

// ────────────────────────────────────────── Local PG ingest (optional) ────

async function ingestToLocalPG(
  env: Record<string, string>,
  allParents: Map<string, ExcelParent>,
  dryRun: boolean,
): Promise<void> {
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  LOCAL PG: Direct SQL ingest (optional)");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  const url = env.DATABASE_URL;
  if (!url) {
    console.log("  ✗ DATABASE_URL not found — skipping");
    return;
  }

  const cleanUrl = url.replace(/[?&]sslmode=[^&#]*/, "");
  const sslMode = (url.match(/[?&]sslmode=([^&#]+)/) || [])[1];
  const client = new pg.Client({
    connectionString: cleanUrl,
    ssl: sslMode !== "disable" ? { rejectUnauthorized: false } : false,
  });

  await client.connect();
  try {
    // Get the store_id from local DB
    const { rows: stores } = await client.query("SELECT id, name FROM stores LIMIT 1");
    if (stores.length === 0) {
      console.log("  ✗ No stores in local DB — skipping local ingest");
      return;
    }
    const storeId = stores[0].id as string;
    console.log(`  Store: ${stores[0].name} (${storeId})`);

    // Tier 1: Categories
    console.log("  Tier 1: Categories …");
    const categoryMap = new Map<string, string>();
    const uniqueCategories = new Set<string>();
    for (const [, p] of allParents) if (p.category) uniqueCategories.add(p.category);

    for (const catName of uniqueCategories) {
      const { rows } = await client.query(
        "SELECT id FROM categories WHERE name = $1 AND store_id = $2 LIMIT 1",
        [catName, storeId],
      );
      if (rows.length > 0) {
        categoryMap.set(catName, rows[0].id as string);
      } else if (!dryRun) {
        const { rows: ins } = await client.query(
          "INSERT INTO categories (id, store_id, name) VALUES (gen_random_uuid(), $1, $2) RETURNING id",
          [storeId, catName],
        );
        categoryMap.set(catName, ins[0].id as string);
      }
    }
    console.log(`    ${categoryMap.size} categories`);

    // Tier 2: Brands
    console.log("  Tier 2: Brands …");
    const brandMap = new Map<string, string>();
    const uniqueBrands = new Set<string>();
    for (const [, p] of allParents) if (p.brand) uniqueBrands.add(p.brand);

    for (const brandName of uniqueBrands) {
      const { rows } = await client.query(
        "SELECT id FROM product_brands WHERE LOWER(name) = LOWER($1) AND store_id = $2 LIMIT 1",
        [brandName, storeId],
      );
      if (rows.length > 0) {
        brandMap.set(brandName.toLowerCase(), rows[0].id as string);
      } else if (!dryRun) {
        const { rows: ins } = await client.query(
          "INSERT INTO product_brands (id, store_id, name) VALUES (gen_random_uuid(), $1, $2) RETURNING id",
          [storeId, brandName],
        );
        brandMap.set(brandName.toLowerCase(), ins[0].id as string);
      }
    }
    console.log(`    ${brandMap.size} brands`);

    // Tier 3: Products
    console.log("  Tier 3: Products …");
    const productMap = new Map<string, string>();
    let created = 0;
    let updated = 0;

    for (const [, p] of allParents) {
      const catId = categoryMap.get(p.category) ?? null;
      const brId = brandMap.get(p.brand.toLowerCase()) ?? null;

      const { rows: existing } = await client.query(
        "SELECT id FROM products WHERE name = $1 AND store_id = $2 LIMIT 1",
        [p.name, storeId],
      );

      if (existing.length > 0) {
        productMap.set(p.name, existing[0].id as string);
        if (!dryRun) {
          const { error } = await client.query(
            `UPDATE products SET category_id = $1, brand_id = $2, cost_price = $3,
             selling_price = $4, wholesale_price = $5, tax_percent = $6,
             total_stock = $7
             WHERE id = $8 AND store_id = $9`,
            [catId, brId, Math.max(0, p.costPrice), Math.max(0, p.salePrice), Math.max(0, p.wholePrice), p.taxPercent, clampStock(p.totalStock), existing[0].id, storeId],
          );
          if (error) console.warn(`    update "${p.name}": ${error.message}`);
          else updated += 1;
        }
        continue;
      }

      if (!dryRun) {
        const { rows: ins, error } = await client.query(
          `INSERT INTO products (id, store_id, category_id, brand_id, name, base_unit,
           total_stock, is_quick_key, cost_price, selling_price, wholesale_price,
           tax_percent, tax_included, is_active, show_in_pos, is_sellable, is_purchasable,
           allow_price_change, reorder_level)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, 'حبة', $5, false, $6, $7, $8, $9,
           false, true, true, true, true, false, 0)
           RETURNING id`,
          [storeId, catId, brId, p.name, clampStock(p.totalStock), p.costPrice, p.salePrice, p.wholePrice, p.taxPercent],
        );
        if (error) { console.warn(`    insert "${p.name}": ${error.message}`); continue; }
        productMap.set(p.name, ins[0].id as string);
        created += 1;
      }
    }
    console.log(`    created: ${created}, updated: ${updated}`);

    // Tier 4: Variants
    console.log("  Tier 4: Variants …");
    let vInserted = 0;
    let vSkipped = 0;

    for (const [, p] of allParents) {
      const pid = productMap.get(p.name);
      if (!pid) continue;

      const usedLabels = new Set<string>();
      for (const v of p.variants) {
        const { rows: existingV } = await client.query(
          "SELECT product_id FROM product_variants WHERE barcode = $1 AND store_id = $2 LIMIT 1",
          [v.barcode, storeId],
        );
        if (existingV.length > 0) { vSkipped += 1; continue; }

        let label = v.variantLabel || "قياسي";
        let candidate = label;
        let suffix = 2;
        while (usedLabels.has(candidate.toLowerCase())) {
          candidate = `${label} (${suffix})`;
          suffix += 1;
        }
        label = candidate;
        usedLabels.add(label.toLowerCase());

        if (!dryRun) {
          const { error } = await client.query(
            `INSERT INTO product_variants (id, product_id, store_id, barcode, variant_label, total_stock, is_active)
             VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, true)`,
            [pid, storeId, v.barcode, label, clampStock(v.totalStock)],
          );
          if (error) {
            if (error.code === "23505") vSkipped += 1;
            else console.warn(`    variant "${v.barcode}": ${error.message}`);
            continue;
          }
        }
        vInserted += 1;
      }
    }
    console.log(`    inserted: ${vInserted}, skipped: ${vSkipped}`);

    // Sync stock
    console.log("  Syncing parent stock …");
    if (!dryRun) {
      const { rows: allProds } = await client.query(
        "SELECT id FROM products WHERE store_id = $1", [storeId],
      );
      for (const p of allProds) {
        await client.query(
          `UPDATE products SET total_stock = GREATEST(0, COALESCE((
            SELECT SUM(total_stock) FROM product_variants
            WHERE product_id = $1 AND is_active
          ), 0)) WHERE id = $1`,
          [p.id],
        );
      }
    }
    console.log("  ✓ Local ingest complete");
  } finally {
    await client.end();
  }
}

// ────────────────────────────────────────── Main ───────────────────────────

async function main(): Promise<void> {
  const env = loadEnv();
  const args = parseArgs();

  const hostedDb = env.SUPABASE_DB_URL ? "yes (connected)" : "no — set SUPABASE_DB_URL";

  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║         PHASE 5 DEPLOY — 4-Tier Architecture             ║");
  console.log("╠════════════════════════════════════════════════════════════╣");
  console.log(`║  Excel files:  ${String(args.files.length).padEnd(40)}║`);
  console.log(`║  Tenant email: ${args.email.padEnd(40)}║`);
  console.log(`║  Local PG:     ${(args.skipMigration ? "skipped" : "apply migration").padEnd(40)}║`);
  console.log(`║  Hosted DB:    ${hostedDb.padEnd(40)}║`);
  console.log(`║  Dry-run:      ${(args.dryRun ? "yes" : "no").padEnd(40)}║`);
  console.log(`║  Ingest mode:  ${(args.localOnly ? "local PG direct" : "Supabase JS client").padEnd(40)}║`);
  console.log("╚════════════════════════════════════════════════════════════╝");

  // Validate files
  for (const file of args.files) {
    if (!existsSync(file)) {
      console.error(`\n✗ File not found: ${file}`);
      process.exit(1);
    }
  }
  if (args.files.length === 0) {
    console.error("\n✗ No Excel files found. Place Global_Products_Cleaned.xlsx and/or Local_Products_Cleaned.xlsx in project root.");
    process.exit(1);
  }

  // ── Step 1: Migration ──
  if (!args.skipMigration) {
    await runMigration(env);
  } else {
    console.log("\n  (--skip-migration — skipping DB migration)");
  }

  // ── Step 2: Parse Excel ──
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  STEP 2: Parse Excel Files");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  const allParents = new Map<string, ExcelParent>();
  const allWarnings: string[] = [];

  for (const file of args.files) {
    console.log(`\n  Reading ${file} …`);
    const { parents, warnings } = parseCleanedExcel(file);
    allWarnings.push(...warnings);

    // Merge: if a parentId exists in both files, merge variants
    for (const [pid, p] of parents) {
      const existing = allParents.get(pid);
      if (existing) {
        // Merge variants from the second file
        for (const v of p.variants) {
          const dupBarcode = existing.variants.some((ev) => ev.barcode === v.barcode);
          if (!dupBarcode) existing.variants.push(v);
        }
        // Update prices if second file has better data
        if (p.costPrice > 0 && (existing.costPrice === 0 || p.costPrice < existing.costPrice)) existing.costPrice = p.costPrice;
        if (p.salePrice > 0 && p.salePrice > existing.salePrice) existing.salePrice = p.salePrice;
      } else {
        allParents.set(pid, p);
      }
    }
  }

  // Print warnings
  for (const w of allWarnings) console.warn(`  ⚠ ${w}`);

  const totalVariants = [...allParents.values()].reduce((sum, p) => sum + p.variants.length, 0);
  console.log(`\n  ──────────────────────────────────`);
  console.log(`  Total parent products: ${allParents.size}`);
  console.log(`  Total variant rows:    ${totalVariants}`);
  console.log(`  Warnings:              ${allWarnings.length}`);
  console.log(`  ──────────────────────────────────`);

  if (allParents.size === 0) {
    console.error("\n✗ No valid data found in Excel files.");
    process.exit(1);
  }

  // ── Step 2.5: Pre-flight sanitization ──
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  STEP 2.5: Pre-flight Sanitization");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  const sanitizeResult = sanitizeInventory(allParents);
  const totalVariantsPost = [...allParents.values()].reduce((sum, p) => sum + p.variants.length, 0);

  // Verify: zero negative stock values remain
  let negativeCheck = 0;
  for (const [, p] of allParents) {
    if (p.totalStock < 0) negativeCheck += 1;
    for (const v of p.variants) {
      if (v.totalStock < 0) negativeCheck += 1;
      if (v.salePrice < 0) negativeCheck += 1;
      if (v.costPrice < 0) negativeCheck += 1;
    }
  }

  console.log(`  Parents scanned:   ${allParents.size}`);
  console.log(`  Variants scanned:  ${totalVariantsPost}`);
  console.log(`  Values corrected:  ${sanitizeResult.fixed}`);
  console.log(`  Negative residue:  ${negativeCheck} ${negativeCheck === 0 ? "✓" : "✗ STILL NEGATIVE"}`);

  if (negativeCheck > 0) {
    console.error("\n✗ Sanitization failed — negative values still present. Aborting.");
    process.exit(1);
  }
  console.log("  ✓ All stock and price values are non-negative\n");

  // ── Step 3: Ingest ──
  if (args.localOnly) {
    await ingestToLocalPG(env, allParents, args.dryRun);
  } else {
    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("  STEP 3: Ingest into Supabase (hosted)");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    const url = env.NEXT_PUBLIC_SUPABASE_URL ?? "";
    const key = env.SUPABASE_SERVICE_ROLE_KEY ?? env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
    if (!url || !key) {
      console.error("\n✗ Supabase credentials not found in .env");
      process.exit(1);
    }

    const client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });

    const tenantEmail = args.email.trim().toLowerCase();
    console.log(`\n  Resolving store for "${tenantEmail}" …`);
    const store = await resolveStore(client, tenantEmail);
    console.log(`  ✓ Store: ${store.name || store.id} (${store.id})`);

    // Pre-flight: check product_variants table exists
    if (!args.dryRun) {
      const { error: pvCheck } = await client.from("product_variants").select("id").limit(1);
      if (pvCheck?.message?.includes("Could not find the table")) {
        console.error("\n  ✗ Table 'product_variants' does not exist on hosted Supabase.");
        console.error("    Migration 062 must be applied first.\n");
        console.error("    Option A — Add SUPABASE_DB_URL to .env and re-run:");
        console.error('      SUPABASE_DB_URL="postgresql://postgres.avjtopmuexiderzgnmdz:[YOUR-DB-PASSWORD]@aws-0-[REGION].pooler.supabase.com:6543/postgres"');
        console.error("      (Find password: Supabase Dashboard → Settings → Database → Connection string)");
        console.error("\n    Option B — Run the migration SQL manually:");
        console.error("      1. Open Supabase Dashboard → SQL Editor");
        console.error("      2. Paste contents of db/migrations/062_four_tier_architecture.sql");
        console.error("      3. Click 'Run'\n");
        console.error("    Then re-run this script with --skip-migration.\n");
        process.exit(1);
      }
    }

    if (args.dryRun) {
      console.log("\n  [DRY-RUN] No data will be written.\n");
    }

    const summary = await importCatalog(client, store.id, allParents, args.dryRun);

    console.log("\n══════════════════════════════════════════════════════════");
    console.log("  PHASE 5 DEPLOY SUMMARY");
    console.log("══════════════════════════════════════════════════════════");
    console.log(`  Categories created:    ${summary.categoriesCreated}`);
    console.log(`  Brands created:        ${summary.brandsCreated}`);
    console.log(`  Products created:      ${summary.productsCreated}`);
    console.log(`  Products updated:      ${summary.productsUpdated}`);
    console.log(`  Variants inserted:     ${summary.variantsInserted}`);
    console.log(`  Variants skipped:      ${summary.variantsSkipped}`);
    console.log("══════════════════════════════════════════════════════════");
    console.log(args.dryRun
      ? "\n  (DRY-RUN — nothing was written)"
      : "\n  ✓ Phase 5 deployment complete.",
    );
  }
}

main().catch((err) => {
  console.error("\n✗ Phase 5 deploy failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
