import { getAdminAccess } from "@/lib/requestAuth";
import { supabase } from "@/lib/supabase";
import { opsToken } from "@/lib/platformOps";
import { rateLimit, rateLimited } from "@/lib/rateLimit";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface ApprovalBody {
  password?: unknown;
  note?: unknown;
}

/** Owner-only acknowledgement of an immutable Z-report cash variance. */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const access = await getAdminAccess(request);
  if (!access) return Response.json({ error: "admin_session_required" }, { status: 401 });

  const { id } = await context.params;
  if (!UUID_RE.test(id)) return Response.json({ error: "invalid_shift_id" }, { status: 400 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const input = body as ApprovalBody;
  const password = typeof input.password === "string" ? input.password : "";
  const note = typeof input.note === "string" ? input.note.trim() : "";
  if (!password) return Response.json({ error: "owner_password_required" }, { status: 400 });
  if (note.length < 3 || note.length > 500) {
    return Response.json({ error: "approval_note_required" }, { status: 400 });
  }

  if (!supabase) {
    if (password !== "12345678") return Response.json({ error: "invalid_owner_password" }, { status: 401 });
    return Response.json({ ok: true, shiftId: id, approvalStatus: "APPROVED" });
  }

  const gate = rateLimit(request, `shift-approval:${access.storeId}`, 5, 15 * 60 * 1000);
  if (!gate.ok) return rateLimited(gate.retryAfter ?? 1);

  const { data: auth, error: authError } = await supabase.rpc("authenticate_admin", {
    p_email: access.email,
    p_password: password,
    p_token: opsToken(),
  });
  if (authError) return Response.json({ error: authError.message }, { status: 500 });
  if (!auth || typeof auth !== "object") {
    return Response.json({ error: "invalid_owner_password" }, { status: 401 });
  }
  const authPayload = auth as {
    store?: { id?: string };
    cashier?: { id?: string; name?: string };
  };
  if (authPayload.store?.id !== access.storeId) {
    return Response.json({ error: "store_mismatch" }, { status: 403 });
  }

  const ownerId = authPayload.cashier?.id ?? null;
  const ownerName = authPayload.cashier?.name || access.name;
  const { data: report, error: approvalError } = await supabase.rpc("approve_shift_variance", {
    p_store_id: access.storeId,
    p_shift_id: id,
    p_approved_by: ownerId,
    p_approved_by_name: ownerName,
    p_note: note,
  });
  if (approvalError) {
    if (approvalError.code === "P0002") return Response.json({ error: "shift_report_not_found" }, { status: 404 });
    if (approvalError.code === "23514") return Response.json({ error: "variance_approval_not_required" }, { status: 409 });
    return Response.json({ error: approvalError.message }, { status: 500 });
  }

  const approved = Array.isArray(report) ? report[0] : report;
  return Response.json({
    ok: true,
    shiftId: id,
    approvalStatus: approved?.approval_status ?? "APPROVED",
    approvedAt: approved?.approved_at ?? null,
    approvedByName: approved?.approved_by_name ?? ownerName,
  });
}
