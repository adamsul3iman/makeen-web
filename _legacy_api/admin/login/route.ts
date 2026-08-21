import { supabase } from "@/lib/supabase";
import { opsToken } from "@/lib/platformOps";
import { adminSessionCookieHeader } from "@/lib/adminSession";
import { deviceSessionCookieHeader } from "@/lib/deviceSession";
import { MOCK_STORE_ID, MOCK_STORE_NAME, MOCK_STORE_CODE } from "@/lib/tenant";
import { rateLimit, rateLimited } from "@/lib/rateLimit";
import type { Store, SubscriptionStatus } from "@/types/pos.types";

/**
 * Dashboard authentication for store owners.
 *
 * A standard email + password login (never a tenant dropdown + shared PIN).
 * The store is resolved from the admin's own cashiers row server-side, so a
 * caller can only ever authenticate against the store they belong to.
 *
 * Response mirrors /api/login (store + cashier + branches/terminals) plus an
 * `admin` block so the client can persist the admin session that scopes the
 * POS PIN pad to one store.
 */

const MOCK_ADMIN_EMAIL = "admin@demo.test";
const MOCK_ADMIN_PASSWORD = "12345678";
const MOCK_BRANCH_ID = "branch-main";
const MOCK_TERMINAL_ID = "terminal-main";

function mockStore(): Store {
  return {
    id: MOCK_STORE_ID,
    code: MOCK_STORE_CODE,
    name: MOCK_STORE_NAME,
    ownerName: "",
    email: MOCK_ADMIN_EMAIL,
    phone: "",
    subscriptionStatus: "active",
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
  };
}

interface AdminLoginInput {
  email?: unknown;
  password?: unknown;
}

interface AuthStoreRow {
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
  subscription_status?: SubscriptionStatus | null;
}

function mapStore(s: AuthStoreRow): Store {
  return {
    id: s.id,
    code: s.code ?? "",
    name: s.name,
    ownerName: s.owner_name ?? "",
    email: s.email ?? "",
    phone: s.phone ?? "",
    subscriptionStatus: s.subscription_status ?? "active",
    logoUrl: s.logo_url ?? "",
    address: s.address ?? "",
    receiptHeader: s.receipt_header ?? "",
    receiptFooter: s.receipt_footer ?? "",
    loyaltyEnabled: s.loyalty_enabled !== false,
    pointsPerSpend: Number(s.points_per_spend) || 1,
    pointValue: Number(s.point_value) || 0.01,
    taxPercent: s.tax_percent != null ? Number(s.tax_percent) : 16,
    taxNumber: s.tax_number ?? "",
    receiptShowTaxNumber: s.receipt_show_tax_number !== false,
    receiptShowCashierTime: s.receipt_show_cashier_time !== false,
    receiptShowBarcodeQr: s.receipt_show_barcode_qr !== false,
    receiptCompactSpacing: s.receipt_compact_spacing === true,
  };
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const input = body as AdminLoginInput;
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  const password = typeof input.password === "string" ? input.password : "";

  if (!email) {
    return Response.json({ error: "البريد الإلكتروني مطلوب" }, { status: 400 });
  }
  if (!password) {
    return Response.json({ error: "كلمة المرور مطلوبة" }, { status: 400 });
  }

  // Brute-force speed bump: at most 5 password attempts per email+IP every 15min.
  // Skipped in mock mode (no real accounts / DB to protect).
  if (supabase) {
    const gate = rateLimit(request, `admin-login:${email}`, 5, 15 * 60 * 1000);
    if (!gate.ok) return rateLimited(gate.retryAfter ?? 1);
  }

  if (!supabase) {
    if (email !== MOCK_ADMIN_EMAIL || password !== MOCK_ADMIN_PASSWORD) {
      return Response.json({ error: "بيانات الدخول غير صحيحة" }, { status: 401 });
    }
    const mockRes = Response.json({
      store: mockStore(),
      cashier: { id: "cashier-admin", name: "مدير النظام", role: "admin", email },
      admin: { email },
      branches: [{ id: MOCK_BRANCH_ID, name: "الفرع الرئيسي" }],
      terminals: [{ id: MOCK_TERMINAL_ID, branchId: MOCK_BRANCH_ID, name: "الكاشير الرئيسي" }],
      defaultBranchId: MOCK_BRANCH_ID,
      defaultTerminalId: MOCK_TERMINAL_ID,
    });
    mockRes.headers.set(
      "Set-Cookie",
      adminSessionCookieHeader({ storeId: MOCK_STORE_ID, email, name: "مدير النظام" }),
    );
    mockRes.headers.append(
      "Set-Cookie",
      deviceSessionCookieHeader({
        storeId: MOCK_STORE_ID,
        actorId: "cashier-admin",
        actorName: "مدير النظام",
        role: "admin",
      }),
    );
    return mockRes;
  }

  const { data, error } = await supabase.rpc("authenticate_admin", {
    p_email: email,
    p_password: password,
    p_token: opsToken(),
  });
  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
  if (!data || typeof data !== "object") {
    return Response.json({ error: "بيانات الدخول غير صحيحة" }, { status: 401 });
  }

  const payload = data as {
    store: AuthStoreRow;
    cashier: { id: string; name: string; role: string; email: string };
    branches?: Array<{ id: string; name: string }>;
    terminals?: Array<{ id: string; branch_id: string; name: string }>;
  };

  if (payload.store.subscription_status === "suspended") {
    return Response.json({ error: "هذا المتجر موقوف" }, { status: 403 });
  }

  const branchRows = payload.branches ?? [];
  const terminalRows = payload.terminals ?? [];
  const defaultBranchId =
    branchRows.find((b) => b.name === "الفرع الرئيسي")?.id ?? branchRows[0]?.id ?? null;
  const defaultTerminalId =
    terminalRows.find((t) => t.branch_id === defaultBranchId && t.name === "الكاشير الرئيسي")?.id ??
    terminalRows.find((t) => t.branch_id === defaultBranchId)?.id ??
    terminalRows[0]?.id ??
    null;

  const res = Response.json({
    store: mapStore(payload.store),
    cashier: {
      id: payload.cashier.id,
      name: payload.cashier.name,
      role: payload.cashier.role,
      email: payload.cashier.email,
    },
    admin: { email: payload.cashier.email },
    branches: branchRows,
    terminals: terminalRows.map((t) => ({ id: t.id, branchId: t.branch_id, name: t.name })),
    defaultBranchId,
    defaultTerminalId,
  });
  res.headers.set(
    "Set-Cookie",
    adminSessionCookieHeader({
      storeId: payload.store.id,
      email: payload.cashier.email,
      name: payload.cashier.name,
    }),
  );
  res.headers.append(
    "Set-Cookie",
    deviceSessionCookieHeader({
      storeId: payload.store.id,
      actorId: payload.cashier.id,
      actorName: payload.cashier.name,
      role: "admin",
    }),
  );
  return res;
}
