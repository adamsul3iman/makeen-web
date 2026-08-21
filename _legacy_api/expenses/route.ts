import { supabase } from "@/lib/supabase";
import { EXPENSE_CATEGORIES } from "@/lib/mock-admin-data";
import { authorizedCapabilityStoreId } from "@/lib/requestAuth";

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** Petty-cash expenses ledger (paid out of the register drawer). */
export async function GET(request: Request): Promise<Response> {
  if (!supabase) {
    return Response.json({ error: "Supabase غير مهيأة" }, { status: 503 });
  }

  const storeId = await authorizedCapabilityStoreId(request, "pos.record_expense");
  if (storeId instanceof Response) return storeId;

  const url = new URL(request.url);
  const category = url.searchParams.get("category");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");

  let query = supabase
    .from("expenses")
    .select("id,cashier_id,category,amount,notes,shift_id,created_at")
    .eq("store_id", storeId)
    .order("created_at", { ascending: false });

  if (category && EXPENSE_CATEGORIES.includes(category as (typeof EXPENSE_CATEGORIES)[number])) {
    query = query.eq("category", category);
  }
  if (from) query = query.gte("created_at", from);
  if (to) query = query.lte("created_at", to);

  const { data, error } = await query;
  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
  return Response.json({ expenses: data ?? [] });
}

export async function POST(request: Request): Promise<Response> {
  if (!supabase) {
    return Response.json({ error: "Supabase غير مهيأة" }, { status: 503 });
  }
  const storeId = await authorizedCapabilityStoreId(request, "pos.record_expense");
  if (storeId instanceof Response) return storeId;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const input = body as {
    cashier_id?: unknown;
    category?: unknown;
    amount?: unknown;
    notes?: unknown;
    shift_id?: unknown;
  };
  const category = typeof input.category === "string" ? input.category : "";
  const amount =
    typeof input.amount === "number" && Number.isFinite(input.amount) ? input.amount : 0;
  const notes = typeof input.notes === "string" ? input.notes : null;
  const cashierId = typeof input.cashier_id === "string" ? input.cashier_id : null;
  const shiftId = typeof input.shift_id === "string" ? input.shift_id : null;

  if (!EXPENSE_CATEGORIES.includes(category as (typeof EXPENSE_CATEGORIES)[number])) {
    return Response.json({ error: "فئة المصروف غير صالحة" }, { status: 400 });
  }
  if (amount <= 0) {
    return Response.json({ error: "المبلغ يجب أن يكون أكبر من صفر" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("expenses")
    .insert({
      store_id: storeId,
      cashier_id: cashierId,
      category,
      amount: round2(amount),
      notes,
      shift_id: shiftId,
    })
    .select("id,cashier_id,category,amount,notes,shift_id,created_at")
    .single();

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
  return Response.json({ expense: data }, { status: 201 });
}
