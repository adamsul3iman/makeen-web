/**
 * scripts/verify_legacy_catalog.mjs
 *
 * Verify a legacy catalog migration for one tenant: report current row counts
 * for categories / product_brands / suppliers / products / product_barcodes
 * and a hierarchy sample. Run BEFORE and AFTER the migration and diff the
 * counts to get the exact insertion numbers.
 *
 * Usage:
 *   node scripts/verify_legacy_catalog.mjs [email] [--since-minutes N]
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_TENANT_EMAIL = "alburjhom3@gmail.com";

const envPath = resolve(ROOT, ".env");
if (existsSync(envPath)) {
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

const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const email = (positional[0] ?? process.env.TENANT_EMAIL ?? DEFAULT_TENANT_EMAIL).trim().toLowerCase();
const sinceMin = process.argv.includes("--since-minutes") ? Number(process.argv[process.argv.indexOf("--since-minutes") + 1]) : 0;

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
if (!url || !key) {
  console.error("Supabase keys missing from .env");
  process.exit(1);
}
const client = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

// resolve store
const found = new Map();
const byStore = await client.from("stores").select("id,name").ilike("email", email).limit(10);
if (byStore.error) throw new Error(`stores: ${byStore.error.message}`);
for (const s of byStore.data ?? []) if (s.id) found.set(s.id, s.name ?? "");
const byCashier = await client.from("cashiers").select("store_id").ilike("email", email).eq("role", "admin").limit(10);
if (byCashier.error) throw new Error(`cashiers: ${byCashier.error.message}`);
for (const c of byCashier.data ?? []) if (c.store_id) found.set(c.store_id, "");
if (found.size === 0) {
  console.error(`No store found for ${email}`);
  process.exit(1);
}
const storeId = found.keys().next().value;
const storeName = found.get(storeId) ?? "";
console.log(`store: ${storeName} (${storeId})  email: ${email}`);
console.log(`since window: ${sinceMin > 0 ? `last ${sinceMin} minutes` : "all time"}\n`);

const count = async (table, extra = {}) => {
  const idCol = table === "product_barcodes" ? "barcode" : "id";
  let q = client.from(table).select(idCol, { count: "exact", head: true }).eq("store_id", storeId);
  for (const [col, val] of Object.entries(extra)) q = q.eq(col, val);
  const { count: c, error } = await q;
  if (error) throw new Error(`${table}: ${error.message}`);
  return c ?? 0;
};

const categories = await client.from("categories").select("id,name,parent_id").eq("store_id", storeId);
if (categories.error) throw new Error(`categories: ${categories.error.message}`);
const cats = categories.data ?? [];
const mainCount = cats.filter((c) => c.parent_id == null).length;
const subCount = cats.length - mainCount;

const sinceFilter = sinceMin > 0 ? `created_at >= now() - interval '${sinceMin} minutes'` : null;

const counts = {
  categories: cats.length,
  categoriesMain: mainCount,
  categoriesSub: subCount,
  product_brands: await count("product_brands"),
  suppliers: await count("suppliers"),
  products: await count("products"),
  product_barcodes: await count("product_barcodes"),
};

const windowed = {};
if (sinceFilter) {
  for (const table of ["products", "product_brands", "suppliers"]) {
    const { count: c, error } = await client
      .from(table)
      .select("id", { count: "exact", head: true })
      .eq("store_id", storeId)
      .gte("created_at", new Date(Date.now() - sinceMin * 60_000).toISOString());
    if (error) throw new Error(`${table} window: ${error.message}`);
    windowed[table] = c ?? 0;
  }
}

console.log("=== COUNTS ===");
for (const [k, v] of Object.entries(counts)) console.log(`${k}: ${v}`);
if (sinceFilter) {
  console.log("\n=== WINDOW (since minutes) ===");
  for (const [k, v] of Object.entries(windowed)) console.log(`${k}: ${v}`);
}

// hierarchy sample
console.log("\n=== HIERARCHY SAMPLE (main -> sub: brand count, product count) ===");
const brands = await client.from("product_brands").select("id").eq("store_id", storeId);
const products = await client.from("products").select("id,category_id,brand_id,name").eq("store_id", storeId);
if (brands.error || products.error) throw new Error("sample query failed");
const brandCountByProduct = new Map();
for (const p of products.data ?? []) {
  if (p.brand_id) brandCountByProduct.set(p.brand_id, (brandCountByProduct.get(p.brand_id) ?? 0) + 1);
}
const productsByCategory = new Map();
for (const p of products.data ?? []) {
  if (p.category_id) productsByCategory.set(p.category_id, (productsByCategory.get(p.category_id) ?? 0) + 1);
}
const subsByMain = new Map();
for (const c of cats) {
  if (c.parent_id) {
    if (!subsByMain.has(c.parent_id)) subsByMain.set(c.parent_id, []);
    subsByMain.get(c.parent_id).push(c);
  }
}
let sample = 0;
for (const main of cats.filter((c) => c.parent_id == null)) {
  if (sample >= 6) break;
  sample += 1;
  const subs = subsByMain.get(main.id) ?? [];
  const mainProducts = productsByCategory.get(main.id) ?? 0;
  console.log(`${main.name}  [products: ${mainProducts}]`);
  for (const sub of subs.slice(0, 3)) {
    console.log(`  └ ${sub.name}  [products: ${productsByCategory.get(sub.id) ?? 0}]`);
  }
  if (subs.length > 3) console.log(`  … and ${subs.length - 3} more sub-categories`);
}

// sample product with barcodes
const sampleProduct = (products.data ?? []).find((p) => p.category_id != null);
if (sampleProduct) {
  const bcs = await client.from("product_barcodes").select("barcode,unit_name,multiplier,cost_price,selling_price,is_default_sale,is_default_purchase").eq("store_id", storeId).eq("product_id", sampleProduct.id);
  const catName = cats.find((c) => c.id === sampleProduct.category_id)?.name ?? "";
  console.log(`\n=== SAMPLE PRODUCT ===`);
  console.log(`${sampleProduct.name}  (category: ${catName})`);
  for (const b of bcs.data ?? []) {
    console.log(
      `  ${b.barcode}  ${b.unit_name} x${b.multiplier}  cost ${b.cost_price}  sale ${b.selling_price}` +
        (b.is_default_sale ? "  [sale-default]" : "") +
        (b.is_default_purchase ? "  [purchase-default]" : ""),
    );
  }
}
