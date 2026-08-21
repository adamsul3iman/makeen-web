import { supabase } from "@/lib/supabase";
import { getAdminAccess } from "@/lib/requestAuth";

const MAX_LOGO_BYTES = 600_000;
const IMAGE_DATA_URL = /^data:image\/(png|jpeg|webp);base64,[a-z0-9+/=]+$/i;

export async function PATCH(request: Request): Promise<Response> {
  const access = await getAdminAccess(request);
  if (!access) return Response.json({ error: "admin_session_required" }, { status: 401 });
  const body = (await request.json().catch(() => null)) as { logo?: unknown } | null;
  const logo = typeof body?.logo === "string" ? body.logo.trim() : "";
  if (logo) {
    if (!IMAGE_DATA_URL.test(logo)) {
      return Response.json({ error: "صيغة الشعار غير مدعومة" }, { status: 400 });
    }
    const encoded = logo.slice(logo.indexOf(",") + 1);
    if (Math.ceil((encoded.length * 3) / 4) > MAX_LOGO_BYTES) {
      return Response.json({ error: "حجم الشعار يجب ألا يتجاوز 600KB" }, { status: 413 });
    }
  }
  if (!supabase) return Response.json({ logoUrl: logo });
  const { error } = await supabase.from("stores").update({ logo_url: logo }).eq("id", access.storeId);
  if (error) return Response.json({ error: error.message }, { status: 500 });
  await supabase.from("admin_audit_logs").insert({
    store_id: access.storeId,
    admin_id: null,
    admin_name: access.name,
    action_type: "UPDATE_RECEIPT_LOGO",
    target_id: access.storeId,
    details: { actor: access.email, hasLogo: Boolean(logo) },
  });
  return Response.json({ logoUrl: logo });
}
