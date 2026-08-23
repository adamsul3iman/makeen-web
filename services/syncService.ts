import {
  getSyncsByStatus,
  isQueueRecordForTenant,
  markSyncAttemptFailed,
  markSyncCompleted,
  quarantineSyncRecord,
  type SyncQueueRecord,
} from "@/lib/idb";
import { mirrorSyncBatch } from "@/lib/syncMirror";
import { getSupabaseBrowser } from "@/lib/supabaseBrowser";
import { getTenantStoreId } from "@/lib/tenantClient";

const BATCH_SIZE = 50;
/**
 * Upper bound on batches drained per invocation. The 15s background tick
 * calls this repeatedly, so a large offline backlog (the outage accumulated
 * PENDING events that the dead /api/sync route could never accept) flushes
 * in a few ticks without one interval run monopolizing the tab.
 */
const MAX_BATCHES_PER_RUN = 20;
/**
 * Consecutive mirror failures allowed before a poison record is quarantined.
 * A record that keeps failing to mirror will never succeed (broken payload/
 * config); keeping it PENDING forever would let it age in the badge and
 * repeatedly re-trigger its mirror work. Quarantined records are never
 * deleted — they move to the `sync_poison` store where the owner can fix and
 * requeue them.
 * Connectivity outages never count: when Supabase is unreachable the batch
 * call throws before any per-record failure is recorded, so the queue
 * survives downtime intact.
 */
const MAX_SERVER_ATTEMPTS = 8;

export interface SyncResult {
  /** Whether a drain was actually attempted (false when skipped by the lock or no client). */
  attempted: boolean;
  syncedCount: number;
}

/**
 * Module-level lock so concurrent intervals/events never dispatch
 * overlapping batches.
 */
let isSyncing = false;

/**
 * Drain the PENDING queue straight into Supabase: fetch up to `BATCH_SIZE`
 * records per round and mirror each event's ledger effect via the shared
 * sync-mirror engine (`mirrorSyncBatch`). Accepted ids are marked SYNCED;
 * corrupt payloads are quarantined; events whose mirror failed age toward
 * the poison cap while staying PENDING for retry.
 *
 * Drains up to MAX_BATCHES_PER_RUN rounds per invocation so an accumulated
 * backlog clears quickly after deploy instead of trickling at one batch per
 * 15s tick. Fails silently: any error just leaves the remaining records
 * PENDING so the next interval retries them. Never throws.
 */
export async function processSyncQueue(): Promise<SyncResult> {
  if (isSyncing) {
    return { attempted: false, syncedCount: 0 };
  }

  const db = getSupabaseBrowser();
  if (!db) {
    // No browser Supabase client configured: nothing can be mirrored.
    return { attempted: false, syncedCount: 0 };
  }

  isSyncing = true;

  let syncedCount = 0;
  try {
    // Tenant isolation: only the store that enqueued a record may push it.
    // Events left behind by a previous tenant's session (logout without a
    // drain, or switching stores on this device) must never be pushed under
    // the active store's session — they would mirror into the wrong store's
    // stock and ledgers.
    const storeId = getTenantStoreId();

    for (let round = 0; round < MAX_BATCHES_PER_RUN; round += 1) {
      const pending = await getSyncsByStatus("PENDING");
      const scoped = pending.filter((r) => isQueueRecordForTenant(r, storeId));
      if (scoped.length === 0) break;

      const batch: SyncQueueRecord[] = scoped.slice(0, BATCH_SIZE);
      let syncedIds: string[] = [];
      let rejected: Array<{ sync_id: string; reason: string }> = [];
      try {
        ({ syncedIds, rejected } = await mirrorSyncBatch(db, batch, storeId ?? ""));
      } catch (error) {
        // Inbox-level failure (connectivity/permission): leave everything
        // PENDING — outage attempts must never age records into quarantine.
        console.error("Sync drain aborted:", error);
        break;
      }

      if (rejected.length > 0) {
        // Never hard-delete: park rejected events in the quarantine so a
        // still-valid sale is not silently lost from the books.
        for (const record of batch.filter((r) => rejected.some((rj) => rj.sync_id === r.sync_id))) {
          const reason =
            rejected.find((rj) => rj.sync_id === record.sync_id)?.reason ??
            "rejected by validation";
          await quarantineSyncRecord(record, reason);
        }
      }

      if (syncedIds.length > 0) {
        await markSyncCompleted(syncedIds);
        syncedCount += syncedIds.length;
      }

      // Records neither acked nor rejected failed their mirror. Age those
      // out; once a record crosses the cap it moves to the quarantine so a
      // poison event can't block the queue or the pending badge forever —
      // and can't silently vanish either.
      const failedIds = batch
        .filter((r) => !syncedIds.includes(r.sync_id) && !rejected.some((rj) => rj.sync_id === r.sync_id))
        .map((r) => r.sync_id);
      if (failedIds.length > 0) {
        const counts = await markSyncAttemptFailed(failedIds);
        const expired = failedIds.filter((_, i) => counts[i] >= MAX_SERVER_ATTEMPTS);
        for (const record of batch.filter((r) => expired.includes(r.sync_id))) {
          await quarantineSyncRecord(
            record,
            `failed to mirror after ${MAX_SERVER_ATTEMPTS} attempts`,
          );
        }
      }

      // No forward progress this round (everything failing): stop burning
      // rounds; the next interval retries after backoff-worthy conditions.
      if (syncedIds.length === 0 && rejected.length === 0) break;
    }

    return { attempted: true, syncedCount };
  } catch {
    return { attempted: true, syncedCount };
  } finally {
    isSyncing = false;
  }
}
