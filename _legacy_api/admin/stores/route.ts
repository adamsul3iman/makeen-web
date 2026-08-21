import { supabase } from "@/lib/supabase";
import { opsToken } from "@/lib/platformOps";
import { requireSuperAdmin } from "@/lib/adminAuth";
import { MOCK_STORE_ID, MOCK_STORE_NAME, MOCK_STORE_CODE } from "@/lib/tenant";

/**
 * Super-admin provisioning. List every tenant or create a new store.
 * Gated by the `x-pos-super-admin-pin` header, which must match a row in
 * the `super_admins` table (seeded by migration 006; mock mode uses 7777).
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export async function GET(request: Request): Promise<Response> {
  const gate = await requireSuperAdmin(request);
  if (gate) return gate;

  if (!supabase) {
    return Response.json({
      stores: [
        {
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
          subscriptionStatus: "active",
        },
      ],
    });
  }

  const { data, error } = await supabase
    .from("stores")
    .select("id,name,owner_name,email,phone,logo_url,address,receipt_header,receipt_footer,loyalty_enabled,points_per_spend,point_value,tax_percent,tax_number,receipt_show_tax_number,receipt_show_cashier_time,receipt_show_barcode_qr,receipt_compact_spacing,subscription_status,created_at,code")
    .order("created_at", { ascending: true });

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
  return Response.json({
    stores: (data ?? []).map((s) => ({
      id: s.id,
      code: s.code ?? "",
      name: s.name,
      ownerName: s.owner_name,
      email: s.email,
      phone: s.phone,
      logoUrl: s.logo_url,
      address: s.address,
      receiptHeader: s.receipt_header,
      receiptFooter: s.receipt_footer,
      loyaltyEnabled: s.loyalty_enabled !== false,
      pointsPerSpend: Number(s.points_per_spend) || 1,
      pointValue: Number(s.point_value) || 0.01,
      taxPercent: s.tax_percent != null ? Number(s.tax_percent) : 16,
      taxNumber: s.tax_number ?? "",
      receiptShowTaxNumber: s.receipt_show_tax_number !== false,
      receiptShowCashierTime: s.receipt_show_cashier_time !== false,
      receiptShowBarcodeQr: s.receipt_show_barcode_qr !== false,
      receiptCompactSpacing: s.receipt_compact_spacing === true,
      subscriptionStatus: s.subscription_status,
      createdAt: s.created_at,
    })),
  });
}

export async function POST(request: Request): Promise<Response> {
  const gate = await requireSuperAdmin(request);
  if (gate) return gate;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const input = body as {
    name?: unknown;
    owner_name?: unknown;
    email?: unknown;
    phone?: unknown;
    password?: unknown;
    code?: unknown;
  };
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) {
    return Response.json({ error: "اسم المتجر مطلوب" }, { status: 400 });
  }
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  if (!email) {
    return Response.json({ error: "بريد مدير المتجر مطلوب" }, { status: 400 });
  }
  if (!EMAIL_RE.test(email)) {
    return Response.json({ error: "البريد الإلكتروني غير صالح" }, { status: 400 });
  }

  // Phase 37: accept the owner's own password from the platform admin. When
  // absent we keep the documented onboarding default ('12345678'), which the
  // owner can change after first login. A provided password must be strong
  // enough (>= 8 characters).
  let password = "12345678";
  if (typeof input.password === "string" && input.password.length > 0) {
    if (input.password.length < 8) {
      return Response.json({ error: "كلمة المرور يجب أن تكون 8 أحرف على الأقل" }, { status: 400 });
    }
    password = input.password;
  }

  // Optional custom store code. Blank → auto-generated 6-character code by
  // provision_new_store; provided → normalized to uppercase and validated to
  // match the /api/login format (4-12 uppercase alphanumeric), then checked for
  // uniqueness so the admin gets a clear Arabic error instead of a race.
  let storeCode = "";
  if (typeof input.code === "string" && input.code.trim().length > 0) {
    storeCode = input.code.trim().toUpperCase();
    if (!/^[A-Z0-9]{4,12}$/.test(storeCode)) {
      return Response.json(
        { error: "كود المتجر يجب أن يتكون من 4-12 حرفاً/رقماً إنجليزياً فقط" },
        { status: 400 },
      );
    }
  }

  if (!supabase) {
    return Response.json(
      {
        store: {
          id: `store-${Date.now().toString(36)}`,
          code: storeCode || MOCK_STORE_CODE,
          name,
          ownerName: typeof input.owner_name === "string" ? input.owner_name : "",
          email,
          phone: typeof input.phone === "string" ? input.phone : "",
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
          subscriptionStatus: "active",
          defaultPassword: password,
        },
      },
      { status: 201 },
    );
  }

  if (storeCode) {
    const { data: duplicate, error: duplicateError } = await supabase
      .from("stores")
      .select("id")
      .eq("code", storeCode)
      .maybeSingle();
    if (duplicateError) {
      return Response.json({ error: duplicateError.message }, { status: 500 });
    }
    if (duplicate) {
      return Response.json(
        { error: "كود المتجر مستخدم مسبقاً — اختر كوداً آخر أو اتركه فارغاً للتوليد التلقائي" },
        { status: 409 },
      );
    }
  }

  // Provision the tenant atomically: the store row, a default admin cashier
  // (email + default password for the dashboard, PIN 1234 for the POS), a main
  // branch and its first terminal are inserted inside one database transaction
  // (see db/migrations/012_admin_email_auth.sql), so a newly created store is
  // immediately login-able on both surfaces.
  const { data, error } = await supabase.rpc("provision_new_store", {
    p_name: name,
    p_owner_name: typeof input.owner_name === "string" ? input.owner_name : "",
    p_email: email,
    p_phone: typeof input.phone === "string" ? input.phone : "",
    p_password: password,
    p_code: storeCode || null,
    p_token: opsToken(),
  });

  if (error) {
    // 23505 = duplicate email (23505 from the email pre-check or the owner
    // email unique index) or a duplicate custom store code (raced past the
    // pre-check above); 22023 = invalid email format or invalid store code.
    const message = String(error.message ?? "");
    if (error.code === "23505" || /duplicate key/i.test(message)) {
      if (/store_code_already_used/i.test(message)) {
        return Response.json(
          { error: "كود المتجر مستخدم مسبقاً — اختر كوداً آخر" },
          { status: 409 },
        );
      }
      return Response.json({ error: "هذا البريد الإلكتروني مستخدم مسبقاً" }, { status: 409 });
    }
    if (error.code === "22023") {
      if (/invalid_store_code/i.test(message)) {
        return Response.json(
          { error: "كود المتجر غير صالح — 4-12 حرفاً/رقماً إنجليزياً فقط" },
          { status: 400 },
        );
      }
      return Response.json({ error: "البريد الإلكتروني غير صالح" }, { status: 400 });
    }
    return Response.json({ error: error.message }, { status: 500 });
  }
  if (!data || typeof data !== "object") {
    return Response.json({ error: "فشل إنشاء المتجر" }, { status: 500 });
  }

  const row = data as {
    id: string;
    code?: string | null;
    name: string;
    owner_name?: string | null;
    email?: string | null;
    phone?: string | null;
    logo_url?: string | null;
    address?: string | null;
    receipt_header?: string | null;
    receipt_footer?: string | null;
    loyalty_enabled?: boolean | null;
    points_per_spend?: number | string | null;
    point_value?: number | string | null;
    tax_percent?: number | string | null;
    tax_number?: string | null;
    receipt_show_tax_number?: boolean | null;
    receipt_show_cashier_time?: boolean | null;
    receipt_show_barcode_qr?: boolean | null;
    receipt_compact_spacing?: boolean | null;
    subscription_status?: string | null;
    created_at?: string | null;
  };

  return Response.json(
    {
      store: {
        id: row.id,
        code: row.code ?? "",
        name: row.name,
        ownerName: row.owner_name ?? "",
        email: row.email ?? "",
        phone: row.phone ?? "",
        logoUrl: row.logo_url ?? "",
        address: row.address ?? "",
        receiptHeader: row.receipt_header ?? "",
        receiptFooter: row.receipt_footer ?? "",
        loyaltyEnabled: row.loyalty_enabled !== false,
        pointsPerSpend: Number(row.points_per_spend) || 1,
        pointValue: Number(row.point_value) || 0.01,
        taxPercent: row.tax_percent != null ? Number(row.tax_percent) : 16,
        taxNumber: row.tax_number ?? "",
        receiptShowTaxNumber: row.receipt_show_tax_number !== false,
        receiptShowCashierTime: row.receipt_show_cashier_time !== false,
        receiptShowBarcodeQr: row.receipt_show_barcode_qr !== false,
        receiptCompactSpacing: row.receipt_compact_spacing === true,
        subscriptionStatus: row.subscription_status ?? "active",
        createdAt: row.created_at ?? "",
      },
    },
    { status: 201 },
  );
}
