import { getSupabaseBrowser } from "./supabaseBrowser";
import { getTenantStoreId } from "./tenantClient";

/**
 * Store-scoped procurement ledger (purchase orders + supplier pickers), queried
 * directly from Supabase in the browser (RLS-enforced). Replaces the former
 * posFetch calls to /api/purchase-orders, /api/suppliers and
 * /api/supplier-accounts on the Purchases page.
 */

export interface PurchaseOrder {
  id: string;
  store_id: string;
  supplier_id: string;
  supplier_name: string;
  order_number: string | null;
  status: string;
  total_amount: number;
  paid_amount: number;
  notes: string | null;
  expected_date: string | null;
  created_at: string;
}

export interface PurchaseOrderItem {
  id: string;
  store_id: string;
  purchase_order_id: string;
  product_id: string | null;
  quantity: number;
  unit_cost: number;
  total_price: number;
}

export interface SupplierOption {
  id: string;
  name: string;
}

export interface SupplierInvoiceOption {
  id: string;
  supplier_id: string;
  invoice_number: string;
  total_amount: number;
  paid_amount: number;
  status: string;
  due_date: string | null;
}

export interface PurchaseOrderItemInput {
  product_id?: unknown;
  quantity?: unknown;
  unit_cost?: unknown;
}

interface PurchaseOrderRow {
  id: string;
  store_id: string;
  supplier_id: string;
  order_number: string | null;
  status: string;
  total_amount: number | string | null;
  paid_amount: number | string | null;
  notes: string | null;
  expected_date: string | null;
  created_at: string;
}

interface PurchaseOrderItemRow {
  id: string;
  store_id: string;
  purchase_order_id: string;
  product_id: string | null;
  quantity: number | string | null;
  unit_cost: number | string | null;
  total_price: number | string | null;
}

interface StoredPoItemRow {
  id: string;
  product_id: string | null;
  quantity: number | string | null;
  unit_cost: number | string | null;
}

const PO_SELECT =
  "id,store_id,supplier_id,order_number,status,total_amount,paid_amount,notes,expected_date,created_at";
const PO_ITEM_SELECT =
  "id,store_id,purchase_order_id,product_id,quantity,unit_cost,total_price";
const INVOICE_OPTION_SELECT =
  "id,supplier_id,invoice_number,total_amount,paid_amount,status,due_date";
const RECEIVED_STATUSES = new Set(["received", "RECEIVED"]);

type SupabaseBrowser = NonNullable<ReturnType<typeof getSupabaseBrowser>>;

function asNum(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** Validate and normalize PO lines the same way the legacy route did. */
function parsePoItems(input: unknown): Array<{
  product_id: string;
  quantity: number;
  unit_cost: number;
  total_price: number;
}> {
  const list = Array.isArray(input)
    ? (input as PurchaseOrderItemInput[]).filter((it) => it && typeof it === "object")
    : [];
  const parsed: Array<{
    product_id: string;
    quantity: number;
    unit_cost: number;
    total_price: number;
  }> = [];
  for (const it of list) {
    const productId = typeof it.product_id === "string" ? it.product_id.trim() : "";
    const quantity = typeof it.quantity === "number" ? Math.floor(it.quantity) : 0;
    const unitCost = typeof it.unit_cost === "number" && Number.isFinite(it.unit_cost) ? it.unit_cost : 0;
    if (!productId || quantity <= 0 || unitCost < 0) {
      throw new Error("بنود أمر شراء غير صالحة");
    }
    parsed.push({
      product_id: productId,
      quantity,
      unit_cost: round2(unitCost),
      total_price: round2(quantity * unitCost),
    });
  }
  return parsed;
}

async function getSupplierNames(
  sb: SupabaseBrowser,
  storeId: string,
  ids: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (ids.length === 0) return map;
  const { data } = await sb.from("suppliers").select("id,name").in("id", ids).eq("store_id", storeId);
  for (const row of (data ?? []) as Array<{ id: string; name: string }>) map.set(row.id, row.name);
  return map;
}

function toPurchaseOrder(row: PurchaseOrderRow, supplierNames: Map<string, string>): PurchaseOrder {
  return {
    id: row.id,
    store_id: row.store_id,
    supplier_id: row.supplier_id,
    supplier_name: supplierNames.get(row.supplier_id) ?? "—",
    order_number: row.order_number,
    status: row.status,
    total_amount: asNum(row.total_amount),
    paid_amount: asNum(row.paid_amount),
    notes: row.notes,
    expected_date: row.expected_date,
    created_at: row.created_at,
  };
}

/**
 * Paged purchase-order listing (newest first) with an optional status filter.
 * Supplier names are resolved with a separate lightweight lookup instead of an
 * embed, mirroring the legacy /api/purchase-orders GET.
 */
export async function fetchPurchaseOrders(
  params: { status?: string; page?: number; pageSize?: number } = {},
): Promise<{ orders: PurchaseOrder[]; total: number; page: number; pageSize: number }> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  const page = Math.max(1, Math.floor(asNum(params.page, 1)));
  const pageSize = Math.max(1, Math.floor(asNum(params.pageSize, 50)));
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const status = typeof params.status === "string" ? params.status.trim() : "";
  let query = sb
    .from("purchase_orders")
    .select(PO_SELECT)
    .eq("store_id", storeId)
    .order("created_at", { ascending: false })
    .range(from, to);
  let countQuery = sb
    .from("purchase_orders")
    .select("id", { count: "exact", head: true })
    .eq("store_id", storeId);
  if (status) {
    query = query.eq("status", status);
    countQuery = countQuery.eq("status", status);
  }

  const { data: orders, error } = await query;
  if (error) throw new Error(error.message);

  const { count, error: countError } = await countQuery;
  if (countError) throw new Error(countError.message);

  const rows = (orders ?? []) as PurchaseOrderRow[];
  const supplierIds = [...new Set(rows.map((row) => row.supplier_id))];
  const supplierNames = await getSupplierNames(sb, storeId, supplierIds);

  return {
    orders: rows.map((row) => toPurchaseOrder(row, supplierNames)),
    total: count ?? 0,
    page,
    pageSize,
  };
}

/**
 * Create a purchase order for the active store. When line items are supplied
 * they are inserted into purchase_order_items and, unless a total_amount was
 * declared explicitly, the header total is computed from the lines (the legacy
 * POST behavior).
 */
export async function createPurchaseOrder(data: {
  supplier_id: string;
  order_number?: string | null;
  status?: string;
  total_amount?: number;
  paid_amount?: number;
  notes?: string | null;
  expected_date?: string | null;
  items?: PurchaseOrderItemInput[];
}): Promise<PurchaseOrder & { items: PurchaseOrderItem[] }> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  const supplierId = typeof data.supplier_id === "string" ? data.supplier_id.trim() : "";
  if (!supplierId) throw new Error("المورد مطلوب");

  const parsedItems = parsePoItems(data.items);

  const payload: Record<string, unknown> = { store_id: storeId, supplier_id: supplierId };
  const orderNumber = cleanText(data.order_number);
  if (orderNumber) payload.order_number = orderNumber;
  const status = typeof data.status === "string" ? data.status.trim() : "";
  if (status) payload.status = status;
  if (data.total_amount !== undefined) payload.total_amount = round2(asNum(data.total_amount));
  if (data.paid_amount !== undefined) payload.paid_amount = round2(asNum(data.paid_amount));
  if (data.notes !== undefined) payload.notes = cleanText(data.notes);
  if (data.expected_date !== undefined) payload.expected_date = cleanText(data.expected_date);
  if (payload.total_amount === undefined && parsedItems.length > 0) {
    payload.total_amount = round2(parsedItems.reduce((acc, it) => acc + it.total_price, 0));
  }

  const { data: po, error: poError } = await sb
    .from("purchase_orders")
    .insert(payload)
    .select(PO_SELECT)
    .single();
  if (poError || !po) throw new Error(poError?.message ?? "تعذر إنشاء أمر الشراء");

  let itemRows: PurchaseOrderItem[] = [];
  if (parsedItems.length > 0) {
    const { data: inserted, error: itemsError } = await sb
      .from("purchase_order_items")
      .insert(parsedItems.map((it) => ({ ...it, store_id: storeId, purchase_order_id: po.id })))
      .select(PO_ITEM_SELECT);
    if (itemsError) throw new Error(itemsError.message);
    itemRows = ((inserted ?? []) as PurchaseOrderItemRow[]).map((row) => ({
      id: row.id,
      store_id: row.store_id,
      purchase_order_id: row.purchase_order_id,
      product_id: row.product_id,
      quantity: asNum(row.quantity),
      unit_cost: asNum(row.unit_cost),
      total_price: asNum(row.total_price),
    }));
  }

  const supplierNames = await getSupplierNames(sb, storeId, [supplierId]);
  return { ...toPurchaseOrder(po as PurchaseOrderRow, supplierNames), items: itemRows };
}

/** Patch a purchase order's editable header fields; the row must belong to the active store. */
export async function updatePurchaseOrder(
  id: string,
  data: {
    supplier_id?: string;
    order_number?: string | null;
    status?: string;
    total_amount?: number;
    paid_amount?: number;
    notes?: string | null;
    expected_date?: string | null;
  },
): Promise<PurchaseOrder> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  const patch: Record<string, unknown> = {};
  if (data.supplier_id !== undefined) {
    const supplierId = typeof data.supplier_id === "string" ? data.supplier_id.trim() : "";
    if (!supplierId) throw new Error("المورد مطلوب");
    patch.supplier_id = supplierId;
  }
  if (data.order_number !== undefined) patch.order_number = cleanText(data.order_number);
  if (data.status !== undefined) {
    const status = typeof data.status === "string" ? data.status.trim() : "";
    if (status) patch.status = status;
  }
  if (data.total_amount !== undefined) patch.total_amount = round2(asNum(data.total_amount));
  if (data.paid_amount !== undefined) patch.paid_amount = round2(asNum(data.paid_amount));
  if (data.notes !== undefined) patch.notes = cleanText(data.notes);
  if (data.expected_date !== undefined) patch.expected_date = cleanText(data.expected_date);
  if (Object.keys(patch).length === 0) throw new Error("لا توجد حقول للتحديث");

  const { data: updated, error } = await sb
    .from("purchase_orders")
    .update(patch)
    .eq("id", id)
    .eq("store_id", storeId)
    .select(PO_SELECT)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!updated) throw new Error("أمر الشراء غير موجود");

  const supplierNames = await getSupplierNames(sb, storeId, [(updated as PurchaseOrderRow).supplier_id]);
  return toPurchaseOrder(updated as PurchaseOrderRow, supplierNames);
}

/**
 * Receive a purchase order: flips its status to RECEIVED and pushes every line
 * with a product through the append-only stock card via the
 * record_inventory_movement RPC. Each PO line contributes a stable idempotency
 * key, so a retry after a timeout cannot add stock twice.
 */
export async function receivePurchaseOrder(
  id: string,
  data: { actorName?: string | null; reason?: string } = {},
): Promise<PurchaseOrder> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  const orderId = typeof id === "string" ? id.trim() : "";
  if (!orderId) throw new Error("معرف أمر الشراء مطلوب");

  const { data: po, error: readError } = await sb
    .from("purchase_orders")
    .select("id,status")
    .eq("id", orderId)
    .eq("store_id", storeId)
    .maybeSingle();
  if (readError) throw new Error(readError.message);
  if (!po) throw new Error("أمر الشراء غير موجود");
  if (RECEIVED_STATUSES.has(po.status)) throw new Error("أمر الشراء مستلم بالفعل");

  const { data: storedItems, error: itemsError } = await sb
    .from("purchase_order_items")
    .select("id,product_id,quantity,unit_cost")
    .eq("purchase_order_id", orderId)
    .eq("store_id", storeId);
  if (itemsError) throw new Error(itemsError.message);

  for (const item of (storedItems ?? []) as StoredPoItemRow[]) {
    if (!item.product_id) continue;
    const quantity = asNum(item.quantity);
    const { error: movementError } = await sb.rpc("record_inventory_movement", {
      p_store_id: storeId,
      p_product_id: item.product_id,
      p_quantity_delta: quantity,
      p_movement_type: "PURCHASE_RECEIPT",
      p_idempotency_key: `purchase:${orderId}:${item.id}`,
      p_unit_quantity: quantity,
      p_reference_type: "PURCHASE_ORDER",
      p_reference_id: orderId,
      p_actor_id: null,
      p_actor_name: data.actorName ?? null,
      p_reason: data.reason ?? "استلام أمر شراء",
      p_metadata: { purchaseOrderItemId: item.id, unitCost: asNum(item.unit_cost) },
    });
    if (movementError) throw new Error(movementError.message);
  }

  const { data: updated, error: updateError } = await sb
    .from("purchase_orders")
    .update({ status: "RECEIVED", received_at: new Date().toISOString() })
    .eq("id", orderId)
    .eq("store_id", storeId)
    .select(PO_SELECT)
    .maybeSingle();
  if (updateError) throw new Error(updateError.message);
  if (!updated) throw new Error("أمر الشراء غير موجود");

  const supplierNames = await getSupplierNames(sb, storeId, [(updated as PurchaseOrderRow).supplier_id]);
  return toPurchaseOrder(updated as PurchaseOrderRow, supplierNames);
}

/** Lightweight supplier picker list (id + name), ordered alphabetically. */
export async function fetchSuppliers(): Promise<SupplierOption[]> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  const { data, error } = await sb
    .from("suppliers")
    .select("id,name")
    .eq("store_id", storeId)
    .order("name", { ascending: true });
  if (error) throw new Error(error.message);

  return (data ?? []) as SupplierOption[];
}

/** Lightweight supplier-invoice list for payable pickers on the Purchases page. */
export async function fetchSupplierInvoices(): Promise<SupplierInvoiceOption[]> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  const { data, error } = await sb
    .from("supplier_invoices")
    .select(INVOICE_OPTION_SELECT)
    .eq("store_id", storeId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);

  return ((data ?? []) as Array<{
    id: string;
    supplier_id: string;
    invoice_number: string;
    total_amount: number | string | null;
    paid_amount: number | string | null;
    status: string;
    due_date: string | null;
  }>).map((row) => ({
    id: row.id,
    supplier_id: row.supplier_id,
    invoice_number: row.invoice_number,
    total_amount: asNum(row.total_amount),
    paid_amount: asNum(row.paid_amount),
    status: row.status,
    due_date: row.due_date,
  }));
}
