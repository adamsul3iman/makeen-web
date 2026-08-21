import { supabase } from "@/lib/supabase";
import { getStoreId, MOCK_STORE_ID } from "@/lib/tenant";
import { rateLimit, rateLimited } from "@/lib/rateLimit";
import { AUDIT_ACTION_TYPES, type AuditActionType } from "@/lib/audit";
import { adminSessionError, capabilityAuthorizationError, getAdminAccess, getCapabilityAccess } from "@/lib/requestAuth";
import { recordAuditRiskSignal } from "@/lib/riskEngine";

/**
 * P3 — immutable admin audit log.
 *
 * Records every sensitive intervention executed from Admin Mode ("God
 * Mode"): inline price overrides, invoice cancellations, manual cash-drawer
 * opens and cashier roster changes. Append-only: this route exposes no
 * UPDATE or DELETE, and the table carries a trigger that rejects both.
 *
 * Trust model — the acting admin is NOT taken from the client. The
 * `x-pos-admin-email` header identifies the owner and the server resolves
 * the real cashier row (id + name snapshot) inside the caller's store, so a
 * leaked session can only log as itself, never as a fabricated identity. The
 * destructive P2 actions themselves are additionally gated by the owner
 * password re-verification endpoint (/api/admin/reverify).
 */

const ADMIN_EMAIL_HEADER = "x-pos-admin-email";
const MOCK_ADMIN_EMAIL = "admin@demo.test";
const MOCK_ADMIN_ID = "admin-1";
const MOCK_ADMIN_NAME = "مدير";

const ALLOWED = AUDIT_ACTION_TYPES as readonly string[];

/** In-process mirror used in mock mode so POST -> GET round-trips. */
const mockEntries: Array<{
  id: string;
  store_id: string;
  admin_id: string;
  admin_name: string;
  action_type: string;
  target_id: string | null;
  details: Record<string, unknown>;
  created_at: string;
}> = [
  {
    id: "audit-demo-1",
    store_id: MOCK_STORE_ID,
    admin_id: MOCK_ADMIN_ID,
    admin_name: MOCK_ADMIN_NAME,
    action_type: "OPEN_DRAWER",
    target_id: null,
    details: { terminalId: "terminal-main" },
    created_at: new Date(Date.now() - 48 * 60 * 1000).toISOString(),
  },
  {
    id: "audit-demo-2",
    store_id: MOCK_STORE_ID,
    admin_id: MOCK_ADMIN_ID,
    admin_name: MOCK_ADMIN_NAME,
    action_type: "OVERRIDE_PRICE",
    target_id: "p1",
    details: { productName: "كولا", from: 10, to: 12, qty: 2 },
    created_at: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
  },
  {
    id: "audit-demo-3",
    store_id: MOCK_STORE_ID,
    admin_id: MOCK_ADMIN_ID,
    admin_name: MOCK_ADMIN_NAME,
    action_type: "CANCEL_INVOICE",
    target_id: "inv-00000000",
    details: { total: -11.6, items: 1 },
    created_at: new Date(Date.now() - 12 * 60 * 1000).toISOString(),
  },
];

interface AuditInput {
  action_type?: unknown;
  target_id?: unknown;
  details?: unknown;
}

function badInput(message: string): Response {
  return Response.json({ error: message }, { status: 400 });
}

/** Latest interventions for the store owner (newest first). */
export async function GET(request: Request): Promise<Response> {
  if (!supabase) {
    const email = request.headers.get(ADMIN_EMAIL_HEADER)?.trim().toLowerCase() ?? "";
    if (!email) return badInput(`رأس ${ADMIN_EMAIL_HEADER} مطلوب`);
    return Response.json({ entries: mockEntries });
  }

  const access = await getCapabilityAccess(request, "audit.view");
  if (!access) {
    return capabilityAuthorizationError(request, "audit.view");
  }
  const storeId = access.storeId;

  const { data, error } = await supabase
    .from("admin_audit_logs")
    .select("id,store_id,admin_id,admin_name,action_type,target_id,details,created_at")
    .eq("store_id", storeId)
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ entries: data ?? [] });
}

/** Append one audit entry for the acting admin of the caller's store. */
export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badInput("invalid_json");
  }

  const input = body as AuditInput;
  const actionType = input.action_type;
  if (typeof actionType !== "string" || !ALLOWED.includes(actionType)) {
    return badInput("نوع الإجراء غير صالح");
  }

  const targetId =
    typeof input.target_id === "string" && input.target_id.length > 0
      ? input.target_id
      : null;

  let details: Record<string, unknown> = {};
  if (input.details !== undefined) {
    if (typeof input.details !== "object" || input.details === null || Array.isArray(input.details)) {
      return badInput("التفاصيل يجب أن تكون JSON object");
    }
    details = input.details as Record<string, unknown>;
  }

  if (supabase) {
    const access = await getAdminAccess(request);
    if (!access) return adminSessionError();
    const email = access.email.trim().toLowerCase();
    const gate = rateLimit(request, `admin-audit:${email}`, 60, 60 * 1000);
    if (!gate.ok) return rateLimited(gate.retryAfter ?? 1);

    const storeId = access.storeId;

    // Resolve the real admin identity server-side — never trust the body.
    const { data: admin, error: adminError } = await supabase
      .from("cashiers")
      .select("id,name")
      .eq("store_id", storeId)
      .eq("email", email)
      .eq("role", "admin")
      .maybeSingle();
    if (adminError) return Response.json({ error: adminError.message }, { status: 500 });
    if (!admin) return Response.json({ error: "بيانات المدير غير صحيحة" }, { status: 403 });

    const { data, error } = await supabase
      .from("admin_audit_logs")
      .insert({
        store_id: storeId,
        admin_id: admin.id,
        admin_name: admin.name,
        action_type: actionType,
        target_id: targetId,
        details,
      })
      .select("id,store_id,admin_id,admin_name,action_type,target_id,details,created_at")
      .maybeSingle();

    if (error) return Response.json({ error: error.message }, { status: 500 });
    if (data?.id) {
      try {
        await recordAuditRiskSignal({
          auditId: data.id,
          storeId,
          actionType,
          actorId: admin.id,
          actorName: admin.name,
          targetId,
          details,
          occurredAt: data.created_at,
        });
      } catch (riskError) {
        console.error(`Risk signal error for audit ${data.id}:`, riskError);
      }
    }
    return Response.json({ entry: data }, { status: 201 });
  }

  // Mock mode: only the documented demo owner may write.
  const email = request.headers.get(ADMIN_EMAIL_HEADER)?.trim().toLowerCase() ?? "";
  if (!email) return badInput(`رأس ${ADMIN_EMAIL_HEADER} مطلوب`);
  if (email !== MOCK_ADMIN_EMAIL) {
    return Response.json({ error: "بيانات المدير غير صحيحة" }, { status: 401 });
  }

  const storeId = getStoreId(request) ?? MOCK_STORE_ID;
  const entry = {
    id: crypto.randomUUID(),
    store_id: storeId,
    admin_id: MOCK_ADMIN_ID,
    admin_name: MOCK_ADMIN_NAME,
    action_type: actionType as AuditActionType,
    target_id: targetId,
    details,
    created_at: new Date().toISOString(),
  };
  mockEntries.unshift(entry);
  if (mockEntries.length > 500) mockEntries.length = 500;
  return Response.json({ entry }, { status: 201 });
}
