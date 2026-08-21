import { supabase } from "@/lib/supabase";
import { MOCK_STORE_ID, MOCK_STORE_NAME, MOCK_STORE_CODE } from "@/lib/tenant";
import { getAdminSession, adminSessionCookieHeader } from "@/lib/adminSession";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const STORE_SETTINGS_SELECT =
  "id,name,owner_name,email,phone,logo_url,address,receipt_header,receipt_footer,loyalty_enabled,points_per_spend,point_value,tax_percent,tax_number,receipt_show_tax_number,receipt_show_cashier_time,receipt_show_barcode_qr,receipt_compact_spacing,subscription_status,code";

async function requireAdminSession(): Promise<
  { storeId: string; email: string; name: string } | Response
> {
  const session = await getAdminSession();
  if (!session) {
    return Response.json(
      { error: "غير مصرح — سجّل دخول كمدير المتجر" },
      { status: 401 },
    );
  }
  return { storeId: session.storeId, email: session.email, name: session.name };
}

function mockStoreSettings() {
  return {
    id: MOCK_STORE_ID,
    code: MOCK_STORE_CODE,
    name: MOCK_STORE_NAME,
    ownerName: "",
    email: "",
    phone: "",
    logoUrl: "",
    address: "",
    receiptHeader: "",
    receiptFooter: "",
    loyaltyEnabled: true,
    pointsPerSpend: 1,
    pointValue: 0.01,
    taxPercent: 16,
    taxNumber: "",
    receiptShowTaxNumber: true,
    receiptShowCashierTime: true,
    receiptShowBarcodeQr: true,
    receiptCompactSpacing: false,
    subscriptionStatus: "active" as const,
  };
}

interface SettingsInput {
  name?: unknown;
  owner_name?: unknown;
  email?: unknown;
  phone?: unknown;
  logo_url?: unknown;
  address?: unknown;
  receipt_header?: unknown;
  receipt_footer?: unknown;
  loyalty_enabled?: unknown;
  points_per_spend?: unknown;
  point_value?: unknown;
  tax_percent?: unknown;
  tax_number?: unknown;
  receipt_show_tax_number?: unknown;
  receipt_show_cashier_time?: unknown;
  receipt_show_barcode_qr?: unknown;
  receipt_compact_spacing?: unknown;
}

/**
 * Store-owner branding + contact settings.
 *
 * Everything is scoped to the caller's OWN store via the server-issued admin
 * session cookie (F2) — never the client-supplied `x-pos-store-id` header —
 * so a tenant cannot read or edit another tenant's row by forging headers.
 * The session is only minted after a successful dashboard login and is
 * HMAC-signed + HttpOnly.
 */
export async function GET(): Promise<Response> {
  const auth = await requireAdminSession();
  if (auth instanceof Response) return auth;
  const { storeId } = auth;

  if (!supabase) {
    return Response.json({ settings: mockStoreSettings() });
  }

  const { data, error } = await supabase
    .from("stores")
    .select(STORE_SETTINGS_SELECT)
    .eq("id", storeId)
    .maybeSingle();

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
  if (!data) {
    return Response.json({ error: "المتجر غير موجود" }, { status: 404 });
  }

  return Response.json({
    settings: {
      id: data.id,
      code: data.code ?? "",
      name: data.name,
      ownerName: data.owner_name,
      email: data.email,
      phone: data.phone,
      logoUrl: data.logo_url,
      address: data.address,
      receiptHeader: data.receipt_header,
      receiptFooter: data.receipt_footer,
      loyaltyEnabled: data.loyalty_enabled !== false,
      pointsPerSpend: Number(data.points_per_spend) || 1,
      pointValue: Number(data.point_value) || 0.01,
      taxPercent: data.tax_percent != null ? Number(data.tax_percent) : 16,
      taxNumber: data.tax_number ?? "",
      receiptShowTaxNumber: data.receipt_show_tax_number !== false,
      receiptShowCashierTime: data.receipt_show_cashier_time !== false,
      receiptShowBarcodeQr: data.receipt_show_barcode_qr !== false,
      receiptCompactSpacing: data.receipt_compact_spacing === true,
      subscriptionStatus: data.subscription_status,
    },
  });
}

export async function PATCH(request: Request): Promise<Response> {
  const auth = await requireAdminSession();
  if (auth instanceof Response) return auth;
  const { storeId, email: sessionEmail, name: sessionName } = auth;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const input = body as SettingsInput;

  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) {
    return Response.json({ error: "اسم المتجر مطلوب" }, { status: 400 });
  }

  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  if (email && !EMAIL_RE.test(email)) {
    return Response.json({ error: "البريد الإلكتروني غير صالح" }, { status: 400 });
  }

  const fields = {
    owner_name: typeof input.owner_name === "string" ? input.owner_name : "",
    email,
    phone: typeof input.phone === "string" ? input.phone : "",
    logo_url: typeof input.logo_url === "string" ? input.logo_url : "",
    address: typeof input.address === "string" ? input.address : "",
    receipt_header: typeof input.receipt_header === "string" ? input.receipt_header : "",
    receipt_footer: typeof input.receipt_footer === "string" ? input.receipt_footer : "",
    loyalty_enabled: typeof input.loyalty_enabled === "boolean" ? input.loyalty_enabled : true,
    points_per_spend:
      typeof input.points_per_spend === "number" && Number.isFinite(input.points_per_spend) && input.points_per_spend > 0
        ? input.points_per_spend
        : 1,
    point_value:
      typeof input.point_value === "number" && Number.isFinite(input.point_value) && input.point_value > 0
        ? input.point_value
        : 0.01,
    tax_percent:
      typeof input.tax_percent === "number" &&
      Number.isFinite(input.tax_percent) &&
      input.tax_percent >= 0 &&
      input.tax_percent <= 100
        ? input.tax_percent
        : 0,
    tax_number:
      typeof input.tax_number === "string" ? input.tax_number.trim().slice(0, 30) : "",
    receipt_show_tax_number:
      typeof input.receipt_show_tax_number === "boolean" ? input.receipt_show_tax_number : true,
    receipt_show_cashier_time:
      typeof input.receipt_show_cashier_time === "boolean" ? input.receipt_show_cashier_time : true,
    receipt_show_barcode_qr:
      typeof input.receipt_show_barcode_qr === "boolean" ? input.receipt_show_barcode_qr : true,
    receipt_compact_spacing:
      typeof input.receipt_compact_spacing === "boolean" ? input.receipt_compact_spacing : false,
  };

  if (!supabase) {
    const settings = mockStoreSettings();
    settings.name = name;
    settings.ownerName = fields.owner_name;
    settings.email = fields.email;
    settings.phone = fields.phone;
    settings.logoUrl = fields.logo_url;
    settings.address = fields.address;
    settings.receiptHeader = fields.receipt_header;
    settings.receiptFooter = fields.receipt_footer;
    settings.loyaltyEnabled = fields.loyalty_enabled;
    settings.pointsPerSpend = fields.points_per_spend;
    settings.pointValue = fields.point_value;
    settings.taxPercent = fields.tax_percent;
    settings.taxNumber = fields.tax_number;
    settings.receiptShowTaxNumber = fields.receipt_show_tax_number;
    settings.receiptShowCashierTime = fields.receipt_show_cashier_time;
    settings.receiptShowBarcodeQr = fields.receipt_show_barcode_qr;
    settings.receiptCompactSpacing = fields.receipt_compact_spacing;
    const mockRes = Response.json({ settings });
    if (fields.email && fields.email !== sessionEmail) {
      mockRes.headers.set(
        "Set-Cookie",
        adminSessionCookieHeader({ storeId, email: fields.email, name: sessionName }),
      );
    }
    return mockRes;
  }

  // The owner email is single-sourced: stores.email AND the admin cashier's
  // login email must agree. Reject an email already owned by another store.
  if (email) {
    const { data: clash } = await supabase
      .from("cashiers")
      .select("id")
      .eq("email", email)
      .neq("store_id", storeId)
      .maybeSingle();
    if (clash) {
      return Response.json({ error: "هذا البريد الإلكتروني مستخدم مسبقاً" }, { status: 409 });
    }
  }

  const { data, error } = await supabase
    .from("stores")
    .update({ name, ...fields })
    .eq("id", storeId)
    .select(STORE_SETTINGS_SELECT)
    .single();

  if (error || !data) {
    return Response.json(
      { error: error?.message ?? "المتجر غير موجود" },
      { status: error ? 500 : 404 },
    );
  }

  // Keep the store's dashboard admin in sync with the new owner email so the
  // two can never drift apart, and refresh the session cookie to match.
  if (email) {
    await supabase
      .from("cashiers")
      .update({ email })
      .eq("store_id", storeId)
      .eq("role", "admin")
      .neq("email", email);
  }

  const res = Response.json({
    settings: {
      id: data.id,
      code: data.code ?? "",
      name: data.name,
      ownerName: data.owner_name,
      email: data.email,
      phone: data.phone,
      logoUrl: data.logo_url,
      address: data.address,
      receiptHeader: data.receipt_header,
      receiptFooter: data.receipt_footer,
      loyaltyEnabled: data.loyalty_enabled !== false,
      pointsPerSpend: Number(data.points_per_spend) || 1,
      pointValue: Number(data.point_value) || 0.01,
      taxPercent: data.tax_percent != null ? Number(data.tax_percent) : 16,
      taxNumber: data.tax_number ?? "",
      receiptShowTaxNumber: data.receipt_show_tax_number !== false,
      receiptShowCashierTime: data.receipt_show_cashier_time !== false,
      receiptShowBarcodeQr: data.receipt_show_barcode_qr !== false,
      receiptCompactSpacing: data.receipt_compact_spacing === true,
      subscriptionStatus: data.subscription_status,
    },
  });
  if (email && email !== sessionEmail) {
    res.headers.set(
      "Set-Cookie",
      adminSessionCookieHeader({ storeId, email, name: sessionName }),
    );
  }
  return res;
}
