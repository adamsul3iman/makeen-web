import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { createClient } from "@supabase/supabase-js";

for (const file of [".env", ".env.local"]) {
  const path = resolve(process.cwd(), file);
  if (!existsSync(path)) continue;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const at = line.indexOf("=");
    const key = line.slice(0, at).trim();
    let value = line.slice(at + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}

const runTag = process.argv[2] ?? "QAM456_20260826103918";
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const wait = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));
async function retryRpc(args, attempts = 4) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    last = await admin.rpc("record_inventory_movement", args);
    if (!last.error) return last;
    if (!/fetch failed|timeout|network/i.test(last.error.message)) return last;
    await wait(attempt * 250);
  }
  return last;
}

async function productByName(name) {
  const { data, error } = await admin.from("products").select("id,store_id,total_stock").eq("name", name).single();
  if (error) throw error;
  const { data: variant, error: variantError } = await admin.from("product_variants").select("id,total_stock").eq("product_id", data.id).limit(1).single();
  if (variantError) throw variantError;
  return { product: data, variant };
}

const zero = await productByName(`${runTag} Zero Receipt`);
const zeroResult = await retryRpc({
  p_store_id: zero.product.store_id,
  p_product_id: zero.product.id,
  p_variant_id: zero.variant.id,
  p_quantity_delta: 100,
  p_movement_type: "PURCHASE_RECEIPT",
  p_idempotency_key: `${runTag}:zero-receipt`,
  p_unit_quantity: 100,
  p_allow_negative: false,
  p_actor_name: "QA recovery",
  p_reason: "QA retry after transport failure",
  p_metadata: {},
});

const stress = await productByName(`${runTag} 1000 Movements`);
const { data: existing, error: existingError } = await admin.from("inventory_movements").select("idempotency_key").eq("store_id", stress.product.store_id).eq("product_id", stress.product.id);
if (existingError) throw existingError;
const keys = new Set((existing ?? []).map((row) => row.idempotency_key));
const started = performance.now();
let retryError = null;
let added = 0;
for (let i = 0; i < 1000; i++) {
  const idempotencyKey = `${runTag}:stress:${i}`;
  if (keys.has(idempotencyKey)) continue;
  const result = await retryRpc({
    p_store_id: stress.product.store_id,
    p_product_id: stress.product.id,
    p_variant_id: stress.variant.id,
    p_quantity_delta: -1,
    p_movement_type: "SALE",
    p_idempotency_key: idempotencyKey,
    p_unit_quantity: 1,
    p_allow_negative: true,
    p_actor_name: "QA recovery",
    p_reason: "QA 1000 movement retry",
    p_metadata: {},
  });
  if (result.error) { retryError = result.error; break; }
  added++;
}

const { data: finalProduct } = await admin.from("products").select("total_stock").eq("id", stress.product.id).single();
const { count: finalCount } = await admin.from("inventory_movements").select("id", { count: "exact", head: true }).eq("store_id", stress.product.store_id).eq("product_id", stress.product.id);
const { data: zeroAfter } = await admin.from("products").select("total_stock").eq("id", zero.product.id).single();

console.log(JSON.stringify({
  runTag,
  zeroReceipt: { status: !zeroResult.error && Number(zeroAfter?.total_stock) === 100 ? "PASS" : "FAIL", stock: zeroAfter?.total_stock, error: zeroResult.error?.message ?? null },
  stress: { status: !retryError && finalCount === 1000 && Number(finalProduct?.total_stock) === 0 ? "PASS" : "FAIL", initiallyPresent: keys.size, added, finalCount, finalStock: finalProduct?.total_stock, recoverySeconds: Number(((performance.now() - started) / 1000).toFixed(2)), error: retryError?.message ?? null },
}, null, 2));
