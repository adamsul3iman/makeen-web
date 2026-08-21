import { supabase } from "@/lib/supabase";
import { authorizedCapabilityStoreId } from "@/lib/requestAuth";
import {
  awardLoyaltyPoints,
  getLoyaltyConfig,
  pointsValue,
  type LoyaltyConfig,
} from "@/lib/loyalty";

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

const CUSTOMER_COLUMNS = "id,name,phone,balance,loyalty_points,created_at";
const EVENT_COLUMNS = "id,type,points,balance_after,reference,description,created_at";

/**
 * Smart marketing / loyalty (v1) — store-scoped customer points ledger.
 *
 * Reads are available to any cashier of the store (`x-pos-store-id`), writes
 * require the admin cashier role, mirroring the other back-office routes.
 * Earning happens automatically on the sync funnel (exactly-once per invoice);
 * this route exposes the admin ledger + manual earn/redeem/adjust actions.
 */
export async function GET(request: Request): Promise<Response> {
  if (!supabase) {
    return Response.json({ error: "Supabase غير مهيأة" }, { status: 503 });
  }
  const storeId = await authorizedCapabilityStoreId(request, "customers.manage");
  if (storeId instanceof Response) return storeId;

  const url = new URL(request.url);
  const customerId = url.searchParams.get("customer_id")?.trim() || "";
  const q = url.searchParams.get("q")?.trim() || "";
  const config = await getLoyaltyConfig(storeId);

  if (customerId) {
    const { data: customer, error } = await supabase
      .from("customers")
      .select(CUSTOMER_COLUMNS)
      .eq("id", customerId)
      .eq("store_id", storeId)
      .maybeSingle();
    if (error) return Response.json({ error: error.message }, { status: 500 });
    if (!customer) return Response.json({ error: "الزبون غير موجود" }, { status: 404 });

    const { data: events, error: eventsError } = await supabase
      .from("loyalty_events")
      .select(EVENT_COLUMNS)
      .eq("customer_id", customerId)
      .eq("store_id", storeId)
      .order("created_at", { ascending: false })
      .limit(50);
    if (eventsError) return Response.json({ error: eventsError.message }, { status: 500 });

    return Response.json({ customer, events: events ?? [], config });
  }

  let query = supabase
    .from("customers")
    .select(CUSTOMER_COLUMNS)
    .eq("store_id", storeId);
  if (q) {
    query = query.or(`name.ilike.%${q}%,phone.ilike.%${q}%`);
  }
  const { data: customers, error } = await query
    .order("loyalty_points", { ascending: false })
    .order("name", { ascending: true })
    .limit(100);

  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ customers: customers ?? [], config });
}

interface LoyaltyInput {
  action?: unknown;
  customer_id?: unknown;
  amount?: unknown;
  points?: unknown;
  reference?: unknown;
  note?: unknown;
}

export async function POST(request: Request): Promise<Response> {
  if (!supabase) {
    return Response.json({ error: "Supabase غير مهيأة" }, { status: 503 });
  }
  const storeId = await authorizedCapabilityStoreId(request, "customers.manage");
  if (storeId instanceof Response) return storeId;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const input = body as LoyaltyInput;
  const action = typeof input.action === "string" ? input.action : "";
  const customerId = typeof input.customer_id === "string" ? input.customer_id.trim() : "";
  const points = typeof input.points === "number" && Number.isInteger(input.points) ? input.points : 0;
  const amount = typeof input.amount === "number" && Number.isFinite(input.amount) ? input.amount : 0;
  const reference = typeof input.reference === "string" ? input.reference.trim() : "";
  const note = typeof input.note === "string" ? input.note.trim() : "";

  if (!customerId) {
    return Response.json({ error: "الزبون مطلوب" }, { status: 400 });
  }
  if (action !== "earn" && action !== "redeem" && action !== "adjust") {
    return Response.json({ error: "إجراء غير صالح" }, { status: 400 });
  }

  // Field validation BEFORE any DB work, so malformed admin calls are rejected
  // fast without a customer round-trip (same pattern as the other write routes).
  if (action === "earn") {
    if (amount <= 0 || !reference) {
      return Response.json({ error: "المبلغ والمرجع مطلوبان" }, { status: 400 });
    }
  }
  if (action === "redeem" && points <= 0) {
    return Response.json({ error: "عدد النقاط يجب أن يكون أكبر من صفر" }, { status: 400 });
  }
  if (action === "adjust" && points === 0) {
    return Response.json({ error: "النقاط يجب ألا تكون صفراً" }, { status: 400 });
  }

  const { data: customer, error: fetchError } = await supabase
    .from("customers")
    .select("id,name,phone,balance,loyalty_points")
    .eq("id", customerId)
    .eq("store_id", storeId)
    .single();
  if (fetchError || !customer) {
    return Response.json(
      { error: fetchError?.message ?? "الزبون غير موجود" },
      { status: fetchError ? 500 : 404 },
    );
  }

  const config = (await getLoyaltyConfig(storeId)) as LoyaltyConfig | null;
  if (!config) {
    return Response.json({ error: "إعدادات الولاء غير متوفرة" }, { status: 500 });
  }

  const currentPoints = Math.max(0, Number(customer.loyalty_points) || 0);

  if (action === "earn") {
    const result = await awardLoyaltyPoints({ storeId, customerId, amount, reference, description: note || "نقاط ولاء" });
    if (result.error) return Response.json({ error: result.error }, { status: 500 });
    return Response.json({ awarded: result.points, points: result.points });
  }

  if (action === "redeem") {
    if (points > currentPoints) {
      return Response.json({ error: "النقاط المتاحة غير كافية" }, { status: 400 });
    }
    const value = pointsValue(points, config);
    if (value <= 0) {
      return Response.json({ error: "قيمة النقاط صفر" }, { status: 400 });
    }

    const newPoints = currentPoints - points;
    const newBalance = round2(Number(customer.balance || 0) - value);

    // 1. Points ledger entry (REDEEM, negative points).
    const { error: eventError } = await supabase.from("loyalty_events").insert({
      store_id: storeId,
      customer_id: customerId,
      type: "REDEEM",
      points: -points,
      balance_after: newPoints,
      reference: "",
      description: note || `صرف ${points} نقطة مقابل ${value.toFixed(2)}`,
    });
    if (eventError) return Response.json({ error: eventError.message }, { status: 500 });

    // 2. Debt ledger entry: redeemed value reduces the customer's ذمم balance.
    const { error: txError } = await supabase.from("customer_transactions").insert({
      customer_id: customerId,
      store_id: storeId,
      type: "SETTLEMENT",
      amount: value,
      balance_after: newBalance,
      description: `نقاط ولاء • ${note || "صرف نقاط"}`,
      shift_id: null,
    });
    if (txError) return Response.json({ error: txError.message }, { status: 500 });

    // 3. Persist both balances.
    const { error: updateError } = await supabase
      .from("customers")
      .update({ loyalty_points: newPoints, balance: newBalance })
      .eq("id", customerId)
      .eq("store_id", storeId);
    if (updateError) return Response.json({ error: updateError.message }, { status: 500 });

    return Response.json({
      customer: { ...customer, loyalty_points: newPoints, balance: newBalance },
      points: newPoints,
      value,
    });
  }

  // action === "adjust": manual correction (+/-), no monetary effect.
  if (points === 0) {
    return Response.json({ error: "النقاط يجب ألا تكون صفراً" }, { status: 400 });
  }
  const newPoints = Math.max(0, currentPoints + points);
  const { error: eventError } = await supabase.from("loyalty_events").insert({
    store_id: storeId,
    customer_id: customerId,
    type: "ADJUST",
    points,
    balance_after: newPoints,
    reference: "",
    description: note || "تعديل يدوي",
  });
  if (eventError) return Response.json({ error: eventError.message }, { status: 500 });

  const { error: updateError } = await supabase
    .from("customers")
    .update({ loyalty_points: newPoints })
    .eq("id", customerId)
    .eq("store_id", storeId);
  if (updateError) return Response.json({ error: updateError.message }, { status: 500 });

  return Response.json({
    customer: { ...customer, loyalty_points: newPoints },
    points: newPoints,
  });
}
