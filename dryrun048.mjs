import { readFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const ROOT = "C:\\Projects\\pos";

function loadEnvFile() {
  const out = {};
  const envPath = join(ROOT, ".env");
  if (!existsSync(envPath)) return out;
  for (const raw of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2) {
      const first = value[0];
      const last = value[value.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) value = value.slice(1, -1);
    }
    out[line.slice(0, eq).trim()] = value;
  }
  return out;
}

function buildPgConfig() {
  const env = loadEnvFile();
  const url = process.env.DATABASE_URL || env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");
  const sslMode = (url.match(/[?&]sslmode=([^&#]+)/) || [])[1];
  const cleanUrl = url.replace(/[?&]sslmode=[^&#]*/, "");
  let ssl = false;
  if (sslMode !== "disable") ssl = { rejectUnauthorized: false };
  return { connectionString: cleanUrl, ssl };
}

const client = new pg.Client(buildPgConfig());
const notices = [];
client.on("notice", (m) => notices.push(m.message));

const sql = readFileSync(join(ROOT, "db", "migrations", "048_reconcile_missing_invoices.sql"), "utf8");

async function before(client) {
  const { rows } = await client.query(`
    SELECT
      (SELECT COUNT(*) FROM sync_events e WHERE e.action_type = 'INVOICE_CREATED') AS events,
      (SELECT COUNT(*) FROM sales_invoices) AS invoices,
      (SELECT COUNT(*) FROM sales_invoice_items) AS items,
      (SELECT COUNT(*) FROM sales_payments) AS payments,
      (SELECT COUNT(*) FROM sync_events e
        WHERE e.action_type = 'INVOICE_CREATED'
          AND NOT EXISTS (SELECT 1 FROM sales_invoices si WHERE si.sync_id = e.sync_id)) AS missing
  `);
  return rows[0];
}

await client.connect();
try {
  const b = await before(client);
  console.log(`BEFORE: events=${b.events} invoices=${b.invoices} items=${b.items} payments=${b.payments} missing_invoice_rows=${b.missing}`);

  await client.query("BEGIN");
  try {
    await client.query(sql);
    const a = await before(client);
    console.log(`AFTER:  events=${a.events} invoices=${a.invoices} items=${a.items} payments=${a.payments} missing_invoice_rows=${a.missing}`);
    console.log(`DELTA:  invoices +${a.invoices - b.invoices}, items +${a.items - b.items}, payments +${a.payments - b.payments}`);
    for (const n of notices) console.log("NOTICE:", n);
    console.log("ROLLING BACK — nothing was persisted.");
    await client.query("ROLLBACK");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("DRY-RUN FAILED (rolled back):", err.message);
    console.error(err.detail || "");
    process.exitCode = 1;
  }
  await client.end();
} catch (err) {
  console.error("Runner error:", err.message);
  await client.end().catch(() => {});
  process.exitCode = 1;
}
