import { getSupabaseBrowser } from "./supabaseBrowser";
import { getTenantStoreId } from "./tenantClient";

export interface StaffRole {
  id: string;
  code: string;
  name: string;
  description?: string | null;
  capabilities?: string[];
  limits?: Record<string, unknown> | null;
  isSystem: boolean;
  sortOrder?: number | null;
}

export interface Cashier {
  id: string;
  storeId: string;
  name: string;
  username?: string | null;
  pinSalt?: string | null;
  pinHash?: string | null;
  role?: string | null;
  roleId?: string | null;
  isActive: boolean;
  createdAt?: string | null;
}

export interface CreateCashierInput {
  name: string;
  username?: string;
  role: string;
  roleId?: string;
  pin: string;
}

export interface UpdateCashierInput {
  name?: string;
  username?: string;
  role?: string;
  roleId?: string;
  pin?: string;
  isActive?: boolean;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function generatePinSalt(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
}

async function hashPin(pin: string, salt: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pin + salt));
  return bytesToHex(new Uint8Array(digest));
}

export async function fetchCashiers(): Promise<Cashier[]> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  const { data, error } = await sb
    .from("cashiers")
    .select("id,store_id,name,username,pin_salt,pin_hash,role,role_id,is_active,created_at")
    .eq("store_id", storeId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);

  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    id: row.id as string,
    storeId: row.store_id as string,
    name: row.name as string,
    username: (row.username as string | null) ?? null,
    pinSalt: (row.pin_salt as string | null) ?? null,
    pinHash: (row.pin_hash as string | null) ?? null,
    role: (row.role as string | null) ?? null,
    roleId: (row.role_id as string | null) ?? null,
    isActive: Boolean(row.is_active),
    createdAt: (row.created_at as string | null) ?? null,
  }));
}

export async function createCashier(input: CreateCashierInput): Promise<Cashier> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  const trimmedName = input.name.trim();
  if (!trimmedName) throw new Error("اسم الموظف مطلوب");

  const pinSalt = generatePinSalt();
  const pinHash = await hashPin(input.pin.trim(), pinSalt);

  const { data, error } = await sb
    .from("cashiers")
    .insert({
      store_id: storeId,
      name: trimmedName,
      ...(input.username ? { username: input.username.trim().toLowerCase() } : {}),
      role: input.role,
      ...(input.roleId ? { role_id: input.roleId } : {}),
      pin_salt: pinSalt,
      pin_hash: pinHash,
      is_active: true,
    })
    .select("id,store_id,name,username,pin_salt,pin_hash,role,role_id,is_active,created_at")
    .single();
  if (error || !data) throw new Error(error?.message ?? "تعذر إنشاء الموظف");

  const row = data as Record<string, unknown>;
  return {
    id: row.id as string,
    storeId: row.store_id as string,
    name: row.name as string,
    username: (row.username as string | null) ?? null,
    pinSalt: (row.pin_salt as string | null) ?? null,
    pinHash: (row.pin_hash as string | null) ?? null,
    role: (row.role as string | null) ?? null,
    roleId: (row.role_id as string | null) ?? null,
    isActive: Boolean(row.is_active),
    createdAt: (row.created_at as string | null) ?? null,
  };
}

export async function updateCashier(
  id: string,
  input: UpdateCashierInput,
): Promise<Cashier> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  const patch: Record<string, unknown> = {};
  if (input.name !== undefined && input.name.trim()) patch.name = input.name.trim();
  if (input.username !== undefined && input.username.trim()) {
    patch.username = input.username.trim().toLowerCase();
  }
  if (input.role !== undefined) patch.role = input.role;
  if (input.roleId !== undefined) patch.role_id = input.roleId;
  if (input.isActive !== undefined) patch.is_active = input.isActive;
  if (input.pin !== undefined && input.pin.length > 0) {
    const pinSalt = generatePinSalt();
    patch.pin_salt = pinSalt;
    patch.pin_hash = await hashPin(input.pin.trim(), pinSalt);
  }
  if (Object.keys(patch).length === 0) throw new Error("لا توجد تغييرات لحفظها");

  const { data, error } = await sb
    .from("cashiers")
    .update(patch)
    .eq("id", id)
    .eq("store_id", storeId)
    .select("id,store_id,name,username,pin_salt,pin_hash,role,role_id,is_active,created_at")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("الموظف غير موجود");

  const row = data as Record<string, unknown>;
  return {
    id: row.id as string,
    storeId: row.store_id as string,
    name: row.name as string,
    username: (row.username as string | null) ?? null,
    pinSalt: (row.pin_salt as string | null) ?? null,
    pinHash: (row.pin_hash as string | null) ?? null,
    role: (row.role as string | null) ?? null,
    roleId: (row.role_id as string | null) ?? null,
    isActive: Boolean(row.is_active),
    createdAt: (row.created_at as string | null) ?? null,
  };
}

export async function deleteCashier(id: string): Promise<void> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  const { error } = await sb.from("cashiers").delete().eq("id", id).eq("store_id", storeId);
  if (error) throw new Error(error.message);
}

export async function fetchRoles(): Promise<StaffRole[]> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  const { data, error } = await sb
    .from("staff_roles")
    .select("id,code,name,description,capabilities,limits,is_system,sort_order")
    .eq("store_id", storeId)
    .order("sort_order", { ascending: true });
  if (error) throw new Error(error.message);

  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    id: row.id as string,
    code: row.code as string,
    name: row.name as string,
    description: (row.description as string | null) ?? null,
    capabilities: Array.isArray(row.capabilities) ? (row.capabilities as string[]) : [],
    limits:
      row.limits && typeof row.limits === "object"
        ? (row.limits as Record<string, unknown>)
        : {},
    isSystem: Boolean(row.is_system),
    sortOrder: (row.sort_order as number | null) ?? null,
  }));
}
