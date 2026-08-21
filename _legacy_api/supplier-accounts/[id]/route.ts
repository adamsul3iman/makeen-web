import { capabilityAuthorizationError, getCapabilityAccess } from "@/lib/requestAuth";
import { opsToken } from "@/lib/platformOps";
import { supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!supabase) return Response.json({ error: "Supabase غير مهيأة" }, { status: 503 });
  const access = await getCapabilityAccess(request, "suppliers.manage");
  if (!access) return capabilityAuthorizationError(request, "suppliers.manage");
  const { id } = await params;
  if (!UUID_RE.test(id)) return Response.json({ error: "invalid_invoice_id" }, { status: 400 });

  const result = await supabase.rpc("supplier_invoice_detail", {
    p_store_id: access.storeId,
    p_invoice_id: id,
    p_token: opsToken(),
  });
  if (result.error) return Response.json({ error: result.error.message }, { status: 500 });
  if (!result.data) return Response.json({ error: "invoice_not_found" }, { status: 404 });
  return Response.json({ invoice: result.data });
}
