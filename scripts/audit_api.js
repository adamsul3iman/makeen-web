#!/usr/bin/env node
/**
 * Comprehensive System Audit Script — Makeen POS
 *
 * Pings every admin/POS API endpoint, validates HTTP status codes and
 * response shapes, and writes results to audit_results.json.
 *
 * Usage:
 *   node scripts/audit_api.js [BASE_URL]
 *
 * Default BASE_URL = http://localhost:3000
 *
 * Auth: The script logs in as the admin first to obtain session cookies,
 * then uses those cookies for all subsequent requests.
 */

const BASE = process.argv[2] || "http://localhost:3000";

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function req(method, path, { body, headers: extraHeaders, cookie, expectJson = true } = {}) {
  const url = `${BASE}${path}`;
  const headers = { ...extraHeaders };
  if (cookie) headers["Cookie"] = cookie;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const start = Date.now();
  let status = 0;
  let json = null;
  let text = null;
  let error = null;

  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: "manual",
    });
    status = res.status;

    // Capture Set-Cookie for session persistence
    const setCookie = res.headers.get("set-cookie");

    if (expectJson) {
      const raw = await res.text();
      try {
        json = JSON.parse(raw);
      } catch {
        text = raw;
      }
    }
    return { status, json, text, error, setCookie, ms: Date.now() - start };
  } catch (e) {
    error = e.message;
    return { status, json, text, error, setCookie: null, ms: Date.now() - start };
  }
}

function extractCookies(setCookieHeaders) {
  if (!setCookieHeaders) return "";
  // Handle both string and array
  const cookies = Array.isArray(setCookieHeaders)
    ? setCookieHeaders
    : [setCookieHeaders];
  return cookies
    .map((c) => c.split(";")[0])
    .filter(Boolean)
    .join("; ");
}

// ─── Test Definitions ─────────────────────────────────────────────────────────

/**
 * Each test is:
 * {
 *   name: string,
 *   module: string,
 *   method: "GET" | "POST" | "PATCH" | "DELETE",
 *   path: string,
 *   body?: object,              // request body (POST/PATCH)
 *   params?: string,            // query string
 *   auth?: "admin" | "device" | "none",
 *   expectStatus: number[],     // acceptable HTTP status codes
 *   expectKeys?: string[],      // keys that must exist in response JSON
 *   expectError?: boolean,      // if true, expect error: string in body
 *   description?: string,
 * }
 */

const TESTS = [
  // ─── Auth ────────────────────────────────────────────────────────────────
  {
    name: "POST /api/admin/login (valid credentials)",
    module: "auth",
    method: "POST",
    path: "/api/admin/login",
    body: { email: "alburj@makeen.com", password: "admin123" },
    auth: "none",
    expectStatus: [200],
    expectKeys: ["store", "cashier", "admin", "branches", "terminals"],
    description: "Admin dashboard login",
  },
  {
    name: "POST /api/admin/login (bad password)",
    module: "auth",
    method: "POST",
    path: "/api/admin/login",
    body: { email: "alburj@makeen.com", password: "wrong" },
    auth: "none",
    expectStatus: [401],
    expectError: true,
    description: "Invalid password should return 401",
  },
  {
    name: "POST /api/admin/login (missing email)",
    module: "auth",
    method: "POST",
    path: "/api/admin/login",
    body: { password: "admin123" },
    auth: "none",
    expectStatus: [400],
    expectError: true,
    description: "Missing email should return 400",
  },
  {
    name: "POST /api/admin/login (empty body)",
    module: "auth",
    method: "POST",
    path: "/api/admin/login",
    body: {},
    auth: "none",
    expectStatus: [400],
    expectError: true,
    description: "Empty body should return 400",
  },

  // ─── Catalog ─────────────────────────────────────────────────────────────
  {
    name: "GET /api/catalog (products list)",
    module: "catalog",
    method: "GET",
    path: "/api/catalog",
    auth: "device",
    expectStatus: [200],
    expectKeys: ["products"],
    description: "Product catalog list",
  },
  {
    name: "GET /api/catalog/products",
    module: "catalog",
    method: "GET",
    path: "/api/catalog/products",
    auth: "device",
    expectStatus: [200],
  },
  {
    name: "GET /api/catalog/products?q=test&limit=5",
    module: "catalog",
    method: "GET",
    path: "/api/catalog/products/search?q=test&limit=5",
    auth: "device",
    expectStatus: [200, 403],
    expectKeys: ["products"],
    description: "Product search (requires inventory.view)",
  },
  {
    name: "GET /api/catalog/references",
    module: "catalog",
    method: "GET",
    path: "/api/catalog/references",
    auth: "device",
    expectStatus: [200],
  },
  {
    name: "GET /api/catalog/labels",
    module: "catalog",
    method: "GET",
    path: "/api/catalog/labels",
    auth: "device",
    expectStatus: [200],
  },
  {
    name: "POST /api/catalog/import (invalid body)",
    module: "catalog",
    method: "POST",
    path: "/api/catalog/import",
    body: {},
    auth: "device",
    expectStatus: [400],
    expectError: true,
    description: "Import with empty body should fail",
  },

  // ─── Branches ────────────────────────────────────────────────────────────
  {
    name: "GET /api/branches",
    module: "branches",
    method: "GET",
    path: "/api/branches",
    auth: "device",
    expectStatus: [200],
    expectKeys: ["branches"],
  },
  {
    name: "POST /api/branches (empty name)",
    module: "branches",
    method: "POST",
    path: "/api/branches",
    body: { name: "" },
    auth: "device",
    expectStatus: [400],
    expectError: true,
  },
  {
    name: "POST /api/branches (valid)",
    module: "branches",
    method: "POST",
    path: "/api/branches",
    body: { name: `__audit_test_branch_${Date.now()}` },
    auth: "device",
    expectStatus: [200],
    expectKeys: ["branch"],
    description: "Creates a test branch (may fail if no manage capability)",
  },

  // ─── Terminals ───────────────────────────────────────────────────────────
  {
    name: "GET /api/terminals",
    module: "terminals",
    method: "GET",
    path: "/api/terminals",
    auth: "device",
    expectStatus: [200],
    expectKeys: ["terminals"],
  },

  // ─── Stores ──────────────────────────────────────────────────────────────
  {
    name: "GET /api/stores",
    module: "stores",
    method: "GET",
    path: "/api/stores",
    auth: "device",
    expectStatus: [200],
  },

  // ─── Customers ───────────────────────────────────────────────────────────
  {
    name: "GET /api/customers",
    module: "customers",
    method: "GET",
    path: "/api/customers",
    auth: "device",
    expectStatus: [200, 304],
    expectKeys: ["customers"],
  },
  {
    name: "POST /api/customers (empty name)",
    module: "customers",
    method: "POST",
    path: "/api/customers",
    body: { name: "" },
    auth: "device",
    expectStatus: [400],
    expectError: true,
  },

  // ─── Suppliers ───────────────────────────────────────────────────────────
  {
    name: "GET /api/suppliers",
    module: "suppliers",
    method: "GET",
    path: "/api/suppliers",
    auth: "device",
    expectStatus: [200],
  },
  {
    name: "GET /api/supplier-accounts",
    module: "supplier-accounts",
    method: "GET",
    path: "/api/supplier-accounts",
    auth: "device",
    expectStatus: [200],
  },

  // ─── Expenses ────────────────────────────────────────────────────────────
  {
    name: "GET /api/expenses",
    module: "expenses",
    method: "GET",
    path: "/api/expenses",
    auth: "device",
    expectStatus: [200],
    expectKeys: ["expenses"],
  },
  {
    name: "GET /api/expenses?category=rent",
    module: "expenses",
    method: "GET",
    path: "/api/expenses?category=rent",
    auth: "device",
    expectStatus: [200],
  },
  {
    name: "POST /api/expenses (invalid category)",
    module: "expenses",
    method: "POST",
    path: "/api/expenses",
    body: { category: "INVALID", amount: 10 },
    auth: "device",
    expectStatus: [400],
    expectError: true,
  },
  {
    name: "POST /api/expenses (zero amount)",
    module: "expenses",
    method: "POST",
    path: "/api/expenses",
    body: { category: "rent", amount: 0 },
    auth: "device",
    expectStatus: [400],
    expectError: true,
  },

  // ─── Inventory ───────────────────────────────────────────────────────────
  {
    name: "GET /api/inventory/movements",
    module: "inventory",
    method: "GET",
    path: "/api/inventory/movements",
    auth: "device",
    expectStatus: [200],
  },

  // ─── Shifts ──────────────────────────────────────────────────────────────
  {
    name: "GET /api/shifts",
    module: "shifts",
    method: "GET",
    path: "/api/shifts",
    auth: "device",
    expectStatus: [200],
    expectKeys: ["shifts", "total", "page", "summary"],
    description: "Closed shifts list",
  },
  {
    name: "GET /api/shifts?page=1&pageSize=10",
    module: "shifts",
    method: "GET",
    path: "/api/shifts?page=1&pageSize=10",
    auth: "device",
    expectStatus: [200],
  },
  {
    name: "GET /api/shifts (bad date range)",
    module: "shifts",
    method: "GET",
    path: "/api/shifts?from=2099-01-01&to=2000-01-01",
    auth: "device",
    expectStatus: [400],
    expectError: true,
  },
  {
    name: "GET /api/shifts/open",
    module: "shifts",
    method: "GET",
    path: "/api/shifts/open",
    auth: "device",
    expectStatus: [200],
    expectKeys: ["shifts"],
  },

  // ─── Shortages ───────────────────────────────────────────────────────────
  {
    name: "GET /api/shortages",
    module: "shortages",
    method: "GET",
    path: "/api/shortages",
    auth: "device",
    expectStatus: [200],
  },
  {
    name: "POST /api/shortages (no body)",
    module: "shortages",
    method: "POST",
    path: "/api/shortages",
    body: {},
    auth: "device",
    expectStatus: [400],
    expectError: true,
  },

  // ─── Risk ────────────────────────────────────────────────────────────────
  {
    name: "GET /api/risk",
    module: "risk",
    method: "GET",
    path: "/api/risk",
    auth: "device",
    expectStatus: [200],
    expectKeys: ["events", "total", "summary", "truncated"],
  },
  {
    name: "GET /api/risk?status=OPEN",
    module: "risk",
    method: "GET",
    path: "/api/risk?status=OPEN",
    auth: "device",
    expectStatus: [200],
  },
  {
    name: "PATCH /api/risk (invalid id)",
    module: "risk",
    method: "PATCH",
    path: "/api/risk",
    body: { id: "not-a-uuid", status: "REVIEWED", note: "test" },
    auth: "device",
    expectStatus: [400],
    expectError: true,
  },

  // ─── Reports ─────────────────────────────────────────────────────────────
  {
    name: "GET /api/reports/overview",
    module: "reports",
    method: "GET",
    path: "/api/reports/overview",
    auth: "device",
    expectStatus: [200],
    expectKeys: ["overview"],
  },
  {
    name: "GET /api/reports/sales",
    module: "reports",
    method: "GET",
    path: "/api/reports/sales",
    auth: "device",
    expectStatus: [200],
  },
  {
    name: "GET /api/reports/profitability",
    module: "reports",
    method: "GET",
    path: "/api/reports/profitability",
    auth: "device",
    expectStatus: [200],
  },

  // ─── Settings ────────────────────────────────────────────────────────────
  {
    name: "GET /api/settings",
    module: "settings",
    method: "GET",
    path: "/api/settings",
    auth: "admin",
    expectStatus: [200],
    expectKeys: ["settings"],
    description: "Requires admin session cookie",
  },
  {
    name: "PATCH /api/settings (invalid email)",
    module: "settings",
    method: "PATCH",
    path: "/api/settings",
    body: { name: "test", email: "not-an-email" },
    auth: "admin",
    expectStatus: [400],
    expectError: true,
  },

  // ─── Admin: Cashiers ─────────────────────────────────────────────────────
  {
    name: "GET /api/admin/cashiers",
    module: "admin",
    method: "GET",
    path: "/api/admin/cashiers",
    auth: "admin",
    expectStatus: [200],
  },

  // ─── Admin: Roles ────────────────────────────────────────────────────────
  {
    name: "GET /api/admin/roles",
    module: "admin",
    method: "GET",
    path: "/api/admin/roles",
    auth: "admin",
    expectStatus: [200],
  },

  // ─── Admin: Stores ───────────────────────────────────────────────────────
  {
    name: "GET /api/admin/stores",
    module: "admin",
    method: "GET",
    path: "/api/admin/stores",
    auth: "admin",
    expectStatus: [200],
  },

  // ─── Admin: Audit ────────────────────────────────────────────────────────
  {
    name: "GET /api/admin/audit",
    module: "admin",
    method: "GET",
    path: "/api/admin/audit",
    auth: "admin",
    expectStatus: [200],
  },

  // ─── Admin: Account ──────────────────────────────────────────────────────
  {
    name: "GET /api/admin/account",
    module: "admin",
    method: "GET",
    path: "/api/admin/account",
    auth: "admin",
    expectStatus: [200],
  },

  // ─── Loyalty ─────────────────────────────────────────────────────────────
  {
    name: "GET /api/loyalty",
    module: "loyalty",
    method: "GET",
    path: "/api/loyalty",
    auth: "device",
    expectStatus: [200],
  },

  // ─── Print Templates ─────────────────────────────────────────────────────
  {
    name: "GET /api/print-templates",
    module: "print-templates",
    method: "GET",
    path: "/api/print-templates",
    auth: "device",
    expectStatus: [200],
  },

  // ─── Access ──────────────────────────────────────────────────────────────
  {
    name: "GET /api/access",
    module: "access",
    method: "GET",
    path: "/api/access",
    auth: "device",
    expectStatus: [200],
  },

  // ─── Receiving ───────────────────────────────────────────────────────────
  {
    name: "GET /api/receiving/suppliers",
    module: "receiving",
    method: "GET",
    path: "/api/receiving/suppliers",
    auth: "device",
    expectStatus: [200],
  },
  {
    name: "GET /api/receiving/price-history",
    module: "receiving",
    method: "GET",
    path: "/api/receiving/price-history",
    auth: "device",
    expectStatus: [200],
  },

  // ─── Auth: Register ──────────────────────────────────────────────────────
  {
    name: "POST /api/auth/register (empty body)",
    module: "auth",
    method: "POST",
    path: "/api/auth/register",
    body: {},
    auth: "none",
    expectStatus: [400],
    expectError: true,
  },

  // ─── Login (POS) ─────────────────────────────────────────────────────────
  {
    name: "POST /api/login (empty body)",
    module: "auth",
    method: "POST",
    path: "/api/login",
    body: {},
    auth: "none",
    expectStatus: [400],
    expectError: true,
  },

  // ─── ISTD ────────────────────────────────────────────────────────────────
  {
    name: "POST /api/istd/submit (empty body)",
    module: "istd",
    method: "POST",
    path: "/api/istd/submit",
    body: {},
    auth: "device",
    expectStatus: [400],
    expectError: true,
  },

  // ─── Sync ────────────────────────────────────────────────────────────────
  {
    name: "POST /api/sync (empty batch)",
    module: "sync",
    method: "POST",
    path: "/api/sync",
    body: { events: [] },
    auth: "device",
    expectStatus: [200],
    description: "Empty sync batch should succeed",
  },

  // ─── Admin: Logout ───────────────────────────────────────────────────────
  {
    name: "POST /api/admin/logout",
    module: "auth",
    method: "POST",
    path: "/api/admin/logout",
    auth: "admin",
    expectStatus: [200],
  },

  // ─── Auth: Unauthenticated access ────────────────────────────────────────
  {
    name: "GET /api/branches (no auth)",
    module: "auth",
    method: "GET",
    path: "/api/branches",
    auth: "none",
    expectStatus: [401, 403, 200],
    description: "Should work via device session or return 401",
  },
  {
    name: "GET /api/settings (no auth)",
    module: "auth",
    method: "GET",
    path: "/api/settings",
    auth: "none",
    expectStatus: [401],
    description: "Settings requires admin session",
  },
  {
    name: "GET /api/risk (no auth)",
    module: "auth",
    method: "GET",
    path: "/api/risk",
    auth: "none",
    expectStatus: [401, 403, 200],
  },

  // ─── Supplier Accounts (write) ───────────────────────────────────────────
  {
    name: "POST /api/supplier-accounts (empty body)",
    module: "supplier-accounts",
    method: "POST",
    path: "/api/supplier-accounts",
    body: {},
    auth: "device",
    expectStatus: [400],
    expectError: true,
  },

  // ─── Customers (transactions) ────────────────────────────────────────────
  {
    name: "GET /api/customers/fake-id/transactions",
    module: "customers",
    method: "GET",
    path: "/api/customers/00000000-0000-0000-0000-000000000000/transactions",
    auth: "device",
    expectStatus: [200, 404],
  },

  // ─── Print Server ────────────────────────────────────────────────────────
  {
    name: "GET /api/print-server",
    module: "print-server",
    method: "GET",
    path: "/api/print-server",
    auth: "device",
    expectStatus: [200],
  },

  // ─── Tax Settings ────────────────────────────────────────────────────────
  {
    name: "GET /api/settings/tax",
    module: "settings",
    method: "GET",
    path: "/api/settings/tax",
    auth: "admin",
    expectStatus: [200],
  },

  // ─── Admin Reverify ──────────────────────────────────────────────────────
  {
    name: "POST /api/admin/reverify (empty)",
    module: "admin",
    method: "POST",
    path: "/api/admin/reverify",
    body: {},
    auth: "admin",
    expectStatus: [400],
    expectError: true,
  },
];

// ─── Runner ───────────────────────────────────────────────────────────────────

async function run() {
  console.log(`\n🔍 Makeen POS — Comprehensive System Audit`);
  console.log(`   Base URL: ${BASE}`);
  console.log(`   Tests: ${TESTS.length}\n`);

  // 1. Login to get admin session cookie
  console.log("─── Phase 1: Authentication ──────────────────────────────");
  let adminCookie = "";
  let deviceCookie = "";

  const loginRes = await req("POST", "/api/admin/login", {
    body: { email: "alburj@makeen.com", password: "admin123" },
  });
  if (loginRes.status === 200 && loginRes.json?.store) {
    adminCookie = extractCookies(loginRes.setCookie);
    // Extract device session cookie too (Set-Cookie may have multiple)
    if (loginRes.setCookie) {
      const allCookies = Array.isArray(loginRes.setCookie)
        ? loginRes.setCookie
        : [loginRes.setCookie];
      const deviceParts = allCookies
        .filter((c) => c.includes("pos_device_session"))
        .map((c) => c.split(";")[0]);
      deviceCookie = deviceParts.join("; ");
    }
    console.log(`   ✅ Admin login OK (store: ${loginRes.json.store.name})`);
    if (!deviceCookie) deviceCookie = adminCookie;
  } else {
    console.log(`   ⚠️  Admin login returned ${loginRes.status} — some tests may fail`);
    console.log(`   Response:`, JSON.stringify(loginRes.json || loginRes.error).slice(0, 200));
  }

  // 2. Run all tests
  console.log("\n─── Phase 2: API Endpoint Tests ─────────────────────────\n");

  const results = [];
  let passed = 0;
  let failed = 0;

  for (const test of TESTS) {
    // Resolve auth cookie
    let cookie = "";
    if (test.auth === "admin") cookie = adminCookie;
    else if (test.auth === "device") cookie = deviceCookie || adminCookie;
    // auth === "none" → no cookie

    const pathWithParams = test.params ? `${test.path}?${test.params}` : test.path;
    const res = await req(test.method, pathWithParams, {
      body: test.body,
      cookie,
    });

    const statusOk = test.expectStatus.includes(res.status);
    const keysOk = !test.expectKeys || !res.json
      ? true
      : test.expectKeys.every((k) => k in res.json);
    const errorOk = test.expectError === undefined
      ? true
      : test.expectError === Boolean(res.json?.error);

    const ok = statusOk && keysOk && errorOk;
    const icon = ok ? "✅" : "❌";

    if (ok) passed++;
    else failed++;

    const result = {
      name: test.name,
      module: test.module,
      method: test.method,
      path: test.path,
      expectedStatus: test.expectStatus,
      actualStatus: res.status,
      statusOk,
      keysOk,
      errorOk,
      ok,
      ms: res.ms,
      responseKeys: res.json ? Object.keys(res.json) : null,
      error: res.error || null,
      description: test.description || null,
    };
    results.push(result);

    const statusStr = statusOk
      ? `${res.status}`
      : `${res.status} (expected ${test.expectStatus.join("|")})`;
    const keysStr = test.expectKeys && !keysOk
      ? ` missing: ${test.expectKeys.filter((k) => !(k in (res.json || {}))).join(", ")}`
      : "";
    const errStr = !errorOk
      ? ` error_mismatch`
      : "";
    console.log(`   ${icon} ${test.method.padEnd(6)} ${test.path.padEnd(45)} ${statusStr.padEnd(10)} ${res.ms}ms${keysStr}${errStr}`);
  }

  // 3. Summary by module
  console.log("\n─── Phase 3: Summary by Module ──────────────────────────\n");

  const byModule = {};
  for (const r of results) {
    if (!byModule[r.module]) byModule[r.module] = { pass: 0, fail: 0, tests: [] };
    if (r.ok) byModule[r.module].pass++;
    else byModule[r.module].fail++;
    byModule[r.module].tests.push(r);
  }

  for (const [mod, data] of Object.entries(byModule).sort((a, b) => a[0].localeCompare(b[0]))) {
    const icon = data.fail === 0 ? "✅" : "❌";
    console.log(`   ${icon} ${mod.padEnd(20)} ${data.pass}/${data.pass + data.fail} passed`);
    for (const t of data.tests.filter((t) => !t.ok)) {
      console.log(`      ❌ ${t.method} ${t.path} → ${t.actualStatus} (expected ${t.expectedStatus.join("|")})`);
    }
  }

  // 4. Write results
  const report = {
    timestamp: new Date().toISOString(),
    baseUrl: BASE,
    totalTests: results.length,
    passed,
    failed,
    successRate: `${((passed / results.length) * 100).toFixed(1)}%`,
    results,
    summary: Object.fromEntries(
      Object.entries(byModule).map(([mod, data]) => [
        mod,
        { passed: data.pass, failed: data.fail, total: data.pass + data.fail },
      ])
    ),
  };

  const fs = require("fs");
  const outPath = require("path").join(__dirname, "..", "audit_results.json");
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");

  console.log(`\n─── Final Results ───────────────────────────────────────`);
  console.log(`   Total: ${results.length} | Passed: ${passed} | Failed: ${failed}`);
  console.log(`   Success Rate: ${report.successRate}`);
  console.log(`   Report written to: audit_results.json`);

  if (failed > 0) {
    console.log(`\n   ⚠️  ${failed} test(s) failed. See audit_results.json for details.`);
    process.exit(1);
  } else {
    console.log(`\n   🎉 All tests passed!`);
    process.exit(0);
  }
}

run().catch((e) => {
  console.error("Audit script crashed:", e);
  process.exit(2);
});
