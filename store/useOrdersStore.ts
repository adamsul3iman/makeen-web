"use client";

/**
 * Parked-orders store (Phase 2).
 *
 * Strictly decoupled from `usePosStore`: this slice never imports the
 * monolith — the dependency points one way (checkout/hold actions call into
 * this store). Orders are offline-first: every mutation lands in IndexedDB
 * immediately, then mirrors to `pos_orders` best-effort. Failed mirrors keep
 * `pendingSync = true` and are retried by the boot sweep.
 */
import { create } from "zustand";
import {
  loadOrdersBootCacheSync,
  loadOrdersCache,
  saveOrdersCache,
} from "@/lib/idb";
import { getTenantStoreId } from "@/lib/tenantClient";
import {
  cancelOrder as cancelOrderRemote,
  closeOrder as closeOrderRemote,
  fetchOpenOrders,
  fetchOrdersByStatus,
  pushOrder,
} from "@/lib/ordersClient";
import { newUuid } from "@/lib/uuid";
import { mintOrderNumber, type LocalOrder } from "@/types/orders.types";

interface OrdersState {
  /** Open orders plus recently closed/cancelled rows kept for the board. */
  orders: LocalOrder[];
  hydrated: boolean;
  loading: boolean;
  lastSyncError: string | null;
  /**
   * Server-fetched settled history for the Orders page Closed tab. Not
   * persisted — when offline it falls back to whatever settled rows the
   * local cache holds.
   */
  settledOrders: LocalOrder[];
  settledLoading: boolean;
  settledError: string | null;

  hydrate: () => Promise<void>;
  /** Refresh the closed/cancelled history from the server (guarded). */
  fetchSettledHistory: (limit?: number) => Promise<void>;
  createOrder: (input: {
    items: LocalOrder["items"];
    invoiceDiscount: LocalOrder["invoiceDiscount"];
    deliveryFee: number;
    customerId?: string;
    customerName?: string;
    customerPhone?: string;
    cashierId?: string;
    cashierName?: string;
    deviceName?: string;
    branchId?: string | null;
    terminalId?: string | null;
  }) => LocalOrder;
  updateOrder: (id: string, patch: Partial<Omit<LocalOrder, "id" | "storeId">>) => void;
  cancelOrder: (id: string, reason: string) => void;
  /** Mark an order closed once its invoice has been queued at checkout. */
  closeWithInvoice: (id: string, invoiceSyncId: string) => void;
  /** Re-push orders whose mirror failed while offline. Best-effort sweep. */
  retryPending: () => Promise<void>;
  /** Merge a server snapshot (fetch or realtime-triggered refresh). */
  mergeServerOrders: (incoming: LocalOrder[]) => void;
}

const CLOSED_RETENTION = 20;

function sortByUpdated(orders: LocalOrder[]): LocalOrder[] {
  return [...orders].sort(
    (a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""),
  );
}

function pruneBoard(orders: LocalOrder[]): LocalOrder[] {
  const open = orders.filter((o) => o.status === "OPEN");
  const settled = orders.filter((o) => o.status !== "OPEN");
  return [...open, ...settled.slice(0, CLOSED_RETENTION)];
}

export const useOrdersStore = create<OrdersState>()((set, get) => ({
  orders: [],
  hydrated: false,
  loading: false,
  lastSyncError: null,
  settledOrders: [],
  settledLoading: false,
  settledError: null,

  hydrate: async () => {
    if (get().loading) return;
    const storeId = getTenantStoreId();
    set({ loading: true });

    // 1) Instant paint from the sync boot mirror (localStorage).
    const boot = loadOrdersBootCacheSync(storeId);
    if (boot && boot.orders.length > 0 && !get().hydrated) {
      set({ orders: sortByUpdated(boot.orders), hydrated: true });
    }

    // 2) Authoritative local cache.
    try {
      const cache = await loadOrdersCache(storeId);
      if (cache && (!get().hydrated || (cache.updatedAt || "") >= latestLocalStamp(get().orders))) {
        set({ orders: sortByUpdated(cache.orders), hydrated: true });
      }
    } catch {
      // IDB unavailable: boot mirror already applied when present.
    }

    // 3) Server truth (guarded — offline devices keep the cache).
    const result = await fetchOpenOrders();
    if (result.ok) {
      get().mergeServerOrders(result.orders);
      set({ lastSyncError: null });
    } else {
      set({ lastSyncError: result.error });
    }

    const orders = get().orders;
    try {
      await saveOrdersCache(
        { storeId: storeId ?? null, orders, updatedAt: new Date().toISOString() },
        storeId,
      );
    } catch {
      // Cache write failure must never break hydration.
    }
    set({ hydrated: true, loading: false });

    // Opportunistic retry of anything left pending by a previous session.
    void get().retryPending();
  },

  fetchSettledHistory: async (limit = 100) => {
    if (get().settledLoading) return;
    set({ settledLoading: true });
    const result = await fetchOrdersByStatus(["CLOSED", "CANCELLED"], limit);
    if (result.ok) {
      // Feed the shared board/cache too — mergeServerOrders never clobbers
      // local pendingSync rows and keeps the persisted cache bounded.
      get().mergeServerOrders(result.orders);
      set({
        settledOrders: sortByUpdated(result.orders),
        settledError: null,
        settledLoading: false,
      });
    } else {
      // Offline fallback: surface whatever settled rows the cache holds so
      // the Closed tab still shows recent local history.
      set({
        settledOrders: sortByUpdated(get().orders.filter((o) => o.status !== "OPEN")),
        settledError: result.error,
        settledLoading: false,
      });
    }
  },

  createOrder: (input) => {
    const storeId = getTenantStoreId() ?? "";
    const now = new Date().toISOString();
    const order: LocalOrder = {
      id: newUuid(),
      storeId,
      orderNumber: mintOrderNumber(input.deviceName),
      status: "OPEN",
      items: input.items,
      invoiceDiscount: input.invoiceDiscount,
      deliveryFee: input.deliveryFee,
      customerId: input.customerId,
      customerName: input.customerName,
      customerPhone: input.customerPhone,
      cashierId: input.cashierId,
      cashierName: input.cashierName,
      deviceName: input.deviceName,
      branchId: input.branchId ?? null,
      terminalId: input.terminalId ?? null,
      createdAt: now,
      updatedAt: now,
      pendingSync: true,
    };

    set((state) => ({ orders: sortByUpdated([order, ...state.orders]) }));
    persistAll(get().orders, storeId);

    void pushOrder(order).then((result) => {
      if (result.ok) {
        set((state) => ({
          orders: state.orders.map((o) =>
            o.id === order.id ? { ...result.order } : o,
          ),
          lastSyncError: null,
        }));
        persistAll(get().orders, storeId);
      } else {
        // Kept pending locally; the sweep retries when online.
        set({ lastSyncError: result.error });
      }
    });

    return order;
  },

  updateOrder: (id, patch) => {
    const storeId = getTenantStoreId() ?? "";
    set((state) => ({
      orders: state.orders.map((o) =>
        o.id === id
          ? { ...o, ...patch, updatedAt: new Date().toISOString(), pendingSync: true }
          : o,
      ),
    }));
    persistAll(get().orders, storeId);
    const updated = get().orders.find((o) => o.id === id);
    if (updated) {
      void pushOrder(updated).then((result) => {
        if (result.ok) {
          set((state) => ({
            orders: state.orders.map((o) =>
              o.id === id ? { ...result.order } : o,
            ),
            lastSyncError: null,
          }));
          persistAll(get().orders, storeId);
        } else {
          set({ lastSyncError: result.error });
        }
      });
    }
  },

  cancelOrder: (id, reason) => {
    const storeId = getTenantStoreId() ?? "";
    set((state) => ({
      orders: state.orders.map((o) =>
        o.id === id && o.status === "OPEN"
          ? {
              ...o,
              status: "CANCELLED",
              cancelReason: reason.trim(),
              closedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              pendingSync: true,
            }
          : o,
      ),
    }));
    persistAll(get().orders, storeId);
    const cancelled = get().orders.find((o) => o.id === id);
    if (cancelled) {
      void cancelOrderRemote(id, reason).then((result) => {
        if (result.ok) {
          set((state) => ({
            orders: state.orders.map((o) =>
              o.id === id ? { ...result.order } : o,
            ),
            lastSyncError: null,
          }));
        } else {
          set({ lastSyncError: result.error });
        }
        persistAll(get().orders, storeId);
      });
    }
  },

  closeWithInvoice: (id, invoiceSyncId) => {
    const storeId = getTenantStoreId() ?? "";
    const trimmed = invoiceSyncId.trim();
    if (!trimmed) return;
    set((state) => ({
      orders: state.orders.map((o) =>
        o.id === id && o.status === "OPEN"
          ? {
              ...o,
              status: "CLOSED",
              invoiceSyncId: trimmed,
              closedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              pendingSync: true,
            }
          : o,
      ),
    }));
    persistAll(get().orders, storeId);
    void closeOrderRemote(id, trimmed).then((result) => {
      if (result.ok) {
        set((state) => ({
          orders: state.orders.map((o) =>
            o.id === id ? { ...result.order } : o,
          ),
          lastSyncError: null,
        }));
      } else {
        set({ lastSyncError: result.error });
      }
      persistAll(get().orders, storeId);
    });
  },

  retryPending: async () => {
    const pending = get().orders.filter((o) => o.pendingSync);
    if (pending.length === 0) return;
    for (const order of pending) {
      if (order.status === "CLOSED" && order.invoiceSyncId) {
        const result = await closeOrderRemote(order.id, order.invoiceSyncId);
        applyRetryResult(set, get, order.id, result);
      } else if (order.status === "CANCELLED") {
        const result = await cancelOrderRemote(order.id, order.cancelReason ?? "");
        applyRetryResult(set, get, order.id, result);
      } else {
        const result = await pushOrder(order);
        applyRetryResult(set, get, order.id, result);
      }
    }
  },

  mergeServerOrders: (incoming) => {
    set((state) => {
      const byId = new Map<string, LocalOrder>();
      // Server rows win unless the local copy is still pending (it carries
      // mutations the server has never seen — never clobber them).
      for (const local of state.orders) {
        byId.set(local.id, local);
      }
      for (const remote of incoming) {
        const local = byId.get(remote.id);
        if (!local || !local.pendingSync) {
          byId.set(remote.id, remote);
        }
      }
      return { orders: pruneBoard(sortByUpdated([...byId.values()])) };
    });
  },
}));

type SetState = (
  partial: Partial<OrdersState> | ((state: OrdersState) => Partial<OrdersState>),
) => void;
type GetState = () => OrdersState;

function applyRetryResult(
  set: SetState,
  get: GetState,
  id: string,
  result: { ok: true; order: LocalOrder } | { ok: false; error: string },
): void {
  if (result.ok) {
    set((state) => ({
      orders: state.orders.map((o) => (o.id === id ? { ...result.order } : o)),
      lastSyncError: null,
    }));
  } else {
    set({ lastSyncError: result.error });
  }
  const storeId = getTenantStoreId();
  void saveOrdersCache(
    { storeId: storeId ?? null, orders: get().orders, updatedAt: new Date().toISOString() },
    storeId,
  ).catch(() => undefined);
}

function persistAll(orders: LocalOrder[], storeId: string): void {
  void saveOrdersCache(
    { storeId: storeId || null, orders, updatedAt: new Date().toISOString() },
    storeId,
  ).catch(() => undefined);
}

function latestLocalStamp(orders: LocalOrder[]): string {
  return orders.reduce<string>(
    (max, order) => ((order.updatedAt || "") > max ? order.updatedAt || "" : max),
    "",
  );
}
