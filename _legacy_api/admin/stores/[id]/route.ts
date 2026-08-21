import { supabase } from "@/lib/supabase";
import { opsToken } from "@/lib/platformOps";
import { requireSuperAdmin } from "@/lib/adminAuth";

const VALID_STATUSES = new Set(["active", "suspended"]);

/** Suspend / reactivate a tenant store (subscription lifecycle). */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const gate = await requireSuperAdmin(request);
  if (gate) return gate;

  const { id } = await params;
  if (!id) {
    return Response.json({ error: "معرف المتجر مطلوب" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const status = (body as { subscription_status?: unknown }).subscription_status;
  if (typeof status !== "string" || !VALID_STATUSES.has(status)) {
    return Response.json({ error: "حالة الاشتراك غير صالحة" }, { status: 400 });
  }

  if (!supabase) {
    return Response.json({
      store: {
        id,
        name: "المتجر الرئيسي",
        ownerName: "",
        email: "",
        phone: "",
        logoUrl: "",
        address: "",
        receiptHeader: "",
        receiptFooter: "",
        subscriptionStatus: status,
      },
    });
  }

  const { data, error } = await supabase
    .from("stores")
    .update({ subscription_status: status })
    .eq("id", id)
    .select("id,name,owner_name,email,phone,logo_url,address,receipt_header,receipt_footer,subscription_status,created_at")
    .single();

  if (error || !data) {
    return Response.json(
      { error: error?.message ?? "المتجر غير موجود" },
      { status: error ? 500 : 404 },
    );
  }
  return Response.json({
    store: {
      id: data.id,
      name: data.name,
      ownerName: data.owner_name,
      email: data.email,
      phone: data.phone,
      logoUrl: data.logo_url,
      address: data.address,
      receiptHeader: data.receipt_header,
      receiptFooter: data.receipt_footer,
      subscriptionStatus: data.subscription_status,
      createdAt: data.created_at,
    },
  });
}

/**
 * Delete a tenant and ALL of its data (cashiers, catalog, branches,
 * terminals, customers, transactions, expenses, suppliers, POs, audit log).
 * Runs atomically inside the `delete_store` RPC (children-first, single
 * transaction). This is irreversible.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const gate = await requireSuperAdmin(request);
  if (gate) return gate;

  const { id } = await params;
  if (!id) {
    return Response.json({ error: "معرف المتجر مطلوب" }, { status: 400 });
  }

  if (!supabase) {
    return Response.json({ ok: true });
  }

  const { data, error } = await supabase.rpc("delete_store", {
    p_store_id: id,
    p_token: opsToken(),
  });
  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
  if (!data) {
    return Response.json({ error: "المتجر غير موجود" }, { status: 404 });
  }

  return Response.json({ ok: true });
}
