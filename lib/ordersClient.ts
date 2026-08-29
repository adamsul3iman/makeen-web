/**
 * Server access for parked orders (`pos_orders`, migration 082).
 *
 * Every call is guarded and returns a result object instead of throwing:
 * orders are offline-first, and a failed mirror must degrade to
 * "pendingSync = true" locally rather than break the hold/restore flow.
 */
import { getSupabaseBrowser, isSupabaseBrowserConfigured } from "./supabaseBrowser";
import { getTenantStoreId } from "./tenantClient";
import type { LocalOrder } from "@/types/orders.types";

export type OrderResult =
  | { ok: true; order: LocalOrder }
  | { ok: false; error: string };

const ORDER_COLUMNS =
  "id,store_id,branch_id,terminal_id,order_number,status,items,invoice_discount,delivery_fee,customer_id,customer_name,customer_phone,cashier_id,cashier_name,device_name,invoice_sync_id,created_at,updated_at,closed_at,cancel_reason";

type OrderRow = {
  id: string;
  store_id: string;
  branch_id: string | null;
  terminal_id: string | null;
  order_number: string;
  status: LocalOrder["status"];
  items: LocalOrder["items"];
  invoice_discount: LocalOrder["invoiceDiscount"];
  delivery_fee: number | null;
  customer_id: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  cashier_id: string | null;
  cashier_name: string | null;
  device_name: string | null;
  invoice_sync_id: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  cancel_reason: string | null;
};

/** Postgres uuid typed exactly — anything else makes the INSERT fail 400. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidOrNull(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return UUID_RE.test(trimmed) ? trimmed : null;
}

function rowToOrder(row: OrderRow): LocalOrder {  return {
    id: row.id,
    storeId: row.store_id,
    branchId: row.branch_id,
    terminalId: row.terminal_id,
    orderNumber: row.order_number,
    status: row.status,
    items: Array.isArray(row.items) ? row.items : [],
    invoiceDiscount: row.invoice_discount ?? null,
    deliveryFee: Number(row.delivery_fee) || 0,
    customerId: row.customer_id ?? undefined,
    customerName: row.customer_name ?? undefined,
    customerPhone: row.customer_phone ?? undefined,
    cashierId: row.cashier_id ?? undefined,
    cashierName: row.cashier_name ?? undefined,
    deviceName: row.device_name ?? undefined,
    invoiceSyncId: row.invoice_sync_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at ?? undefined,
    cancelReason: row.cancel_reason ?? undefined,
    pendingSync: false,
  };
}

/**
 * Project a LocalOrder onto the exact `pos_orders` shape (migration 082).
 * Every uuid-typed column is validated and blanked to NULL — PostgREST
 * rejects the whole INSERT with 400 on one malformed id (e.g. a legacy
 * device-local hold id or an unset tenant store), so nothing non-uuid
 * ever reaches the wire. Numerics are coerced defensively too.
 */
function orderToRow(order: LocalOrder): Record<string, unknown> {
  return {
    id: uuidOrNull(order.id),
    store_id: uuidOrNull(order.storeId),
    branch_id: uuidOrNull(order.branchId),
    terminal_id: uuidOrNull(order.terminalId),
    order_number: order.orderNumber,
    status: order.status,
    items: order.items,
    invoice_discount: order.invoiceDiscount ?? null,
    delivery_fee: Number(order.deliveryFee) || 0,
    customer_id: uuidOrNull(order.customerId),
    customer_name: order.customerName ?? null,
    customer_phone: order.customerPhone ?? null,
    cashier_id: uuidOrNull(order.cashierId),
    cashier_name: order.cashierName ?? null,
    device_name: order.deviceName ?? null,
    invoice_sync_id: order.invoiceSyncId ?? null,
    closed_at: order.closedAt ?? null,
    cancel_reason: order.cancelReason ?? null,
  };
}

/**
 * Fetch the store's orders filtered by status, newest first. Powers both the
 * open board (["OPEN"]) and the settled history tab (["CLOSED","CANCELLED"]).
 *
 * Pagination is offset-based (never cursor/timestamp, because ordering is by
 * `updated_at` which is a non-unique tie source — an offset slice guarantees
 * no row is skipped or double-counted when the underlying set changes between
 * pages). A `limit` of 0 means "fetch everything" (used by the open board).
 */
export async function fetchOrdersByStatus(
  statuses: LocalOrder["status"][],
  limit = 100,
  offset = 0,
): Promise<{ ok: true; orders: LocalOrder[] } | { ok: false; error: string }> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !isSupabaseBrowserConfigured() || !storeId) {
    return { ok: false, error: "Supabase غير مهيأة" };
  }
  try {
    let query = sb
      .from("pos_orders")
      .select(ORDER_COLUMNS)
      .eq("store_id", storeId)
      .in("status", statuses)
      .order("updated_at", { ascending: false });
    if (limit > 0) query = query.range(offset, offset + limit - 1);
    // A >0 paginated slice is a "last page" indicator: an empty page means
    // there is no more — the caller surfaces that as no-more-history.
    const { data, error } = await query;
    if (error) return { ok: false, error: error.message };
    return { ok: true, orders: ((data ?? []) as OrderRow[]).map(rowToOrder) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "network" };
  }
}

/** Fetch the store's open (parked) orders, newest first. */
export async function fetchOpenOrders(): Promise<
  { ok: true; orders: LocalOrder[] } | { ok: false; error: string }
> {
  return fetchOrdersByStatus(["OPEN"], 200);
}

/**
 * Create or update an order row. Uses upsert on the primary key so retries
 * after connectivity loss are idempotent.
 */
export async function pushOrder(order: LocalOrder): Promise<OrderResult> {
  const sb = getSupabaseBrowser();
  if (!sb || !isSupabaseBrowserConfigured()) return { ok: false, error: "offline" };
  // A parked order can only mirror when BOTH ids are genuine uuids — the
  // row's primary key and its tenant FK are typed uuid in migration 082.
  if (!UUID_RE.test(order.id)) return { ok: false, error: "معرّف الطلب غير صالح للمزامنة" };
  if (!uuidOrNull(order.storeId)) return { ok: false, error: "لا يوجد متجر مرتبط بالطلب" };
  try {
    const { data, error } = await sb
      .from("pos_orders")
      .upsert(orderToRow(order))
      .select(ORDER_COLUMNS)
      .maybeSingle();
    if (error) return { ok: false, error: error.message };
    if (!data) return { ok: false, error: "no row returned" };
    return { ok: true, order: rowToOrder(data as OrderRow) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "network" };
  }
}

/**
 * Mark an order CLOSED once its invoice has been queued. The DB CHECK guard
 * requires `invoice_sync_id` on every closed order — enforced here too so a
 * bug can never park a paid sale in limbo.
 */
export async function closeOrder(
  orderId: string,
  invoiceSyncId: string,
): Promise<OrderResult> {
  const sb = getSupabaseBrowser();
  if (!sb || !isSupabaseBrowserConfigured()) return { ok: false, error: "offline" };
  const trimmed = invoiceSyncId.trim();
  if (!trimmed) return { ok: false, error: "closed orders require invoice_sync_id" };
  try {
    const { data, error } = await sb
      .from("pos_orders")
      .update({ status: "CLOSED", invoice_sync_id: trimmed, closed_at: new Date().toISOString() })
      .eq("id", orderId)
      .select(ORDER_COLUMNS)
      .maybeSingle();
    if (error) return { ok: false, error: error.message };
    if (!data) return { ok: false, error: "order not found" };
    return { ok: true, order: rowToOrder(data as OrderRow) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "network" };
  }
}

/**
 * Cancel a parked order. Cancellation is a status update — pos_orders has no
 * DELETE grant, mirroring the ledger-safety-by-construction posture.
 */
export async function cancelOrder(
  orderId: string,
  reason: string,
): Promise<OrderResult> {
  const sb = getSupabaseBrowser();
  if (!sb || !isSupabaseBrowserConfigured()) return { ok: false, error: "offline" };
  try {
    const { data, error } = await sb
      .from("pos_orders")
      .update({ status: "CANCELLED", cancel_reason: reason.trim(), closed_at: new Date().toISOString() })
      .eq("id", orderId)
      .select(ORDER_COLUMNS)
      .maybeSingle();
    if (error) return { ok: false, error: error.message };
    if (!data) return { ok: false, error: "order not found" };
    return { ok: true, order: rowToOrder(data as OrderRow) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "network" };
  }
}
