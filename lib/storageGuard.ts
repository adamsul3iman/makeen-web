/**
 * Persistent-storage guard (SYNC-F2 / NIGHT_AUDIT_REPORT §3.2).
 *
 * The offline sync queue is the register's source of truth until the mirror
 * acks it, so losing IndexedDB rows to Chromium's automatic eviction under
 * disk pressure is real money loss. Three defenses:
 *
 *  1. `navigator.storage.persist()` — marks the origin as persistent so the
 *     browser must never evict its storage silently. Requested at app boot
 *     and re-asserted at every register login (`requestPersistentStorage`),
 *     because grants are heuristic and can change between sessions.
 *  2. A low-frequency quota watchdog — when usage crosses STORAGE_PRESSURE_
 *     THRESHOLD it logs loudly and dispatches STORAGE_PRESSURE_EVENT with the
 *     `{ usage, quota }` detail; when usage falls back under the threshold a
 *     final event carries `detail: null` so UI shells can clear the warning.
 *  3. `getStoragePressure()` returns the current snapshot so a shell that
 *     mounts after the onset event still renders the warning immediately.
 *
 * Every API degrades gracefully: on browsers/environments without the
 * Storage Manager (older Safari/iOS webviews, some embedders) requests resolve
 * `null`, the watchdog stays inert and nothing ever throws into boot.
 *
 * Idempotent: `initStorageGuard()` may be called from any mount point; only
 * the first call in a document does anything.
 */

export const STORAGE_PRESSURE_EVENT = "pos-storage-pressure";

/** Quota estimate snapshot dispatched while the origin is over threshold. */
export interface StoragePressureDetail {
  usage: number;
  quota: number;
}

/** Fraction of granted quota at which the operator warning fires. */
const STORAGE_PRESSURE_THRESHOLD = 0.9;

/** How often the quota estimate is re-checked. */
const WATCH_INTERVAL_MS = 5 * 60 * 1000;

let initialized = false;
let pressureActive = false;
let lastPressure: StoragePressureDetail | null = null;

/**
 * Current over-threshold snapshot, or null while healthy/unknown. Lets a
 * subscriber that mounts later than the onset event render the live state
 * without waiting for the next watchdog tick.
 */
export function getStoragePressure(): StoragePressureDetail | null {
  return lastPressure;
}

/**
 * Ask the browser to make this origin's storage persistent. Resolves:
 *  - true  → granted (origin exempt from automatic eviction),
 *  - false → denied (watchdog still runs; UI should surface pressure),
 *  - null  → Storage Manager unavailable or the call threw; best-effort only,
 *            never an error. Callers may fire-and-forget.
 */
export async function requestPersistentStorage(): Promise<boolean | null> {
  if (typeof navigator === "undefined" || !navigator.storage?.persist) return null;
  try {
    return await navigator.storage.persist();
  } catch {
    // Exotic embedders can reject synchronously; never break the caller.
    return null;
  }
}

async function checkQuota(): Promise<void> {
  if (!navigator.storage?.estimate) return;
  try {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    if (quota > 0 && usage / quota >= STORAGE_PRESSURE_THRESHOLD) {
      lastPressure = { usage, quota };
      if (!pressureActive) {
        pressureActive = true;
        console.error(
          `[storage] ${Math.round((usage / quota) * 100)}% of quota used — unsynced sales at risk. Free disk space or prune local history.`,
        );
        window.dispatchEvent(
          new CustomEvent<StoragePressureDetail>(STORAGE_PRESSURE_EVENT, {
            detail: lastPressure,
          }),
        );
      }
    } else if (pressureActive) {
      // Falling edge: tell listeners the danger passed (detail = null).
      pressureActive = false;
      lastPressure = null;
      window.dispatchEvent(
        new CustomEvent<StoragePressureDetail | null>(STORAGE_PRESSURE_EVENT, {
          detail: null,
        }),
      );
    }
  } catch {
    // estimate() unavailable/blocked: the watchdog is advisory only.
  }
}

export function initStorageGuard(): void {
  if (initialized || typeof window === "undefined") return;
  initialized = true;

  void (async () => {
    const granted = await requestPersistentStorage();
    // Denied is common on fresh/ephemeral profiles; the watchdog still runs.
    console.info(`[storage] persist() granted=${granted ?? "unsupported"}`);

    void checkQuota();
    window.setInterval(() => void checkQuota(), WATCH_INTERVAL_MS);
  })();
}
