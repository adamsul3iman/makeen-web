import { getSupabaseBrowser } from "./supabaseBrowser";
import { getTenantStoreId } from "./tenantClient";

/** Interventions that must land in the immutable admin audit log (P3). */
export const AUDIT_ACTION_TYPES = [
  "OVERRIDE_PRICE",
  "CANCEL_INVOICE",
  "OPEN_DRAWER",
  "SAVE_CASHIER",
  "DELETE_CASHIER",
  "ENTER_RETURN_MODE",
  "ADJUST_STOCK",
  "CREATE_SUPPLIER_INVOICE",
  "RECORD_SUPPLIER_PAYMENT",
  "SHIFT_VARIANCE",
  "SHIFT_VARIANCE_APPROVED",
  "SHIFT_STALE_RESOLVED",
  "REVIEW_RISK_EVENT",
  "SAVE_PRINT_TEMPLATE",
  "DELETE_PRINT_TEMPLATE",
  "UPDATE_RECEIPT_LOGO",
] as const;

export type AuditActionType = (typeof AUDIT_ACTION_TYPES)[number];

/** One append-only row of the admin audit log (as returned by the API). */
export interface AuditEntry {
  id: string;
  store_id: string;
  admin_id: string | null;
  admin_name?: string | null;
  action_type: AuditActionType;
  target_id: string | null;
  details: Record<string, unknown>;
  created_at: string;
}

/**
 * Best-effort push of a sensitive admin intervention to the audit log.
 *
 * Never throws and never blocks the action it reports: if Supabase is
 * unreachable the sensitive action has already completed locally and the
 * entry is simply not recorded (the same offline posture as the rest of the
 * POS). The acting admin is recorded as the owner account.
 */
export async function pushAudit(
  email: string | null | undefined,
  actionType: AuditActionType,
  targetId?: string | null,
  details?: Record<string, unknown>,
): Promise<boolean> {
  if (!email) return false;
  try {
    const sb = getSupabaseBrowser();
    const storeId = getTenantStoreId();
    if (!sb || !storeId) return false;
    const { error } = await sb.from("admin_audit_logs").insert({
      store_id: storeId,
      admin_id: "owner",
      admin_name: "المدير",
      action_type: actionType,
      target_id: targetId ?? null,
      details: details ?? {},
    });
    return !error;
  } catch {
    return false;
  }
}
