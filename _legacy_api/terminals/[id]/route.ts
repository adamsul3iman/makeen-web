import { supabase } from "@/lib/supabase";
import { authorizedCapabilityStoreId } from "@/lib/requestAuth";

interface TerminalInput {
  name?: unknown;
}

/**
 * Rename a terminal (PATCH) or delete an empty one (DELETE).
 * Admin role only. The terminal must belong to one of the caller's branches,
 * and deletion is blocked while any sync_events (sales/shifts) reference it
 * so historical drawer reports stay intact.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!supabase) return Response.json({ error: "Supabase غير مهيأة" }, { status: 503 });
  const storeId = await authorizedCapabilityStoreId(request, "branches.manage");
  if (storeId instanceof Response) return storeId;
  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const name = ((body as TerminalInput)?.name ?? "").toString().trim();
  if (!name) return Response.json({ error: "اسم الكاشير مطلوب" }, { status: 400 });

  // Verify the terminal belongs to a branch of this store.
  const { data: terminal, error: readError } = await supabase
    .from("terminals")
    .select("id,branch_id")
    .eq("id", id)
    .maybeSingle();
  if (readError) return Response.json({ error: readError.message }, { status: 500 });
  if (!terminal) return Response.json({ error: "الكاشير غير موجود" }, { status: 404 });

  const { data: branch, error: branchError } = await supabase
    .from("branches")
    .select("id")
    .eq("id", terminal.branch_id)
    .eq("store_id", storeId)
    .maybeSingle();
  if (branchError) return Response.json({ error: branchError.message }, { status: 500 });
  if (!branch) return Response.json({ error: "الكاشير غير موجود" }, { status: 404 });

  const { data, error } = await supabase
    .from("terminals")
    .update({ name })
    .eq("id", id)
    .select("id,branch_id,name")
    .maybeSingle();
  if (error) return Response.json({ error: error.message }, { status: 500 });
  if (!data) return Response.json({ error: "الكاشير غير موجود" }, { status: 404 });

  return Response.json({ terminal: { id: data.id, branchId: data.branch_id, name: data.name } });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!supabase) return Response.json({ error: "Supabase غير مهيأة" }, { status: 503 });
  const storeId = await authorizedCapabilityStoreId(request, "branches.manage");
  if (storeId instanceof Response) return storeId;
  const { id } = await params;

  const { data: terminal, error: readError } = await supabase
    .from("terminals")
    .select("id,branch_id")
    .eq("id", id)
    .maybeSingle();
  if (readError) return Response.json({ error: readError.message }, { status: 500 });
  if (!terminal) return Response.json({ error: "الكاشير غير موجود" }, { status: 404 });

  const { data: branch, error: branchError } = await supabase
    .from("branches")
    .select("id")
    .eq("id", terminal.branch_id)
    .eq("store_id", storeId)
    .maybeSingle();
  if (branchError) return Response.json({ error: branchError.message }, { status: 500 });
  if (!branch) return Response.json({ error: "الكاشير غير موجود" }, { status: 404 });

  const { data: eventRows, error: eventError } = await supabase
    .from("sync_events")
    .select("sync_id")
    .eq("terminal_id", id)
    .limit(1);
  if (eventError) return Response.json({ error: eventError.message }, { status: 500 });
  if ((eventRows ?? []).length > 0) {
    return Response.json({ error: "لا يمكن حذف كاشير لديه سجل مبيعات" }, { status: 409 });
  }

  const { error: deleteError } = await supabase.from("terminals").delete().eq("id", id);
  if (deleteError) return Response.json({ error: deleteError.message }, { status: 500 });

  return Response.json({ ok: true });
}
