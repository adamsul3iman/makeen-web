import { capabilityAuthorizationError, getCapabilityAccess } from "@/lib/requestAuth";
import { supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/** PATCH — resolve (mark as resolved) or unresolve a shortage flag. */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const access = await getCapabilityAccess(request, "inventory.manage");
  if (!access) return capabilityAuthorizationError(request, "inventory.manage");

  const { id } = await params;
  if (!id) return Response.json({ error: "missing_id" }, { status: 400 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const input = body as { resolved?: unknown };
  const resolved = input.resolved === true;

  if (!supabase) return Response.json({ error: "Supabase غير مهيأة" }, { status: 503 });

  const update: Record<string, unknown> = {
    resolved,
    resolved_by: resolved ? access.actorName ?? "admin" : null,
    resolved_at: resolved ? new Date().toISOString() : null,
  };

  const { data, error } = await supabase
    .from("shortage_flags")
    .update(update)
    .eq("id", id)
    .eq("store_id", access.storeId)
    .select("id,resolved")
    .maybeSingle();

  if (error) return Response.json({ error: error.message }, { status: 500 });
  if (!data) return Response.json({ error: "العَلَم غير موجود" }, { status: 404 });
  return Response.json({ flag: data });
}

/** DELETE — permanently remove a shortage flag. */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const access = await getCapabilityAccess(request, "inventory.manage");
  if (!access) return capabilityAuthorizationError(request, "inventory.manage");

  const { id } = await params;
  if (!id) return Response.json({ error: "missing_id" }, { status: 400 });
  if (!supabase) return Response.json({ error: "Supabase غير مهيأة" }, { status: 503 });

  const { data, error } = await supabase
    .from("shortage_flags")
    .delete()
    .eq("id", id)
    .eq("store_id", access.storeId)
    .select("id")
    .maybeSingle();

  if (error) return Response.json({ error: error.message }, { status: 500 });
  if (!data) return Response.json({ error: "العَلَم غير موجود" }, { status: 404 });
  return Response.json({ ok: true });
}
