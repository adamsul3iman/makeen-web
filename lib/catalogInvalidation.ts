/**
 * Catalog invalidation bus — real-time inventory→POS sync.
 *
 * One convergence point (`subscribeCatalogRefresh`) fed by three triggers,
 * strongest first. Every trigger ends in `hydrateCatalog()`, which is
 * already coalesced per tenant, so overlapping triggers collapse into a
 * single snapshot fetch:
 *
 *   1. BroadcastChannel  — same device, other tabs, instant (<50ms).
 *      Fired by every back-office write (`notifyLocalCatalogWrite`) so an
 *      open register reflects a price edit without touching the network.
 *   2. Supabase Realtime — cross-device push (~1s). postgres_changes on
 *      the catalog tables + pos_orders, filtered per tenant. Requires the
 *      tables to be in the supabase_realtime publication (migration 083);
 *      degrades silently to the polling floor when unavailable.
 *   3. Stamp polling     — guaranteed floor. `catalog_stamps` carries one
 *      bump-on-any-change token per store (migration 083); the background
 *      sync tick compares it to the last hydrated value. Survives socket
 *      loss, deletes, and tables without updated_at columns.
 *
 * Offline posture: triggers simply never fire while offline; the IDB cache
 * remains the source of truth exactly as before this module existed.
 */

import type { RealtimeChannel } from "@supabase/supabase-js";
import { getSupabaseBrowser, isSupabaseBrowserConfigured } from "./supabaseBrowser";

const CHANNEL_NAME = "pos-catalog-sync";
const STAMP_KEY_PREFIX = "pos-catalog-stamp:";

/** Tables whose changes invalidate the hydrated POS catalog. */
const CATALOG_REALTIME_TABLES = [
  "products",
  "product_variants",
  "categories",
  "product_brands",
  "product_units",
] as const;

/** Debounce for realtime bursts (bulk imports fire hundreds of rows). */
const REALTIME_DEBOUNCE_MS = 800;

export type CatalogRefreshReason =
  | "broadcast"
  | "realtime"
  | "stamp"
  | "orders";

type RefreshListener = (reason: CatalogRefreshReason) => void;

const refreshListeners = new Set<RefreshListener>();

function dispatch(reason: CatalogRefreshReason): void {
  for (const listener of [...refreshListeners]) {
    try {
      listener(reason);
    } catch (error) {
      console.error("[catalog-invalidation] listener failed:", error);
    }
  }
}

// ---------------------------------------------------------------------------
// Trigger 1 — BroadcastChannel (cross-tab, same device)
// ---------------------------------------------------------------------------

let channel: BroadcastChannel | null = null;

interface CatalogBusMessage {
  storeId: string;
  ts: number;
}

function ensureChannel(): void {
  if (channel || typeof window === "undefined" || typeof BroadcastChannel === "undefined") {
    return;
  }
  try {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = (event: MessageEvent<CatalogBusMessage>) => {
      const data = event.data;
      if (!data || typeof data.storeId !== "string") return;
      // Tenant guard: ignore chatter from a device session bound to another
      // store (same browser can hold several store tabs).
      if (data.storeId !== getWatchedStoreId()) return;
      dispatch("broadcast");
    };
  } catch {
    channel = null;
  }
}

/**
 * Publish "the catalog changed" to every OTHER tab of this device.
 * Fire-and-forget; safe to call before the channel exists or offline.
 */
export function notifyLocalCatalogWrite(storeId: string | null | undefined): void {
  if (!storeId || typeof window === "undefined") return;
  ensureChannel();
  try {
    channel?.postMessage({ storeId, ts: Date.now() } satisfies CatalogBusMessage);
  } catch {
    /* serialization/teardown races are non-fatal */
  }
}

// ---------------------------------------------------------------------------
// Trigger 2 — Supabase Realtime (cross-device push)
// ---------------------------------------------------------------------------

let watchedStoreId: string | null = null;
let realtimeChannel: RealtimeChannel | null = null;
let realtimeTimer: ReturnType<typeof setTimeout> | null = null;

function getWatchedStoreId(): string | null {
  return watchedStoreId;
}

function handleRealtimeEvent(): void {
  if (realtimeTimer) clearTimeout(realtimeTimer);
  realtimeTimer = setTimeout(() => {
    realtimeTimer = null;
    dispatch("realtime");
  }, REALTIME_DEBOUNCE_MS);
}

function ensureRealtime(storeId: string): void {
  const sb = getSupabaseBrowser();
  if (!sb || !isSupabaseBrowserConfigured()) return;
  if (realtimeChannel && watchedStoreId === storeId) return;
  teardownRealtime();

  try {
    const ch = sb.channel(`catalog:${storeId}`);
    for (const table of CATALOG_REALTIME_TABLES) {
      ch.on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table,
          filter: `store_id=eq.${storeId}`,
        },
        handleRealtimeEvent,
      );
    }
    // Open orders are pushed to the orders board through the same socket;
    // the board subscribes to refresh events like any catalog consumer.
    ch.on(
      "postgres_changes",
      { event: "*", schema: "public", table: "pos_orders", filter: `store_id=eq.${storeId}` },
      () => dispatch("orders"),
    );
    ch.subscribe((status) => {
      // On permanent channel failure the stamp poll below remains the
      // correctness floor — no retry storm needed here.
      if (status === "CHANNEL_ERROR") {
        console.warn("[catalog-invalidation] realtime channel error; relying on stamp polling");
      }
    });
    realtimeChannel = ch;
  } catch (error) {
    console.warn("[catalog-invalidation] realtime unavailable:", error);
    realtimeChannel = null;
  }
}

function teardownRealtime(): void {
  if (realtimeTimer) {
    clearTimeout(realtimeTimer);
    realtimeTimer = null;
  }
  if (realtimeChannel) {
    void realtimeChannel.unsubscribe();
    realtimeChannel = null;
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Start watching catalog changes for a tenant. Idempotent per store:
 * calling again with the same id is a no-op; a different id tears the
 * previous watch down first (device handover / tenant switch).
 *
 * Reference-counted: multiple consumers (POS layout, orders board, mobile
 * receiving) may share one socket. The watch stays alive until every
 * consumer has stopped it.
 */
let watchConsumers = 0;

export function startCatalogWatch(storeId: string | null | undefined): void {
  if (!storeId || typeof window === "undefined") return;
  if (watchedStoreId === storeId) {
    watchConsumers += 1;
    return;
  }
  stopCatalogWatch();
  watchedStoreId = storeId;
  watchConsumers = 1;
  ensureChannel();
  ensureRealtime(storeId);
}

export function stopCatalogWatch(): void {
  if (watchConsumers > 0) {
    watchConsumers -= 1;
    if (watchConsumers > 0) return;
  }
  watchedStoreId = null;
  teardownRealtime();
}

/**
 * Register a refresh callback. Returns an unsubscribe function.
 * Multiple consumers (POS layout, receiving, orders board) coexist;
 * `hydrateCatalog`'s per-store job map collapses duplicate work.
 */
export function subscribeCatalogRefresh(listener: RefreshListener): () => void {
  refreshListeners.add(listener);
  return () => {
    refreshListeners.delete(listener);
  };
}

// ---------------------------------------------------------------------------
// Trigger 3 — version-stamp polling (guaranteed floor)
// ---------------------------------------------------------------------------

function stampKey(storeId: string): string {
  return `${STAMP_KEY_PREFIX}${storeId}`;
}

/** The stamp this device last hydrated from the server (null = unknown). */
export function lastSeenCatalogStamp(storeId: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(stampKey(storeId));
  } catch {
    return null;
  }
}

/** Persist the stamp matching the snapshot that was just applied. */
export function rememberCatalogStamp(storeId: string, version: string | null | undefined): void {
  if (!storeId || !version || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(stampKey(storeId), version);
  } catch {
    /* storage full/private mode: polling just re-hydrates, still correct */
  }
}

/**
 * Read the server's current catalog stamp. Returns null when Supabase is
 * unreachable/unconfigured (offline) — callers treat that as "no change".
 */
export async function fetchCatalogStamp(storeId: string): Promise<string | null> {
  const sb = getSupabaseBrowser();
  if (!sb || !isSupabaseBrowserConfigured()) return null;
  try {
    const { data, error } = await sb
      .from("catalog_stamps")
      .select("version")
      .eq("store_id", storeId)
      .maybeSingle<{ version: string }>();
    if (error) return null;
    return data?.version ?? null;
  } catch {
    return null;
  }
}

/**
 * Polling floor, called from the background sync tick. Resolves true when
 * the server stamp differs from the last hydrated one — the caller then
 * runs `hydrateCatalog()` which re-remembers the fresh stamp on success.
 */
export async function hasCatalogDrifted(storeId: string): Promise<boolean> {
  const remote = await fetchCatalogStamp(storeId);
  if (!remote) return false;
  const seen = lastSeenCatalogStamp(storeId);
  return seen !== remote;
}
