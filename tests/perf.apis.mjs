/**
 * API latency benchmark suite.
 *
 * Runs against a running Next server (BASE_URL or http://127.0.0.1:3100),
 * so it must execute while `next start` is up — tests/run.mjs wires it in
 * right after the api.health sweep.
 *
 * Measures the hot path a register actually touches every day:
 *   - POS cashier login          POST /api/login
 *   - owner dashboard login      POST /api/admin/login
 *   - catalog snapshot boot      GET  /api/catalog
 *   - checkout / inventory sync  POST /api/sync
 *   - barcode candidate          GET  /api/catalog/products/barcode
 *
 * Reports p50/p75/p95/p99/max + ops/sec for each route and enforces
 * generous budgets that catch regressions (5xx, hangs, huge p95) without
 * flaking on a local box. Exits non-zero on any violation.
 */
const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:3100";

const ITERATIONS = Number(process.env.PERF_ITERS ?? 200);
const CONCURRENCY = Number(process.env.PERF_CONCURRENCY ?? 10);

let pass = 0;
let fail = 0;
const failures = [];

function ok(cond, msg) {
  if (cond) {
    pass += 1;
  } else {
    fail += 1;
    failures.push(msg);
    console.error(`  ✗ ${msg}`);
  }
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function summarize(latencies) {
  const sorted = [...latencies].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 50),
    p75: percentile(sorted, 75),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

async function timedReq(path, init) {
  const started = performance.now();
  const res = await fetch(`${BASE_URL}${path}`, init);
  const ms = performance.now() - started;
  return { res, ms };
}

/**
 * Sequential latency sweep: N back-to-back requests, one at a time.
 */
async function benchSequential(name, path, init, { expectStatus = 200 } = {}) {
  const latencies = [];
  let badStatus = 0;
  for (let i = 0; i < ITERATIONS; i++) {
    const { res, ms } = await timedReq(path, init);
    if (res.status !== expectStatus) badStatus += 1;
    else latencies.push(ms);
  }
  const stats = summarize(latencies);
  const ops = latencies.length / ((latencies.reduce((a, b) => a + b, 0) || 1) / 1000);
  return { name, stats, ops, badStatus, ran: latencies.length };
}

/**
 * Concurrent latency sweep: CONCURRENCY parallel requests, looped until
 * ITERATIONS completed. Measures how the route holds up under load.
 */
async function benchConcurrent(name, path, init, { expectStatus = 200 } = {}) {
  const latencies = [];
  let badStatus = 0;
  let remaining = ITERATIONS;
  async function worker() {
    while (remaining > 0) {
      remaining -= 1;
      const { res, ms } = await timedReq(path, init);
      if (res.status !== expectStatus) badStatus += 1;
      else latencies.push(ms);
    }
  }
  const started = performance.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  const wallMs = performance.now() - started;
  const stats = summarize(latencies);
  const ops = latencies.length / (wallMs / 1000);
  return { name, stats, ops, badStatus, ran: latencies.length };
}

function reportLine(result) {
  const { name, stats, ops, badStatus, ran } = result;
  console.log(
    `  ${name.padEnd(34)} n=${String(ran).padStart(4)}  ` +
      `p50=${stats.p50.toFixed(1).padStart(7)}ms  p95=${stats.p95.toFixed(1).padStart(7)}ms  ` +
      `p99=${stats.p99.toFixed(1).padStart(7)}ms  max=${stats.max.toFixed(1).padStart(8)}ms  ` +
      `ops=${ops.toFixed(0).padStart(5)}/s` +
      (badStatus > 0 ? `  BAD_STATUS=${badStatus}` : ""),
  );
}

const STORE = { "x-pos-store-id": "store-main" };

async function main() {
  // Mode detection mirrors api.health.mjs.
  const probe = await fetch(`${BASE_URL}/api/catalog`, { headers: STORE });
  const mock = probe.status === 200;
  console.log(`mode: ${mock ? "mock (no Supabase keys)" : "live"}`);
  if (!mock) {
    console.log("perf: live mode requires a seeded tenant; barcode + catalog may need admin/store headers");
  }

  const loginBody = JSON.stringify({ pin: "1234", storeId: "store-main" });
  const adminLoginBody = JSON.stringify({ email: "admin@demo.test", password: "12345678" });
  const syncEvent = {
    sync_id: `perf-${Date.now()}`,
    action_type: "INVOICE_CREATED",
    payload: {
      items: [
        { productId: "p-1", barcode: "6250000000012", qty: 2, unitPrice: 5, lineTotal: 10, discount: 0 },
        { productId: "p-2", barcode: "6250000000029", qty: 1, unitPrice: 3.5, lineTotal: 3.5, discount: 0 },
      ],
      subtotal: 13.5,
      tax: 2.16,
      discount: 0,
      total: 15.66,
      paymentMethod: "CASH",
      amountPaid: 20,
      change: 4.34,
      completed_at: new Date().toISOString(),
    },
  };
  const syncHeaders = { ...STORE, "Content-Type": "application/json" };

  const results = [];

  console.log(`\n-- sequential (n=${ITERATIONS}) ---------------------------------`);
  results.push(await benchSequential("POST /api/login", "/api/login", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: loginBody,
  }));
  results.push(await benchSequential("POST /api/admin/login", "/api/admin/login", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: adminLoginBody,
  }));
  results.push(await benchSequential("GET /api/catalog", "/api/catalog", { headers: STORE }));
  results.push(await benchSequential("POST /api/sync", "/api/sync", {
    method: "POST", headers: syncHeaders, body: JSON.stringify([syncEvent]),
  }));
  results.push(await benchSequential("GET /api/catalog/products/barcode", "/api/catalog/products/barcode", {}));

  console.log(`\n-- concurrent (n=${ITERATIONS}, c=${CONCURRENCY}) -------------------`);
  results.push(await benchConcurrent("POST /api/login", "/api/login", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: loginBody,
  }));
  results.push(await benchConcurrent("GET /api/catalog", "/api/catalog", { headers: STORE }));
  results.push(await benchConcurrent("POST /api/sync", "/api/sync", {
    method: "POST", headers: syncHeaders, body: JSON.stringify([syncEvent]),
  }));

  console.log("");
  for (const r of results) reportLine(r);
  console.log("");

  // Budgets: generous enough for a shared local machine, tight enough to
  // catch a route that started doing unbounded DB work or re-architecting.
  // p95 must stay under 300ms; p99 under 600ms; max under 2s. Any 5xx or
  // repeated non-expected status is a hard failure.
  for (const r of results) {
    ok(r.badStatus === 0, `${r.name}: all responses expected status (bad=${r.badStatus})`);
    ok(r.ran > 0, `${r.name}: produced measurable samples`);
    if (r.ran > 0) {
      ok(r.stats.p95 < 300, `${r.name}: p95 < 300ms (got ${r.stats.p95.toFixed(1)}ms)`);
      ok(r.stats.p99 < 600, `${r.name}: p99 < 600ms (got ${r.stats.p99.toFixed(1)}ms)`);
      ok(r.stats.max < 2000, `${r.name}: max < 2000ms (got ${r.stats.max.toFixed(1)}ms)`);
    }
  }

  console.log(`Perf: ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.error("Failures:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Perf sweep crashed:", err);
  process.exit(1);
});
