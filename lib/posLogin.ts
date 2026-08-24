import { supabase } from "@/lib/supabase";
import { MOCK_STORE_ID, MOCK_STORE_NAME, MOCK_STORE_CODE } from "@/lib/tenant";
import { sha256Hex } from "@/lib/sha256";
import { deviceSessionCookieHeader } from "@/lib/deviceSession";
import { clearAdminSessionCookieHeader } from "@/lib/adminSession";
import type { Store } from "@/types/pos.types";
import {
  STAFF_ROLE_PRESETS,
  homePathForDevice,
  normalizeStaffRoleCode,
} from "@/lib/permissions";

// Owner/cashier separation: the store owner logs in with email + password on
// the dashboard and never holds a PIN; only cashier rows can unlock a register.
interface MockCashier {
  id: string;
  name: string;
  username: string;
  pin: string;
  role: string;
  roleCode: string;
  isActive: boolean;
}

const MOCK_CASHIERS: MockCashier[] = [
  {
    id: "cashier-ahmed",
    name: "أحمد",
    username: "ahmed",
    pin: "1234",
    role: "cashier",
    roleCode: "cashier",
    isActive: true,
  },
  {
    id: "cashier-mahmoud",
    name: "محمود",
    username: "mahmoud",
    pin: "9999",
    role: "cashier",
    roleCode: "cashier",
    isActive: true,
  },
  {
    id: "cashier-layla",
    name: "ليلى",
    username: "layla",
    pin: "1111",
    role: "cashier",
    roleCode: "inventory_clerk",
    isActive: true,
  },
];

// Suspended staff must not sign in, but their row stays discoverable so the
// sign-in page can tell the owner that the account is suspended (403) instead
// of returning a generic 401.
const MOCK_SUSPENDED_CASHIER: MockCashier = {
  id: "cashier-suspended",
  name: "موقوف مؤقتاً",
  username: "suspended",
  pin: "0000",
  role: "cashier",
  roleCode: "cashier",
  isActive: false,
};

const MOCK_BRANCH_ID = "branch-main";
const MOCK_TERMINAL_ID = "terminal-main";

function mockStore(): Store {
  return {
    id: MOCK_STORE_ID,
    code: MOCK_STORE_CODE,
    name: MOCK_STORE_NAME,
    ownerName: "",
    email: "",
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

export interface StaffLoginRequest {
  /** Legacy pin+storeId mode (used by the register and workflow tests). */
  storeId?: string;
  /** Unified staff mode: human-friendly store code + username + pin. */
  storeCode?: string;
  username?: string;
  pin: string;
}

/**
 * Staff authentication shared by the unified /api/login (store code +
 * username + PIN) and the legacy register flow (storeId + PIN). Validates the
 * PIN against the cashiers of one store and returns the full store context
 * every subsequent request echoes via the signed device cookie, plus the
 * role's home path for the proxy to redirect to.
 */
export async function staffLoginResponse(input: StaffLoginRequest): Promise<Response> {
  const pin = input.pin.trim();
  const username = input.username?.trim().toLowerCase() ?? "";

  if (!supabase) {
    if (input.storeId) {
      if (input.storeId !== MOCK_STORE_ID) {
        return Response.json({ error: "المتجر غير موجود" }, { status: 404 });
      }
    } else {
      const storeCode = (input.storeCode ?? "").trim().toUpperCase();
      if (storeCode !== MOCK_STORE_CODE) {
        return Response.json({ error: "كود المتجر غير صحيح" }, { status: 404 });
      }
    }
    const allMockCashiers = [...MOCK_CASHIERS, MOCK_SUSPENDED_CASHIER];
    if (username) {
      const suspended = allMockCashiers.find((c) => c.username === username && c.isActive === false);
      if (suspended) {
        return Response.json({ error: "الحساب موقوف — تواصل مع مدير المتجر" }, { status: 403 });
      }
    }
    const cashier = MOCK_CASHIERS.find((c) => {
      const pinOk = c.pin === pin;
      const nameOk = username ? c.username === username : true;
      return pinOk && nameOk;
    });
    if (!cashier) {
      return Response.json({ error: "بيانات الدخول غير صحيحة" }, { status: 401 });
    }
    const roleCode = normalizeStaffRoleCode(cashier.roleCode);
    const role = STAFF_ROLE_PRESETS[roleCode];
    const response = Response.json({
      store: mockStore(),
      cashier: {
        id: cashier.id,
        name: cashier.name,
        role: cashier.role,
        roleCode,
        roleName: role.name,
        capabilities: role.capabilities,
        limits: role.limits,
      },
      branches: [{ id: MOCK_BRANCH_ID, name: "الفرع الرئيسي" }],
      terminals: [{ id: MOCK_TERMINAL_ID, branchId: MOCK_BRANCH_ID, name: "الكاشير الرئيسي" }],
      defaultBranchId: MOCK_BRANCH_ID,
      defaultTerminalId: MOCK_TERMINAL_ID,
      homePath: homePathForDevice({ role: "cashier", roleCode }),
    });
    response.headers.set(
      "Set-Cookie",
      deviceSessionCookieHeader({
        storeId: MOCK_STORE_ID,
        actorId: cashier.id,
        actorName: cashier.name,
        role: "cashier",
        staffRoleCode: roleCode,
      }),
    );
    response.headers.append("Set-Cookie", clearAdminSessionCookieHeader());
    return response;
  }

  let storeQuery = supabase
    .from("stores")
    .select("id,name,owner_name,email,phone,logo_url,address,receipt_header,receipt_footer,loyalty_enabled,points_per_spend,point_value,tax_percent,tax_number,receipt_show_tax_number,receipt_show_cashier_time,receipt_show_barcode_qr,receipt_compact_spacing,subscription_status,code")
    .limit(1);
  if (input.storeId) {
    storeQuery = storeQuery.eq("id", input.storeId);
  } else {
    const storeCode = (input.storeCode ?? "").trim().toUpperCase();
    storeQuery = storeQuery.eq("code", storeCode);
  }
  const { data: store, error: storeError } = await storeQuery.maybeSingle();
  if (storeError) {
    return Response.json({ error: storeError.message }, { status: 500 });
  }
  if (!store) {
    return Response.json({ error: "المتجر غير موجود" }, { status: 404 });
  }
  if (store.subscription_status === "suspended") {
    return Response.json({ error: "هذا المتجر موقوف" }, { status: 403 });
  }

  const { data: cashierRows, error: cashierError } = await supabase
    .from("cashiers")
    .select("id,name,role,role_id,pin_salt,pin_hash,username,is_active")
    .eq("store_id", store.id);
  if (cashierError) {
    return Response.json({ error: cashierError.message }, { status: 500 });
  }

  // Suspended staff can't sign in, but their row stays discoverable so the
  // sign-in page can say "الحساب موقوف" (403) rather than a generic 401.
  if (username) {
    const suspended = (cashierRows ?? []).find(
      (r) =>
        r.role !== "admin" &&
        r.role !== "مدير" &&
        r.username &&
        r.username.trim().toLowerCase() === username &&
        r.is_active === false,
    );
    if (suspended) {
      return Response.json({ error: "الحساب موقوف — تواصل مع مدير المتجر" }, { status: 403 });
    }
  }

  // F3: verify against the stored per-cashier hash (sha256(pin + salt)).
  // Hash-less rows can no longer authenticate: migration 076 backfilled every
  // legacy row via 016's formula and dropped the plaintext pin column. Only
  // cashier rows are eligible — the owner (role 'admin') holds dashboard
  // credentials and never a PIN, so its hash can never unlock a register.
  const cashier = (cashierRows ?? []).find((r) => {
    if (r.role === "admin" || r.role === "مدير") return false;
    if (r.is_active === false) return false;
    if (username) {
      if (!r.username || r.username.trim().toLowerCase() !== username) return false;
    }
    return r.pin_hash
      ? sha256Hex(pin + (r.pin_salt ?? sha256Hex(`pos:pin-salt:${store.id}`).slice(0, 16))) === r.pin_hash
      : false;
  });
  if (!cashier) {
    return Response.json({ error: "بيانات الدخول غير صحيحة" }, { status: 401 });
  }

  const fallbackRoleCode = normalizeStaffRoleCode(cashier.role);
  let staffRole = {
    id: cashier.role_id as string | null,
    code: fallbackRoleCode,
    name: STAFF_ROLE_PRESETS[fallbackRoleCode].name,
    capabilities: [...STAFF_ROLE_PRESETS[fallbackRoleCode].capabilities],
    limits: { ...STAFF_ROLE_PRESETS[fallbackRoleCode].limits },
  };
  if (cashier.role_id) {
    const { data: roleRow, error: roleError } = await supabase
      .from("staff_roles")
      .select("id,code,name,capabilities,limits")
      .eq("id", cashier.role_id)
      .eq("store_id", store.id)
      .maybeSingle();
    if (roleError) return Response.json({ error: roleError.message }, { status: 500 });
    if (roleRow) {
      staffRole = {
        id: roleRow.id,
        code: normalizeStaffRoleCode(roleRow.code),
        name: roleRow.name,
        capabilities: Array.isArray(roleRow.capabilities) ? roleRow.capabilities : [],
        limits: roleRow.limits && typeof roleRow.limits === "object"
          ? roleRow.limits as typeof staffRole.limits
          : { ...STAFF_ROLE_PRESETS[fallbackRoleCode].limits },
      };
    }
  }

  const { data: branches, error: branchesError } = await supabase
    .from("branches")
    .select("id,name")
    .eq("store_id", store.id)
    .order("created_at", { ascending: true });
  if (branchesError) {
    return Response.json({ error: branchesError.message }, { status: 500 });
  }
  const branchRows = (branches ?? []) as Array<{ id: string; name: string }>;
  const branchIds = branchRows.map((b) => b.id);

  const { data: terminals, error: terminalsError } = await supabase
    .from("terminals")
    .select("id,branch_id,name")
    .in("branch_id", branchIds.length > 0 ? branchIds : ["00000000-0000-0000-0000-000000000000"]);
  if (terminalsError) {
    return Response.json({ error: terminalsError.message }, { status: 500 });
  }
  const terminalRows = (terminals ?? []) as Array<{ id: string; branch_id: string; name: string }>;

  // The auto-seeded "الفرع الرئيسي" / "الكاشير الرئيسي" are the safe defaults;
  // fall back to the first branch/terminal of this store when absent.
  const defaultBranchId =
    branchRows.find((b) => b.name === "الفرع الرئيسي")?.id ?? branchRows[0]?.id ?? null;
  const defaultTerminalId =
    terminalRows.find((t) => t.branch_id === defaultBranchId && t.name === "الكاشير الرئيسي")?.id ??
    terminalRows.find((t) => t.branch_id === defaultBranchId)?.id ??
    terminalRows[0]?.id ??
    null;

  const response = Response.json({
    store: {
      id: store.id,
      code: store.code,
      name: store.name,
      ownerName: store.owner_name,
      email: store.email,
      phone: store.phone,
      subscriptionStatus: store.subscription_status,
      logoUrl: store.logo_url,
      address: store.address,
      receiptHeader: store.receipt_header,
      receiptFooter: store.receipt_footer,
      loyaltyEnabled: store.loyalty_enabled !== false,
      pointsPerSpend: Number(store.points_per_spend) || 1,
      pointValue: Number(store.point_value) || 0.01,
      taxPercent: store.tax_percent != null ? Number(store.tax_percent) : 16,
      taxNumber: store.tax_number ?? "",
      receiptShowTaxNumber: store.receipt_show_tax_number !== false,
      receiptShowCashierTime: store.receipt_show_cashier_time !== false,
      receiptShowBarcodeQr: store.receipt_show_barcode_qr !== false,
      receiptCompactSpacing: store.receipt_compact_spacing === true,
    },
    cashier: {
      id: cashier.id,
      name: cashier.name,
      role: cashier.role,
      roleId: staffRole.id,
      roleCode: staffRole.code,
      roleName: staffRole.name,
      capabilities: staffRole.capabilities,
      limits: staffRole.limits,
    },
    branches: branchRows,
    terminals: terminalRows.map((t) => ({ id: t.id, branchId: t.branch_id, name: t.name })),
    defaultBranchId,
    defaultTerminalId,
    homePath: homePathForDevice({ role: "cashier", roleCode: staffRole.code }),
  });
  response.headers.set(
    "Set-Cookie",
    deviceSessionCookieHeader({
      storeId: store.id,
      actorId: cashier.id,
      actorName: cashier.name,
      role: "cashier",
      staffRoleCode: staffRole.code,
    }),
  );
  response.headers.append("Set-Cookie", clearAdminSessionCookieHeader());
  return response;
}
