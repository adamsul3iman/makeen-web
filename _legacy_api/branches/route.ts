import { supabase } from "@/lib/supabase";
import { MOCK_STORE_ID } from "@/lib/tenant";
import { getStoreId, storeIdError } from "@/lib/tenant";
import { authorizedCapabilityStoreId, authorizedStoreId } from "@/lib/requestAuth";

export const MOCK_BRANCH_ID = "branch-main";
export const MOCK_TERMINAL_ID = "terminal-main";

interface BranchInput {
  name?: unknown;
}

/**
 * Store-scoped branch (فرع) registry for the multi-terminal architecture.
 *
 * GET returns every branch with its terminals so the POS login can default
 * the cashier to a branch/register and the admin page can manage them.
 * POST (admin role) creates a branch and auto-creates a default
 * "كاشير 1" terminal, so a new branch is immediately usable at the register.
 */
export async function GET(request: Request): Promise<Response> {
  if (!supabase) {
    return Response.json({
      branches: [
        {
          id: MOCK_BRANCH_ID,
          name: "الفرع الرئيسي",
          terminals: [{ id: MOCK_TERMINAL_ID, name: "الكاشير الرئيسي" }],
        },
      ],
    });
  }

  const storeId = await authorizedStoreId(request);
  if (storeId instanceof Response) return storeId;

  const { data: branches, error } = await supabase
    .from("branches")
    .select("id,name,created_at")
    .eq("store_id", storeId)
    .order("created_at", { ascending: true });
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const branchRows = (branches ?? []) as Array<{ id: string; name: string; created_at: string }>;
  const branchIds = branchRows.map((b) => b.id);

  const { data: terminals, error: terminalsError } = await supabase
    .from("terminals")
    .select("id,branch_id,name,created_at")
    .in("branch_id", branchIds.length > 0 ? branchIds : ["00000000-0000-0000-0000-000000000000"])
    .order("created_at", { ascending: true });
  if (terminalsError) return Response.json({ error: terminalsError.message }, { status: 500 });

  const terminalRows = (terminals ?? []) as Array<{
    id: string;
    branch_id: string;
    name: string;
    created_at: string;
  }>;

  return Response.json({
    branches: branchRows.map((b) => ({
      id: b.id,
      name: b.name,
      createdAt: b.created_at,
      terminals: terminalRows
        .filter((t) => t.branch_id === b.id)
        .map((t) => ({ id: t.id, name: t.name, createdAt: t.created_at })),
    })),
  });
}

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
      const name = ((body as BranchInput)?.name ?? "").toString().trim();
      if (!name) {
        return Response.json({ error: "اسم الفرع مطلوب" }, { status: 400 });
      }
      const branchId = `branch-${Date.now().toString(36)}`;
      return Response.json({
        branch: {
          id: branchId,
          name,
          terminals: [{ id: `terminal-${Date.now().toString(36)}`, name: "كاشير 1" }],
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
  const name = ((body as BranchInput)?.name ?? "").toString().trim();
  if (!name) {
    return Response.json({ error: "اسم الفرع مطلوب" }, { status: 400 });
  }
  if (name.length > 80) {
    return Response.json({ error: "اسم الفرع طويل جداً" }, { status: 400 });
  }

  const { data: branch, error } = await supabase
    .from("branches")
    .insert({ store_id: storeId, name })
    .select("id,name,created_at")
    .single();
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const terminalName = "كاشير 1";
  const { data: terminal, error: terminalError } = await supabase
    .from("terminals")
    .insert({ branch_id: branch.id, name: terminalName })
    .select("id,name,created_at")
    .single();

  return Response.json({
    branch: {
      id: branch.id,
      name: branch.name,
      createdAt: branch.created_at,
      terminals: terminalError
        ? []
        : [{ id: terminal.id, name: terminal.name, createdAt: terminal.created_at }],
    },
  });
}
