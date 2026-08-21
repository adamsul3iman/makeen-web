#!/usr/bin/env node
/**
 * scripts/cleanup_dirty_categories.mjs
 *
 * One-off data repair: the legacy catalog migration (scripts/migrate_legacy_catalog.ts)
 * recreated dirty category names by joining middle segments with " // " (splitCategory
 * line 130), e.g. a source value "فيوتشر // علب بلاستيك // كاسات سلش // X" produced the
 * category "علب بلاستيك // كاسات سلش". Those dirty names now live in the live
 * `categories` table and real products point at them.
 *
 * Strategy (mirrors the approved plan):
 *   - Find every category whose name contains a double-slash, slash or backslash.
 *   - Split the name on whitespace-around-(double-slash-or-slash-or-backslash); the
 *     FIRST segment is the clean category name. A clean category is looked up as a
 *     sibling (same parent_id, same store) with that exact name.
 *   - If the dirty category still has products and no clean sibling exists, the
 *     clean category is created under the same parent.
 *   - All products on the dirty category are re-linked to the clean category.
 *   - After verifying ZERO products remain (guard against the ON DELETE CASCADE
 *     on products.category_id), the dirty categories are deleted.
 *
 * Everything runs inside a single transaction — any failure rolls back wholesale.
 *
 * Usage:
 *   node scripts/cleanup_dirty_categories.mjs --dry-run
 *   node scripts/cleanup_dirty_categories.mjs            (apply)
 *   node scripts/cleanup_dirty_categories.mjs <store-id> (target a specific store)
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_STORE_ID = "a58fd381-97c5-40b3-baa0-b47d5c79d985";
const SEP = /\s*(?:\/\/|\/|\\)\s*/;
const DIRTY_RE = /\/|\\/;

function loadEnv() {
  const out = {};
  const envPath = resolve(ROOT, ".env");
  if (!existsSync(envPath)) return out;
  for (const raw of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && ((value[0] === '"' && value.at(-1) === '"') || (value[0] === "'" && value.at(-1) === "'"))) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

function buildPgConfig(env) {
  const url = process.env.DATABASE_URL || env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set (process.env or .env). Aborting.");
    process.exit(2);
  }
  const sslMode = (url.match(/[?&]sslmode=([^&#]+)/) || [])[1];
  const cleanUrl = url.replace(/[?&]sslmode=[^&#]*/, "");
  let ssl = false;
  if (sslMode !== "disable") ssl = { rejectUnauthorized: false };
  return { connectionString: cleanUrl, ssl };
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const storeId = (positional[0] ?? DEFAULT_STORE_ID).trim();
  const env = loadEnv();
  const client = new pg.Client(buildPgConfig(env));
  await client.connect();

  try {
    const { rows: storeRows } = await client.query(
      `SELECT id, name, email FROM stores WHERE id = $1`,
      [storeId],
    );
    if (storeRows.length === 0) {
      console.error(`Target store ${storeId} not found. Aborting.`);
      process.exit(1);
    }
    console.log(`Store: ${storeRows[0].name} <${storeRows[0].email}> (${storeRows[0].id})`);
    console.log(dryRun ? "DRY-RUN — nothing will be written.\n" : "");

    const { rows: cats } = await client.query(
      `SELECT id, name, parent_id, store_id FROM categories WHERE store_id = $1`,
      [storeId],
    );
    const { rows: prods } = await client.query(
      `SELECT id, category_id FROM products WHERE store_id = $1`,
      [storeId],
    );

    const byKey = new Map();
    for (const c of cats) {
      const key = `${c.parent_id ?? "NULL"}::${c.name}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(c);
    }

    const counts = new Map();
    for (const p of prods) if (p.category_id) counts.set(p.category_id, (counts.get(p.category_id) ?? 0) + 1);

    const dirty = cats.filter((c) => DIRTY_RE.test(c.name ?? ""));
    if (dirty.length === 0) {
      console.log("No dirty categories found. Nothing to do.");
      return;
    }

    const plan = [];
    for (const d of dirty) {
      const segs = String(d.name ?? "").split(SEP).map((s) => s.trim()).filter(Boolean);
      const first = segs[0] ?? "";
      const siblings = byKey.get(`${d.parent_id ?? "NULL"}::${first}`) ?? [];
      const candidates = siblings.filter((x) => x.id !== d.id);
      if (candidates.length > 1) {
        throw new Error(`Ambiguous target for "${d.name}" (parent ${d.parent_id}): multiple siblings named "${first}". Aborting before any write.`);
      }
      const childCount = cats.filter((c) => c.parent_id === d.id).length;
      if (childCount > 0) {
        throw new Error(`Dirty category "${d.name}" still has ${childCount} child category(s). Aborting before any write.`);
      }
      plan.push({
        dirtyId: d.id,
        dirtyName: d.name,
        parentId: d.parent_id,
        firstSeg: first,
        targetId: candidates[0]?.id ?? null,
        productCount: counts.get(d.id) ?? 0,
      });
    }

    const relinkTotal = plan.reduce((sum, p) => sum + p.productCount, 0);
    const toCreate = plan.filter((p) => p.productCount > 0 && !p.targetId);
    console.log(`Plan: ${plan.length} dirty categories, ${relinkTotal} products to re-link, ${toCreate.length} clean categories to create.`);

    for (const p of plan) {
      const parentName = p.parentId ? (cats.find((c) => c.id === p.parentId)?.name ?? "?") : "(main)";
      const action = p.productCount === 0
        ? "delete only"
        : p.targetId
          ? `re-link ${p.productCount} prods -> existing`
          : `create + re-link ${p.productCount} prods`;
      console.log(`  - ${JSON.stringify(p.dirtyName)}  [${action}]  target="${p.firstSeg}" parent="${parentName}"`);
    }

    if (dryRun) return;

    await client.query("BEGIN");
    try {
      const createdByDirty = new Map();
      for (const p of toCreate) {
        const existing = await client.query(
          `SELECT id FROM categories WHERE store_id = $1 AND parent_id IS NOT DISTINCT FROM $2 AND name = $3 LIMIT 1`,
          [storeId, p.parentId, p.firstSeg],
        );
        let targetId = existing.rows[0]?.id ?? null;
        if (!targetId) {
          const inserted = await client.query(
            `INSERT INTO categories (name, parent_id, store_id) VALUES ($1, $2, $3) RETURNING id`,
            [p.firstSeg, p.parentId, storeId],
          );
          targetId = inserted.rows[0].id;
        }
        p.targetId = targetId;
        createdByDirty.set(p.dirtyId, targetId);
      }

      let relinked = 0;
      for (const p of plan) {
        if (p.productCount === 0 || !p.targetId) continue;
        const result = await client.query(
          `UPDATE products SET category_id = $1 WHERE store_id = $2 AND category_id = $3`,
          [p.targetId, storeId, p.dirtyId],
        );
        relinked += result.rowCount ?? 0;
      }
      console.log(`Re-linked ${relinked} products.`);

      for (const p of plan) {
        const remain = await client.query(
          `SELECT count(*)::int AS n FROM products WHERE store_id = $1 AND category_id = $2`,
          [storeId, p.dirtyId],
        );
        if ((remain.rows[0]?.n ?? 0) > 0) {
          throw new Error(`Guard failed: "${p.dirtyName}" still has ${remain.rows[0].n} products — refusing to delete. Rolling back.`);
        }
      }

      const deleted = await client.query(
        `DELETE FROM categories WHERE store_id = $1 AND id = ANY($2::uuid[])`,
        [storeId, plan.map((p) => p.dirtyId)],
      );
      console.log(`Deleted ${deleted.rowCount ?? 0} dirty categories.`);

      await client.query("COMMIT");
      console.log("\nCOMMITTED.");

      const verify = await client.query(
        `SELECT (SELECT count(*) FROM categories WHERE store_id = $1 AND (name ~ '/|\\\\')) AS dirty_left,
                (SELECT count(*) FROM categories WHERE store_id = $1) AS total_cats,
                (SELECT count(*) FROM products WHERE store_id = $1) AS total_prods`,
        [storeId],
      );
      const v = verify.rows[0];
      console.log(`Post-check: dirty categories left=${v.dirty_left}, total categories=${v.total_cats}, total products=${v.total_prods} (products unchanged).`);
      console.log(`Summary: ${plan.length} dirty categories removed, ${relinked} products re-linked to clean categories, ${toCreate.length} clean categories created.`);
    } catch (error) {
      await client.query("ROLLBACK");
      console.error(`\nROLLED BACK — no changes applied. ${error instanceof Error ? error.message : error}`);
      process.exitCode = 1;
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("Cleanup error:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
