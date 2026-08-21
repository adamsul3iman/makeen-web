import { existsSync, readFileSync } from "node:fs";
import pg from "pg";

function loadEnv() {
  const values = { ...process.env };
  if (!existsSync(".env")) return values;
  for (const raw of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index < 1) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!values[key]) values[key] = value;
  }
  return values;
}

function money(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
  console.log(`  ok  ${message}`);
}

const env = loadEnv();
if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const email = process.argv[2] || "alburjhom3@gmail.com";
const from = process.argv[3] || "2025-01-01T00:00:00+03:00";
const to = process.argv[4] || new Date().toISOString();
const connectionString = env.DATABASE_URL.replace(/[?&]sslmode=[^&#]*/, "");
const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });

await client.connect();
try {
  const storeResult = await client.query(
    "SELECT id, name FROM stores WHERE lower(email) = lower($1) LIMIT 1",
    [email],
  );
  if (storeResult.rowCount !== 1) throw new Error(`Store not found for ${email}`);
  const store = storeResult.rows[0];
  const reportResult = await client.query(
    `SELECT
       sales_ledger_summary($1, $2, $3) AS ledger,
       sales_ledger_quality($1, $2, $3) AS quality,
       profitability_statement($1, $2, $3) AS profitability`,
    [store.id, from, to],
  );
  const { ledger, quality, profitability } = reportResult.rows[0];
  const sales = ledger.summary;
  const statement = profitability.statement;

  console.log(`Accounting consistency: ${store.name} (${from} -> ${to})`);
  assert(
    money(statement.netRevenue) === money(Number(sales.subtotal) + Number(sales.deliveryFee)),
    "recognized revenue = discounted subtotal + delivery fees",
  );
  assert(
    money(statement.outputTax) === money(sales.tax),
    "output tax reconciles to the sales ledger",
  );
  assert(
    money(statement.grossProfitCandidate) === money(sales.grossProfitCandidate),
    "gross-profit candidate is identical in both reports",
  );
  assert(
    Boolean(profitability.quality.profitReliable) === Boolean(sales.profitReliable),
    "profit reliability is identical in both reports",
  );
  assert(
    Number(quality.zeroCostLineCount) === 0 || (sales.grossProfit == null && statement.grossProfit == null),
    "zero-cost sales never publish a final profit",
  );

  console.log(JSON.stringify({ sales, quality, statement, profitabilityQuality: profitability.quality }, null, 2));
} finally {
  await client.end();
}
