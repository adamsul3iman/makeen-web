import { supabase } from "@/lib/supabase";
import { authorizedCapabilityStoreId, capabilityAuthorizationError, getCapabilityAccess } from "@/lib/requestAuth";

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

interface PoItemInput {
  product_id?: unknown;
  quantity?: unknown;
  unit_cost?: unknown;
}

/** Purchase orders: list (joined), create, and receive (stock + cost bump). */
export async function GET(request: Request): Promise<Response> {
  if (!supabase) {
    return Response.json({ error: "Supabase غير مهيأة" }, { status: 503 });
  }

  const storeId = await authorizedCapabilityStoreId(request, "purchases.manage");
  if (storeId instanceof Response) return storeId;

  const { data: pos, error: poError } = await supabase
    .from("purchase_orders")
    .select("id,supplier_id,total_amount,status,received_at,created_at")
    .eq("store_id", storeId)
    .order("created_at", { ascending: false });

  if (poError) {
    return Response.json({ error: poError.message }, { status: 500 });
  }

  const poIds = (pos ?? []).map((po) => po.id);
  const supplierIds = [...new Set((pos ?? []).map((po) => po.supplier_id))];

  const [{ data: items }, { data: suppliers }] = await Promise.all([
    poIds.length > 0
      ? supabase
          .from("purchase_order_items")
          .select("id,purchase_order_id,product_id,quantity,unit_cost,total_price")
          .in("purchase_order_id", poIds)
          .eq("store_id", storeId)
      : Promise.resolve({ data: [] }),
    supplierIds.length > 0
      ? supabase
          .from("suppliers")
          .select("id,name")
          .in("id", supplierIds)
          .eq("store_id", storeId)
      : Promise.resolve({ data: [] }),
  ]);

  const supplierName = new Map((suppliers ?? []).map((s) => [s.id, s.name]));
  const orderItems = new Map<string, typeof items>();
  for (const it of items ?? []) {
    const list = orderItems.get(it.purchase_order_id) ?? [];
    list.push(it);
    orderItems.set(it.purchase_order_id, list);
  }

  const orders = (pos ?? []).map((po) => ({
    ...po,
    supplier_name: supplierName.get(po.supplier_id) ?? "—",
    items: orderItems.get(po.id) ?? [],
  }));

  return Response.json({ orders });
}

export async function POST(request: Request): Promise<Response> {
  if (!supabase) {
    return Response.json({ error: "Supabase غير مهيأة" }, { status: 503 });
  }
  const storeId = await authorizedCapabilityStoreId(request, "purchases.manage");
  if (storeId instanceof Response) return storeId;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const input = body as { supplier_id?: unknown; items?: unknown };
  const supplierId = typeof input.supplier_id === "string" ? input.supplier_id : "";
  const items = Array.isArray(input.items)
    ? (input.items as PoItemInput[]).filter((it) => it && typeof it === "object")
    : [];

  if (!supplierId) {
    return Response.json({ error: "المورد مطلوب" }, { status: 400 });
  }
  if (items.length === 0) {
    return Response.json({ error: "أضف صنفاً واحداً على الأقل" }, { status: 400 });
  }

  const parsedItems: { product_id: string; quantity: number; unit_cost: number; total_price: number }[] = [];
  for (const it of items) {
    const productId = typeof it.product_id === "string" ? it.product_id : "";
    const quantity = typeof it.quantity === "number" ? Math.floor(it.quantity) : 0;
    const unitCost = typeof it.unit_cost === "number" && Number.isFinite(it.unit_cost) ? it.unit_cost : 0;
    if (!productId || quantity <= 0 || unitCost < 0) {
      return Response.json({ error: "بنود أمر شراء غير صالحة" }, { status: 400 });
    }
    parsedItems.push({
      product_id: productId,
      quantity,
      unit_cost: round2(unitCost),
      total_price: round2(quantity * unitCost),
    });
  }

  const totalAmount = round2(parsedItems.reduce((acc, it) => acc + it.total_price, 0));

  const { data: po, error: poError } = await supabase
    .from("purchase_orders")
    .insert({
      supplier_id: supplierId,
      store_id: storeId,
      total_amount: totalAmount,
      status: "pending",
    })
    .select("id,supplier_id,total_amount,status,received_at,created_at")
    .single();
  if (poError || !po) {
    return Response.json({ error: poError?.message ?? "فشل إنشاء أمر الشراء" }, { status: 500 });
  }

  const { error: itemsError } = await supabase.from("purchase_order_items").insert(
    parsedItems.map((it) => ({ ...it, store_id: storeId, purchase_order_id: po.id })),
  );
  if (itemsError) {
    return Response.json({ error: itemsError.message }, { status: 500 });
  }

  return Response.json(
    { order: { ...po, items: parsedItems.map((it) => ({ ...it, purchase_order_id: po.id })) } },
    { status: 201 },
  );
}

export async function PATCH(request: Request): Promise<Response> {
  if (!supabase) {
    return Response.json({ error: "Supabase غير مهيأة" }, { status: 503 });
  }
  const access = await getCapabilityAccess(request, "purchases.manage");
  if (!access) return capabilityAuthorizationError(request, "purchases.manage");
  const storeId = access.storeId;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const id = typeof (body as { id?: unknown }).id === "string" ? (body as { id: string }).id : "";
  if (!id) {
    return Response.json({ error: "معرف أمر الشراء مطلوب" }, { status: 400 });
  }

  const { data: po, error: poError } = await supabase
    .from("purchase_orders")
    .select("id,status")
    .eq("id", id)
    .eq("store_id", storeId)
    .single();
  if (poError || !po) {
    return Response.json({ error: poError?.message ?? "أمر الشراء غير موجود" }, { status: 404 });
  }
  if (po.status === "received") {
    return Response.json({ error: "أمر الشراء مستلم بالفعل" }, { status: 409 });
  }

  const { data: items, error: itemsError } = await supabase
    .from("purchase_order_items")
    .select("id,product_id,quantity,unit_cost")
    .eq("purchase_order_id", id)
    .eq("store_id", storeId);
  if (itemsError) {
    return Response.json({ error: itemsError.message }, { status: 500 });
  }

  // Receive through the append-only stock card. Each PO line has a stable
  // idempotency key, so a retry after a timeout cannot add stock twice.
  for (const item of items ?? []) {
    if (!item.product_id) continue;
    // The order may have flipped to received between the guard and here.
    const { data: fresh } = await supabase
      .from("purchase_orders")
      .select("status")
      .eq("id", id)
      .eq("store_id", storeId)
      .maybeSingle();
    if (fresh?.status !== "pending") {
      return Response.json({ error: "أمر الشراء مستلم بالفعل" }, { status: 409 });
    }
    const movement = await supabase.rpc("record_inventory_movement", {
      p_store_id: storeId,
      p_product_id: item.product_id,
      p_quantity_delta: item.quantity,
      p_movement_type: "PURCHASE_RECEIPT",
      p_idempotency_key: `purchase:${id}:${item.id}`,
      p_unit_quantity: item.quantity,
      p_reference_type: "PURCHASE_ORDER",
      p_reference_id: id,
      p_actor_id: access.role === "admin" ? null : access.actorId,
      p_actor_name: access.actorName,
      p_reason: "استلام أمر شراء",
      p_metadata: { purchaseOrderItemId: item.id, unitCost: item.unit_cost },
    });
    if (movement.error) {
      return Response.json({ error: movement.error.message }, { status: 500 });
    }
    const { error: costError } = await supabase
      .from("products")
      .update({ cost_price: round2(item.unit_cost) })
      .eq("id", item.product_id)
      .eq("store_id", storeId);
    if (costError) {
      return Response.json({ error: costError.message }, { status: 500 });
    }
  }

  const { data: updated, error: updateError } = await supabase
    .from("purchase_orders")
    .update({ status: "received", received_at: new Date().toISOString() })
    .eq("id", id)
    .eq("store_id", storeId)
    .select("id,supplier_id,total_amount,status,received_at,created_at")
    .single();
  if (updateError) {
    return Response.json({ error: updateError.message }, { status: 500 });
  }

  return Response.json({ order: updated });
}
