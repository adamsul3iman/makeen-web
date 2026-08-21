import { readFile } from "node:fs/promises";
import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");

const sslMode = (url.match(/[?&]sslmode=([^&#]+)/) || [])[1];
const connectionString = url.replace(/[?&]sslmode=[^&#]*/, "");
const client = new pg.Client({
  connectionString,
  ssl: sslMode === "disable" ? false : { rejectUnauthorized: false },
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

await client.connect();
try {
  await client.query("BEGIN");
  const migration = await readFile(new URL("../db/migrations/047_stale_shift_recovery.sql", import.meta.url), "utf8");
  await client.query(migration);

  const store = await client.query(
    "INSERT INTO stores (name, owner_name, email) VALUES ($1,$2,$3) RETURNING id",
    ["QA stale shift rollback", "QA Owner", `qa-${crypto.randomUUID()}@example.test`],
  );
  const storeId = store.rows[0].id;
  const branch = await client.query(
    "INSERT INTO branches (store_id,name) VALUES ($1,$2) RETURNING id",
    [storeId, "QA Branch"],
  );
  const branchId = branch.rows[0].id;
  const terminal = await client.query(
    "INSERT INTO terminals (branch_id,name) VALUES ($1,$2) RETURNING id",
    [branchId, "QA Register"],
  );
  const terminalId = terminal.rows[0].id;
  const shiftId = crypto.randomUUID();
  const openEventId = crypto.randomUUID();
  const invoiceEventId = crypto.randomUUID();
  const openedAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

  await client.query(
    `INSERT INTO sync_events
      (sync_id,store_id,action_type,payload,client_created_at,branch_id,terminal_id,cashier_name)
     VALUES ($1,$2,'SHIFT_OPENED',$3::jsonb,$4,$5,$6,'QA Cashier')`,
    [openEventId, storeId, JSON.stringify({ shiftId, startingCash: 100, startTime: openedAt, cashierName: "QA Cashier" }), openedAt, branchId, terminalId],
  );
  await client.query(
    `INSERT INTO sync_events
      (sync_id,store_id,action_type,payload,client_created_at,branch_id,terminal_id,cashier_name)
     VALUES ($1,$2,'INVOICE_CREATED','{}'::jsonb,now(),$3,$4,'QA Cashier')`,
    [invoiceEventId, storeId, branchId, terminalId],
  );
  await client.query(
    `INSERT INTO sales_invoices
      (sync_id,store_id,branch_id,terminal_id,shift_id,cashier_name,payment_method,
       subtotal,tax,discount,total,amount_paid,cash_amount,completed_at)
     VALUES ($1,$2,$3,$4,$5,'QA Cashier','CASH',50,0,2,50,50,50,now())`,
    [invoiceEventId, storeId, branchId, terminalId, shiftId],
  );
  await client.query(
    "INSERT INTO expenses (store_id,category,amount,shift_id,notes) VALUES ($1,'QA',5,$2,'rollback test')",
    [storeId, shiftId],
  );

  const first = await client.query(
    "SELECT * FROM resolve_stale_shift($1,$2,$3,NULL,$4,$5)",
    [storeId, shiftId, 146, "QA Owner", "Verified rollback-only recovery"],
  );
  const report = first.rows[0];
  assert(Number(report.expected_cash) === 145, "expected cash must be 100 + 50 - 5");
  assert(Number(report.actual_cash) === 146, "actual cash must preserve the blind count");
  assert(Number(report.variance) === 1, "variance must equal actual minus expected");
  assert(report.approval_status === "APPROVED", "owner recovery must approve its variance atomically");
  assert(report.close_source === "ADMIN_RECOVERY", "Z report must retain its recovery source");

  const second = await client.query(
    "SELECT * FROM resolve_stale_shift($1,$2,$3,NULL,$4,$5)",
    [storeId, shiftId, 999, "QA Owner", "Idempotency retry"],
  );
  assert(second.rows[0].id === report.id, "a retry must return the original report");
  assert(Number(second.rows[0].actual_cash) === 146, "a retry must not mutate financial values");

  const counts = await client.query(
    `SELECT
       (SELECT count(*) FROM shift_reports WHERE store_id=$1 AND shift_id=$2) AS reports,
       (SELECT count(*) FROM admin_audit_logs WHERE store_id=$1 AND action_type='SHIFT_STALE_RESOLVED') AS audits,
       (SELECT count(*) FROM risk_events WHERE store_id=$1 AND event_key='stale-shift:' || $2::text) AS risks`,
    [storeId, shiftId],
  );
  assert(Number(counts.rows[0].reports) === 1, "exactly one Z report is allowed");
  assert(Number(counts.rows[0].audits) === 1, "exactly one audit entry is allowed");
  assert(Number(counts.rows[0].risks) === 1, "exactly one risk signal is allowed");

  let immutable = false;
  try {
    await client.query("SAVEPOINT immutable_check");
    await client.query("UPDATE shift_reports SET expected_cash=0 WHERE id=$1", [report.id]);
  } catch (error) {
    immutable = error.code === "55000";
    await client.query("ROLLBACK TO SAVEPOINT immutable_check");
  }
  assert(immutable, "financial fields must remain immutable");

  console.log("Stale shift recovery integration: 12 passed, 0 failed (transaction rolled back)");
  await client.query("ROLLBACK");
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  throw error;
} finally {
  await client.end();
}
