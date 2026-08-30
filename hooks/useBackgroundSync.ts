"use client";

import { useEffect } from "react";
import { usePosStore } from "@/store/usePosStore";
import { processSyncQueue } from "@/services/syncService";
import { getSyncsByStatus, isQueueRecordForTenant, pruneIstdStates, pruneSyncedSyncQueue } from "@/lib/idb";
import { getTenantStoreId } from "@/lib/tenantClient";
import { hasCatalogDrifted } from "@/lib/catalogInvalidation";
import { useOrdersStore } from "@/store/useOrdersStore";

const SYNC_INTERVAL_MS = 15_000;

// MEM-1/MEM-2: retention sweeps are cheap when idle (indexed range probes)
// but there is no reason to run them every tick. Once an hour per tab is
// plenty; the module-level timestamp also de-duplicates across ticks within
// the session.
const RETENTION_INTERVAL_MS = 60 * 60 * 1000;
let lastRetentionAt = 0;

async function runRetentionSweeps(): Promise<void> {
  const now = Date.now();
  if (now - lastRetentionAt < RETENTION_INTERVAL_MS) return;
  lastRetentionAt = now;
  // Each sweep is independently guarded: a failure in one must never block
  // the other, and neither may break the sync tick.
  try {
    const pruned = await pruneSyncedSyncQueue();
    if (pruned > 0) console.info(`[sync] queue retention: pruned ${pruned} SYNCED rows`);
  } catch (error) {
    console.warn("[sync] queue retention sweep failed:", error);
  }
  try {
    const pruned = await pruneIstdStates();
    if (pruned > 0) console.info(`[sync] istd retention: pruned ${pruned} SUBMITTED rows`);
  } catch (error) {
    console.warn("[sync] istd retention sweep failed:", error);
  }
}

async function refreshPendingCount(): Promise<void> {
  const storeId = getTenantStoreId();
  const count = (await getSyncsByStatus("PENDING")).filter((r) =>
    isQueueRecordForTenant(r, storeId),
  ).length;
  usePosStore.getState().setPendingSyncCount(count);
  await usePosStore.getState().refreshPoisonSyncCount();
  // ISTD/JoFotara badge counts mirror the IndexedDB state store, so a
  // FAILED submission (or a late clearance) is always visible.
  await usePosStore.getState().refreshIstdCounts();
}

/**
 * Guaranteed catalog-convergence floor: one cheap stamp read per tick.
 * Realtime/BroadcastChannel usually win the race; this catches devices
 * whose socket dropped, tables without realtime membership, and deletes.
 */
async function pollCatalogDrift(): Promise<void> {
  const storeId = usePosStore.getState().currentStore?.id ?? getTenantStoreId();
  if (!storeId) return;
  try {
    if (await hasCatalogDrifted(storeId)) {
      await usePosStore.getState().hydrateCatalog();
    }
  } catch {
    /* offline or table not migrated yet — cache stays authoritative */
  }
}

async function syncIfOnline(): Promise<void> {
  if (!usePosStore.getState().isOnline) return;
  const result = await processSyncQueue();
  await refreshPendingCount();
  if (result.syncedCount > 0) {
    await usePosStore.getState().hydrateCatalog();
  }
  // Post-ack is the ideal sweep point: anything just marked SYNCED ages from
  // now, and a drained queue makes room before the next burst.
  await runRetentionSweeps();
}

/**
 * Manual sync trigger (Phase 3 "ليونة" quick-actions drawer). Runs the same
 * pipeline as a background tick on demand: drain the queue, refresh badges,
 * sweep retention, poll catalog drift, and retry parked-order mirrors.
 * Never throws — the drawer renders the outcome.
 */
export async function runManualSync(): Promise<{
  ok: boolean;
  pending: number;
}> {
  try {
    const result = await processSyncQueue();
    await refreshPendingCount();
    if (result.syncedCount > 0) {
      await usePosStore.getState().hydrateCatalog();
    }
    await runRetentionSweeps();
    await pollCatalogDrift();
    void useOrdersStore.getState().retryPending();
    return { ok: true, pending: usePosStore.getState().pendingSyncCount };
  } catch {
    return { ok: false, pending: usePosStore.getState().pendingSyncCount };
  }
}

/**
 * Background sync engine:
 *  - Keeps the store's `isOnline` flag in sync with the browser.
 *  - Drains the PENDING queue straight into Supabase every 15s while online.
 *  - Triggers an immediate push when the tab comes back online.
 *  - Re-runs when the tab regains visibility (intervals are throttled
 *    in background tabs).
 *  - Refreshes pendingSyncCount so the UI reflects the real queue size.
 */
export function useBackgroundSync(): void {
  useEffect(() => {
    const handleOnline = () => {
      usePosStore.getState().setOnline(true);
      void syncIfOnline();
      void pollCatalogDrift();
    };
    const handleOffline = () => {
      usePosStore.getState().setOnline(false);
    };
    // Immediate flush after a checkout settles: completeCheckout dispatches
    // "pos:invoice-queued" once the invoice is durably enqueued, so an online
    // sale pushes to Supabase in the same tick instead of waiting up to the
    // 15s interval. When already mid-drain, processSyncQueue's module lock
    // coalesces the call — no double work, no lost events.
    const handleInvoiceQueued = () => {
      void syncIfOnline();
    };
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        void syncIfOnline();
        void pollCatalogDrift();
      }
    };

    const interval = setInterval(() => {
      void refreshPendingCount();
      void syncIfOnline();
      void pollCatalogDrift();
    }, SYNC_INTERVAL_MS);

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    window.addEventListener("pos:invoice-queued", handleInvoiceQueued);
    document.addEventListener("visibilitychange", handleVisibility);

    void refreshPendingCount();
    void runRetentionSweeps();
    // Immediate drain on mount so a freshly-launched register (or a reload)
    // recovers any invoices trapped in the queue without waiting for the first
    // 15s tick. processSyncQueue's tenant guard no-ops until rehydrate has set
    // the active store id; the interval retries it a moment later.
    void syncIfOnline();

    return () => {
      clearInterval(interval);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("pos:invoice-queued", handleInvoiceQueued);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, []);
}
