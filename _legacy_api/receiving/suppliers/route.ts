import { capabilityAuthorizationError, getAnyCapabilityAccess } from "@/lib/requestAuth";
import { RECEIVING_CAPABILITIES } from "@/lib/permissions";
import { supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function toSupplier(row: {
  id: string;
  name: string;
  phone?: string | null;
  balance?: number | null;
  payment_terms_days?: number | null;
}): { id: string; name: string; phone: string; balance: number; paymentTermsDays: number } {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone ?? "",
    balance: Math.max(0, Number(row.balance) || 0),
    paymentTermsDays: Math.max(0, Number(row.payment_terms_days) || 0),
  };
}

/** Vendor directory for the goods-in picker (cached offline by the device). */
export async function GET(request: Request): Promise<Response> {
  const access = await getAnyCapabilityAccess(request, [...RECEIVING_CAPABILITIES]);
  if (!access) return capabilityAuthorizationError(request, "suppliers.manage");

  if (!supabase) {
    return Response.json({ suppliers: [] });
  }

  try {
    const { data, error } = await supabase
      .from("suppliers")
      .select("id,name,balance,payment_terms_days")
      .eq("store_id", access.storeId)
      .order("name");
    if (error) throw error;
    return Response.json({
      suppliers: (data ?? []).map((supplier) => ({
        id: supplier.id,
        name: supplier.name,
        balance: Math.max(0, Number(supplier.balance) || 0),
        paymentTermsDays: Math.max(0, Number(supplier.payment_terms_days) || 0),
      })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "receiving_suppliers_failed";
    return Response.json({ error: message }, { status: 500 });
  }
}

/**
 * Inline vendor creation from the goods-in picker. Gated by ANY receiving
 * capability (an inventory clerk holding only `catalog.add` may add a vendor
 * mid-invoice without the back-office `suppliers.manage` role).
 *
 * Accepts an optional client-generated `id` so the queued SUPPLIER_CREATE
 * mirror replays onto the exact row an offline SUPPLIER_INVOICE_CREATED will
 * reference; a retry after a timeout returns the existing row instead of
 * duplicating it.
 */
export async function POST(request: Request): Promise<Response> {
  const access = await getAnyCapabilityAccess(request, [...RECEIVING_CAPABILITIES]);
  if (!access) return capabilityAuthorizationError(request, "suppliers.manage");

  if (!supabase) {
    return Response.json({ error: "Supabase غير مهيأة" }, { status: 503 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const input = (body ?? {}) as { id?: unknown; name?: unknown; phone?: unknown };
  const id = typeof input.id === "string" ? input.id.trim() : "";
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) return Response.json({ error: "اسم المورد مطلوب" }, { status: 400 });
  if (name.length > 150) return Response.json({ error: "اسم المورد طويل جداً" }, { status: 400 });
  const phone = typeof input.phone === "string" ? input.phone.trim() : "";
  if (phone.length > 20) return Response.json({ error: "رقم الهاتف طويل جداً" }, { status: 400 });
  const requestedId = UUID_RE.test(id) ? id : null;

  try {
    // Idempotent by client id: the SUPPLIER_CREATE mirror and this fast path
    // can race (offline queue draining right as the device comes back), so a
    // unique violation is treated as a successful read of the existing row.
    if (requestedId) {
      const existing = await supabase
        .from("suppliers")
        .select("id,name,phone,balance,payment_terms_days")
        .eq("id", requestedId)
        .eq("store_id", access.storeId)
        .maybeSingle();
      if (existing.error) return Response.json({ error: existing.error.message }, { status: 500 });
      if (existing.data) return Response.json({ supplier: toSupplier(existing.data) }, { status: 200 });

      const inserted = await supabase
        .from("suppliers")
        .insert({ id: requestedId, store_id: access.storeId, name, phone, balance: 0 })
        .select("id,name,phone,balance,payment_terms_days")
        .single();
      if (inserted.error) {
        if (inserted.error.code === "23505") {
          const replay = await supabase
            .from("suppliers")
            .select("id,name,phone,balance,payment_terms_days")
            .eq("id", requestedId)
            .eq("store_id", access.storeId)
            .maybeSingle();
          if (replay.error) return Response.json({ error: replay.error.message }, { status: 500 });
          if (replay.data) return Response.json({ supplier: toSupplier(replay.data) }, { status: 200 });
        }
        return Response.json({ error: inserted.error.message }, { status: 500 });
      }
      return Response.json({ supplier: toSupplier(inserted.data) }, { status: 201 });
    }

    const inserted = await supabase
      .from("suppliers")
      .insert({ store_id: access.storeId, name, phone, balance: 0 })
      .select("id,name,phone,balance,payment_terms_days")
      .single();
    if (inserted.error) return Response.json({ error: inserted.error.message }, { status: 500 });
    return Response.json({ supplier: toSupplier(inserted.data) }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "receiving_supplier_create_failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
