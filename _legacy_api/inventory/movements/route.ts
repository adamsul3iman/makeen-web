import { supabase } from "@/lib/supabase";
import { capabilityAuthorizationError, getCapabilityAccess } from "@/lib/requestAuth";

const MOVEMENT_TYPES = new Set([
  "OPENING",
  "SALE",
  "RETURN",
  "PURCHASE_RECEIPT",
  "ADJUSTMENT_IN",
  "ADJUSTMENT_OUT",
  "STOCKTAKE",
  "DAMAGE",
  "TRANSFER_IN",
  "TRANSFER_OUT",
]);

function numberValue(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function GET(request: Request): Promise<Response> {
  if (!supabase) return Response.json({ error: "Supabase غير مهيأة" }, { status: 503 });
  const access = await getCapabilityAccess(request, "inventory.view");
  if (!access) return capabilityAuthorizationError(request, "inventory.view");
  const storeId = access.storeId;

  const url = new URL(request.url);
  const productId = url.searchParams.get("productId")?.trim() ?? "";
  const movementType = url.searchParams.get("type")?.trim() ?? "";
  const page = Math.max(1, Math.floor(numberValue(url.searchParams.get("page")) || 1));
  const pageSize = Math.min(200, Math.max(1, Math.floor(numberValue(url.searchParams.get("pageSize")) || 25)));
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  try {
    let query = supabase
      .from("inventory_movements")
      .select("id,product_id,branch_id,terminal_id,actor_id,actor_name,movement_type,quantity_delta,unit_quantity,unit_name,multiplier,balance_before,balance_after,barcode,variant_label,reference_type,reference_id,reason,metadata,occurred_at,created_at")
      .eq("store_id", storeId)
      .order("occurred_at", { ascending: false })
      .range(from, to);
    if (productId) query = query.eq("product_id", productId);
    if (movementType && MOVEMENT_TYPES.has(movementType)) query = query.eq("movement_type", movementType);

    const movementsResult = await query;
    if (movementsResult.error) return Response.json({ error: movementsResult.error.message }, { status: 500 });

    let countQuery = supabase
      .from("inventory_movements")
      .select("id", { count: "exact", head: true })
      .eq("store_id", storeId);
    if (productId) countQuery = countQuery.eq("product_id", productId);
    if (movementType && MOVEMENT_TYPES.has(movementType)) countQuery = countQuery.eq("movement_type", movementType);
    const countResult = await countQuery;
    const total = countResult.count ?? 0;

    const productIds = [...new Set((movementsResult.data ?? []).map((movement) => movement.product_id))];
    const productsResult = productIds.length > 0
      ? await supabase.from("products").select("id,name,base_unit,total_stock").eq("store_id", storeId).in("id", productIds)
      : { data: [], error: null };
    if (productsResult.error) return Response.json({ error: productsResult.error.message }, { status: 500 });
    const productMap = new Map((productsResult.data ?? []).map((product) => [product.id, product]));

    return Response.json({
      movements: (movementsResult.data ?? []).map((movement) => ({
        ...movement,
        product_name: productMap.get(movement.product_id)?.name ?? "منتج محذوف",
        base_unit: productMap.get(movement.product_id)?.base_unit ?? "",
        current_stock: Number(productMap.get(movement.product_id)?.total_stock ?? movement.balance_after),
      })),
      total,
      page,
      pageSize,
    });
  } catch (err) {
    console.error("Inventory movements fetch failed:", err);
    return Response.json({ error: "تعذر تحميل حركات المخزون" }, { status: 500 });
  }
}

export async function POST(request: Request): Promise<Response> {
  if (!supabase) return Response.json({ error: "Supabase غير مهيأة" }, { status: 503 });
  const access = await getCapabilityAccess(request, "inventory.manage");
  if (!access) return capabilityAuthorizationError(request, "inventory.manage");
  const storeId = access.storeId;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const input = (body ?? {}) as Record<string, unknown>;
  const productId = typeof input.productId === "string" ? input.productId.trim() : "";
  const barcode = typeof input.barcode === "string" ? input.barcode.trim() : "";
  const mode = typeof input.mode === "string" ? input.mode : "";
  const quantity = numberValue(input.quantity);
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  const idempotencyKey = typeof input.idempotencyKey === "string" && input.idempotencyKey.trim()
    ? input.idempotencyKey.trim()
    : crypto.randomUUID();

  if (!productId) return Response.json({ error: "اختر المنتج" }, { status: 400 });
  if (!new Set(["IN", "OUT", "COUNT", "DAMAGE"]).has(mode)) {
    return Response.json({ error: "نوع التسوية غير صالح" }, { status: 400 });
  }
  if (!Number.isFinite(quantity) || quantity < 0 || (mode !== "COUNT" && quantity <= 0)) {
    return Response.json({ error: "الكمية يجب أن تكون أكبر من صفر" }, { status: 400 });
  }
  if (quantity > 999999999) return Response.json({ error: "الكمية أكبر من الحد المسموح" }, { status: 400 });
  if (reason.length < 3 || reason.length > 500) {
    return Response.json({ error: "سبب واضح من 3 إلى 500 حرف مطلوب" }, { status: 400 });
  }

  const productResult = await supabase
    .from("products")
    .select("id,name,base_unit,total_stock")
    .eq("id", productId)
    .eq("store_id", storeId)
    .maybeSingle();
  if (productResult.error) return Response.json({ error: productResult.error.message }, { status: 500 });
  if (!productResult.data) return Response.json({ error: "المنتج غير موجود" }, { status: 404 });

  let multiplier = 1;
  if (barcode) {
    const barcodeResult = await supabase
      .from("product_variants")
      .select("barcode")
      .eq("barcode", barcode)
      .eq("product_id", productId)
      .eq("store_id", storeId)
      .maybeSingle();
    if (barcodeResult.error) return Response.json({ error: barcodeResult.error.message }, { status: 500 });
    if (!barcodeResult.data) return Response.json({ error: "الباركود لا يتبع المنتج المحدد" }, { status: 400 });
    multiplier = 1;
  }

  const movementKey = `adjustment:${idempotencyKey}`;
  const existingMovement = await supabase
    .from("inventory_movements")
    .select("id,product_id,movement_type,quantity_delta,unit_quantity,unit_name,multiplier,balance_before,balance_after,barcode,variant_label,reference_type,reference_id,actor_name,reason,occurred_at")
    .eq("store_id", storeId)
    .eq("idempotency_key", movementKey)
    .maybeSingle();
  if (existingMovement.error) return Response.json({ error: existingMovement.error.message }, { status: 500 });
  if (existingMovement.data) return Response.json({ movement: existingMovement.data });

  const movementType = mode === "IN"
    ? "ADJUSTMENT_IN"
    : mode === "OUT"
      ? "ADJUSTMENT_OUT"
      : mode === "DAMAGE"
        ? "DAMAGE"
        : "STOCKTAKE";
  const signedUnitQuantity = mode === "IN" ? quantity : mode === "COUNT" ? quantity : -quantity;
  const quantityDelta = mode === "COUNT" ? 0 : Number((signedUnitQuantity * multiplier).toFixed(3));

  const movementResult = await supabase.rpc("record_inventory_movement", {
    p_store_id: storeId,
    p_product_id: productId,
    p_quantity_delta: quantityDelta,
    p_movement_type: movementType,
    p_idempotency_key: movementKey,
    p_unit_quantity: mode === "COUNT" ? null : signedUnitQuantity,
    p_barcode: mode === "COUNT" ? null : barcode || null,
    p_reference_type: "MANUAL_ADJUSTMENT",
    p_reference_id: idempotencyKey,
    p_actor_id: access.role === "admin" ? null : access.actorId,
    p_actor_name: access.actorName,
    p_reason: reason,
    p_metadata: { mode, requestedQuantity: quantity },
    p_target_balance: mode === "COUNT" ? Number(quantity.toFixed(3)) : null,
  });
  if (movementResult.error) {
    const error = movementResult.error.message.includes("insufficient_stock")
      ? "الرصيد لا يكفي لتنفيذ هذه الحركة"
      : movementResult.error.message.includes("no_stock_change")
        ? "الكمية الفعلية مطابقة للرصيد ولا توجد حركة لتسجيلها"
        : movementResult.error.message;
    return Response.json({ error }, { status: 409 });
  }

  const movement = Array.isArray(movementResult.data) ? movementResult.data[0] : movementResult.data;
  const audit = await supabase.from("admin_audit_logs").insert({
    store_id: storeId,
    admin_id: access.role === "admin" ? null : access.actorId,
    admin_name: access.actorName,
    action_type: "ADJUST_STOCK",
    target_id: productId,
    details: {
      productName: productResult.data.name,
      movementId: movement?.id ?? null,
      mode,
      quantity,
      barcode: barcode || null,
      reason,
      balanceBefore: movement?.balance_before ?? productResult.data.total_stock,
      balanceAfter: movement?.balance_after ?? null,
    },
  });
  if (audit.error) console.error("Inventory adjustment audit failed:", audit.error.message);

  return Response.json({ movement }, { status: 201 });
}
