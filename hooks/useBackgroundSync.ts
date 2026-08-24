"use client";

import { useEffect } from "react";
import { usePosStore } from "@/store/usePosStore";
import { processSyncQueue } from "@/services/syncService";
import { getSyncsByStatus, isQueueRecordForTenant, pruneIstdStates, pruneSyncedSyncQueue } from "@/lib/idb";
import { getTenantStoreId } from "@/lib/tenantClient";

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

async function syncIfOnline(): Promise<void> {
  if (!usePosStore.getState().isOnline) return;
  await processSyncQueue();
  await refreshPendingCount();
  // Post-ack is the ideal sweep point: anything just marked SYNCED ages from
  // now, and a drained queue makes room before the next burst.
  await runRetentionSweeps();
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
    };
    const handleOffline = () => {
      usePosStore.getState().setOnline(false);
    };
    const handleVisibility = () => {
      if (document.visibilityState === "visible") void syncIfOnline();
    };

    const interval = setInterval(() => {
      void refreshPendingCount();
      void syncIfOnline();
    }, SYNC_INTERVAL_MS);

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    document.addEventListener("visibilitychange", handleVisibility);

    void refreshPendingCount();
    void runRetentionSweeps();

    return () => {
      clearInterval(interval);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, []);
}
