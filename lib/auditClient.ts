import { getSupabaseBrowser } from "./supabaseBrowser";
import { getTenantStoreId } from "./tenantClient";

export interface AdminAuditLog {
  id: string;
  store_id: string;
  admin_id: string | null;
  admin_name: string | null;
  action_type: string;
  target_id: string | null;
  details: Record<string, unknown> | null;
  created_at: string;
}

/**
 * Store-scoped admin audit trail (سجل التدقيق) — newest 200 entries first.
 */
export async function fetchAuditLogs(): Promise<AdminAuditLog[]> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  const { data, error } = await sb
    .from("admin_audit_logs")
    .select("id,store_id,admin_id,admin_name,action_type,target_id,details,created_at")
    .eq("store_id", storeId)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw new Error(error.message);
  return ((data ?? []) as AdminAuditLog[]);
}
