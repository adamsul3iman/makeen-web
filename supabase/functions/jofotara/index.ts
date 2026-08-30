// supabase/functions/jofotara/index.ts
// P0 remediation step 3 (audit F-04): JoFotara/ISTD device credentials live
// ONLY here. The browser bundle carries the anon key alone and reaches this
// function over PostgREST-style calls; the secret never crosses the boundary.
//
// Deploy:
//   supabase functions deploy jofotara --no-verify-jwt
// (--no-verify-JWT: the POS has no Supabase Auth; every request already
//  carries the anon apikey header, and admin writes are password-proofed
//  inside `config_save`. If you prefer JWT verification ON, issue machine
//  tokens out of band — not part of this remediation. NOTE: with gateway
//  JWT verification ON, a rejected request never reaches this handler and
//  the platform's bare 401 carries no CORS headers — the browser then
//  reports a CORS policy error instead of the real status.)
//
// Environment (auto-injected by the platform):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Optional:
//   JOFOTARA_BASE_URL  override (default https://backend.jofotara.gov.jo)
//
// Actions (POST application/json):
//   { action: "config_get", storeId }
//     -> { ok:true, taxNumber, istdClientId, configured }   // masked
//
//   { action: "config_save", storeId, adminEmail, adminPassword,
//     taxNumber, clientId, secret? }
//     -> { ok:true, taxNumber, istdClientId, configured }
//     Password proof reuses authenticate_admin_client (bcrypt, store-scoped).
//     Omitted/blank `secret` preserves the stored one.
//
//   { action: "invoice_submit", storeId, syncId, invoice }
//     invoice = { completed_at, total, tax, discount, paymentMethod,
//                 customerName?, customerPhone?, customerId?, items?[] }
//     -> { ok:true, uuid, qrCode? } | { ok:false, code, message? }
//     Full single-writer pipeline ported from lib/istdSync.ts: claim row on
//     istd_submissions, token exchange, submit, outcome + ledger mirror.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ISTD_BASE_URL =
  (Deno.env.get("JOFOTARA_BASE_URL") ?? "https://backend.jofotara.gov.jo").replace(/\/$/, "");

// Preflight contract: the browser blocks the POST (and surfaces it as a CORS
// error) unless the gateway/function answers OPTIONS with these headers. The
// allow-list must cover everything lib/istdIntegration.ts sends: apikey +
// Authorization bearer + JSON content-type.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-api-version",
  "Access-Control-Max-Age": "86400",
  Vary: "Origin",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/* ───────────────────────────── helpers ─────────────────────────────────── */

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
const jordanAmount = (n: number): string => {
  const v = round2(n);
  return Object.is(v, -0) ? "0.00" : v.toFixed(2);
};
const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
};
const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const invoiceReference = (syncId: string): string =>
  syncId.replaceAll("-", "").slice(0, 10).toUpperCase();

const PAYMENT_METHOD_ISTD: Record<string, string> = {
  CASH: "cash",
  VISA: "card",
  CLIQ: "cliq",
  SPLIT: "cash_and_card",
  DEBT: "on_account",
  UNKNOWN: "cash",
};

interface TenantSettingsRow {
  tax_number: string | null;
  istd_client_id: string | null;
  istd_client_secret: string | null;
  istd_buyer_category: string | null;
}

async function loadSettings(storeId: string): Promise<TenantSettingsRow | null> {
  const { data, error } = await sb
    .from("tenant_tax_settings")
    .select("tax_number,istd_client_id,istd_client_secret,istd_buyer_category")
    .eq("store_id", storeId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ?? null;
}

function configuredOf(row: TenantSettingsRow | null): boolean {
  return Boolean(
    row &&
      text(row.tax_number).length > 0 &&
      text(row.istd_client_id).length > 0 &&
      text(row.istd_client_secret).length > 0,
  );
}

/** bcrypt proof via the existing SECURITY DEFINER RPC (migrations 069/072). */
async function assertStoreAdmin(
  storeId: string,
  email: string,
  password: string,
): Promise<boolean> {
  const { data, error } = await sb.rpc("authenticate_admin_client", {
    p_email: email,
    p_password: password,
  });
  if (error || !data || typeof data !== "object") return false;
  const store = (data as { store?: { id?: string; subscription_status?: string } }).store;
  if (!store?.id || store.id !== storeId) return false;
  return store.subscription_status !== "suspended";
}

/** Exchange the tenant's device credentials for a JoFotara Bearer JWT. */
async function requestToken(
  clientId: string,
  clientSecret: string,
  timeoutMs: number,
): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`${ISTD_BASE_URL}/api/get_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw Object.assign(new Error("تعذر الوصول إلى خوادم ISTD — تحقق من الاتصال"), {
      code: "network",
    });
  }
  if (!response.ok) {
    const code = response.status === 401 || response.status === 403
      ? "invalid_credentials"
      : "token_failed";
    throw Object.assign(new Error(`ISTD token failure (${response.status})`), { code });
  }
  const data = (await response.json().catch(() => ({}))) as {
    access_token?: unknown;
    token?: unknown;
  };
  const token = typeof data.access_token === "string"
    ? data.access_token
    : typeof data.token === "string"
      ? data.token
      : "";
  if (!token) {
    throw Object.assign(new Error("ISTD response carried no token"), { code: "token_failed" });
  }
  return token;
}

/* ───────────────────────── JoFotara mapping (port of mapSalesInvoiceToIstd) */

interface InvoiceLineInput {
  lineNo?: unknown;
  productName?: unknown;
  quantity?: unknown;
  unitPrice?: unknown;
  lineDiscount?: unknown;
  taxPercent?: unknown;
  taxAmount?: unknown;
  lineTotal?: unknown;
}

function mapInvoicePayload(invoice: Record<string, unknown>): Record<string, unknown> {
  // Jordan ISTD: only finalized sales may be reported. Refuse proforma / open
  // documents (isFinalized === false) so the tax authority never receives a
  // non-finalized invoice, even if a stale queue record reaches this function.
  if (invoice.isFinalized === false) {
    throw Object.assign(
      new Error("لا يمكن إرسال فاتورة مبدئية / مفتوحة إلى المصلحة"),
      { code: "proforma_not_submittable" },
    );
  }
  const completedAt = text(invoice.completed_at ?? invoice.completedAt);
  const date = completedAt.slice(0, 10);
  const time = completedAt.length > 11 ? completedAt.slice(11, 19) : "";
  const total = num(invoice.total);
  const taxTotal = num(invoice.tax);
  const discount = num(invoice.discount);
  const isReturn = total < 0;
  const paymentMethod = typeof invoice.paymentMethod === "string"
    ? PAYMENT_METHOD_ISTD[invoice.paymentMethod] ?? "cash"
    : "cash";
  const taxNumber = text(invoice.tax_number);
  // Registration category: per-invoice override wins, else the store's
  // configurable default (injected server-side before mapping), else B2C.
  const buyerCategory: "B2B" | "B2C" =
    invoice.buyerCategory === "B2B" || invoice.buyerCategory === "B2C"
      ? invoice.buyerCategory
      : invoice.istd_buyer_category === "B2B"
        ? "B2B"
        : "B2C";

  const rawItems = Array.isArray(invoice.items) ? (invoice.items as InvoiceLineInput[]) : [];
  const items = rawItems.length > 0
    ? rawItems.map((item) => {
        const gross = round2(num(item.lineTotal));
        const tax = round2(num(item.taxAmount));
        return {
          line_id: num(item.lineNo) || 1,
          description: text(item.productName) || "مبيعات",
          quantity: num(item.quantity),
          unit_price: round2(num(item.unitPrice)),
          discount: round2(num(item.lineDiscount)),
          tax_category: "Standard",
          tax_percentage: num(item.taxPercent),
          tax_exclusive_price: round2(gross - tax),
          tax_amount: tax,
          total: gross,
        };
      })
    : [{
        line_id: 1,
        description: "مبيعات",
        quantity: 1,
        unit_price: round2(total - taxTotal),
        discount: 0,
        tax_category: "Standard",
        tax_percentage: total !== 0 ? round2((taxTotal / (total - taxTotal)) * 100) : 0,
        tax_exclusive_price: round2(total - taxTotal),
        tax_amount: round2(taxTotal),
        total: round2(total),
      }];

  const buyer: Record<string, unknown> = {};
  if (text(invoice.customerName)) buyer.name = text(invoice.customerName);
  if (text(invoice.customerPhone)) buyer.phone = text(invoice.customerPhone);
  if (text(invoice.customerId)) buyer.id = text(invoice.customerId);
  buyer.category = buyerCategory;
  if (buyerCategory === "B2B" && text(invoice.customerTin)) buyer.tin = text(invoice.customerTin);

  // Secure rounding: recompute the totals from the authoritative line figures
  // just mapped, never trusting the client-supplied header total that could
  // drift from line_items. Each value is rounded to 2 JOD decimals.
  const lineGross = round2(items.reduce((acc, it) => acc + (it.total as number), 0));
  const lineTax = round2(items.reduce((acc, it) => acc + (it.tax_amount as number), 0));
  const lineExclusive = round2(
    items.reduce((acc, it) => acc + (it.tax_exclusive_price as number), 0),
  );

  return {
    invoice_uuid: text(invoice.sync_id ?? invoice.id),
    invoice_ref_number: invoiceReference(text(invoice.sync_id ?? invoice.id)),
    invoice_type: isReturn ? "credit" : "general_sales",
    currency: "JOD",
    issue_date: date,
    issue_time: time,
    payment_method: paymentMethod,
    supplier: {
      name: text(invoice.supplier_name) || "متجر التجزئة",
      tin: taxNumber,
      address: "",
      phone: "",
    },
    buyer,
    line_items: items,
    totals: {
      tax_exclusive_total: lineExclusive,
      discount_total: round2(discount),
      tax_total: lineTax,
      grand_total: lineGross,
    },
    signature: {
      algorithm: "ISTD-SHA256",
      tax_number: taxNumber,
      invoice_total: jordanAmount(lineGross),
      tax_amount: jordanAmount(lineTax),
    },
  };
}

/* ─────────────────────────── action handlers ───────────────────────────── */

async function handleConfigGet(storeId: string): Promise<Response> {
  const row = await loadSettings(storeId);
  return json({
    ok: true,
    taxNumber: text(row?.tax_number),
    istdClientId: text(row?.istd_client_id),
    istdBuyerCategory:
      row?.istd_buyer_category === "B2B" || row?.istd_buyer_category === "B2C"
        ? row.istd_buyer_category
        : "B2C",
    configured: configuredOf(row),
  });
}

async function handleConfigSave(body: Record<string, unknown>): Promise<Response> {
  const storeId = text(body.storeId);
  const adminEmail = text(body.adminEmail).toLowerCase();
  const adminPassword = typeof body.adminPassword === "string" ? body.adminPassword : "";
  const taxNumber = text(body.taxNumber).slice(0, 30);
  const clientId = text(body.clientId).slice(0, 200);
  const secret = typeof body.secret === "string" ? body.secret.trim() : "";
  const buyerCategory: "B2B" | "B2C" =
    body.istdBuyerCategory === "B2B" || body.istdBuyerCategory === "B2C"
      ? body.istdBuyerCategory
      : "B2C";

  if (!storeId) return json({ ok: false, code: "bad_request", message: "storeId مطلوب" }, 400);

  if (!(await assertStoreAdmin(storeId, adminEmail, adminPassword))) {
    return json({ ok: false, code: "invalid_admin_credentials" }, 200);
  }

  const existing = await loadSettings(storeId);
  const nextSecret = secret || text(existing?.istd_client_secret);
  const upsert: Record<string, unknown> = {
    store_id: storeId,
    tax_number: taxNumber,
    istd_client_id: clientId,
    istd_client_secret: nextSecret,
    istd_buyer_category: buyerCategory,
  };
  const { error } = await sb
    .from("tenant_tax_settings")
    .upsert(upsert, { onConflict: "store_id" });
  if (error) return json({ ok: false, code: "db_error", message: error.message }, 200);

  if (taxNumber) {
    await sb.from("stores").update({ tax_number: taxNumber }).eq("id", storeId);
  }

  return json({
    ok: true,
    taxNumber,
    istdClientId: clientId,
    istdBuyerCategory: buyerCategory,
    configured: Boolean(taxNumber && clientId && nextSecret),
  });
}

/** Claim backoff: a fresh claim is due immediately; SUBMITTING steal after 10s. */
const CLAIM_DUE_BACKOFF_MS = 10_000;

async function handleInvoiceSubmit(body: Record<string, unknown>): Promise<Response> {
  const storeId = text(body.storeId);
  const syncId = text(body.syncId);
  const invoice = (body.invoice && typeof body.invoice === "object"
    ? body.invoice
    : {}) as Record<string, unknown>;
  if (!storeId || !syncId) {
    return json({ ok: false, code: "bad_request", message: "storeId و syncId مطلوبان" }, 400);
  }

  const settings = await loadSettings(storeId);
  if (!configuredOf(settings)) {
    return json({
      ok: false,
      code: "not_configured",
      message: "الفوترة الإلكترونية غير مفعّلة لهذا المتجر — أضف بيانات JoFotara من الإعدادات",
    });
  }
  const taxNumber = text(settings!.tax_number);
  const clientId = text(settings!.istd_client_id);
  const clientSecret = text(settings!.istd_client_secret);

  const { data: storeRow } = await sb.from("stores").select("name").eq("id", storeId).maybeSingle();
  invoice.supplier_name = text(storeRow?.name) || "متجر التجزئة";
  invoice.tax_number = taxNumber;
  invoice.sync_id = syncId;
  invoice.istd_buyer_category = text(settings!.istd_buyer_category) || "B2C";
  const payload = mapInvoicePayload(invoice);

  // Single-writer claim bookkeeping (ported from lib/istdSync.ts).
  const past = new Date(Date.now() - 60_000).toISOString();
  await sb.from("istd_submissions").upsert(
    { sync_id: syncId, store_id: storeId, status: "PENDING", last_attempt_at: past },
    { onConflict: "sync_id", ignoreDuplicates: true },
  );
  const cutoff = new Date(Date.now() - CLAIM_DUE_BACKOFF_MS).toISOString();
  const take = await sb
    .from("istd_submissions")
    .update({ status: "SUBMITTING", last_attempt_at: new Date().toISOString() })
    .eq("sync_id", syncId)
    .eq("store_id", storeId)
    .in("status", ["PENDING", "FAILED", "SUBMITTING"])
    .lt("last_attempt_at", cutoff)
    .select("sync_id");
  const owned = (take.data?.length ?? 0) === 1;
  if (!owned) {
    // Another worker holds the claim — report its result when it finished.
    const { data: claim } = await sb
      .from("istd_submissions")
      .select("status,istd_uuid,istd_qr")
      .eq("sync_id", syncId)
      .eq("store_id", storeId)
      .maybeSingle();
    if (claim?.status === "SUBMITTED" && claim.istd_uuid) {
      return json({ ok: true, uuid: claim.istd_uuid, qrCode: claim.istd_qr ?? undefined });
    }
    return json({ ok: false, code: "pending" }, 200);
  }

  const markFailed = async (code: string) => {
    await sb
      .from("istd_submissions")
      .update({ status: "FAILED", error: code, last_attempt_at: new Date().toISOString() })
      .eq("sync_id", syncId)
      .eq("store_id", storeId);
  };

  try {
    const token = await requestToken(clientId, clientSecret, 8_000);
    let response: Response;
    try {
      response = await fetch(`${ISTD_BASE_URL}/api/invoice`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ invoice: payload }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw Object.assign(new Error("network"), { code: "network" });
    }
    if (!response.ok) {
      throw Object.assign(new Error(`HTTP ${response.status}`), { code: "submission_failed" });
    }
    const data = (await response.json().catch(() => ({}))) as {
      uuid?: unknown;
      qrCode?: unknown;
      qr?: unknown;
    };
    const uuid = typeof data.uuid === "string" ? data.uuid : "";
    if (!uuid) throw Object.assign(new Error("no_uuid"), { code: "no_uuid" });
    const qrCode = typeof data.qrCode === "string"
      ? data.qrCode
      : typeof data.qr === "string"
        ? data.qr
        : undefined;

    await sb
      .from("istd_submissions")
      .update({
        status: "SUBMITTED",
        istd_uuid: uuid,
        istd_qr: qrCode ?? null,
        error: null,
        last_attempt_at: new Date().toISOString(),
      })
      .eq("sync_id", syncId)
      .eq("store_id", storeId);
    await sb
      .from("sales_invoices")
      .update({ istd_uuid: uuid, istd_qr: qrCode ?? null, istd_submitted_at: new Date().toISOString() })
      .eq("sync_id", syncId)
      .eq("store_id", storeId);

    return json({ ok: true, uuid, qrCode });
  } catch (err) {
    const code = err && typeof err === "object" && "code" in err && typeof err.code === "string"
      ? err.code
      : "unknown";
    await markFailed(code);
    return json({ ok: false, code, message: err instanceof Error ? err.message : undefined });
  }
}

/* ───────────────────────────── entrypoint ──────────────────────────────── */

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (request.method !== "POST") return json({ ok: false, code: "method_not_allowed" }, 405);

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, code: "bad_json" }, 400);
  }

  try {
    switch (body.action) {
      case "config_get":
        return await handleConfigGet(text(body.storeId));
      case "config_save":
        return await handleConfigSave(body);
      case "invoice_submit":
        return await handleInvoiceSubmit(body);
      default:
        return json({ ok: false, code: "unknown_action" }, 400);
    }
  } catch (err) {
    console.error("[jofotara] unhandled:", err);
    return json({ ok: false, code: "internal", message: err instanceof Error ? err.message : "" }, 500);
  }
});
