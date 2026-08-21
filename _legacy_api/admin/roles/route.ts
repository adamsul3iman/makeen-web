import { getAdminSession } from "@/lib/adminSession";
import { STAFF_ROLE_CODES, STAFF_ROLE_PRESETS } from "@/lib/permissions";
import { supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

function mockRoles() {
  return STAFF_ROLE_CODES.map((code) => ({
    id: `mock-role-${code}`,
    ...STAFF_ROLE_PRESETS[code],
    isSystem: true,
  }));
}

export async function GET(): Promise<Response> {
  const session = await getAdminSession();
  if (!session) {
    return Response.json({ error: "admin_session_required" }, { status: 401 });
  }

  if (!supabase) return Response.json({ roles: mockRoles() });

  const { data, error } = await supabase
    .from("staff_roles")
    .select("id,code,name,description,capabilities,limits,is_system,sort_order")
    .eq("store_id", session.storeId)
    .order("sort_order", { ascending: true });
  if (error) return Response.json({ error: error.message }, { status: 500 });

  return Response.json({
    roles: (data ?? []).map((role) => ({
      id: role.id,
      code: role.code,
      name: role.name,
      description: role.description,
      capabilities: Array.isArray(role.capabilities) ? role.capabilities : [],
      limits: role.limits && typeof role.limits === "object" ? role.limits : {},
      isSystem: role.is_system,
      sortOrder: role.sort_order,
    })),
  });
}

