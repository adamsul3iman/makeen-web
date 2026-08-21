import { supabase } from "@/lib/supabase";
import { MOCK_STORE_ID, getStoreId, storeIdError } from "@/lib/tenant";
import { authorizedCapabilityStoreId } from "@/lib/requestAuth";

interface TerminalInput {
  branch_id?: unknown;
  name?: unknown;
}

/**
 * Create a terminal (كاشير) inside one of the store's branches.
 * Admin role only; the branch is verified to belong to the caller's store so
 * a tenant can never attach a register to another tenant's branch.
 */
export async function POST(request: Request): Promise<Response> {
  if (!supabase) {
    const storeId = getStoreId(request);
    if (!storeId || storeId === MOCK_STORE_ID) {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        body = null;
      }
      const input = body as TerminalInput;
      const name = (input?.name ?? "").toString().trim();
      if (!name) return Response.json({ error: "اسم الكاشير مطلوب" }, { status: 400 });
      return Response.json({
        terminal: {
          id: `terminal-${Date.now().toString(36)}`,
          branchId: (input?.branch_id ?? "").toString(),
          name,
        },
      });
    }
    return storeIdError();
  }

  const storeId = await authorizedCapabilityStoreId(request, "branches.manage");
  if (storeId instanceof Response) return storeId;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const input = body as TerminalInput;
  const branchId = (input?.branch_id ?? "").toString().trim();
  const name = (input?.name ?? "").toString().trim();
  if (!branchId) return Response.json({ error: "الفرع مطلوب" }, { status: 400 });
  if (!name) return Response.json({ error: "اسم الكاشير مطلوب" }, { status: 400 });
  if (name.length > 80) return Response.json({ error: "اسم الكاشير طويل جداً" }, { status: 400 });

  const { data: branch, error: branchError } = await supabase
    .from("branches")
    .select("id")
    .eq("id", branchId)
    .eq("store_id", storeId)
    .maybeSingle();
  if (branchError) return Response.json({ error: branchError.message }, { status: 500 });
  if (!branch) return Response.json({ error: "الفرع غير موجود" }, { status: 404 });

  const { data: terminal, error } = await supabase
    .from("terminals")
    .insert({ branch_id: branchId, name })
    .select("id,branch_id,name,created_at")
    .single();
  if (error) return Response.json({ error: error.message }, { status: 500 });

  return Response.json({
    terminal: {
      id: terminal.id,
      branchId: terminal.branch_id,
      name: terminal.name,
      createdAt: terminal.created_at,
    },
  });
}
