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

/**
 * Draft for creating / editing a role. `code` is required for creation and
 * immutable on update (cashiers.role stores it textually). Editing a role goes
 * through the proof-per-call RPCs (migration 097), never direct table DML.
 */
export interface RoleDraft {
  id?: string;
  code: string;
  name: string;
  description?: string;
  capabilities: string[];
  limits: Record<string, number | null>;
}

/**
 * Safe roster row — migration 078 removed browser access to credential
 * columns (pin_salt/pin_hash/password_hash/email). The list comes from the
 * `list_cashiers_public` SECURITY DEFINER RPC.
 */
export interface Cashier {
  id: string;
  storeId: string;
  name: string;
  username?: string | null;
  role?: string | null;
  roleId?: string | null;
  isActive: boolean;
}

export async function fetchCashiers(): Promise<Cashier[]> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  const { data, error } = await sb.rpc("list_cashiers_public", {
    p_store_id: storeId,
    p_include_inactive: true,
  });
  if (error) throw new Error(error.message);

  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    id: row.id as string,
    storeId,
    name: row.name as string,
    username: (row.username as string | null) ?? null,
    role: (row.role as string | null) ?? null,
    roleId: (row.role_id as string | null) ?? null,
    isActive: Boolean(row.is_active),
  }));
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
