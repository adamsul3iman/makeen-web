import { supabase } from "@/lib/supabase";
import { authorizedCapabilityStoreId } from "@/lib/requestAuth";

interface SupplierInput {
  name?: unknown;
  phone?: unknown;
  email?: unknown;
  address?: unknown;
}

function validate(body: SupplierInput): { supplier: Record<string, unknown>; error?: string } {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return { supplier: {}, error: "اسم المورد مطلوب" };
  const phone = typeof body.phone === "string" ? body.phone.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const address = typeof body.address === "string" ? body.address : null;
  return { supplier: { name, phone, email, address } };
}

/** Suppliers ledger (read + create + update). */
export async function GET(request: Request): Promise<Response> {
  if (!supabase) {
    return Response.json({ error: "Supabase غير مهيأة" }, { status: 503 });
  }
  const storeId = await authorizedCapabilityStoreId(request, "suppliers.manage");
  if (storeId instanceof Response) return storeId;

  const { data, error } = await supabase
    .from("suppliers")
    .select("id,name,phone,email,address,balance,created_at")
    .eq("store_id", storeId)
    .order("name", { ascending: true });
  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
  return Response.json({ suppliers: data ?? [] });
}

export async function POST(request: Request): Promise<Response> {
  if (!supabase) {
    return Response.json({ error: "Supabase غير مهيأة" }, { status: 503 });
  }
  const storeId = await authorizedCapabilityStoreId(request, "suppliers.manage");
  if (storeId instanceof Response) return storeId;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const { supplier, error: validationError } = validate(body as SupplierInput);
  if (validationError) {
    return Response.json({ error: validationError }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("suppliers")
    .insert({ ...supplier, balance: 0, store_id: storeId })
    .select("id,name,phone,email,address,balance,created_at")
    .single();
  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
  return Response.json({ supplier: data }, { status: 201 });
}

export async function PUT(request: Request): Promise<Response> {
  if (!supabase) {
    return Response.json({ error: "Supabase غير مهيأة" }, { status: 503 });
  }
  const storeId = await authorizedCapabilityStoreId(request, "suppliers.manage");
  if (storeId instanceof Response) return storeId;
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id) {
    return Response.json({ error: "معرف المورد مطلوب" }, { status: 400 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const { supplier, error: validationError } = validate(body as SupplierInput);
  if (validationError) {
    return Response.json({ error: validationError }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("suppliers")
    .update(supplier)
    .eq("id", id)
    .eq("store_id", storeId)
    .select("id,name,phone,email,address,balance,created_at")
    .single();
  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
  return Response.json({ supplier: data });
}
