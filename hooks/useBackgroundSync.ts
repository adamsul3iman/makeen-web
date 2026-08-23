"use client";

import { useEffect } from "react";
import { usePosStore } from "@/store/usePosStore";
import { processSyncQueue } from "@/services/syncService";
import { getSyncsByStatus, isQueueRecordForTenant } from "@/lib/idb";
import { getTenantStoreId } from "@/lib/tenantClient";

const SYNC_INTERVAL_MS = 15_000;

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

    return () => {
      clearInterval(interval);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, []);
}
