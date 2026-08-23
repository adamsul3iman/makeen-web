import { getSupabaseBrowser } from "./supabaseBrowser";

/**
 * Direct Supabase browser queries for the Super Admin stores console
 * (replaces posFetch calls to /api/admin/stores and /api/admin/stores/[id]).
 * Super Admin sees every tenant, so no store_id scoping is applied.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_STATUSES = new Set(["active", "suspended"]);

const STORE_COLUMNS =
  "id,name,owner_name,email,phone,logo_url,address,receipt_header,receipt_footer,loyalty_enabled,points_per_spend,point_value,tax_percent,tax_number,receipt_show_tax_number,receipt_show_cashier_time,receipt_show_barcode_qr,receipt_compact_spacing,subscription_status,created_at,code";

export interface SuperAdminStore {
  id: string;
  code: string;
  name: string;
  ownerName: string;
  email: string;
  phone: string;
  logoUrl: string;
  address: string;
  receiptHeader: string;
  receiptFooter: string;
  loyaltyEnabled: boolean;
  pointsPerSpend: number;
  pointValue: number;
  taxPercent: number;
  taxNumber: string;
  receiptShowTaxNumber: boolean;
  receiptShowCashierTime: boolean;
  receiptShowBarcodeQr: boolean;
  receiptCompactSpacing: boolean;
  subscriptionStatus: string;
  createdAt?: string | null;
}

export interface CreateStoreInput {
  name: string;
  owner_name?: string;
  email: string;
  phone?: string;
  password?: string;
  code?: string;
}

function mapStoreRow(row: Record<string, unknown>): SuperAdminStore {
  return {
    id: row.id as string,
    code: (row.code as string | null) ?? "",
    name: row.name as string,
    ownerName: (row.owner_name as string | null) ?? "",
    email: (row.email as string | null) ?? "",
    phone: (row.phone as string | null) ?? "",
    logoUrl: (row.logo_url as string | null) ?? "",
    address: (row.address as string | null) ?? "",
    receiptHeader: (row.receipt_header as string | null) ?? "",
    receiptFooter: (row.receipt_footer as string | null) ?? "",
    loyaltyEnabled: row.loyalty_enabled !== false,
    pointsPerSpend: Number(row.points_per_spend) || 1,
    pointValue: Number(row.point_value) || 0.01,
    taxPercent: row.tax_percent != null ? Number(row.tax_percent) : 16,
    taxNumber: (row.tax_number as string | null) ?? "",
    receiptShowTaxNumber: row.receipt_show_tax_number !== false,
    receiptShowCashierTime: row.receipt_show_cashier_time !== false,
    receiptShowBarcodeQr: row.receipt_show_barcode_qr !== false,
    receiptCompactSpacing: row.receipt_compact_spacing === true,
    subscriptionStatus: (row.subscription_status as string | null) ?? "active",
    createdAt: (row.created_at as string | null) ?? null,
  };
}

/** List every tenant store (oldest first). */
export async function fetchStores(): Promise<SuperAdminStore[]> {
  const sb = getSupabaseBrowser();
  if (!sb) throw new Error("Supabase غير مهيأة");

  const { data, error } = await sb
    .from("stores")
    .select(STORE_COLUMNS)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);

  return ((data ?? []) as Array<Record<string, unknown>>).map(mapStoreRow);
}

/**
 * Provision a new tenant atomically via the `provision_new_store` RPC: the
 * store row, its owner cashier (email + dashboard password, PIN 1234 for the
 * POS), a main branch and its first terminal are inserted in one transaction.
 */
export async function createStore(data: CreateStoreInput): Promise<SuperAdminStore> {
  const sb = getSupabaseBrowser();
  if (!sb) throw new Error("Supabase غير مهيأة");

  const name = typeof data.name === "string" ? data.name.trim() : "";
  if (!name) throw new Error("اسم المتجر مطلوب");

  const email = typeof data.email === "string" ? data.email.trim().toLowerCase() : "";
  if (!email) throw new Error("بريد مدير المتجر مطلوب");
  if (!EMAIL_RE.test(email)) throw new Error("البريد الإلكتروني غير صالح");

  // Absent password keeps the documented onboarding default ('12345678'),
  // changeable after first login. Provided passwords must be >= 8 characters.
  let password = "12345678";
  if (typeof data.password === "string" && data.password.length > 0) {
    if (data.password.length < 8) {
      throw new Error("كلمة المرور يجب أن تكون 8 أحرف على الأقل");
    }
    password = data.password;
  }

  // Blank → auto-generated code inside provision_new_store; provided →
  // normalized to uppercase and validated against the /api/login format.
  let storeCode = "";
  if (typeof data.code === "string" && data.code.trim().length > 0) {
    storeCode = data.code.trim().toUpperCase();
    if (!/^[A-Z0-9]{4,12}$/.test(storeCode)) {
      throw new Error("كود المتجر يجب أن يتكون من 4-12 حرفاً/رقماً إنجليزياً فقط");
    }
  }

  const { data: created, error } = await sb.rpc("provision_new_store", {
    p_name: name,
    p_owner_name: typeof data.owner_name === "string" ? data.owner_name : "",
    p_email: email,
    p_phone: typeof data.phone === "string" ? data.phone : "",
    p_password: password,
    p_code: storeCode || null,
    p_token: "",
  });

  if (error) {
    // 23505 = duplicate owner email or raced-past duplicate store code;
    // 22023 = invalid email format or invalid store code.
    const message = String(error.message ?? "");
    if (error.code === "23505" || /duplicate key/i.test(message)) {
      if (/store_code_already_used/i.test(message)) {
        throw new Error("كود المتجر مستخدم مسبقاً — اختر كوداً آخر");
      }
      throw new Error("هذا البريد الإلكتروني مستخدم مسبقاً");
    }
    if (error.code === "22023") {
      if (/invalid_store_code/i.test(message)) {
        throw new Error("كود المتجر غير صالح — 4-12 حرفاً/رقماً إنجليزياً فقط");
      }
      throw new Error("البريد الإلكتروني غير صالح");
    }
    throw new Error(message || "فشل إنشاء المتجر");
  }
  if (!created || typeof created !== "object") throw new Error("فشل إنشاء المتجر");

  return mapStoreRow(created as Record<string, unknown>);
}

/** Suspend / reactivate a tenant store (subscription lifecycle). */
export async function updateStoreStatus(id: string, subscription_status: string): Promise<SuperAdminStore> {
  const sb = getSupabaseBrowser();
  if (!sb) throw new Error("Supabase غير مهيأة");

  if (!VALID_STATUSES.has(subscription_status)) {
    throw new Error("حالة الاشتراك غير صالحة");
  }

  const { data, error } = await sb
    .from("stores")
    .update({ subscription_status })
    .eq("id", id)
    .select(STORE_COLUMNS)
    .single();
  if (error || !data) throw new Error(error?.message ?? "المتجر غير موجود");

  return mapStoreRow(data as unknown as Record<string, unknown>);
}

/**
 * Delete a tenant and ALL of its data atomically inside the `delete_store`
 * RPC (children-first, single transaction). Irreversible.
 */
export async function deleteStore(id: string): Promise<void> {
  const sb = getSupabaseBrowser();
  if (!sb) throw new Error("Supabase غير مهيأة");

  const { data, error } = await sb.rpc("delete_store", {
    p_store_id: id,
    p_token: "",
  });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("المتجر غير موجود");
}
