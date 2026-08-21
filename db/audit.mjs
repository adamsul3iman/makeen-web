import pg from "pg";
import { readFileSync } from "node:fs";
import { join } from "node:path";

let url = process.env.DATABASE_URL || "";
if (!url) {
  const env = {};
  for (const line of readFileSync(join(process.cwd(), ".env"), "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i === -1) continue;
    let v = t.slice(i + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    env[t.slice(0, i).trim()] = v;
  }
  url = env.DATABASE_URL;
}

const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();

const q = async (label, sql) => {
  const { rows } = await c.query(sql);
  console.log(`${label}: ${JSON.stringify(rows[0])}`);
};

await q("stores        ", `select count(*)::int n, min(name) name from stores`);
await q("stores_tax    ", `select count(*)::int n, count(*) filter (where tax_percent > 0 and tax_number <> '') configured from stores`);
await q("super_admins  ", `select count(*)::int n, min(pin) pin from super_admins`);
await q("cashiers      ", `select count(*)::int n, count(*) filter (where store_id is null) no_store from cashiers`);
await q("categories    ", `select count(*)::int n, count(*) filter (where store_id is null) no_store from categories`);
await q("products      ", `select count(*)::int n, count(*) filter (where store_id is null) no_store from products`);
await q("barcodes      ", `select count(*)::int n, count(*) filter (where store_id is null) no_store from product_barcodes`);
await q("sync_events   ", `select count(*)::int n, count(*) filter (where store_id is null) no_store, count(*) filter (where branch_id is null or terminal_id is null) no_terminal from sync_events`);
await q("branches      ", `select count(*)::int n, count(*) filter (where store_id is null) no_store from branches`);
await q("terminals     ", `select count(*)::int n, count(*) filter (where branch_id is null) no_branch from terminals`);
await q("customers     ", `select count(*)::int n from customers`);
await q("transactions  ", `select count(*)::int n from customer_transactions`);
await q("expenses      ", `select count(*)::int n from expenses`);
await q("suppliers     ", `select count(*)::int n from suppliers`);
await q("purchase_orders", `select count(*)::int n from purchase_orders`);
await q("po_items      ", `select count(*)::int n from purchase_order_items`);
await q("loyalty_events", `select count(*)::int n from loyalty_events`);
await q("migrations    ", `select count(*)::int n, string_agg(version, ', ' order by version) v from schema_migrations`);

await c.end();
