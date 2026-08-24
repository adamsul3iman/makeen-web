/**
 * Persistent-storage guard (SYNC-F2 / NIGHT_AUDIT_REPORT §3.2).
 *
 * The offline sync queue is the register's source of truth until the mirror
 * acks it, so losing IndexedDB rows to Chromium's automatic eviction under
 * disk pressure is real money loss. Two defenses:
 *
 *  1. `navigator.storage.persist()` — marks the origin as persistent so the
 *     browser must never evict its storage silently. Best-effort: denied
 *     grants (e.g. transient profiles) are logged, never thrown.
 *  2. A low-frequency quota watchdog — when usage crosses STORAGE_PRESSURE_
 *     THRESHOLD it logs loudly and dispatches `pos-storage-pressure` so UI
 *     shells can surface an operator-visible warning.
 *
 * Idempotent: `initStorageGuard()` may be called from any mount point; only
 * the first call in a document does anything.
 */

export const STORAGE_PRESSURE_EVENT = "pos-storage-pressure";

/** Fraction of granted quota at which the operator warning fires. */
const STORAGE_PRESSURE_THRESHOLD = 0.9;

/** How often the quota estimate is re-checked. */
const WATCH_INTERVAL_MS = 5 * 60 * 1000;

let initialized = false;
let pressureActive = false;

async function checkQuota(): Promise<void> {
  if (!navigator.storage?.estimate) return;
  try {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    if (quota > 0 && usage / quota >= STORAGE_PRESSURE_THRESHOLD) {
      if (!pressureActive) {
        pressureActive = true;
        console.error(
          `[storage] ${Math.round((usage / quota) * 100)}% of quota used — unsynced sales at risk. Free disk space or prune local history.`,
        );
        window.dispatchEvent(
          new CustomEvent(STORAGE_PRESSURE_EVENT, { detail: { usage, quota } }),
        );
      }
    } else {
      pressureActive = false;
    }
  } catch {
    // estimate() unavailable/blocked: the watchdog is advisory only.
  }
}

export function initStorageGuard(): void {
  if (initialized || typeof window === "undefined") return;
  initialized = true;

  void (async () => {
    try {
      if (navigator.storage?.persist) {
        const granted = await navigator.storage.persist();
        // Denied is common on fresh/ephemeral profiles; the watchdog still runs.
        console.info(`[storage] persist() granted=${granted}`);
      }
    } catch {
      // persist() can throw on exotic embedders; never break boot.
    }

    void checkQuota();
    window.setInterval(() => void checkQuota(), WATCH_INTERVAL_MS);
  })();
}
