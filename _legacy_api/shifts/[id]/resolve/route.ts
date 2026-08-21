import { getAdminAccess } from "@/lib/requestAuth";
import { supabase } from "@/lib/supabase";
import { opsToken } from "@/lib/platformOps";
import { rateLimit, rateLimited } from "@/lib/rateLimit";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface ResolveBody {
  actualCash?: unknown;
  password?: unknown;
  note?: unknown;
}

/** Owner-only atomic recovery of a stale SHIFT_OPENED event. */
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
  const input = body as ResolveBody;
  const actualCash = typeof input.actualCash === "number" ? input.actualCash : Number.NaN;
  const password = typeof input.password === "string" ? input.password : "";
  const note = typeof input.note === "string" ? input.note.trim() : "";
  if (!Number.isFinite(actualCash) || actualCash < 0 || actualCash > 99_999_999_999) {
    return Response.json({ error: "actual_cash_invalid" }, { status: 400 });
  }
  if (!password) return Response.json({ error: "owner_password_required" }, { status: 400 });
  if (note.length < 3 || note.length > 500) {
    return Response.json({ error: "resolution_note_required" }, { status: 400 });
  }

  if (!supabase) {
    if (password !== "12345678") return Response.json({ error: "invalid_owner_password" }, { status: 401 });
    return Response.json({ ok: true, shiftId: id, closeSource: "ADMIN_RECOVERY" });
  }

  const gate = rateLimit(request, `shift-recovery:${access.storeId}`, 5, 15 * 60 * 1000);
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

  const { data, error } = await supabase.rpc("resolve_stale_shift", {
    p_store_id: access.storeId,
    p_shift_id: id,
    p_actual_cash: actualCash,
    p_resolved_by: authPayload.cashier?.id ?? null,
    p_resolved_by_name: authPayload.cashier?.name || access.name,
    p_note: note,
  });
  if (error) {
    if (error.code === "P0002") return Response.json({ error: "shift_open_event_not_found" }, { status: 404 });
    if (error.code === "55000") return Response.json({ error: "shift_is_not_stale" }, { status: 409 });
    if (error.code === "22023") return Response.json({ error: error.message }, { status: 400 });
    return Response.json({ error: error.message }, { status: 500 });
  }

  const report = Array.isArray(data) ? data[0] : data;
  return Response.json({
    ok: true,
    shiftId: id,
    closeSource: report?.close_source ?? "ADMIN_RECOVERY",
    variance: Number(report?.variance ?? 0),
    approvalStatus: report?.approval_status ?? "NOT_REQUIRED",
  });
}
