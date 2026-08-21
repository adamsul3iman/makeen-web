import { supabase } from "@/lib/supabase";
import { authorizedStoreId } from "@/lib/requestAuth";
import { sha256Hex } from "@/lib/sha256";

function customersVersionOf(
  customers: Array<{
    id: string;
    name: string;
    phone?: string | null;
    balance?: number | null;
    created_at?: string | null;
  }>,
): string {
  return sha256Hex(
    JSON.stringify(
      customers.map((customer) => ({
        id: customer.id,
        name: customer.name,
        phone: customer.phone ?? "",
        balance: Number(customer.balance) || 0,
        created_at: customer.created_at ?? "",
      })),
    ),
  );
}

/** Admin read/write for the customer ledger (ذمم العملاء). */
export async function GET(request: Request): Promise<Response> {
  if (!supabase) {
    return Response.json({ error: "Supabase غير مهيأة" }, { status: 503 });
  }
  const storeId = await authorizedStoreId(request);
  if (storeId instanceof Response) return storeId;

  const { data, error } = await supabase
    .from("customers")
    .select("id,name,phone,balance,created_at")
    .eq("store_id", storeId)
    .order("name", { ascending: true });

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
  const customers = data ?? [];
  const updatedAt = customersVersionOf(customers);
  const etag = request.headers.get("if-none-match")?.replace(/"/g, "").trim();
  if (etag && etag === updatedAt) {
    return new Response(null, {
      status: 304,
      headers: { ETag: `"${updatedAt}"` },
    });
  }
  return Response.json(
    { customers, updatedAt },
    { headers: { ETag: `"${updatedAt}"` } },
  );
}

export async function POST(request: Request): Promise<Response> {
  if (!supabase) {
    return Response.json({ error: "Supabase غير مهيأة" }, { status: 503 });
  }
  const storeId = await authorizedStoreId(request);
  if (storeId instanceof Response) return storeId;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const input = body as { name?: unknown; phone?: unknown; balance?: unknown };
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const phone = typeof input.phone === "string" ? input.phone.trim() : "";
  const balance =
    typeof input.balance === "number" && Number.isFinite(input.balance) ? input.balance : 0;

  if (!name) {
    return Response.json({ error: "اسم الزبون مطلوب" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("customers")
    .insert({ name, phone, balance, store_id: storeId })
    .select("id,name,phone,balance,created_at")
    .single();

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
  return Response.json({ customer: data }, { status: 201 });
}
