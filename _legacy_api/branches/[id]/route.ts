import { supabase } from "@/lib/supabase";
import { authorizedCapabilityStoreId } from "@/lib/requestAuth";

interface BranchInput {
  name?: unknown;
}

/**
 * Rename a branch (PATCH) or delete an empty one (DELETE).
 * Both require the admin cashier role. A branch can only be deleted when it
 * has no terminals and no historical sync_events reference it, so fiscal
 * history is never orphaned.
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
  const name = ((body as BranchInput)?.name ?? "").toString().trim();
  if (!name) return Response.json({ error: "اسم الفرع مطلوب" }, { status: 400 });

  const { data, error } = await supabase
    .from("branches")
    .update({ name })
    .eq("id", id)
    .eq("store_id", storeId)
    .select("id,name")
    .maybeSingle();
  if (error) return Response.json({ error: error.message }, { status: 500 });
  if (!data) return Response.json({ error: "الفرع غير موجود" }, { status: 404 });

  return Response.json({ branch: data });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!supabase) return Response.json({ error: "Supabase غير مهيأة" }, { status: 503 });
  const storeId = await authorizedCapabilityStoreId(request, "branches.manage");
  if (storeId instanceof Response) return storeId;
  const { id } = await params;

  const { data: branch, error: branchError } = await supabase
    .from("branches")
    .select("id")
    .eq("id", id)
    .eq("store_id", storeId)
    .maybeSingle();
  if (branchError) return Response.json({ error: branchError.message }, { status: 500 });
  if (!branch) return Response.json({ error: "الفرع غير موجود" }, { status: 404 });

  const { data: terminalRows, error: terminalError } = await supabase
    .from("terminals")
    .select("id")
    .eq("branch_id", id);
  if (terminalError) return Response.json({ error: terminalError.message }, { status: 500 });
  if ((terminalRows ?? []).length > 0) {
    return Response.json({ error: "لا يمكن حذف فرع يحتوي على كاشيرات" }, { status: 409 });
  }

  const { data: eventRows, error: eventError } = await supabase
    .from("sync_events")
    .select("sync_id")
    .eq("branch_id", id)
    .limit(1);
  if (eventError) return Response.json({ error: eventError.message }, { status: 500 });
  if ((eventRows ?? []).length > 0) {
    return Response.json({ error: "لا يمكن حذف فرع لديه سجل مبيعات" }, { status: 409 });
  }

  const { error: deleteError } = await supabase.from("branches").delete().eq("id", id);
  if (deleteError) return Response.json({ error: deleteError.message }, { status: 500 });

  return Response.json({ ok: true });
}
