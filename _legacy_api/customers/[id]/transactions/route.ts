import { supabase } from "@/lib/supabase";
import { authorizedCapabilityStoreId } from "@/lib/requestAuth";

const VALID_TYPES = new Set(["SALE_DEBT", "SETTLEMENT"]);

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

interface TransactionInput {
  type?: unknown;
  amount?: unknown;
  description?: unknown;
  shift_id?: unknown;
}

/** Ledger history + new entries for a single customer. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!supabase) {
    return Response.json({ error: "Supabase غير مهيأة" }, { status: 503 });
  }
  const storeId = await authorizedCapabilityStoreId(request, "customers.manage");
  if (storeId instanceof Response) return storeId;
  const { id } = await params;

  const { data, error } = await supabase
    .from("customer_transactions")
    .select("id,type,amount,balance_after,description,shift_id,created_at")
    .eq("customer_id", id)
    .eq("store_id", storeId)
    .order("created_at", { ascending: false });

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
  return Response.json({ transactions: data ?? [] });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!supabase) {
    return Response.json({ error: "Supabase غير مهيأة" }, { status: 503 });
  }
  const storeId = await authorizedCapabilityStoreId(request, "customers.manage");
  if (storeId instanceof Response) return storeId;

  const { id } = await params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const input = body as TransactionInput;
  const type = typeof input.type === "string" ? input.type : "";
  const amount =
    typeof input.amount === "number" && Number.isFinite(input.amount) ? input.amount : 0;
  const description =
    typeof input.description === "string" ? input.description : null;
  const shiftId =
    typeof input.shift_id === "string" && input.shift_id.length > 0
      ? input.shift_id
      : null;

  if (!VALID_TYPES.has(type)) {
    return Response.json({ error: "نوع حركة غير صالح" }, { status: 400 });
  }
  if (amount <= 0) {
    return Response.json({ error: "المبلغ يجب أن يكون أكبر من صفر" }, { status: 400 });
  }

  const { data: customer, error: fetchError } = await supabase
    .from("customers")
    .select("id,balance")
    .eq("id", id)
    .eq("store_id", storeId)
    .single();
  if (fetchError || !customer) {
    return Response.json({ error: fetchError?.message ?? "الزبون غير موجود" }, { status: 404 });
  }

  // SALE_DEBT adds to the outstanding balance, SETTLEMENT reduces it.
  const delta = type === "SALE_DEBT" ? amount : -amount;
  const balanceAfter = round2((customer.balance ?? 0) + delta);

  // Step 1: Insert the transaction record
  const { data: tx, error: insertError } = await supabase
    .from("customer_transactions")
    .insert({
      customer_id: id,
      store_id: storeId,
      type,
      amount,
      balance_after: balanceAfter,
      description,
      shift_id: shiftId,
    })
    .select("id,type,amount,balance_after,description,shift_id,created_at")
    .single();
  if (insertError) {
    return Response.json({ error: insertError.message }, { status: 500 });
  }

  // Step 2: Atomic balance update — only succeeds if balance hasn't changed
  // (optimistic concurrency control). This prevents lost updates.
  const { error: updateError } = await supabase
    .from("customers")
    .update({ balance: balanceAfter })
    .eq("id", id)
    .eq("store_id", storeId)
    .eq("balance", customer.balance);

  if (updateError) {
    // Balance changed since we read it — delete the orphaned transaction
    await supabase.from("customer_transactions").delete().eq("id", tx.id);
    return Response.json({ error: "تم تعديل رصيد الزبون بواسطة مستخدم آخر — أعد المحاولة", status: 409 });
  }

  return Response.json({ transaction: tx, balanceAfter }, { status: 201 });
}
