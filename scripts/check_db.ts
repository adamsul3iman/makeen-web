#!/usr/bin/env npx tsx
/**
 * scripts/check_db.ts
 *
 * Post-deployment verification: checks products, product_variants,
 * and FK/stock integrity for "مؤسسة البرج".
 *
 * Usage:
 *   npx tsx scripts/check_db.ts
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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

const env = loadEnv();
const url = env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const key = env.SUPABASE_SERVICE_ROLE_KEY ?? env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
if (!url || !key) {
  console.error("✗ Supabase credentials not found in .env");
  process.exit(1);
}

const client = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function fetchCount(table: string, filter?: { column: string; value: unknown }): Promise<number> {
  let q = client.from(table).select("id", { count: "exact", head: true });
  if (filter) q = q.eq(filter.column, filter.value);
  const { count, error } = await q;
  if (error) throw new Error(`count ${table}: ${error.message}`);
  return count ?? 0;
}

async function main() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║         POST-DEPLOYMENT DB CHECK                       ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  // ── Resolve store ──
  const { data: store, error: storeErr } = await client
    .from("stores").select("id,name").ilike("email", "alburjhom3@gmail.com").limit(1).single();
  if (storeErr || !store) {
    console.error("✗ Could not find store for alburjhom3@gmail.com:", storeErr?.message);
    process.exit(1);
  }
  console.log(`  Store: ${store.name} (${store.id})\n`);

  // ── 1. Products count ──
  const productTotal = await fetchCount("products");
  const productScoped = await fetchCount("products", { column: "store_id", value: store.id });
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  1. Products");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`  Total (all stores):   ${productTotal}`);
  console.log(`  This store:           ${productScoped}`);

  // ── 2. Product variants count ──
  const variantTotal = await fetchCount("product_variants");
  const variantScoped = await fetchCount("product_variants", { column: "store_id", value: store.id });
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  2. Product Variants");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`  Total (all stores):   ${variantTotal}`);
  console.log(`  This store:           ${variantScoped}`);

  // ── 3. FK + stock integrity ──
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  3. FK & Stock Integrity (this store)");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  // Fetch all variants for this store with their parent product info
  const PAGE = 1000;
  const allVariants: Array<{
    id: string; barcode: string; variant_label: string;
    total_stock: number; product_id: string;
  }> = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await client
      .from("product_variants")
      .select("id, barcode, variant_label, total_stock, product_id")
      .eq("store_id", store.id)
      .range(from, from + PAGE - 1);
    if (error) { console.error(`  ✗ Fetching variants: ${error.message}`); break; }
    allVariants.push(...(data ?? []));
    if ((data ?? []).length < PAGE) break;
  }

  // Fetch all products for this store
  const allProducts: Array<{
    id: string; name: string; total_stock: number;
  }> = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await client
      .from("products")
      .select("id, name, total_stock")
      .eq("store_id", store.id)
      .range(from, from + PAGE - 1);
    if (error) { console.error(`  ✗ Fetching products: ${error.message}`); break; }
    allProducts.push(...(data ?? []));
    if ((data ?? []).length < PAGE) break;
  }

  const productMap = new Map(allProducts.map((p) => [p.id, p]));
  const variantByProduct = new Map<string, typeof allVariants>();
  for (const v of allVariants) {
    const list = variantByProduct.get(v.product_id) ?? [];
    list.push(v);
    variantByProduct.set(v.product_id, list);
  }

  let orphanVariants = 0;
  let negativeStockVariants = 0;
  let negativeStockProducts = 0;
  let stockMismatch = 0;
  let zeroVariantProducts = 0;

  // Check every variant has a valid parent
  for (const v of allVariants) {
    if (!productMap.has(v.product_id)) orphanVariants += 1;
    if (v.total_stock < 0) negativeStockVariants += 1;
  }

  // Check parent stock matches sum of active variant stocks
  for (const p of allProducts) {
    if (p.total_stock < 0) negativeStockProducts += 1;
    const variants = variantByProduct.get(p.id) ?? [];
    if (variants.length === 0) {
      zeroVariantProducts += 1;
      continue;
    }
    const computedStock = variants.reduce((sum, v) => sum + (v.total_stock ?? 0), 0);
    if (Math.abs(computedStock - p.total_stock) > 0.001) stockMismatch += 1;
  }

  const productsWithVariants = allProducts.length - zeroVariantProducts;

  console.log(`  Products:                      ${allProducts.length}`);
  console.log(`  Variants:                      ${allVariants.length}`);
  console.log(`  Products with variants:        ${productsWithVariants}`);
  console.log(`  Products without variants:     ${zeroVariantProducts}`);
  console.log(`  Orphaned variants (no parent): ${orphanVariants}  ${orphanVariants === 0 ? "✓" : "✗"}`);
  console.log(`  Negative stock (variants):     ${negativeStockVariants}  ${negativeStockVariants === 0 ? "✓" : "✗"}`);
  console.log(`  Negative stock (products):     ${negativeStockProducts}  ${negativeStockProducts === 0 ? "✓" : "✗"}`);
  console.log(`  Parent/variant stock mismatch: ${stockMismatch}  ${stockMismatch === 0 ? "✓" : "✗"}`);

  // ── Summary ──
  const failures = orphanVariants + negativeStockVariants + negativeStockProducts + stockMismatch;
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  if (failures === 0) {
    console.log("  ✓ ALL CHECKS PASSED — data is clean.");
  } else {
    console.log(`  ✗ ${failures} integrity issue(s) found.`);
  }
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  process.exitCode = failures > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error("\n✗ Check failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
