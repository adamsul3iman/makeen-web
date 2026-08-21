"use client";

import { useEffect } from "react";
import { usePosStore } from "@/store/usePosStore";

const STORAGE_KEY = "pos-store";
const COMPLETING_KEY = "pos.is-completing";

const SHARED_FIELDS = [
  "items",
  "totals",
  "invoiceDiscount",
  "isReturnMode",
  "heldInvoices",
  "shiftState",
  "shiftTotals",
  "shiftTransactions",
] as const;

/**
 * Cross-tab register sync (F-3). zustand persist v5 registers no `storage`
 * listener of its own, so a cart mutation in one tab never reaches an already
 * open tab. This hook subscribes to the same-origin `storage` event (which
 * fires in every tab EXCEPT the one that wrote) and patches only the shared
 * business-state fields, keeping multiple register windows coherent.
 *
 * It also forwards the cross-tab submit lock: `completeCheckout`/`closeShift`
 * mirror `isCompleting` to localStorage under `pos.is-completing` during the
 * critical section, so every other tab honours the same double-submit guard.
 */
export function useCrossTabSync(): void {
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === COMPLETING_KEY) {
        usePosStore.setState({ isCompleting: e.newValue === "1" });
        return;
      }
      if (e.key !== STORAGE_KEY || !e.newValue) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(e.newValue);
      } catch {
        return;
      }
      const next = (parsed as { state?: Record<string, unknown> }).state;
      if (!next) return;
      const patch: Record<string, unknown> = {};
      for (const field of SHARED_FIELDS) {
        if (field in next) patch[field] = next[field];
      }
      if (Object.keys(patch).length > 0) {
        usePosStore.setState(
          patch as unknown as Parameters<typeof usePosStore.setState>[0],
        );
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
}
