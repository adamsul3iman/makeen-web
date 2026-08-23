import { getSupabaseBrowser } from "./supabaseBrowser";
import { getTenantStoreId } from "./tenantClient";

const CUSTOMER_COLUMNS = "id,name,phone,balance,loyalty_points,created_at";
const EVENT_COLUMNS = "id,type,points,balance_after,reference,description,created_at";

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

export interface LoyaltyCustomer {
  id: string;
  name: string;
  phone: string | null;
  balance: number | null;
  loyalty_points: number | null;
  created_at?: string | null;
}

export interface LoyaltyEvent {
  id: string;
  type: "EARN" | "REDEEM" | "ADJUST";
  points: number;
  balance_after: number;
  reference: string | null;
  description: string | null;
  created_at: string;
}

export interface LoyaltyConfig {
  enabled: boolean;
  /** Currency spent to earn one point. */
  pointsPerSpend: number;
  /** Currency value of a single point when redeeming. */
  pointValue: number;
}

async function getStoreLoyaltyConfig(sb: NonNullable<ReturnType<typeof getSupabaseBrowser>>, storeId: string): Promise<LoyaltyConfig> {
  const { data } = await sb
    .from("stores")
    .select("loyalty_enabled,points_per_spend,point_value")
    .eq("id", storeId)
    .maybeSingle();
  const rate = Number(data?.points_per_spend);
  return {
    enabled: data ? data.loyalty_enabled !== false : true,
    pointsPerSpend: Number.isFinite(rate) && rate > 0 ? rate : 1,
    pointValue: Number(data?.point_value) || 0.01,
  };
}

function isMissingFunctionError(message: string): boolean {
  return (
    message.includes("PGRST202") ||
    message.includes("Could not find the function") ||
    message.includes("schema cache")
  );
}

/**
 * Store-scoped customer list for the loyalty ledger (نقاط الولاء), richest
 * accounts first. Optional `q` searches name/phone.
 */
export async function fetchLoyaltyCustomers(q?: string): Promise<LoyaltyCustomer[]> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  let query = sb.from("customers").select(CUSTOMER_COLUMNS).eq("store_id", storeId);
  const term = q?.trim();
  if (term) {
    query = query.or(`name.ilike.%${term}%,phone.ilike.%${term}%`);
  }
  const { data, error } = await query
    .order("loyalty_points", { ascending: false })
    .order("name", { ascending: true })
    .limit(100);
  if (error) throw new Error(error.message);
  return ((data ?? []) as LoyaltyCustomer[]);
}

/**
 * Newest 50 ledger entries for one customer; the customer row must belong to
 * the caller's store.
 */
export async function fetchLoyaltyEvents(customerId: string): Promise<LoyaltyEvent[]> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  const trimmedCustomerId = customerId.trim();
  if (!trimmedCustomerId) throw new Error("الزبون مطلوب");

  const { data, error } = await sb
    .from("loyalty_events")
    .select(EVENT_COLUMNS)
    .eq("customer_id", trimmedCustomerId)
    .eq("store_id", storeId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw new Error(error.message);
  return ((data ?? []) as LoyaltyEvent[]);
}

/**
 * Award points for a spend amount. Prefers the server-side
 * `award_loyalty_points` RPC (exactly-once per reference); falls back to a
 * direct ledger insert when the function is not deployed.
 */
export async function earnLoyaltyPoints(
  customerId: string,
  opts: { amount: number; reference: string; note?: string },
): Promise<{ awarded: boolean; points: number }> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  const trimmedCustomerId = customerId.trim();
  const amount = Number(opts.amount);
  const reference = opts.reference.trim();
  if (!trimmedCustomerId) throw new Error("الزبون مطلوب");
  if (!Number.isFinite(amount) || amount <= 0 || !reference) {
    throw new Error("المبلغ والمرجع مطلوبان");
  }
  const description = opts.note?.trim() || "نقاط ولاء";

  const rpcResult = await sb.rpc("award_loyalty_points", {
    p_store_id: storeId,
    p_customer_id: trimmedCustomerId,
    p_amount: amount,
    p_reference: reference,
    p_description: description,
  });
  if (!rpcResult.error) {
    const raw = Array.isArray(rpcResult.data) ? rpcResult.data[0] : rpcResult.data;
    return { awarded: true, points: Math.max(0, Number((raw as { points?: number })?.points) || 0) };
  }
  if (!isMissingFunctionError(rpcResult.error.message)) throw new Error(rpcResult.error.message);

  // Direct path: read config + customer, then write the EARN event ourselves.
  const config = await getStoreLoyaltyConfig(sb, storeId);
  const points = !config.enabled ? 0 : Math.floor(amount / config.pointsPerSpend);
  if (points <= 0) return { awarded: false, points: 0 };

  const { data: customer, error: fetchError } = await sb
    .from("customers")
    .select("id,loyalty_points")
    .eq("id", trimmedCustomerId)
    .eq("store_id", storeId)
    .maybeSingle();
  if (fetchError) throw new Error(fetchError.message);
  if (!customer) throw new Error("الزبون غير موجود");

  const currentPoints = Math.max(0, Number(customer.loyalty_points) || 0);
  const balanceAfter = currentPoints + points;

  const { error: eventError } = await sb.from("loyalty_events").insert({
    store_id: storeId,
    customer_id: trimmedCustomerId,
    type: "EARN",
    points,
    balance_after: balanceAfter,
    reference,
    description,
  });
  if (eventError) throw new Error(eventError.message);

  const { error: updateError } = await sb
    .from("customers")
    .update({ loyalty_points: balanceAfter })
    .eq("id", trimmedCustomerId)
    .eq("store_id", storeId);
  if (updateError) throw new Error(updateError.message);

  return { awarded: true, points };
}

/**
 * Redeem points for credit: negative REDEEM entry in the points ledger plus a
 * SETTLEMENT entry in the debt ledger, then persist both balances.
 */
export async function redeemLoyaltyPoints(
  customerId: string,
  opts: { points: number; note?: string },
): Promise<{ customer: LoyaltyCustomer; redeemedValue: number }> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  const trimmedCustomerId = customerId.trim();
  const points = Number(opts.points);
  if (!trimmedCustomerId) throw new Error("الزبون مطلوب");
  if (!Number.isInteger(points) || points <= 0) {
    throw new Error("عدد النقاط يجب أن يكون أكبر من صفر");
  }

  const { data: customer, error: fetchError } = await sb
    .from("customers")
    .select("id,name,phone,balance,loyalty_points")
    .eq("id", trimmedCustomerId)
    .eq("store_id", storeId)
    .maybeSingle();
  if (fetchError) throw new Error(fetchError.message);
  if (!customer) throw new Error("الزبون غير موجود");

  const currentPoints = Math.max(0, Number(customer.loyalty_points) || 0);
  if (points > currentPoints) throw new Error("النقاط المتاحة غير كافية");

  const config = await getStoreLoyaltyConfig(sb, storeId);
  const value = round2(Math.max(0, points) * (config.pointValue || 0));
  if (value <= 0) throw new Error("قيمة النقاط صفر");
  const note = opts.note?.trim();

  const newPoints = currentPoints - points;
  const newBalance = round2(Number(customer.balance || 0) - value);

  const { error: eventError } = await sb.from("loyalty_events").insert({
    store_id: storeId,
    customer_id: trimmedCustomerId,
    type: "REDEEM",
    points: -points,
    balance_after: newPoints,
    reference: "",
    description: note || `صرف ${points} نقطة مقابل ${value.toFixed(2)}`,
  });
  if (eventError) throw new Error(eventError.message);

  const { error: txError } = await sb.from("customer_transactions").insert({
    customer_id: trimmedCustomerId,
    store_id: storeId,
    type: "SETTLEMENT",
    amount: value,
    balance_after: newBalance,
    description: `نقاط ولاء • ${note || "صرف نقاط"}`,
    shift_id: null,
  });
  if (txError) throw new Error(txError.message);

  const { error: updateError } = await sb
    .from("customers")
    .update({ loyalty_points: newPoints, balance: newBalance })
    .eq("id", trimmedCustomerId)
    .eq("store_id", storeId);
  if (updateError) throw new Error(updateError.message);

  return {
    customer: { ...customer, loyalty_points: newPoints, balance: newBalance },
    redeemedValue: value,
  };
}

/**
 * Manual +/- correction with no monetary effect; clamped at zero.
 */
export async function adjustLoyaltyPoints(
  customerId: string,
  opts: { points: number; note?: string },
): Promise<{ customer: LoyaltyCustomer }> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  const trimmedCustomerId = customerId.trim();
  const points = Number(opts.points);
  if (!trimmedCustomerId) throw new Error("الزبون مطلوب");
  if (!Number.isInteger(points) || points === 0) {
    throw new Error("النقاط يجب ألا تكون صفراً");
  }

  const { data: customer, error: fetchError } = await sb
    .from("customers")
    .select("id,name,phone,balance,loyalty_points")
    .eq("id", trimmedCustomerId)
    .eq("store_id", storeId)
    .maybeSingle();
  if (fetchError) throw new Error(fetchError.message);
  if (!customer) throw new Error("الزبون غير موجود");

  const currentPoints = Math.max(0, Number(customer.loyalty_points) || 0);
  const newPoints = Math.max(0, currentPoints + points);

  const { error: eventError } = await sb.from("loyalty_events").insert({
    store_id: storeId,
    customer_id: trimmedCustomerId,
    type: "ADJUST",
    points,
    balance_after: newPoints,
    reference: "",
    description: opts.note?.trim() || "تعديل يدوي",
  });
  if (eventError) throw new Error(eventError.message);

  const { error: updateError } = await sb
    .from("customers")
    .update({ loyalty_points: newPoints })
    .eq("id", trimmedCustomerId)
    .eq("store_id", storeId);
  if (updateError) throw new Error(updateError.message);

  return { customer: { ...customer, loyalty_points: newPoints } };
}
