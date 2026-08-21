import type { PersistStorage, StorageValue } from "zustand/middleware";

/**
 * Coalesced localStorage-backed persistence for zustand's `persist`
 * middleware — wired WITHOUT `createJSONStorage`.
 *
 * The default persist pipeline wraps the storage with `createJSONStorage`,
 * which JSON.stringifies the full partialized snapshot synchronously on
 * EVERY state change. During a rapid barcode scan (dozens of cart mutations
 * per second) that serializes the whole snapshot — cart, held invoices and
 * the growing shift ledger — on each op and blocks rendering on the main
 * thread: the "UI lag / freeze during scanning" symptom.
 *
 * This adapter defers BOTH the serialization and the `setItem` to the end of
 * a debounce window: mutations inside one window share a single stringify +
 * write of the latest snapshot. The snapshot is flushed before the tab
 * unloads so nothing is lost, and `flushPersistWrites()` forces a durable
 * write on critical transitions.
 *
 * `getItem` stays synchronous and returns the already-parsed storage value
 * (the persist middleware consumes `.state`/`.version` directly), so
 * rehydration is unchanged. The written localStorage value keeps the exact
 * `{ "state": {...}, "version": N }` shape, so cross-tab readers
 * (`useCrossTabSync`, `readPersistedStoreId`) are unaffected.
 */
const WRITE_DEBOUNCE_MS = 250;

let pendingName: string | null = null;
let pendingValue: unknown = null;
let writeTimer: ReturnType<typeof setTimeout> | null = null;

function writeNow(): void {
  if (pendingName === null) return;
  const name = pendingName;
  const value = pendingValue;
  pendingName = null;
  pendingValue = null;
  writeTimer = null;
  try {
    localStorage.setItem(name, JSON.stringify(value));
  } catch {
    // Quota exceeded / private browsing: the in-memory store stays correct.
  }
}

export function flushPersistWrites(): void {
  if (writeTimer !== null) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  writeNow();
}

function scheduleWrite(name: string, value: unknown): void {
  pendingName = name;
  pendingValue = value;
  if (writeTimer !== null) clearTimeout(writeTimer);
  writeTimer = setTimeout(writeNow, WRITE_DEBOUNCE_MS);
}

/** Coalesced adapter instance; call sites pick the persist storage type. */
export function createPosPersistStorage<S>(): PersistStorage<S> {
  return {
    getItem: (name) => {
      if (typeof localStorage === "undefined") return null;
      try {
        const raw = localStorage.getItem(name);
        if (!raw) return null;
        return JSON.parse(raw) as unknown as StorageValue<S>;
      } catch {
        return null;
      }
    },
    setItem: (name, value) => {
      if (typeof localStorage === "undefined") return;
      scheduleWrite(name, value);
    },
    removeItem: (name) => {
      if (typeof localStorage === "undefined") return;
      flushPersistWrites();
      try {
        localStorage.removeItem(name);
      } catch {
        // ignore
      }
    },
  };
}

/** Shared instance for direct durable writes (see `persistDurablePosState`). */
export const posPersistStorage = createPosPersistStorage<unknown>();

if (
  typeof window !== "undefined" &&
  typeof window.addEventListener === "function"
) {
  const flush = () => flushPersistWrites();
  window.addEventListener("pagehide", flush);
  window.addEventListener("beforeunload", flush);
  window.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushPersistWrites();
  });
}
