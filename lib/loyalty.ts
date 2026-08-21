import { supabase } from "@/lib/supabase";

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** Store-level loyalty configuration (008_loyalty_points). */
export interface LoyaltyConfig {
  enabled: boolean;
  /** Currency spent to earn one point (1.00 = one point per unit). */
  pointsPerSpend: number;
  /** Currency value of a single point when redeeming (0.01). */
  pointValue: number;
}

export const DEFAULT_LOYALTY_CONFIG: LoyaltyConfig = {
  enabled: true,
  pointsPerSpend: 1,
  pointValue: 0.01,
};

/** Read the caller's own loyalty config; null when the store row is missing. */
export async function getLoyaltyConfig(storeId: string): Promise<LoyaltyConfig | null> {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("stores")
    .select("loyalty_enabled,points_per_spend,point_value")
    .eq("id", storeId)
    .maybeSingle();
  if (error || !data) return null;
  const rate = Number(data.points_per_spend);
  return {
    enabled: data.loyalty_enabled !== false,
    pointsPerSpend: Number.isFinite(rate) && rate > 0 ? rate : DEFAULT_LOYALTY_CONFIG.pointsPerSpend,
    pointValue: Number(data.point_value) || DEFAULT_LOYALTY_CONFIG.pointValue,
  };
}

/** Whole points earned for a spend amount at the given rate. */
export function pointsForAmount(amount: number, config: LoyaltyConfig): number {
  if (!config.enabled || config.pointsPerSpend <= 0 || amount <= 0) return 0;
  return Math.floor(amount / config.pointsPerSpend);
}

/**
 * Award loyalty points for a settled invoice. Exactly-once per `reference`
 * (the sync_id), so offline invoices replay without double-counting — the
 * same marker guard pattern used by the debt ledger.
 */
export async function awardLoyaltyPoints(opts: {
  storeId: string;
  customerId: string;
  amount: number;
  reference: string;
  description?: string;
}): Promise<{ awarded: boolean; points: number; error?: string }> {
  if (!supabase) return { awarded: false, points: 0 };
  const { storeId, customerId, amount, reference, description } = opts;
  const config = await getLoyaltyConfig(storeId);
  if (!config) return { awarded: false, points: 0, error: "loyalty config not found" };
  const points = pointsForAmount(amount, config);
  if (points <= 0) return { awarded: false, points: 0 };

  const { data: customer, error: readError } = await supabase
    .from("customers")
    .select("id,loyalty_points")
    .eq("id", customerId)
    .eq("store_id", storeId)
    .single();
  if (readError || !customer) {
    return { awarded: false, points: 0, error: readError?.message ?? "customer not found" };
  }

  // Idempotency: a failed ack retries the same sync_id; never double-award.
  const marker = `sync:${reference}`;
  const { data: existing } = await supabase
    .from("loyalty_events")
    .select("id")
    .eq("store_id", storeId)
    .eq("customer_id", customer.id)
    .eq("type", "EARN")
    .ilike("description", `%${marker}%`)
    .maybeSingle();
  if (existing) return { awarded: true, points };

  const current = Math.max(0, Number(customer.loyalty_points) || 0);
  const balanceAfter = current + points;

  const { error: txError } = await supabase.from("loyalty_events").insert({
    store_id: storeId,
    customer_id: customer.id,
    type: "EARN",
    points,
    balance_after: balanceAfter,
    reference,
    description: `${description ?? "نقاط ولاء"} • ${marker}`,
  });
  if (txError) return { awarded: false, points, error: txError.message };

  const { error: updateError } = await supabase
    .from("customers")
    .update({ loyalty_points: balanceAfter })
    .eq("id", customer.id)
    .eq("store_id", storeId);
  if (updateError) return { awarded: false, points, error: updateError.message };

  return { awarded: true, points };
}

/** Currency value of a points block at the store's redeem rate. */
export function pointsValue(points: number, config: LoyaltyConfig): number {
  return round2(Math.max(0, points) * (config.pointValue || 0));
}

/**
 * True when an invoice is a return/cancellation that must claw back the
 * original invoice's points: an explicit cancellation or a negative total
 * that references an original invoice. Positive sales (and negative totals
 * with no reference) never claw back.
 */
export function isLoyaltyClawback(opts: {
  total: number;
  originalInvoiceId?: string | null;
  isCancellation?: boolean;
}): boolean {
  if (!opts.originalInvoiceId) return false;
  if (opts.isCancellation === true) return true;
  return Number.isFinite(opts.total) && opts.total < 0;
}

export interface LoyaltyClawbackResult {
  reversed: boolean;
  points?: number;
  error?: string;
}

/**
 * Reverse the points a return/cancellation's original invoice earned, exactly
 * the amount of the original EARN event. Idempotent per `reversalSyncId` (the
 * return invoice's sync_id), so offline returns replay without double-reversing.
 */
export async function clawBackLoyaltyPoints(opts: {
  db?: typeof supabase;
  storeId: string;
  customerId: string;
  originalInvoiceSyncId: string;
  reversalSyncId: string;
  description?: string;
}): Promise<LoyaltyClawbackResult> {
  const client = opts.db ?? supabase;
  if (!client) return { reversed: false };
  const { storeId, customerId, originalInvoiceSyncId, reversalSyncId, description } = opts;

  // Idempotency: this return already reversed once — never double-reverse.
  const { data: existing } = await client
    .from("loyalty_events")
    .select("id")
    .eq("store_id", storeId)
    .eq("customer_id", customerId)
    .eq("type", "REDEEM")
    .eq("reference", reversalSyncId)
    .maybeSingle();
  if (existing) return { reversed: true };

  // The original invoice's EARN event defines exactly what to claw back.
  const { data: earn } = await client
    .from("loyalty_events")
    .select("points")
    .eq("store_id", storeId)
    .eq("customer_id", customerId)
    .eq("type", "EARN")
    .eq("reference", originalInvoiceSyncId)
    .maybeSingle();
  if (!earn) return { reversed: false };

  const earned = Math.max(0, Number(earn.points) || 0);
  if (earned <= 0) return { reversed: false };

  const { data: customer } = await client
    .from("customers")
    .select("loyalty_points")
    .eq("id", customerId)
    .eq("store_id", storeId)
    .single();
  if (!customer) return { reversed: false, error: "customer not found" };

  const current = Math.max(0, Number(customer.loyalty_points) || 0);
  const balanceAfter = current - earned;

  const { error: txError } = await client.from("loyalty_events").insert({
    store_id: storeId,
    customer_id: customerId,
    type: "REDEEM",
    points: -earned,
    balance_after: balanceAfter,
    reference: reversalSyncId,
    description: `${description ?? "استرداد نقاط ولاء"} • revert:${originalInvoiceSyncId}`,
  });
  if (txError) return { reversed: false, points: -earned, error: txError.message };

  const { error: updateError } = await client
    .from("customers")
    .update({ loyalty_points: balanceAfter })
    .eq("id", customerId)
    .eq("store_id", storeId);
  if (updateError) return { reversed: false, points: -earned, error: updateError.message };

  return { reversed: true, points: -earned };
}
