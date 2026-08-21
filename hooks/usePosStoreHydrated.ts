"use client";

import { useSyncExternalStore } from "react";
import { usePosStore } from "@/store/usePosStore";

function subscribe(callback: () => void) {
  const unsubscribeHydrate = usePosStore.persist.onHydrate(callback);
  const unsubscribeFinish = usePosStore.persist.onFinishHydration(callback);
  return () => {
    unsubscribeHydrate();
    unsubscribeFinish();
  };
}

function getSnapshot() {
  return usePosStore.persist.hasHydrated();
}

export function usePosStoreHydrated(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
