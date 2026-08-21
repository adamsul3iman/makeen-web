import { capabilityAuthorizationError, getCapabilityAccess } from "@/lib/requestAuth";
import { supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * Phase 5 — Shortage Radar.
 *
 * Back-office endpoint behind the `inventory.view` capability (owner sessions
 * always pass; PIN staff need the capability). GET returns the durable
 * `shortage_flags` radar for the store; POST records a server-side flag. The
 * register's emergency flag normally travels through the offline sync
 * pipeline (`SHORTAGE_FLAGGED` events) — this route is the online counterpart
 * and the read API for the admin dashboard.
 */

export async function GET(request: Request): Promise<Response> {
  const access = await getCapabilityAccess(request, "inventory.view");
  if (!access) return capabilityAuthorizationError(request, "inventory.view");

  if (!supabase) {
    return Response.json({ flags: [] });
  }

  try {
    const { data, error } = await supabase
      .from("shortage_flags")
      .select(
        "id,product_id,product_name,current_stock,reason,cashier_id,cashier_name,branch_id,terminal_id,resolved,resolved_by,resolved_at,created_at",
      )
      .eq("store_id", access.storeId)
      .order("created_at", { ascending: false });
    if (error) {
      // Table might not have RLS policies configured; return empty rather than 500
      console.warn("shortage_flags query error:", error.message);
      return Response.json({ flags: [], warning: error.message });
    }
    return Response.json({ flags: data ?? [] });
  } catch (err) {
    console.error("shortage_flags unexpected error:", err);
    return Response.json({ flags: [], warning: "Unexpected error loading shortage flags" });
  }
}

export async function POST(request: Request): Promise<Response> {
  const access = await getCapabilityAccess(request, "inventory.manage");
  if (!access) return capabilityAuthorizationError(request, "inventory.manage");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const input = body as {
    productId?: unknown;
    productName?: unknown;
    currentStock?: unknown;
    reason?: unknown;
  };
  const productId = typeof input.productId === "string" ? input.productId.trim() : "";
  if (!productId) {
    return Response.json({ error: "product_id_missing" }, { status: 400 });
  }

  if (!supabase) {
    return Response.json({ error: "Supabase غير مهيأة" }, { status: 503 });
  }

  const currentStock =
    typeof input.currentStock === "number" && Number.isFinite(input.currentStock)
      ? Math.round((input.currentStock + Number.EPSILON) * 1000) / 1000
      : 0;
  const { error } = await supabase.from("shortage_flags").insert({
    store_id: access.storeId,
    product_id: productId,
    product_name: typeof input.productName === "string" ? input.productName.trim() : "",
    current_stock: Math.max(0, currentStock),
    reason: typeof input.reason === "string" ? input.reason.trim() : null,
    cashier_id: null,
    cashier_name: "",
    resolved: false,
  });
  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
  return Response.json({ success: true });
}
