"use client";

import { useEffect } from "react";
import { getTenantStoreId } from "@/lib/tenantClient";
import {
  startCatalogWatch,
  stopCatalogWatch,
  subscribeCatalogRefresh,
} from "@/lib/catalogInvalidation";
import { useOrdersStore } from "@/store/useOrdersStore";
import { useB2BStore } from "@/store/useB2BStore";

/**
 * Phase 2 boot wiring for the orders/B2B slices.
 *
 * - Hydrates both stores once per mount (IDB cache first, server after).
 * - Subscribes to the shared invalidation bus: `pos_orders` realtime events
 *   dispatch reason "orders", which re-pulls the board so parked carts appear
 *   across devices within one socket tick.
 * - Retries pending mirrors whenever connectivity flips back on.
 */
export function useOrdersBoot(): void {
  useEffect(() => {
    const storeId = getTenantStoreId();
    if (!storeId) return;

    void useOrdersStore.getState().hydrate();
    void useB2BStore.getState().hydrate();

    // Reuse the catalog watch socket (it already listens to pos_orders).
    // Reference-counted start/stop keeps PosLayout's own watch alive.
    startCatalogWatch(storeId);
    const unsubscribe = subscribeCatalogRefresh((reason) => {
      if (reason === "orders") {
        void useOrdersStore.getState().hydrate();
      }
      // Catalog reasons also refresh units; the POS store owns that flow.
    });

    const goOnline = (): void => {
      void useOrdersStore.getState().retryPending();
    };
    window.addEventListener("online", goOnline);

    return () => {
      unsubscribe();
      window.removeEventListener("online", goOnline);
      stopCatalogWatch();
    };
  }, []);
}
