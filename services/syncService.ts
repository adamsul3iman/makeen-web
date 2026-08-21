import {
  getSyncsByStatus,
  isQueueRecordForTenant,
  markSyncAttemptFailed,
  markSyncCompleted,
  quarantineSyncRecord,
  type SyncQueueRecord,
} from "@/lib/idb";
import { getTenantStoreId } from "@/lib/tenantClient";
import { STORE_HEADER } from "@/lib/tenant";

const BATCH_SIZE = 50;
const SYNC_ENDPOINT = "/api/sync";
/**
 * Consecutive server-side failures allowed before a poison record is
 * quarantined. A record that keeps failing to mirror after this many 2xx
 * responses will never succeed (broken payload/config); keeping it PENDING
 * forever would let it age in the badge and repeatedly re-trigger its mirror
 * work server-side. Quarantined records are never deleted — they move to the
 * `sync_poison` store where the owner can fix and requeue them.
 * Server outages never count (no 2xx), so the queue survives downtime intact.
 */
const MAX_SERVER_ATTEMPTS = 8;

interface SyncApiResponse {
  success: boolean;
  synced_ids: string[];
  /** Corrupt events the server refuses — dropped so they stop retrying. */
  rejected?: Array<{ sync_id: string; reason: string }>;
}

export interface SyncResult {
  /** Whether a request was actually attempted (false when skipped by the lock or empty queue). */
  attempted: boolean;
  syncedCount: number;
}

/**
 * Module-level lock so concurrent intervals/events never dispatch
 * overlapping batches.
 */
let isSyncing = false;

/**
 * Drain the PENDING queue: fetch up to `BATCH_SIZE` records, POST them
 * to the sync endpoint, and mark the accepted ids as SYNCED.
 *
 * Fails silently: any network/HTTP error just leaves the records
 * PENDING so the next interval retries them. Never throws.
 */
export async function processSyncQueue(): Promise<SyncResult> {
  if (isSyncing) {
    return { attempted: false, syncedCount: 0 };
  }

  isSyncing = true;

  try {
    const pending = await getSyncsByStatus("PENDING");
    if (pending.length === 0) {
      return { attempted: true, syncedCount: 0 };
    }

    // Tenant isolation: only the store that enqueued a record may push it.
    // Events left behind by a previous tenant's session (logout without a
    // drain, or switching stores on this device) must never be posted under
    // the active store's session — the server would mirror them into the
    // wrong store's stock and ledgers.
    const storeId = getTenantStoreId();
    const scoped = pending.filter((r) => isQueueRecordForTenant(r, storeId));
    if (scoped.length === 0) {
      return { attempted: true, syncedCount: 0 };
    }

    const batch = scoped.slice(0, BATCH_SIZE);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (storeId) headers[STORE_HEADER] = storeId;
    const res = await fetch(SYNC_ENDPOINT, {
      method: "POST",
      headers,
      body: JSON.stringify(batch satisfies SyncQueueRecord[]),
    });

    if (!res.ok) {
      return { attempted: true, syncedCount: 0 };
    }

    const data = (await res.json()) as SyncApiResponse;
    const rejectedIds = new Set((data.rejected ?? []).map((r) => r.sync_id));
    if (rejectedIds.size > 0) {
      // Never hard-delete: park server-rejected events in the quarantine so
      // a still-valid sale is not silently lost from the books.
      for (const record of batch.filter((r) => rejectedIds.has(r.sync_id))) {
        const reason =
          data.rejected?.find((rj) => rj.sync_id === record.sync_id)?.reason ??
          "rejected by server";
        await quarantineSyncRecord(record, reason);
      }
    }
    if (
      data.success &&
      Array.isArray(data.synced_ids) &&
      data.synced_ids.length > 0
    ) {
      await markSyncCompleted(data.synced_ids);
    }
    const ackedIds = new Set(data.synced_ids ?? []);

    // The server accepted the batch but skipped some records (their mirror
    // failed). Age those out; once a record crosses the cap it is moved to
    // the quarantine so a poison event can't block the queue or the pending
    // badge forever — and can't silently vanish either.
    const failedIds = batch
      .filter((r) => !ackedIds.has(r.sync_id) && !rejectedIds.has(r.sync_id))
      .map((r) => r.sync_id);
    if (failedIds.length > 0) {
      const counts = await markSyncAttemptFailed(failedIds);
      const expired = failedIds.filter((_, i) => counts[i] >= MAX_SERVER_ATTEMPTS);
      if (expired.length > 0) {
        for (const record of batch.filter((r) => expired.includes(r.sync_id))) {
          await quarantineSyncRecord(
            record,
            `failed to mirror after ${MAX_SERVER_ATTEMPTS} attempts`,
          );
        }
      }
    }

    return { attempted: true, syncedCount: ackedIds.size };
  } catch {
    return { attempted: true, syncedCount: 0 };
  } finally {
    isSyncing = false;
  }
}
