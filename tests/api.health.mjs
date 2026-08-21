/**
 * API integration health sweep.
 *
 * Runs against a running Next server (BASE_URL or http://127.0.0.1:3100).
 * Verifies every route returns structured JSON and handles valid, missing,
 * and malformed payloads without crashing. Expectations are mode-aware:
 * without Supabase keys (mock mode) DB-backed routes return 503; the
 * catalog/shifts/sync routes keep working locally.
 */
const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:3100";

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

async function req(path, { method = "GET", body, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.body = body;
    if (typeof body === "string") init.headers["Content-Type"] = "text/plain";
    else init.headers["Content-Type"] = "application/json";
  }
  const res = await fetch(`${BASE_URL}${path}`, init);
  let json = null;
  let jsonOk = true;
  try {
    json = await res.json();
  } catch {
    jsonOk = false;
  }
  return { status: res.status, json, jsonOk, res };
}

/**
 * Split a joined `set-cookie` header into { name: value } pairs. Our session
 * cookies are base64url + hex (no commas), so splitting on "," is safe.
 */
function parseSetCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  for (const part of header.split(",")) {
    const nv = part.split(";", 1)[0];
    const eq = nv.indexOf("=");
    if (eq < 0) continue;
    cookies[nv.slice(0, eq).trim()] = nv.slice(eq + 1).trim();
  }
  return cookies;
}

const ADMIN = { "x-pos-role": "admin" };
const STORE = { "x-pos-store-id": "store-main" };
const SUPER = { "x-pos-super-admin-pin": "7777" };

function expectStatus(name, actual, expected, extra = "") {
  ok(actual.status === expected, `${name}: expected ${expected} got ${actual.status}${extra}`);
  ok(actual.jsonOk, `${name}: response body must be JSON${extra}`);
}

async function main() {
  // Detect mode: the catalog endpoint never 503s; DB-backed GETs tell us.
  // (The store header is required in live mode, so the probe first proves
  // that a tenantless request is rejected before the real snapshot check.)
  const probe = await req("/api/catalog");
  const mock = probe.status === 200 && probe.json?.categories !== undefined;
  console.log(`mode: ${mock ? "mock (no Supabase keys)" : "live"}`);
  if (!mock) {
    ok(probe.status === 400, "GET /api/catalog no-store-header -> 400 store_id_required");
  }
  const catalog = await req("/api/catalog", { headers: STORE });
  ok(catalog.status === 200, "GET /api/catalog -> 200");
  ok(
    catalog.json?.categories &&
      catalog.json?.products &&
      catalog.json?.barcodes &&
      catalog.json?.barcodeIndex &&
      catalog.json?.cashiers,
    "GET /api/catalog -> snapshot shape (categories/products/barcodes/barcodeIndex/cashiers)",
  );

  // ---- GET sweep ---------------------------------------------------------
  const dbGetExpect = mock ? 503 : 200;
  const gets = [
    ["/api/customers", dbGetExpect],
    ["/api/suppliers", dbGetExpect],
    ["/api/catalog/references?type=category", dbGetExpect],
    ["/api/expenses", dbGetExpect],
    ["/api/purchase-orders", dbGetExpect],
    ["/api/customers/some-id/transactions", dbGetExpect],
  ];
  for (const [path, expect] of gets) {
    const r = await req(path, { headers: STORE });
    expectStatus(`GET ${path}`, r, expect);
    if (mock) ok(r.json?.error, `GET ${path} mock -> error message`);
  }

  const shifts = await req("/api/shifts", { headers: STORE });
  ok(shifts.status < 500, "GET /api/shifts -> not 5xx");
  ok(Array.isArray(shifts.json?.shifts), "GET /api/shifts -> shifts array");
  const shiftsTerminal = await req("/api/shifts?terminalId=terminal-main", { headers: STORE });
  ok(shiftsTerminal.status < 500, "GET /api/shifts?terminalId= -> not 5xx");
  ok(Array.isArray(shiftsTerminal.json?.shifts), "GET /api/shifts?terminalId= -> shifts array");

  // ---- POST/PATCH authorization + payload sweep --------------------------
  const endpoints = [
    ["customers", "POST", { name: "زبون تجريبي", phone: "0770000000" }],
    ["suppliers", "POST", { name: "مورد تجريبي", phone: "0790000000" }],
    ["expenses", "POST", { category: "نثريات", amount: 5, notes: "test" }],
    ["purchase-orders", "POST", { supplier_id: "s-1", items: [{ product_id: "p-1", quantity: 2, unit_cost: 3 }] }],
    ["purchase-orders", "PATCH", { id: "po-1" }],
  ];

  for (const [base, verb, validPayload] of endpoints) {
    const path = `/api/${base}`;
    const label = `${verb} ${path}`;

    // No store header: isolated tenants must be rejected before any work.
    const noStore = await req(path, { method: verb, headers: ADMIN });
    expectStatus(`${label} no-store-header`, noStore, mock ? 503 : 400, ` (mock=${mock})`);

    // Without the admin header (store present).
    const anon = await req(path, { method: verb, headers: STORE, body: JSON.stringify(validPayload) });
    expectStatus(`${label} no-admin-header`, anon, mock ? 503 : 403, ` (mock=${mock})`);

    // Missing body must not 500. In mock mode the Supabase guard 503s before
    // the body is ever parsed; with a configured DB the parse guard 400s.
    const missing = await req(path, { method: verb, headers: { ...STORE, ...ADMIN } });
    expectStatus(`${label} missing-body`, missing, mock ? 503 : 400, " (no 500 crash)");

    // Malformed JSON must not 500 (same mock-mode short-circuit).
    const malformed = await req(path, { method: verb, body: "{not json", headers: { ...STORE, ...ADMIN } });
    expectStatus(`${label} malformed-body`, malformed, mock ? 503 : 400, " (no 500 crash)");

    if (!mock) {
      // Live mode: validation 400s and authorized attempts must not crash.
      const invalid = await req(path, { method: verb, body: JSON.stringify({}), headers: { ...STORE, ...ADMIN } });
      ok(invalid.jsonOk, `${label} invalid-value -> JSON response`);
      const valid = await req(path, { method: verb, body: JSON.stringify(validPayload), headers: { ...STORE, ...ADMIN } });
      ok(valid.jsonOk, `${label} valid -> JSON response (status ${valid.status})`);
    }
  }

  // Customer transaction ledger POST (sub-route).
  const txPath = "/api/customers/some-id/transactions";
  const txNoStore = await req(txPath, { method: "POST", headers: ADMIN, body: JSON.stringify({ type: "SETTLEMENT", amount: 10 }) });
  expectStatus(`POST ${txPath} no-store-header`, txNoStore, mock ? 503 : 400);
  const txAnon = await req(txPath, { method: "POST", headers: STORE, body: JSON.stringify({ type: "SETTLEMENT", amount: 10 }) });
  expectStatus(`POST ${txPath} no-admin-header`, txAnon, mock ? 503 : 403);
  const txMissing = await req(txPath, { method: "POST", headers: { ...STORE, ...ADMIN } });
  expectStatus(`POST ${txPath} missing-body`, txMissing, mock ? 503 : 400);
  const txMalformed = await req(txPath, { method: "POST", body: "nope", headers: { ...STORE, ...ADMIN } });
  expectStatus(`POST ${txPath} malformed-body`, txMalformed, mock ? 503 : 400);

  // CSV import: empty text and malformed CSV must not crash.
  const impNoStore = await req("/api/catalog/import", { method: "POST", headers: ADMIN, body: "" });
  expectStatus(`POST /api/catalog/import no-store-header`, impNoStore, mock ? 503 : 400);
  const impAnon = await req("/api/catalog/import", { method: "POST", headers: STORE, body: "" });
  expectStatus(`POST /api/catalog/import no-admin-header`, impAnon, mock ? 503 : 403);
  const impEmpty = await req("/api/catalog/import", { method: "POST", body: "Category, Product Name\n", headers: { ...STORE, ...ADMIN } });
  ok(impEmpty.status === 400 || (mock && impEmpty.status === 503), "POST /api/catalog/import empty csv -> 400 (or mock 503)");
  const impBad = await req("/api/catalog/import", { method: "POST", body: "Category, Product Name\n\n", headers: { ...STORE, ...ADMIN } });
  ok(impBad.status === 400 || (mock && impBad.status === 503), "POST /api/catalog/import blank rows -> 400 (or mock 503)");

  const productNoStore = await req("/api/catalog/products", {
    method: "POST",
    headers: ADMIN,
    body: JSON.stringify({ name: "Test", category: "Cat", variants: [] }),
  });
  expectStatus("POST /api/catalog/products no-store-header", productNoStore, mock ? 503 : 400);
  const productAnon = await req("/api/catalog/products", {
    method: "POST",
    headers: STORE,
    body: JSON.stringify({ name: "Test", category: "Cat", variants: [] }),
  });
  expectStatus("POST /api/catalog/products no-admin-header", productAnon, mock ? 503 : 403);
  const productMissingBody = await req("/api/catalog/products", { method: "POST", headers: { ...STORE, ...ADMIN } });
  expectStatus("POST /api/catalog/products missing-body", productMissingBody, mock ? 503 : 400);
  const productInvalid = await req("/api/catalog/products", {
    method: "POST",
    headers: { ...STORE, ...ADMIN },
    body: JSON.stringify({ name: "   ", category: "Cat", variants: [] }),
  });
  expectStatus("POST /api/catalog/products invalid-body", productInvalid, mock ? 503 : 400);
  const productDeleteNoStore = await req("/api/catalog/products/not-real", { method: "DELETE", headers: ADMIN });
  expectStatus("DELETE /api/catalog/products/[id] no-store-header", productDeleteNoStore, mock ? 503 : 400);

  const referenceNoStore = await req("/api/catalog/references?type=category", {
    method: "POST",
    headers: ADMIN,
    body: JSON.stringify({ name: "اختبار" }),
  });
  expectStatus("POST /api/catalog/references no-store-header", referenceNoStore, mock ? 503 : 400);
  const referenceAnon = await req("/api/catalog/references?type=brand", {
    method: "POST",
    headers: STORE,
    body: JSON.stringify({ name: "اختبار" }),
  });
  expectStatus("POST /api/catalog/references no-admin-header", referenceAnon, mock ? 503 : 403);
  const referenceMissing = await req("/api/catalog/references?type=category", {
    method: "POST",
    headers: { ...STORE, ...ADMIN },
  });
  expectStatus("POST /api/catalog/references missing-body", referenceMissing, mock ? 503 : 400);

  // ---- /api/sync round-trip ----------------------------------------------
  const validEvent = {
    sync_id: `test-${Date.now()}`,
    action_type: "INVOICE_CREATED",
    payload: {
      items: [{ productId: "p-1", barcode: "12345", qty: 1, unitPrice: 1, lineTotal: 1, discount: 0 }],
      subtotal: 1,
      tax: 0.16,
      discount: 0,
      total: 1.16,
      paymentMethod: "CASH",
      amountPaid: 2,
      change: 0.84,
      completed_at: new Date().toISOString(),
    },
  };

  const syncMissing = await req("/api/sync", { method: "POST" });
  expectStatus("POST /api/sync missing-body", syncMissing, 400);

  const syncMalformed = await req("/api/sync", { method: "POST", body: "{oops" });
  expectStatus("POST /api/sync malformed-body", syncMalformed, 400);

  const syncScalar = await req("/api/sync", { method: "POST", body: JSON.stringify("not-an-array") });
  expectStatus("POST /api/sync non-array", syncScalar, 400);

  if (!mock) {
    // Live mode sync is tenant-scoped: a batch without the store header is rejected.
    const syncNoStore = await req("/api/sync", { method: "POST", body: JSON.stringify([validEvent]) });
    expectStatus("POST /api/sync no-store-header", syncNoStore, 400);
  }

  const syncValid = await req("/api/sync", { method: "POST", headers: STORE, body: JSON.stringify([validEvent]) });
  ok(syncValid.status === 200, "POST /api/sync valid batch -> 200");
  ok(syncValid.json?.success === true, "POST /api/sync valid batch -> success true");
  ok(Array.isArray(syncValid.json?.synced_ids) && syncValid.json.synced_ids[0] === validEvent.sync_id, "POST /api/sync echoes sync_id");

  const invalidAction = { ...validEvent, sync_id: `test-invalid-${Date.now()}`, action_type: "GARBAGE" };
  const syncMixed = await req("/api/sync", { method: "POST", headers: STORE, body: JSON.stringify([validEvent, invalidAction, null]) });
  ok(syncMixed.status === 200, "POST /api/sync mixed batch -> 200");
  ok(syncMixed.json?.received === 1, "POST /api/sync mixed batch -> only valid events counted");

  // ---- Multi-tenant routes ------------------------------------------------
  const registry = await req("/api/stores");
  ok(registry.status === 200, "GET /api/stores -> 200");
  ok(Array.isArray(registry.json?.stores) && registry.json.stores.length > 0, "GET /api/stores -> stores array");
  ok(registry.json?.stores[0]?.subscriptionStatus === "active", "GET /api/stores -> only active stores");

  const loginNoStore = await req("/api/login", { method: "POST", body: JSON.stringify({ pin: "1234" }) });
  expectStatus("POST /api/login missing-storeId", loginNoStore, 400);
  const loginShortPin = await req("/api/login", { method: "POST", body: JSON.stringify({ pin: "12", storeId: "store-main" }) });
  expectStatus("POST /api/login short-pin", loginShortPin, 400);
  const loginBad = await req("/api/login", { method: "POST", body: JSON.stringify({ pin: "0000", storeId: "store-main" }) });
  expectStatus("POST /api/login wrong-pin", loginBad, 401);
  const loginOk = await req("/api/login", { method: "POST", body: JSON.stringify({ pin: "1234", storeId: "store-main" }) });
  ok(loginOk.status === 200, "POST /api/login valid -> 200");
  ok(loginOk.json?.store?.id === "store-main" && loginOk.json?.cashier, "POST /api/login -> store + cashier context");
  ok(typeof loginOk.json?.store?.taxPercent === "number" && typeof loginOk.json?.store?.taxNumber === "string", "POST /api/login -> fiscal tax on store");
  ok(Array.isArray(loginOk.json?.branches) && Array.isArray(loginOk.json?.terminals), "POST /api/login -> branches + terminals registry");
  ok(loginOk.json?.defaultBranchId && loginOk.json?.defaultTerminalId, "POST /api/login -> default branch + terminal ids");

  // A staff/cashier login must issue a fresh device cookie AND immediately
  // revoke any older owner (pos_admin) cookie — otherwise the register would
  // carry admin privileges after a handover and the operator would be forced
  // to clear cookies by hand before the owner can sign back in.
  if (mock) {
    const loginCookies = parseSetCookies(loginOk.res.headers.get("set-cookie") ?? "");
    ok(Boolean(loginCookies["pos_device"]), "POST /api/login -> issues a new device session cookie");
    ok(loginCookies["pos_admin"] === "", "POST /api/login -> clears the owner (pos_admin) cookie");
    // A PIN-only cashier device cookie must never unlock owner capability
    // routes (the shifts X-report requires shifts.x_report).
    if (loginCookies["pos_device"]) {
      const cashierDenied = await req("/api/shifts/open", { headers: { Cookie: loginCookies["pos_device"] } });
      expectStatus("GET /api/shifts/open cashier-device-cookie", cashierDenied, 401);
    }
  }

  // ---- Branches + terminals (multi-terminal architecture) ---------------
  const branchesGet = await req("/api/branches", { headers: STORE });
  ok(branchesGet.status === 200, "GET /api/branches -> 200");
  ok(Array.isArray(branchesGet.json?.branches), "GET /api/branches -> branches array");
  ok(
    branchesGet.json?.branches[0]?.id && Array.isArray(branchesGet.json?.branches[0]?.terminals),
    "GET /api/branches -> branch with nested terminals",
  );
  const branchesNoStore = await req("/api/branches");
  ok(branchesNoStore.status === (mock ? 200 : 400), `GET /api/branches no-store-header -> ${mock ? "200 (mock)" : "400"}`);

  const branchPostNoStore = await req("/api/branches", { method: "POST", headers: ADMIN, body: JSON.stringify({ name: "فرع تجريبي" }) });
  ok(branchPostNoStore.status === (mock ? 200 : 400), `POST /api/branches no-store-header -> ${mock ? "200 (mock)" : "400"}`);
  const branchPostAnon = await req("/api/branches", { method: "POST", headers: STORE, body: JSON.stringify({ name: "فرع تجريبي" }) });
  ok(branchPostAnon.status === (mock ? 200 : 403), `POST /api/branches no-admin-header -> ${mock ? "200 (mock)" : "403"}`);
  const branchPostEmpty = await req("/api/branches", { method: "POST", headers: { ...STORE, ...ADMIN }, body: JSON.stringify({ name: "   " }) });
  expectStatus("POST /api/branches empty-name", branchPostEmpty, 400);
  const branchPostOk = await req("/api/branches", { method: "POST", headers: { ...STORE, ...ADMIN }, body: JSON.stringify({ name: "فرع تجريبي" }) });
  ok(branchPostOk.status === 200 || branchPostOk.status === 201, "POST /api/branches valid -> 2xx");
  ok(
    branchPostOk.json?.branch?.id &&
      Array.isArray(branchPostOk.json?.branch?.terminals) &&
      branchPostOk.json?.branch?.terminals[0]?.name,
    "POST /api/branches -> auto-creates default terminal",
  );

  const terminalPostNoStore = await req("/api/terminals", { method: "POST", headers: ADMIN, body: JSON.stringify({ branch_id: "branch-main", name: "كاشير تجريبي" }) });
  ok(terminalPostNoStore.status === (mock ? 200 : 400), `POST /api/terminals no-store-header -> ${mock ? "200 (mock)" : "400"}`);
  const terminalPostEmpty = await req("/api/terminals", { method: "POST", headers: { ...STORE, ...ADMIN }, body: JSON.stringify({ branch_id: "branch-main", name: "" }) });
  expectStatus("POST /api/terminals empty-name", terminalPostEmpty, 400);
  const terminalPostOk = await req("/api/terminals", { method: "POST", headers: { ...STORE, ...ADMIN }, body: JSON.stringify({ branch_id: "branch-main", name: "كاشير تجريبي" }) });
  ok(terminalPostOk.status === 200 || terminalPostOk.status === 201, "POST /api/terminals valid -> 2xx");
  ok(terminalPostOk.json?.terminal?.id && terminalPostOk.json?.terminal?.name, "POST /api/terminals -> created terminal shape");

  // ---- Store-owner dashboard login (email + password, no tenant dropdown) --
  const adminLoginNoBody = await req("/api/admin/login", { method: "POST" });
  expectStatus("POST /api/admin/login missing-body", adminLoginNoBody, 400);
  const adminLoginNoEmail = await req("/api/admin/login", { method: "POST", body: JSON.stringify({ password: "12345678" }) });
  expectStatus("POST /api/admin/login missing-email", adminLoginNoEmail, 400);
  const adminLoginNoPassword = await req("/api/admin/login", { method: "POST", body: JSON.stringify({ email: "admin@demo.test" }) });
  expectStatus("POST /api/admin/login missing-password", adminLoginNoPassword, 400);
  const adminLoginBad = await req("/api/admin/login", { method: "POST", body: JSON.stringify({ email: "admin@demo.test", password: "wrong" }) });
  expectStatus("POST /api/admin/login wrong-password", adminLoginBad, mock ? 401 : (401 || 200));
  const adminLoginOk = await req("/api/admin/login", { method: "POST", body: JSON.stringify({ email: "admin@demo.test", password: "12345678" }) });
  ok(adminLoginOk.status === 200, "POST /api/admin/login valid -> 200");
  ok(adminLoginOk.json?.store?.id && adminLoginOk.json?.cashier?.role === "admin", "POST /api/admin/login -> store + admin cashier context");
  ok(adminLoginOk.json?.admin?.email, "POST /api/admin/login -> admin session block");
  ok(Array.isArray(adminLoginOk.json?.branches) && Array.isArray(adminLoginOk.json?.terminals), "POST /api/admin/login -> branches + terminals registry");
  if (mock) {
    const adminCookies = parseSetCookies(adminLoginOk.res.headers.get("set-cookie") ?? "");
    ok(
      Boolean(adminCookies["pos_admin"]) && Boolean(adminCookies["pos_device"]),
      "POST /api/admin/login -> sets owner + device session cookies",
    );
  }

  // Admin routes are gated by the server-issued HttpOnly session cookie
  // (F2), not client headers — capture it for the checks below.
  const adminSetCookie = adminLoginOk.res.headers.get("set-cookie") ?? "";
  const posAdminCookie = adminSetCookie.split(";")[0]?.trim() ?? "";
  const SESS = posAdminCookie ? { Cookie: posAdminCookie } : {};

  // ---- Sign-out: /api/admin/logout revokes BOTH HttpOnly cookies ---------
  // The single logout endpoint is shared by the POS lock screen, the admin
  // shell and the mobile page, so clearing both cookies here guarantees the
  // app-root proxy stops bouncing /login back to a stale role home — the
  // precondition for a clean cashier→admin role switch.
  const logout = await req("/api/admin/logout", { method: "POST" });
  if (mock) {
    expectStatus("POST /api/admin/logout", logout, 200);
    const logoutCookies = parseSetCookies(logout.res.headers.get("set-cookie") ?? "");
    ok(
      logoutCookies["pos_admin"] === "" && logoutCookies["pos_device"] === "",
      "POST /api/admin/logout -> clears owner + device session cookies",
    );
  }

  // ---- Accounting X/Z + anti-fraud control plane -------------------------
  const xReportNoSession = await req("/api/shifts/open");
  expectStatus("GET /api/shifts/open no-session", xReportNoSession, 401);
  const xReport = await req("/api/shifts/open", { headers: SESS });
  expectStatus("GET /api/shifts/open owner", xReport, 200);
  ok(Array.isArray(xReport.json?.shifts) && typeof xReport.json?.generatedAt === "string", "GET /api/shifts/open -> live X-report shape");

  const riskNoSession = await req("/api/risk");
  expectStatus("GET /api/risk no-session", riskNoSession, 401);
  const risk = await req("/api/risk", { headers: SESS });
  expectStatus("GET /api/risk owner", risk, 200);
  ok(Array.isArray(risk.json?.events) && typeof risk.json?.summary?.total === "number", "GET /api/risk -> events + aggregate summary");

  const riskReviewNoSession = await req("/api/risk", {
    method: "PATCH",
    body: JSON.stringify({ id: "11111111-1111-4111-8111-111111111111", status: "REVIEWED", note: "reviewed" }),
  });
  expectStatus("PATCH /api/risk no-session", riskReviewNoSession, 401);
  const riskReviewInvalid = await req("/api/risk", {
    method: "PATCH",
    headers: SESS,
    body: JSON.stringify({ id: "bad", status: "REVIEWED", note: "reviewed" }),
  });
  expectStatus("PATCH /api/risk invalid-id", riskReviewInvalid, 400);
  if (mock) {
    const riskReview = await req("/api/risk", {
      method: "PATCH",
      headers: SESS,
      body: JSON.stringify({ id: "11111111-1111-4111-8111-111111111111", status: "REVIEWED", note: "reviewed" }),
    });
    expectStatus("PATCH /api/risk owner", riskReview, 200);
  }

  const shiftApprovalInvalid = await req("/api/shifts/not-a-uuid/approval", {
    method: "POST",
    headers: { ...STORE, ...ADMIN, ...SESS },
    body: JSON.stringify({ password: "12345678", note: "reviewed" }),
  });
  expectStatus("POST /api/shifts/[id]/approval invalid-id", shiftApprovalInvalid, 400);

  const staleResolveNoSession = await req("/api/shifts/11111111-1111-4111-8111-111111111111/resolve", {
    method: "POST",
    body: JSON.stringify({ actualCash: 10, password: "12345678", note: "reviewed" }),
  });
  expectStatus("POST /api/shifts/[id]/resolve no-session", staleResolveNoSession, 401);
  const staleResolveInvalidCash = await req("/api/shifts/11111111-1111-4111-8111-111111111111/resolve", {
    method: "POST",
    headers: { ...STORE, ...ADMIN, ...SESS },
    body: JSON.stringify({ actualCash: -1, password: "12345678", note: "reviewed" }),
  });
  expectStatus("POST /api/shifts/[id]/resolve invalid-cash", staleResolveInvalidCash, 400);
  if (mock) {
    const staleResolve = await req("/api/shifts/11111111-1111-4111-8111-111111111111/resolve", {
      method: "POST",
      headers: { ...STORE, ...ADMIN, ...SESS },
      body: JSON.stringify({ actualCash: 10, password: "12345678", note: "reviewed" }),
    });
    expectStatus("POST /api/shifts/[id]/resolve owner", staleResolve, 200);
    ok(staleResolve.json?.closeSource === "ADMIN_RECOVERY", "POST /api/shifts/[id]/resolve -> administrative Z source");
  }

  // ---- P2: secondary password re-verification (destructive POS actions) ----
  const reverifyNoBody = await req("/api/admin/reverify", { method: "POST" });
  expectStatus("POST /api/admin/reverify missing-body", reverifyNoBody, 400);
  const reverifyNoSession = await req("/api/admin/reverify", { method: "POST", body: JSON.stringify({ password: "12345678" }) });
  expectStatus("POST /api/admin/reverify no-session", reverifyNoSession, 401);
  const reverifyNoPassword = await req("/api/admin/reverify", { method: "POST", headers: SESS, body: JSON.stringify({ email: "admin@demo.test" }) });
  expectStatus("POST /api/admin/reverify missing-password", reverifyNoPassword, 400);
  const reverifyBad = await req("/api/admin/reverify", { method: "POST", headers: SESS, body: JSON.stringify({ email: "admin@demo.test", password: "wrong" }) });
  expectStatus("POST /api/admin/reverify wrong-password", reverifyBad, mock ? 401 : (401 || 200));
  const reverifyOk = await req("/api/admin/reverify", { method: "POST", headers: SESS, body: JSON.stringify({ email: "admin@demo.test", password: "12345678" }) });
  ok(reverifyOk.status === 200, "POST /api/admin/reverify valid -> 200");
  ok(reverifyOk.json?.ok === true, "POST /api/admin/reverify -> {ok:true}");

  // ---- P2: inline admin cashier management (add/edit PINs) -----------------
  const adminEmail = { "x-pos-admin-email": "admin@demo.test" };
  const rolesNoSession = await req("/api/admin/roles");
  expectStatus("GET /api/admin/roles no-session", rolesNoSession, 401);
  const rolesOk = await req("/api/admin/roles", { headers: SESS });
  ok(rolesOk.status === 200, "GET /api/admin/roles valid -> 200");
  ok(Array.isArray(rolesOk.json?.roles) && rolesOk.json.roles.length >= 5, "GET /api/admin/roles -> standard role templates");
  ok(rolesOk.json?.roles?.some((role) => role.code === "accountant" && role.capabilities?.includes("reports.view")), "GET /api/admin/roles -> accountant report capability");
  const invalidCapability = await req("/api/access?capability=system.root", { headers: SESS });
  expectStatus("GET /api/access invalid capability", invalidCapability, 400);
  const ownerCapability = await req("/api/access?capability=reports.view", { headers: SESS });
  ok(ownerCapability.status === 200, "GET /api/access owner capability -> 200");
  ok(ownerCapability.json?.access?.capabilities?.includes("reports.view"), "GET /api/access -> signed capability set");
  const validCashierBody = JSON.stringify({ password: "12345678", cashier: { name: "كاشير جديد", role: "cashier", pin: "5678" } });
  const cashiersNoSession = await req("/api/admin/cashiers", { method: "POST", headers: STORE, body: validCashierBody });
  expectStatus("POST /api/admin/cashiers no-session", cashiersNoSession, 401);
  const cashiersNoCashier = await req("/api/admin/cashiers", { method: "POST", headers: { ...STORE, ...SESS }, body: JSON.stringify({ password: "12345678" }) });
  expectStatus("POST /api/admin/cashiers missing-cashier", cashiersNoCashier, 400);
  const cashiersNoPassword = await req("/api/admin/cashiers", { method: "POST", headers: { ...STORE, ...SESS }, body: JSON.stringify({ cashier: { name: "كاشير جديد", role: "cashier", pin: "5678" } }) });
  expectStatus("POST /api/admin/cashiers missing-password", cashiersNoPassword, 400);
  const cashiersNoName = await req("/api/admin/cashiers", { method: "POST", headers: { ...STORE, ...SESS }, body: JSON.stringify({ password: "12345678", cashier: { role: "cashier", pin: "5678" } }) });
  expectStatus("POST /api/admin/cashiers missing-name", cashiersNoName, 400);
  const cashiersNoRole = await req("/api/admin/cashiers", { method: "POST", headers: { ...STORE, ...SESS }, body: JSON.stringify({ password: "12345678", cashier: { name: "كاشير جديد", pin: "5678" } }) });
  expectStatus("POST /api/admin/cashiers missing-role", cashiersNoRole, 400);
  const cashiersBadPin = await req("/api/admin/cashiers", { method: "POST", headers: { ...STORE, ...SESS }, body: JSON.stringify({ password: "12345678", cashier: { name: "كاشير جديد", role: "cashier", pin: "12" } }) });
  expectStatus("POST /api/admin/cashiers bad-pin", cashiersBadPin, 400);
  const cashiersAdminRole = await req("/api/admin/cashiers", { method: "POST", headers: { ...STORE, ...SESS }, body: JSON.stringify({ password: "12345678", cashier: { name: "مدير إضافي", role: "admin", pin: "5678" } }) });
  expectStatus("POST /api/admin/cashiers admin-role rejected", cashiersAdminRole, 400);
  const cashiersBadPassword = await req("/api/admin/cashiers", { method: "POST", headers: { ...STORE, ...SESS }, body: JSON.stringify({ password: "wrong", cashier: { name: "كاشير جديد", role: "cashier", pin: "5678" } }) });
  expectStatus("POST /api/admin/cashiers wrong-password", cashiersBadPassword, mock ? 401 : (401 || 200));
  const cashiersOk = await req("/api/admin/cashiers", { method: "POST", headers: { ...STORE, ...SESS }, body: validCashierBody });
  ok(cashiersOk.status === 200 || cashiersOk.status === 201, "POST /api/admin/cashiers valid -> 2xx");
  ok(cashiersOk.json?.cashier?.id && cashiersOk.json?.cashier?.name === "كاشير جديد", "POST /api/admin/cashiers -> created cashier shape");
  const accountantRole = rolesOk.json?.roles?.find((role) => role.code === "accountant");
  const cashierEdit = await req("/api/admin/cashiers", {
    method: "POST",
    headers: { ...STORE, ...SESS },
    body: JSON.stringify({
      password: "12345678",
      cashier: {
        id: cashiersOk.json?.cashier?.id,
        name: "محاسب تجريبي",
        role: "accountant",
        roleId: accountantRole?.id,
        pin: "",
      },
    }),
  });
  ok(cashierEdit.status === 200, "POST /api/admin/cashiers edit role without resetting PIN -> 200");
  ok(cashierEdit.json?.cashier?.role === "accountant", "POST /api/admin/cashiers -> assigned accountant role");

  // P1b: back-office roster — list and delete via the admin session.
  const cashiersListNoSession = await req("/api/admin/cashiers", { method: "GET" });
  expectStatus("GET /api/admin/cashiers no-session", cashiersListNoSession, 401);
  const cashiersList = await req("/api/admin/cashiers", { method: "GET", headers: SESS });
  ok(cashiersList.status === 200, "GET /api/admin/cashiers valid -> 200");
  ok(Array.isArray(cashiersList.json?.cashiers), "GET /api/admin/cashiers -> cashiers array");
  if (!mock) {
    ok(cashiersList.json?.cashiers?.some((c) => c.name === "كاشير جديد"), "GET /api/admin/cashiers -> created cashier listed");
  }
  const deleteNoSession = await req("/api/admin/cashiers", { method: "DELETE", headers: STORE, body: JSON.stringify({ password: "12345678", id: "cashier-x" }) });
  expectStatus("DELETE /api/admin/cashiers no-session", deleteNoSession, 401);
  const deleteNoId = await req("/api/admin/cashiers", { method: "DELETE", headers: SESS, body: JSON.stringify({ password: "12345678" }) });
  expectStatus("DELETE /api/admin/cashiers missing-id", deleteNoId, 400);
  const deleteOk = await req("/api/admin/cashiers", { method: "DELETE", headers: SESS, body: JSON.stringify({ password: "12345678", id: cashiersOk.json?.cashier?.id }) });
  ok(deleteOk.status === 200 && deleteOk.json?.ok === true, "DELETE /api/admin/cashiers valid -> {ok:true}");
  const cashiersListAfter = await req("/api/admin/cashiers", { method: "GET", headers: SESS });
  ok(Array.isArray(cashiersListAfter.json?.cashiers), "GET /api/admin/cashiers after-delete -> array");
  if (!mock) {
    ok(!cashiersListAfter.json?.cashiers?.some((c) => c.name === "كاشير جديد"), "GET /api/admin/cashiers -> deleted cashier gone");
  }

  // ---- P3: immutable admin audit log (append-only ledger) -----------------
  const auditGetNoEmail = await req("/api/admin/audit");
  expectStatus("GET /api/admin/audit missing-email", auditGetNoEmail, 400);
  const auditGetNoStore = await req("/api/admin/audit", { headers: adminEmail });
  ok(auditGetNoStore.status === (mock ? 200 : 400), `GET /api/admin/audit no-store-header -> ${mock ? "200 (mock)" : "400"}`);
  const auditPostNoEmail = await req("/api/admin/audit", { method: "POST", headers: STORE, body: JSON.stringify({ action_type: "OPEN_DRAWER" }) });
  expectStatus("POST /api/admin/audit missing-email", auditPostNoEmail, 400);
  const auditPostNoBody = await req("/api/admin/audit", { method: "POST", headers: { ...STORE, ...adminEmail } });
  expectStatus("POST /api/admin/audit missing-body", auditPostNoBody, 400);
  const auditPostBadAction = await req("/api/admin/audit", { method: "POST", headers: { ...STORE, ...adminEmail }, body: JSON.stringify({ action_type: "HACK" }) });
  expectStatus("POST /api/admin/audit bad-action", auditPostBadAction, 400);
  const auditPostBadDetails = await req("/api/admin/audit", { method: "POST", headers: { ...STORE, ...adminEmail }, body: JSON.stringify({ action_type: "OPEN_DRAWER", details: [1, 2] }) });
  expectStatus("POST /api/admin/audit bad-details", auditPostBadDetails, 400);
  const auditPostWrongAdmin = await req("/api/admin/audit", { method: "POST", headers: { ...STORE, "x-pos-admin-email": "hacker@demo.test" }, body: JSON.stringify({ action_type: "OPEN_DRAWER" }) });
  expectStatus("POST /api/admin/audit wrong-admin", auditPostWrongAdmin, mock ? 401 : 403);
  const auditPostOk = await req("/api/admin/audit", { method: "POST", headers: { ...STORE, ...adminEmail }, body: JSON.stringify({ action_type: "OVERRIDE_PRICE", target_id: "p1", details: { productName: "كولا", from: 10, to: 12 } }) });
  ok(auditPostOk.status === 201, "POST /api/admin/audit valid -> 201");
  ok(auditPostOk.json?.entry?.id && auditPostOk.json?.entry?.action_type === "OVERRIDE_PRICE" && auditPostOk.json?.entry?.created_at, "POST /api/admin/audit -> entry shape (id/action_type/created_at)");
  const auditGet = await req("/api/admin/audit", { headers: { ...STORE, ...adminEmail } });
  ok(auditGet.status === 200, "GET /api/admin/audit with-admin-email -> 200");
  ok(Array.isArray(auditGet.json?.entries), "GET /api/admin/audit -> entries array");
  ok(
    auditGet.json?.entries?.some((e) => e.action_type === "OVERRIDE_PRICE" && e.target_id === "p1"),
    "GET /api/admin/audit -> posted entry round-trips",
  );

  // Closed self-registration: stores are created only by the Super Admin via
  // /api/admin/stores, so the public /api/auth/register always refuses.
  const regBlocked = await req("/api/auth/register", { method: "POST" });
  expectStatus("POST /api/auth/register always closed", regBlocked, 403);
  const regBlockedValid = await req("/api/auth/register", { method: "POST", body: JSON.stringify({ name: "متجر جديد", owner_name: "المدير", email: "owner-new@demo.test", password: "secret123" }) });
  expectStatus("POST /api/auth/register valid body still closed", regBlockedValid, 403);

  // Super-admin provisioning.
  const provNoPin = await req("/api/admin/stores");
  expectStatus("GET /api/admin/stores no-pin", provNoPin, 403);
  const provWrongPin = await req("/api/admin/stores", { headers: { "x-pos-super-admin-pin": "0000" } });
  expectStatus("GET /api/admin/stores wrong-pin", provWrongPin, 403);
  const provList = await req("/api/admin/stores", { headers: SUPER });
  ok(provList.status === 200, "GET /api/admin/stores with-pin -> 200");
  ok(Array.isArray(provList.json?.stores), "GET /api/admin/stores -> stores array");
  const provNoEmail = await req("/api/admin/stores", { method: "POST", headers: SUPER, body: JSON.stringify({ name: "متجر تجريبي" }) });
  expectStatus("POST /api/admin/stores missing-email", provNoEmail, 400);
  const provShortPassword = await req("/api/admin/stores", { method: "POST", headers: SUPER, body: JSON.stringify({ name: "متجر تجريبي", email: "owner@demo.test", password: "123" }) });
  expectStatus("POST /api/admin/stores short-password", provShortPassword, 400);
  const provCreate = await req("/api/admin/stores", { method: "POST", headers: SUPER, body: JSON.stringify({ name: "متجر تجريبي", owner_name: "مدير", email: "owner@demo.test" }) });
  ok(provCreate.status === 201, "POST /api/admin/stores with-pin -> 201");
  ok(provCreate.json?.store?.id, "POST /api/admin/stores -> created store id");
  ok(provCreate.json?.store?.taxPercent === 16, "POST /api/admin/stores -> default tax 16");
  ok(provCreate.json?.store?.taxNumber === "", "POST /api/admin/stores -> empty tax number");
  ok(provCreate.json?.store?.loyaltyEnabled === true, "POST /api/admin/stores -> loyalty enabled by default");
  ok(provCreate.json?.store?.pointsPerSpend === 1 && provCreate.json?.store?.pointValue === 0.01, "POST /api/admin/stores -> default loyalty rate");
  if (mock) {
    ok(provCreate.json?.store?.defaultPassword === "12345678", "POST /api/admin/stores mock -> default admin password");
  }
  const provCreateCustom = await req("/api/admin/stores", { method: "POST", headers: SUPER, body: JSON.stringify({ name: "متجر مخصص", owner_name: "مدير", email: "owner2@demo.test", password: "myPass123" }) });
  ok(provCreateCustom.status === 201, "POST /api/admin/stores with-pin custom-password -> 201");
  ok(provCreateCustom.json?.store?.taxPercent === 16, "POST /api/admin/stores custom-password -> default tax 16");
  if (mock) {
    ok(provCreateCustom.json?.store?.defaultPassword === "myPass123", "POST /api/admin/stores mock -> custom password echoed");
  }
  const provPatch = await req("/api/admin/stores/store-main", { method: "PATCH", headers: SUPER, body: JSON.stringify({ subscription_status: "active" }) });
  ok(provPatch.status === 200, "PATCH /api/admin/stores/[id] with-pin -> 200");
  ok(provPatch.json?.store?.subscriptionStatus === "active", "PATCH /api/admin/stores/[id] -> status echoed");

  // Tenant settings (own store only, admin session required).
  const settingsGetNoSession = await req("/api/settings");
  expectStatus("GET /api/settings no-session", settingsGetNoSession, 401);
  const settingsGet = await req("/api/settings", { headers: SESS });
  ok(settingsGet.status === 200, "GET /api/settings -> 200");
  ok(settingsGet.json?.settings?.id && typeof settingsGet.json?.settings?.name === "string", "GET /api/settings -> settings shape");
  ok(typeof settingsGet.json?.settings?.taxPercent === "number" && typeof settingsGet.json?.settings?.taxNumber === "string", "GET /api/settings -> fiscal tax fields");
  const rg = settingsGet.json?.settings ?? {};
  ok(typeof rg.receiptShowTaxNumber === "boolean" && typeof rg.receiptShowCashierTime === "boolean" && typeof rg.receiptShowBarcodeQr === "boolean" && typeof rg.receiptCompactSpacing === "boolean", "GET /api/settings -> receipt layout toggles present");
  const PRINT_SESS = mock ? { ...SESS, ...STORE, ...ADMIN } : SESS;

  const templatesNoSession = await req("/api/print-templates?kind=RECEIPT");
  expectStatus("GET /api/print-templates no-session", templatesNoSession, 401);
  const templatesInvalidKind = await req("/api/print-templates?kind=BAD", { headers: PRINT_SESS });
  expectStatus("GET /api/print-templates invalid kind", templatesInvalidKind, 400);
  const receiptTemplates = await req("/api/print-templates?kind=RECEIPT", { headers: PRINT_SESS });
  ok(receiptTemplates.status === 200, "GET /api/print-templates receipt -> 200");
  ok(Array.isArray(receiptTemplates.json?.templates), "GET /api/print-templates -> templates array");
  ok(receiptTemplates.json?.templates?.every((template) => template.kind === "RECEIPT"), "GET /api/print-templates -> kind scoped");
  const receiptConfig = receiptTemplates.json?.templates?.[0]?.config;
  ok(receiptConfig?.itemColumnMode === "full" && receiptConfig?.tableHeaderStyle === "dark", "GET /api/print-templates -> professional item columns normalized");
  ok(receiptConfig?.summaryStyle === "grid" && receiptConfig?.totalStyle === "rules", "GET /api/print-templates -> professional totals normalized");
  const templateInvalid = await req("/api/print-templates", { method: "POST", headers: PRINT_SESS, body: JSON.stringify({ kind: "BAD", name: "x" }) });
  expectStatus("POST /api/print-templates invalid kind", templateInvalid, 400);
  const templateCreate = await req("/api/print-templates", { method: "POST", headers: PRINT_SESS, body: JSON.stringify({ kind: "BARCODE_LABEL", name: "اختبار", config: { widthMm: 999, heightMm: 2 }, isDefault: false }) });
  ok(templateCreate.status === 201, "POST /api/print-templates valid -> 201");
  ok(templateCreate.json?.template?.config?.widthMm === 100 && templateCreate.json?.template?.config?.heightMm === 12, "POST /api/print-templates -> dimensions normalized");

  const logoNoSession = await req("/api/settings/logo", { method: "PATCH", body: JSON.stringify({ logo: "" }) });
  expectStatus("PATCH /api/settings/logo no-session", logoNoSession, 401);
  const logoInvalid = await req("/api/settings/logo", { method: "PATCH", headers: PRINT_SESS, body: JSON.stringify({ logo: "javascript:alert(1)" }) });
  expectStatus("PATCH /api/settings/logo invalid data", logoInvalid, 400);
  const logoValid = await req("/api/settings/logo", { method: "PATCH", headers: PRINT_SESS, body: JSON.stringify({ logo: "data:image/png;base64,aA==" }) });
  ok(logoValid.status === 200 && logoValid.json?.logoUrl?.startsWith("data:image/png"), "PATCH /api/settings/logo valid data url -> 200");

  const reportsNoSession = await req("/api/reports/overview");
  ok(reportsNoSession.status === (mock ? 200 : 401), `GET /api/reports/overview no-session -> ${mock ? "200 (mock)" : "401"}`);
  const reportsOverview = await req("/api/reports/overview", { headers: SESS });
  ok(reportsOverview.status === 200, "GET /api/reports/overview -> 200");
  ok(reportsOverview.json?.overview?.summary && Array.isArray(reportsOverview.json?.overview?.topProducts), "GET /api/reports/overview -> overview shape");
  ok(typeof reportsOverview.json?.overview?.summary?.netSales === "number", "GET /api/reports/overview -> numeric netSales");

  const settingsPatchNoSession = await req("/api/settings", { method: "PATCH", headers: ADMIN, body: JSON.stringify({ name: "متجر" }) });
  expectStatus("PATCH /api/settings no-session", settingsPatchNoSession, 401);
  const settingsPatchMissing = await req("/api/settings", { method: "PATCH", headers: SESS });
  expectStatus("PATCH /api/settings missing-body", settingsPatchMissing, 400);
  const settingsPatchEmpty = await req("/api/settings", { method: "PATCH", headers: SESS, body: JSON.stringify({ name: "" }) });
  expectStatus("PATCH /api/settings empty-name", settingsPatchEmpty, 400);
  const settingsPatchOk = await req("/api/settings", { method: "PATCH", headers: SESS, body: JSON.stringify({ name: "المتجر الرئيسي", receipt_footer: "أهلاً بكم", tax_percent: 15, tax_number: "311122233300003" }) });
  ok(settingsPatchOk.status === 200, "PATCH /api/settings valid -> 200");
  ok(settingsPatchOk.json?.settings?.name === "المتجر الرئيسي", "PATCH /api/settings -> name echoed");
  ok(settingsPatchOk.json?.settings?.taxPercent === 15 && settingsPatchOk.json?.settings?.taxNumber === "311122233300003", "PATCH /api/settings -> fiscal tax round-trip");
  const settingsPatchClamp = await req("/api/settings", { method: "PATCH", headers: SESS, body: JSON.stringify({ name: "المتجر الرئيسي", tax_percent: 250 }) });
  ok(settingsPatchClamp.status === 200 && settingsPatchClamp.json?.settings?.taxPercent === 0, "PATCH /api/settings -> out-of-range tax clamps to 0");
  const settingsPatchLayout = await req("/api/settings", { method: "PATCH", headers: SESS, body: JSON.stringify({ name: "المتجر الرئيسي", receipt_show_tax_number: false, receipt_show_cashier_time: false, receipt_show_barcode_qr: false, receipt_compact_spacing: true }) });
  ok(settingsPatchLayout.status === 200, "PATCH /api/settings receipt-layout valid -> 200");
  const rg2 = settingsPatchLayout.json?.settings ?? {};
  ok(rg2.receiptShowTaxNumber === false && rg2.receiptShowCashierTime === false && rg2.receiptShowBarcodeQr === false && rg2.receiptCompactSpacing === true, "PATCH /api/settings -> receipt layout toggles round-trip");
  const settingsPatchLayoutReset = await req("/api/settings", { method: "PATCH", headers: SESS, body: JSON.stringify({ name: "المتجر الرئيسي" }) });
  ok(settingsPatchLayoutReset.json?.settings?.receiptShowTaxNumber === true && settingsPatchLayoutReset.json?.settings?.receiptCompactSpacing === false, "PATCH /api/settings -> absent layout fields keep defaults");

  // Loyalty ledger (tenant-scoped reads + admin writes).
  const loyaltyGet = await req("/api/loyalty", { headers: STORE });
  ok(loyaltyGet.status === (mock ? 503 : 200), `GET /api/loyalty -> ${mock ? "503 (mock)" : "200"}`);
  if (!mock) {
    ok(Array.isArray(loyaltyGet.json?.customers), "GET /api/loyalty -> customers array");
    ok(loyaltyGet.json?.config && typeof loyaltyGet.json?.config?.enabled === "boolean", "GET /api/loyalty -> loyalty config shape");
  }
  const loyaltyNoStore = await req("/api/loyalty");
  expectStatus("GET /api/loyalty no-store-header", loyaltyNoStore, mock ? 503 : 400);
  const loyaltyPostNoStore = await req("/api/loyalty", { method: "POST", headers: ADMIN, body: JSON.stringify({ action: "adjust", customer_id: "c-1", points: 1 }) });
  expectStatus("POST /api/loyalty no-store-header", loyaltyPostNoStore, mock ? 503 : 400);
  const loyaltyPostAnon = await req("/api/loyalty", { method: "POST", headers: STORE, body: JSON.stringify({ action: "adjust", customer_id: "c-1", points: 1 }) });
  expectStatus("POST /api/loyalty no-admin-header", loyaltyPostAnon, mock ? 503 : 403);
  const loyaltyPostMissing = await req("/api/loyalty", { method: "POST", headers: { ...STORE, ...ADMIN } });
  expectStatus("POST /api/loyalty missing-body", loyaltyPostMissing, mock ? 503 : 400);
  const loyaltyPostMalformed = await req("/api/loyalty", { method: "POST", body: "nope", headers: { ...STORE, ...ADMIN } });
  expectStatus("POST /api/loyalty malformed-body", loyaltyPostMalformed, mock ? 503 : 400);

  // ---- Summary -----------------------------------------------------------
  console.log(`\nAPI health: ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.error("Failures:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("API health sweep crashed:", err);
  process.exit(1);
});
