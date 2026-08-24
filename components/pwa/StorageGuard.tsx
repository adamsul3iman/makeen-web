"use client";

import { useEffect } from "react";
import { initStorageGuard } from "@/lib/storageGuard";

/**
 * Mount-once bootstrap for the persistent-storage guard (SYNC-F2): requests
 * `navigator.storage.persist()` and starts the quota-pressure watchdog.
 * Renders nothing.
 */
export function StorageGuard() {
  useEffect(() => {
    initStorageGuard();
  }, []);

  return null;
}
