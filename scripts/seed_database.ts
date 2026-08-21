/**
 * scripts/seed_database.ts
 *
 * Seeds the Supabase database from Makeen_Import_Ready.json using the
 * 4-Tier architecture (Category > Product > Variant/SKU).
 *
 * Usage:
 *   npx tsx scripts/seed_database.ts [--email EMAIL] [--dry-run]
 *
 * Examples:
 *   npx tsx scripts/seed_database.ts --email alburj@makeen.com
 *   npx tsx scripts/seed_database.ts --email alburj@makeen.com --dry-run
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_TENANT_EMAIL = "alburj@makeen.com";
const INPUT_FILE = resolve(ROOT, "Makeen_Import_Ready.json");
const PRODUCT_CHUNK = 200;
const VARIANT_CHUNK = 500;
const STOCK_CHUNK = 200;

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

// ────────────────────────────────────────────────────── CLI args
function parseArgs(): { email: string; dryRun: boolean } {
  const args = process.argv.slice(2);
  let email = DEFAULT_TENANT_EMAIL;
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--email" && args[i + 1]) email = args[++i]!;
    if (args[i] === "--dry-run") dryRun = true;
  }
  return { email, dryRun };
}

// ────────────────────────────────────────────────────── JSON shape
interface ImportRow {
  name: string;
  barcode: string;
  sale_price: number;
  cost_price: number;
  category: string;
  stock: number;
}

interface ProductGroup {
  name: string;
  category: string;
  salePrice: number;
  costPrice: number;
  barcodes: Array<{ barcode: string; stock: number }>;
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

// ────────────────────────────────────────────────────── group products
function groupProducts(rows: ImportRow[]): ProductGroup[] {
  const map = new Map<string, ProductGroup>();
  for (const row of rows) {
    let group = map.get(row.name);
    if (!group) {
      group = {
        name: row.name,
        category: row.category || "عام",
        salePrice: row.sale_price,
        costPrice: row.cost_price,
        barcodes: [],
      };
      map.set(row.name, group);
    }
    group.barcodes.push({ barcode: row.barcode, stock: row.stock });
  }
  return Array.from(map.values());
}

// ────────────────────────────────────────────────────── category resolver
async function getOrCreateCategory(
  client: SupabaseClient,
  storeId: string,
  name: string,
  cache: Map<string, string>,
): Promise<string | null> {
  if (!name) return null;
  const key = name.toLowerCase();
  const cached = cache.get(key);
  if (cached) return cached;

  // Try insert
  const { data, error } = await client
    .from("categories")
    .insert({ name, store_id: storeId })
    .select("id")
    .single();

  if (error) {
    // Already exists — fetch
    const existing = await client
      .from("categories")
      .select("id")
      .eq("name", name)
      .eq("store_id", storeId)
      .limit(1);
    if (existing.error || !existing.data?.[0]) {
      throw new Error(`إنشاء التصنيف «${name}»: ${error.message}`);
    }
    cache.set(key, existing.data[0].id as string);
    return existing.data[0].id as string;
  }

  cache.set(key, data.id as string);
  return data.id as string;
}

// ────────────────────────────────────────────────────── main
async function main(): Promise<void> {
  loadEnv();
  const { email, dryRun } = parseArgs();

  console.log("═".repeat(60));
  console.log("🌱 بدء تغذية قاعدة البيانات");
  console.log("═".repeat(60));
  console.log(`📧 البريد: ${email}`);
  console.log(`📋 الملف:  ${INPUT_FILE}`);
  console.log(`🔧 الوضع: ${dryRun ? "محاكاة (dry-run)" : "تطبيق حقيقي"}`);
  console.log("─".repeat(60));

  // 1. Load JSON
  if (!existsSync(INPUT_FILE)) {
    console.error("❌ Makeen_Import_Ready.json غير موجود. شغّل import_products.ts أولاً.");
    process.exit(1);
  }
  const rawRows: ImportRow[] = JSON.parse(readFileSync(INPUT_FILE, "utf-8"));
  console.log(`📦 تم تحميل ${rawRows.length} صف من JSON`);

  // 2. Group by product name
  const products = groupProducts(rawRows);
  const uniqueBarcodes = new Set(rawRows.map((r) => r.barcode));
  const categories = [...new Set(rawRows.map((r) => r.category || "عام"))];
  console.log(`🏷️  منتجات فريدة: ${products.length}`);
  console.log(`📊 باركودات فريدة: ${uniqueBarcodes.size}`);
  console.log(`📁 تصنيفات: ${categories.join("، ")}`);
  console.log("─".repeat(60));

  // 3. Connect to Supabase
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    console.error("❌ متغيرات Supabase غير موجودة في .env");
    process.exit(1);
  }
  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  // 4. Resolve store
  const store = await resolveStore(supabase, email);
  console.log(`🏪 المتجر: ${store.name} (${store.id})`);
  console.log("─".repeat(60));

  if (dryRun) {
    console.log("🔍 محاكاة — لن يتم إدراج أي بيانات");
    console.log(`  سيتم إنشاء ${categories.length} تصنيف`);
    console.log(`  سيتم إنشاء ${products.length} منتج`);
    console.log(`  سيتم إنشاء ${uniqueBarcodes.size} متغير (باركود)`);
    console.log("═".repeat(60));
    return;
  }

  // 5. Create categories
  console.log("\n── المرحلة 1: إنشاء التصنيفات ──");
  const categoryCache = new Map<string, string>();
  for (const cat of categories) {
    const id = await getOrCreateCategory(supabase, store.id, cat, categoryCache);
    console.log(`  ✅ ${cat} → ${id}`);
  }
  console.log(`  إجمالي: ${categoryCache.size} تصنيف`);

  // 6. Insert parent products
  console.log("\n── المرحلة 2: إنشاء المنتجات الأساسية ──");
  const productNameToId = new Map<string, string>();

  // Check existing products
  const existingProds: Array<{ id: string; name: string }> = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("products")
      .select("id,name")
      .eq("store_id", store.id)
      .range(from, from + 999);
    if (error) throw new Error(`قراءة المنتجات: ${error.message}`);
    const batch = (data ?? []) as Array<{ id: string; name: string }>;
    existingProds.push(...batch);
    if (batch.length < 1000) break;
  }
  for (const p of existingProds) productNameToId.set(p.name, p.id);
  console.log(`  منتجات موجودة: ${existingProds.length}`);

  // Check existing barcodes
  const existingBc = new Map<string, string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("product_variants")
      .select("barcode,product_id")
      .eq("store_id", store.id)
      .range(from, from + 999);
    if (error) throw new Error(`قراءة المتغيرات: ${error.message}`);
    const batch = (data ?? []) as Array<{ barcode: string; product_id: string }>;
    for (const v of batch) existingBc.set(v.barcode, v.product_id);
    if (batch.length < 1000) break;
  }
  console.log(`  متغيرات موجودة: ${existingBc.size}`);

  // Determine which products need to be created
  const toCreate: ProductGroup[] = [];
  for (const pg of products) {
    if (productNameToId.has(pg.name)) continue;
    toCreate.push(pg);
  }
  console.log(`  منتجات جديدة: ${toCreate.length}`);

  // Batch create
  for (let s = 0; s < toCreate.length; s += PRODUCT_CHUNK) {
    const chunk = toCreate.slice(s, s + PRODUCT_CHUNK);
    const rows = chunk.map((pg) => ({
      store_id: store.id,
      category_id: categoryCache.get(pg.category.toLowerCase()) ?? null,
      name: pg.name,
      base_unit: "حبة",
      total_stock: 0,
      is_quick_key: false,
      cost_price: pg.costPrice,
      selling_price: pg.salePrice,
      wholesale_price: pg.salePrice,
      tax_percent: 16,
      tax_included: true,
      is_active: true,
      show_in_pos: true,
      is_sellable: true,
      is_purchasable: true,
      allow_price_change: false,
      reorder_level: 0,
    }));

    const { data, error } = await supabase
      .from("products")
      .insert(rows)
      .select("id,name");

    if (error) throw new Error(`إنشاء منتجات (صف ${s + 1}): ${error.message}`);
    for (const r of data ?? []) productNameToId.set(r.name as string, r.id as string);
    console.log(`  … منتجات ${s + 1}–${Math.min(s + PRODUCT_CHUNK, toCreate.length)}/${toCreate.length}`);
  }

  console.log(`  إجمالي المنتجات: ${productNameToId.size}`);

  // 7. Insert variants
  console.log("\n── المرحلة 3: إنشاء المتغيرات (باركودات) ──");
  let variantsInserted = 0;
  let variantsSkipped = 0;

  const variantRows: Array<{
    product_id: string;
    store_id: string;
    barcode: string;
    variant_label: string;
    total_stock: number;
    is_active: boolean;
  }> = [];

  for (const pg of products) {
    const productId = productNameToId.get(pg.name);
    if (!productId) continue;

    const bcCount = pg.barcodes.length;
    for (let bi = 0; bi < bcCount; bi++) {
      const bc = pg.barcodes[bi]!;

      if (existingBc.has(bc.barcode)) {
        variantsSkipped++;
        continue;
      }

      let label = "";
      if (bcCount === 1) {
        label = pg.name;
      } else {
        label = `نكهة ${bi + 1}`;
      }

      // Ensure label uniqueness per product
      let candidate = label;
      let suffix = 2;
      const existingLabels = new Set<string>();
      for (const vr of variantRows) {
        if (vr.product_id === productId) existingLabels.add(vr.variant_label.toLowerCase());
      }
      while (existingLabels.has(candidate.toLowerCase())) {
        candidate = `${label} (${suffix})`;
        suffix++;
      }
      label = candidate;

      variantRows.push({
        product_id: productId,
        store_id: store.id,
        barcode: bc.barcode,
        variant_label: label,
        total_stock: 0,
        is_active: true,
      });
    }
  }

  // Batch insert variants (no .select to avoid round-trip overhead)
  for (let s = 0; s < variantRows.length; s += VARIANT_CHUNK) {
    const chunk = variantRows.slice(s, s + VARIANT_CHUNK);
    const { error } = await supabase
      .from("product_variants")
      .insert(chunk);

    if (error) {
      // Row-by-row fallback
      for (const row of chunk) {
        const { error: rowErr } = await supabase
          .from("product_variants")
          .insert(row);
        if (rowErr) variantsSkipped++;
        else variantsInserted++;
      }
    } else {
      variantsInserted += chunk.length;
    }

    console.log(`  … متغيرات ${s + 1}–${Math.min(s + VARIANT_CHUNK, variantRows.length)}/${variantRows.length}`);
  }

  console.log(`  تم إدراج: ${variantsInserted}`);
  console.log(`  تم تخطي: ${variantsSkipped}`);

  // 8. Record opening stock (batch direct updates — faster than RPC)
  console.log("\n── المرحلة 4: تسجيل الرصيد الافتتاحي ──");
  let stockRecorded = 0;
  let stockSkipped = 0;

  // Build stock rows: one per variant with stock > 0
  const stockRows: Array<{
    productId: string;
    barcode: string;
    stock: number;
  }> = [];

  for (const pg of products) {
    const productId = productNameToId.get(pg.name);
    if (!productId) continue;

    for (const bc of pg.barcodes) {
      if (bc.stock > 0) {
        stockRows.push({ productId, barcode: bc.barcode, stock: bc.stock });
      }
    }
  }

  console.log(`  باركودات تحتاج رصيد: ${stockRows.length}`);

  // Batch update product_variants.total_stock directly
  for (let s = 0; s < stockRows.length; s += STOCK_CHUNK) {
    const chunk = stockRows.slice(s, s + STOCK_CHUNK);
    for (const row of chunk) {
      const { error } = await supabase
        .from("product_variants")
        .update({ total_stock: row.stock })
        .eq("store_id", store.id)
        .eq("barcode", row.barcode);
      if (error) stockSkipped++;
      else stockRecorded++;
    }
    console.log(`  … أرصدة ${s + 1}–${Math.min(s + STOCK_CHUNK, stockRows.length)}/${stockRows.length}`);
  }

  console.log(`  تم تسجيل: ${stockRecorded}`);
  console.log(`  تم تخطي: ${stockSkipped}`);

  // Note: trg_pv_stock_sync trigger auto-syncs products.total_stock from variants

  // 9. Summary
  console.log("\n" + "═".repeat(60));
  console.log("🏁اكتملت التغذية بنجاح!");
  console.log("═".repeat(60));
  console.log(`🏷️  التصنيفات:   ${categoryCache.size}`);
  console.log(`📦 المنتجات:    ${productNameToId.size}`);
  console.log(`📊 المتغيرات:   ${variantsInserted} (تم تخطي ${variantsSkipped})`);
  console.log(`📈 الأرصدة:     ${stockRecorded} (تم تخطي ${stockSkipped})`);
  console.log("═".repeat(60));
}

main().catch((err) => {
  console.error("💥 خطأ فادح:", err);
  process.exit(1);
});
