"use client";

import { useEffect } from "react";
import { usePosStore } from "@/store/usePosStore";
import {
  startCatalogWatch,
  stopCatalogWatch,
  subscribeCatalogRefresh,
} from "@/lib/catalogInvalidation";
import { getTenantStoreId } from "@/lib/tenantClient";

/**
 * Mount-point for the catalog invalidation bus (POS register, receiving,
 * and any surface that renders hydrated catalog data).
 *
 * Starts the three triggers (BroadcastChannel / Realtime / stamp polling)
 * for the active tenant and funnels every non-orders refresh request into
 * `hydrateCatalog`, which coalesces concurrent requests per store.
 *
 * Orders-board updates are dispatched with reason "orders" and consumed
 * by the orders store's own subscription.
 */
export function useCatalogWatch(): void {
  const sessionStoreId = usePosStore((s) => s.currentStore?.id ?? null);

  useEffect(() => {
    const storeId = sessionStoreId ?? getTenantStoreId();
    if (!storeId) return;

    startCatalogWatch(storeId);

    const unsubscribe = subscribeCatalogRefresh((reason) => {
      if (reason === "orders") return;
      void usePosStore.getState().hydrateCatalog();
    });

    return () => {
      unsubscribe();
      stopCatalogWatch();
    };
  }, [sessionStoreId]);
}
