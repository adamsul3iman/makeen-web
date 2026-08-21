#!/usr/bin/env node
/**
 * db/migrate.mjs — declarative migration runner for the POS backend.
 *
 * Reads `DATABASE_URL` (process.env or `.env`), applies any SQL files in
 * `db/migrations/` that have NOT yet been recorded in the `schema_migrations`
 * tracking table, in lexical (i.e. numeric) order, and then verifies that the
 * live schema matches the canonical structure the application expects.
 *
 * Usage:
 *   node db/migrate.mjs            apply pending migrations, then verify structure
 *   node db/migrate.mjs --check    report pending migrations without applying
 *   node db/migrate.mjs --verify   verify structure only (never applies anything)
 *   node db/migrate.mjs --apply    force-apply even if a migration errored before
 *
 * Notes:
 *   - Each migration runs inside its own transaction. Once it succeeds the
 *     version is recorded, so retries are safe and never re-apply.
 *   - Legacy databases that were provisioned manually (before this runner
 *     existed) are handled gracefully: if a migration fails only because its
 *     objects already exist (duplicate table / column / object), it is recorded
 *     as applied with a warning and the run continues.
 *   - The structural manifest below is the canonical schema the app uses
 *     (003-style products/product_barcodes plus the multi-tenant additions).
 */
import { readdir, readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = join(ROOT, "db", "migrations");

/** Canonical schema the application expects. Values are required columns. */
const EXPECTED_SCHEMA = {
  cashiers: ["id", "name", "pin", "role", "role_id", "store_id", "email", "password_hash", "pin_salt", "pin_hash", "username", "is_active"],
  staff_roles: ["id", "store_id", "code", "name", "description", "capabilities", "limits", "is_system", "sort_order", "created_at", "updated_at"],
  categories: ["id", "name", "store_id"],
  products: ["id", "category_id", "name", "base_unit", "total_stock", "is_quick_key", "store_id", "brand_id", "default_supplier_id", "tax_percent", "tax_included", "is_active", "show_in_pos", "is_sellable", "is_purchasable", "allow_price_change", "reorder_level", "parent_id", "variant_label", "is_variant_root"],
  product_brands: ["id", "store_id", "name", "created_at"],
  product_barcodes: ["product_id", "barcode", "unit_name", "multiplier", "cost_price", "selling_price", "store_id", "wholesale_price", "is_default_sale", "is_default_purchase", "variant_label"],
  inventory_movements: ["id", "store_id", "product_id", "branch_id", "terminal_id", "actor_id", "actor_name", "movement_type", "quantity_delta", "unit_quantity", "unit_name", "multiplier", "balance_before", "balance_after", "barcode", "variant_label", "reference_type", "reference_id", "idempotency_key", "reason", "metadata", "occurred_at", "created_at"],
  inventory_postings: ["sync_id", "store_id", "posted_at"],
  sync_events: ["sync_id", "action_type", "payload", "created_at", "client_created_at", "store_id", "branch_id", "terminal_id"],
  branches: ["id", "store_id", "name", "created_at"],
  terminals: ["id", "branch_id", "name", "created_at"],
  customers: ["id", "name", "phone", "balance", "created_at", "store_id", "loyalty_points"],
  customer_transactions: ["id", "customer_id", "type", "amount", "balance_after", "description", "shift_id", "created_at", "store_id"],
  expenses: ["id", "cashier_id", "category", "amount", "notes", "shift_id", "created_at", "store_id"],
  suppliers: ["id", "name", "phone", "email", "address", "balance", "payment_terms_days", "created_at", "store_id"],
  purchase_orders: ["id", "supplier_id", "total_amount", "status", "received_at", "created_at", "store_id"],
  purchase_order_items: ["id", "purchase_order_id", "product_id", "quantity", "unit_cost", "total_price", "store_id"],
  supplier_invoices: ["id", "store_id", "supplier_id", "purchase_order_id", "invoice_number", "invoice_date", "due_date", "subtotal", "tax_amount", "total_amount", "paid_amount", "balance_due", "status", "notes", "created_at", "updated_at"],
  supplier_invoice_items: ["id", "invoice_id", "store_id", "line_no", "product_id", "description", "quantity", "unit_cost", "tax_percent", "net_amount", "tax_amount", "total_amount"],
  supplier_payments: ["id", "store_id", "supplier_id", "invoice_id", "amount", "method", "reference", "notes", "paid_at", "created_at"],
  stores: ["id", "name", "owner_name", "email", "phone", "subscription_status", "created_at", "logo_url", "address", "receipt_header", "receipt_footer", "loyalty_enabled", "points_per_spend", "point_value", "tax_percent", "tax_number", "receipt_show_tax_number", "receipt_show_cashier_time", "receipt_show_barcode_qr", "receipt_compact_spacing"],
  super_admins: ["id", "name", "pin", "created_at"],
  loyalty_events: ["id", "store_id", "customer_id", "type", "points", "balance_after", "reference", "description", "created_at"],
  admin_audit_logs: ["id", "store_id", "admin_id", "admin_name", "action_type", "target_id", "details", "created_at"],
  print_templates: ["id", "store_id", "kind", "name", "is_default", "config", "created_at", "updated_at"],
  shift_reports: ["id", "store_id", "shift_id", "close_event_id", "branch_id", "terminal_id", "cashier_id", "cashier_name", "opened_at", "closed_at", "starting_cash", "cash_sales", "visa_sales", "cliq_sales", "debt_sales", "debt_collections", "discounts", "returns", "expenses", "total_sales", "expected_cash", "actual_cash", "variance", "approval_status", "approved_by", "approved_by_name", "approved_at", "approval_note", "close_source", "resolved_by", "resolved_by_name", "resolution_note", "created_at", "updated_at"],
  tenant_tax_settings: ["store_id", "tax_number", "istd_client_id", "istd_client_secret", "created_at", "updated_at"],
  istd_submissions: ["sync_id", "store_id", "status", "istd_uuid", "istd_qr", "error", "last_attempt_at", "created_at"],
  risk_events: ["id", "store_id", "event_key", "actor_id", "actor_name", "branch_id", "terminal_id", "shift_id", "event_type", "severity", "score", "amount", "target_id", "details", "status", "reviewed_by", "reviewed_by_name", "reviewed_at", "review_note", "occurred_at", "created_at"],
  print_jobs: ["id", "store_id", "kind", "status", "payload", "priority", "attempts", "last_worker", "source_event_id", "created_at", "claimed_at", "printed_at", "expires_at"],
  platform_secrets: ["name", "value"],
};

/** SQLSTATE codes that mean "the object already exists" (benign on a legacy DB). */
const BENIGN_DUPLICATE_CODES = new Set(["42P07", "42701", "42710", "42723", "42P04", "42P06"]);

/**
 * Server-only secret injected into migration 015's SQL at apply time.
 * Kept out of the committed migration file; sourced from PLATFORM_OPS_SECRET
 * (process.env or .env). Empty when no migration needs it.
 */
let OPS_TOKEN = "";

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

function loadEnvFile() {
  const out = {};
  const envPath = join(ROOT, ".env");
  if (!existsSync(envPath)) return out;
  for (const raw of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function buildPgConfig() {
  const env = loadEnvFile();
  const url = process.env.DATABASE_URL || env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set (process.env or .env). Aborting.");
    process.exit(2);
  }
  // Do NOT round-trip through `new URL()`: the WHATWG parser mangles `@`
  // characters that legitimately appear inside a password. node-postgres'
  // own parser (pg-connection-string) splits on the LAST `@`, so we hand it
  // the raw string after only removing any `sslmode` parameter (handled via
  // the explicit `ssl` option below).
  const sslMode = (url.match(/[?&]sslmode=([^&#]+)/) || [])[1];
  const cleanUrl = url.replace(/[?&]sslmode=[^&#]*/, "");
  let ssl = false;
  if (sslMode !== "disable") {
    // Supabase requires TLS on both the direct (5432) and pooler (6543) ports.
    // `rejectUnauthorized: false` keeps the runner working even when the cert
    // chain cannot be validated from this host.
    ssl = { rejectUnauthorized: false };
  }
  return { connectionString: cleanUrl, ssl };
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

async function listMigrations() {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql"));
  const out = [];
  for (const file of files.sort()) {
    const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
    out.push({ version: file.replace(/\.sql$/, ""), file, sql });
  }
  return out;
}

async function ensureTrackingTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
}

async function getAppliedVersions(client) {
  const { rows } = await client.query("SELECT version FROM schema_migrations");
  return new Set(rows.map((r) => r.version));
}

async function applyMigration(client, migration) {
  let sql = migration.sql;
  if (sql.includes("{{PLATFORM_OPS_SECRET}}")) {
    if (!OPS_TOKEN) {
      throw new Error(`PLATFORM_OPS_SECRET is required by ${migration.version} but is not set (process.env or .env)`);
    }
    sql = sql.replaceAll("{{PLATFORM_OPS_SECRET}}", OPS_TOKEN);
  }
  await client.query("BEGIN");
  try {
    await client.query(sql);
    await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [migration.version]);
    await client.query("COMMIT");
    return { ok: true, tolerated: false };
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.code && BENIGN_DUPLICATE_CODES.has(err.code)) {
      await client.query("INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING", [
        migration.version,
      ]);
      return { ok: true, tolerated: true, reason: `${err.code}: ${firstLine(err.message)}` };
    }
    return { ok: false, error: err };
  }
}

function firstLine(message) {
  return String(message || "").split("\n")[0].slice(0, 200);
}

// ---------------------------------------------------------------------------
// Structure verification
// ---------------------------------------------------------------------------

async function verifyStructure(client) {
  const { rows: tables } = await client.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
  );
  const actualTables = new Set(tables.map((r) => r.table_name));

  const { rows: columns } = await client.query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`,
  );
  const actualColumns = new Map();
  for (const row of columns) {
    const list = actualColumns.get(row.table_name) || new Set();
    list.add(row.column_name);
    actualColumns.set(row.table_name, list);
  }

  const { rows: extRows } = await client.query(
    `SELECT extname FROM pg_extension WHERE extname = 'pgcrypto'`,
  );
  const hasPgcrypto = extRows.length > 0;

  let failures = 0;
  const lines = [];

  if (!hasPgcrypto) {
    failures += 1;
    lines.push("  ✗ extension pgcrypto — MISSING");
  } else {
    lines.push("  ✓ extension pgcrypto");
  }

  for (const [table, required] of Object.entries(EXPECTED_SCHEMA)) {
    if (!actualTables.has(table)) {
      failures += 1;
      lines.push(`  ✗ table ${table} — MISSING`);
      continue;
    }
    const present = actualColumns.get(table) || new Set();
    const missing = required.filter((col) => !present.has(col));
    if (missing.length === 0) {
      lines.push(`  ✓ table ${table} (${required.length} columns)`);
    } else {
      failures += 1;
      lines.push(`  ✗ table ${table} — missing columns: ${missing.join(", ")}`);
    }
  }

  const unexpected = [...actualTables].filter((t) => t !== "schema_migrations" && !(t in EXPECTED_SCHEMA));
  for (const table of unexpected) {
    lines.push(`  ~ table ${table} — extra (not in manifest)`);
  }

  return { failures, lines, actualTables };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = new Set(process.argv.slice(2));
const onlyCheck = args.has("--check");
const onlyVerify = args.has("--verify");

async function main() {
  const config = buildPgConfig();
  const client = new pg.Client(config);
  await client.connect();

  try {
    await ensureTrackingTable(client);
    const env = loadEnvFile();
    OPS_TOKEN = process.env.PLATFORM_OPS_SECRET || env.PLATFORM_OPS_SECRET || "";
    const migrations = await listMigrations();
    const applied = await getAppliedVersions(client);
    const pending = migrations.filter((m) => !applied.has(m.version));

    console.log("Connected to PostgreSQL (database from DATABASE_URL)");
    console.log(`Migrations on disk: ${migrations.length}, already applied: ${migrations.length - pending.length}`);

    if (pending.length > 0 && !onlyVerify && !onlyCheck) {
      console.log(`\n==> Applying ${pending.length} pending migration(s) in order:`);
      for (const migration of pending) {
        const result = await applyMigration(client, migration);
        if (result.ok) {
          const note = result.tolerated ? ` (already present in DB — recorded as applied) [${result.reason}]` : "";
          console.log(`  + ${migration.version}${note}`);
        } else {
          console.error(`  ! ${migration.version} FAILED:`);
          console.error(`    ${result.error.message}`);
          console.error("    Run `node db/migrate.mjs --check` for a report; nothing was recorded for this version.");
          process.exitCode = 1;
          return;
        }
      }
    }

    if (pending.length > 0 && (onlyVerify || onlyCheck)) {
      console.log(onlyVerify
        ? `\nNOTE: ${pending.length} migration(s) are pending. Run without --verify to apply them.`
        : `\nPending migrations (${pending.length}):`);
      if (onlyCheck) for (const m of pending) console.log(`  - ${m.version}`);
    }

    if (onlyCheck) {
      console.log("\n==> Live tables vs migration manifest (read-only):");
      const { failures, lines } = await verifyStructure(client);
      for (const line of lines) console.log(line);
      console.log(`\n${failures === 0 ? "STRUCTURE OK — live tables match the expected schema." : `STRUCTURE FAILED — ${failures} problem(s) found.`}`);
      process.exitCode = failures > 0 ? 1 : 0;
      return;
    }

    console.log("\n==> Structure verification (canonical schema vs live database):");
    const { failures, lines } = await verifyStructure(client);
    for (const line of lines) console.log(line);
    console.log(`\n${failures === 0 ? "STRUCTURE OK — the database matches the expected schema." : `STRUCTURE FAILED — ${failures} problem(s) found.`}`);
    if (!onlyVerify && pending.length === 0 && failures === 0) {
      console.log("All migrations applied; no structure drift detected.");
    }
    process.exitCode = failures > 0 ? 1 : 0;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("Migration runner error:", err.message);
  process.exitCode = 1;
});
