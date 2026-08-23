import { getSupabaseBrowser } from "./supabaseBrowser";
import { getTenantStoreId } from "./tenantClient";

export interface InventoryMovement {
  id: string;
  product_id: string;
  product_name: string;
  base_unit: string;
  movement_type: string;
  quantity_delta: number;
  unit_quantity: number;
  unit_name: string;
  multiplier: number;
  balance_before: number;
  balance_after: number;
  barcode: string | null;
  variant_label: string;
  reference_type: string | null;
  reference_id: string | null;
  actor_name: string;
  reason: string;
  occurred_at: string;
}

function asNum(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

const MOVEMENT_TYPES = new Set([
  "OPENING", "SALE", "RETURN", "PURCHASE_RECEIPT",
  "ADJUSTMENT_IN", "ADJUSTMENT_OUT", "STOCKTAKE", "DAMAGE",
  "TRANSFER_IN", "TRANSFER_OUT",
]);

export async function fetchMovements(opts: {
  productId?: string;
  type?: string;
  page: number;
  pageSize: number;
}): Promise<{ movements: InventoryMovement[]; total: number; page: number; pageSize: number }> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  const { productId, type, page, pageSize } = opts;
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  let query = sb
    .from("inventory_movements")
    .select("id,product_id,branch_id,terminal_id,actor_id,actor_name,movement_type,quantity_delta,unit_quantity,unit_name,multiplier,balance_before,balance_after,barcode,variant_label,reference_type,reference_id,reason,metadata,occurred_at,created_at")
    .eq("store_id", storeId)
    .order("occurred_at", { ascending: false })
    .range(from, to);
  if (productId) query = query.eq("product_id", productId);
  if (type && MOVEMENT_TYPES.has(type)) query = query.eq("movement_type", type);

  const { data: movements, error: movErr } = await query;
  if (movErr) throw new Error(movErr.message);

  let countQ = sb.from("inventory_movements").select("id", { count: "exact", head: true }).eq("store_id", storeId);
  if (productId) countQ = countQ.eq("product_id", productId);
  if (type && MOVEMENT_TYPES.has(type)) countQ = countQ.eq("movement_type", type);
  const { count } = await countQ;

  const productIds = [...new Set((movements ?? []).map((m: { product_id: string }) => m.product_id))];
  let productMap = new Map<string, { name: string; base_unit: string; total_stock: number }>();
  if (productIds.length > 0) {
    const { data: products } = await sb
      .from("products")
      .select("id,name,base_unit,total_stock")
      .eq("store_id", storeId)
      .in("id", productIds);
    for (const p of (products ?? []) as Array<{ id: string; name: string; base_unit: string; total_stock: number }>) {
      productMap.set(p.id, p);
    }
  }

  return {
    movements: ((movements ?? []) as Record<string, unknown>[]).map((m) => ({
      ...m,
      product_name: productMap.get(m.product_id as string)?.name ?? "منتج محذوف",
      base_unit: productMap.get(m.product_id as string)?.base_unit ?? "",
      current_stock: asNum(productMap.get(m.product_id as string)?.total_stock ?? m.balance_after),
    })) as unknown as InventoryMovement[],
    total: count ?? 0,
    page,
    pageSize,
  };
}

export async function createMovement(opts: {
  productId: string;
  barcode: string;
  mode: "IN" | "OUT" | "COUNT" | "DAMAGE";
  quantity: number;
  reason: string;
  idempotencyKey: string;
  actorName: string;
}): Promise<{ movement: InventoryMovement }> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  const { productId, barcode, mode, quantity, reason, idempotencyKey, actorName } = opts;

  const { data: product } = await sb
    .from("products")
    .select("id,name,base_unit,total_stock")
    .eq("id", productId)
    .eq("store_id", storeId)
    .maybeSingle();
  if (!product) throw new Error("المنتج غير موجود");

  if (barcode) {
    const { data: bv } = await sb
      .from("product_variants")
      .select("barcode")
      .eq("barcode", barcode)
      .eq("product_id", productId)
      .eq("store_id", storeId)
      .maybeSingle();
    if (!bv) throw new Error("الباركود لا يتبع المنتج المحدد");
  }

  const movementKey = `adjustment:${idempotencyKey}`;
  const { data: existing } = await sb
    .from("inventory_movements")
    .select("id,product_id,movement_type,quantity_delta,unit_quantity,unit_name,multiplier,balance_before,balance_after,barcode,variant_label,reference_type,reference_id,actor_name,reason,occurred_at")
    .eq("store_id", storeId)
    .eq("idempotency_key", movementKey)
    .maybeSingle();
  if (existing) return { movement: existing as unknown as InventoryMovement };

  const movementType = mode === "IN" ? "ADJUSTMENT_IN" : mode === "OUT" ? "ADJUSTMENT_OUT" : mode === "DAMAGE" ? "DAMAGE" : "STOCKTAKE";
  const signedUnitQuantity = mode === "IN" ? quantity : mode === "COUNT" ? quantity : -quantity;
  const quantityDelta = mode === "COUNT" ? 0 : Number((signedUnitQuantity * 1).toFixed(3));

  const { data: movementResult, error: rpcErr } = await sb.rpc("record_inventory_movement", {
    p_store_id: storeId,
    p_product_id: productId,
    p_quantity_delta: quantityDelta,
    p_movement_type: movementType,
    p_idempotency_key: movementKey,
    p_unit_quantity: mode === "COUNT" ? null : signedUnitQuantity,
    p_barcode: mode === "COUNT" ? null : barcode || null,
    p_reference_type: "MANUAL_ADJUSTMENT",
    p_reference_id: idempotencyKey,
    p_actor_id: null,
    p_actor_name: actorName,
    p_reason: reason,
    p_metadata: { mode, requestedQuantity: quantity },
    p_target_balance: mode === "COUNT" ? Number(quantity.toFixed(3)) : null,
  });
  if (rpcErr) {
    const msg = rpcErr.message.includes("insufficient_stock")
      ? "الرصيد لا يكفي لتنفيذ هذه الحركة"
      : rpcErr.message.includes("no_stock_change")
        ? "الكمية الفعلية مطابقة للرصيد ولا توجد حركة لتسجيلها"
        : rpcErr.message;
    throw new Error(msg);
  }

  const movement = Array.isArray(movementResult) ? movementResult[0] : movementResult;

  await sb.from("admin_audit_logs").insert({
    store_id: storeId,
    admin_id: null,
    admin_name: actorName,
    action_type: "ADJUST_STOCK",
    target_id: productId,
    details: {
      productName: product.name,
      movementId: (movement as Record<string, unknown>)?.id ?? null,
      mode,
      quantity,
      barcode: barcode || null,
      reason,
      balanceBefore: (movement as Record<string, unknown>)?.balance_before ?? product.total_stock,
      balanceAfter: (movement as Record<string, unknown>)?.balance_after ?? null,
    },
  });

  return { movement: movement as unknown as InventoryMovement };
}
