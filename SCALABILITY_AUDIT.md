# SCALABILITY AUDIT — Offline-First Architecture

**Scope:** IndexedDB layer (`lib/idb.ts`), catalog pipeline (`lib/clientCatalog.ts`, `lib/supabase.ts`, `store/usePosStore.ts`), sync engine (`services/syncService.ts`, `lib/syncMirror.ts`, `hooks/useBackgroundSync.ts`), Supabase schema & indexes (`db/migrations/001–075`).
**Mode:** Read-only audit. No application code was modified.
**Verdict up front:** The offline-first *correctness* design is strong (idempotent event sourcing, poison quarantine, FIFO deferral of shift closes). The *scale* design is not: the system is tuned for ~6,600 SKUs and hours-long outages. At 50k products it degrades; at a 3-day outage with 10k queued invoices it enters a multi-hour, memory-heavy drain with real quarantine-storm risk.

---

## 1. Severity Summary

| # | Finding | Impact at scale | Severity |
|---|---------|-----------------|----------|
| S1 | Whole catalog stored as **one IndexedDB row** + mirrored into **localStorage** (5 MB quota) | Silent loss of boot cache ≳6–8k SKUs; full-rewrite cost per change | 🔴 Critical |
| S2 | Sync drain mirrors events **one-by-one over HTTPS** (~10–15 round trips/event) | 10k invoices ≈ **100k+ HTTP requests**, multi-hour drain | 🔴 Critical |
| S3 | `getSyncsByStatus("PENDING")` deserializes the **entire queue** every round *and* every 15 s badge tick | Tens–hundreds of MB churn → GC jank/OOM on low-end terminals | 🔴 Critical |
| S4 | SYNCED records are **never purged** from `sync_queue` | Unbounded IDB growth; queue doubles as invoice history | 🟠 High |
| S5 | No `navigator.storage.persist()` anywhere | Browser may **evict `pos_local_db`** under disk pressure → silent loss of unsynced sales | 🔴 Critical |
| S6 | Quarantine counter counts **transient** server errors (deadlock/timeout) toward the 8-attempt cap | Mass false-quarantine exactly when post-outage load peaks | 🟠 High |
| S7 | `assessShiftLedgerCompleteness` fetches **unbounded** `sync_events` slice, filters `payload->>shiftId` in JS, no composite index | Z-report finalization scans grow forever; PostgREST `max-rows` truncation can corrupt the completeness decision | 🟠 High |
| S8 | Missing SQL indexes: `sales_invoices(store_id, shift_id)`, `expenses(store_id, shift_id)`, `sync_events(store_id, action_type, client_created_at)`, `products(store_id, name)` | Slow reporting/Z-reports; O(n²)-ish catalog pagination | 🟠 High |
| S9 | Catalog version = pure-JS SHA-256 of `JSON.stringify(entire catalog)` on main thread | Multi-second UI freeze at 50k SKUs; hash invalidates on every shape change | 🟠 High |
| S10 | Triple JSONB duplication: payload lives in queue + `sync_events.payload` (forever) + `sales_invoices.payload` (forever) | 3× storage growth; table bloat slows everything touching `sync_events` | 🟡 Medium |
| S11 | `record_inventory_movement` takes `FOR UPDATE` on `products` per line; concurrent drains can deadlock; deadlock errors age records to quarantine | Lock serialization during bulk sync; ties into S6 | 🟡 Medium |
| S12 | Dual barcode systems: mirror writes `product_variants`, but the stock RPC reads `product_barcodes` (restored by 070 after 062 dropped it) | Stock lines for barcodes missing from `product_barcodes` fail `22023` and are **silently skipped** | 🟠 High (correctness × scale) |
| S13 | Smart search linearly scans all products w/ Arabic normalization per debounced keystroke | Fine at 6.6k, sluggish at 50k | 🟡 Medium |
| S14 | Drain only runs in the foreground tab; background tabs throttle timers to ≥1/min | Closing/背景-ing the register stalls the backlog flush | 🟡 Medium |

---

## 2. Architecture As-Built (map)

```
Catalog (read path)
  Supabase ──fetchAllRows(1000/page, sequential)──▶ fetchCatalogSnapshot()
    lib/supabase.ts:72          lib/clientCatalog.ts:114
      │ sha256(JSON.stringify(all)) = catalogVersionOf   lib/clientCatalog.ts:102
      ▼
  saveCatalogCache()  ── ONE IDB row (catalog_cache/"main") + localStorage boot mirror
    lib/idb.ts:745–752
      ▼
  hydrateCatalog()    ── local cache first, remote refresh, version-hash compare
    store/usePosStore.ts:3084–3216
      ▼
  zustand state: products/barcodes/barcodeIndex maps in RAM (whole catalog)

Sales (write path)
  checkout ──enqueueSync()──▶ IDB `sync_queue` (status index)     lib/idb.ts:465
  every 15s tick ──processSyncQueue()                            hooks/useBackgroundSync.ts:51
      │ getSyncsByStatus("PENDING") ← materializes WHOLE queue    services/syncService.ts:81
      ▼ batches of 50, ≤20 rounds/run
  mirrorSyncBatch(): sequential per-event handlers               lib/syncMirror.ts:1903
      ├─ sync_events inbox upsert (idempotent sync_id)
      ├─ sales ledger: variants lookup → products lookup → existing check
      │   → insert invoice → ensure children (items, payments)
      ├─ debt / loyalty / expense / cash-movement mirrors
      ├─ stock: record_inventory_movement RPC PER LINE            lib/syncMirror.ts:1811
      ├─ receiving / shortage / print-job mirrors
      └─ SHIFT_CLOSED: completeness probe + recompute + finalize   lib/syncMirror.ts:1437,1506
```

---

## 3. Scenario A — Store grows to 50,000 products

### What happens today

1. **Fetch:** `fetchAllRows` pages 1000 rows at a time (`lib/supabase.ts:79`). Products alone = **50 sequential requests**; variants similar. Total ≈ 100+ round trips inside `fetchCatalogSnapshot`. Each page uses `order(name)+range()` — there is **no `(store_id, name)` index on `products`** (only `idx_products_store_id`, migration 006:46), so Postgres re-sorts the tenant's whole product set per page. First hydration on a fresh device: tens of seconds to minutes on store Wi-Fi.
2. **Hash:** `catalogVersionOf` SHA-256s the entire serialized catalog in pure JS on the main thread (`lib/clientCatalog.ts:102–104, 269`). At an estimated 40–90 MB of JSON this is a **multi-second UI freeze**, plus 2× transient memory (string + parsed objects).
3. **Persist:** `saveCatalogCache` writes the whole snapshot as **a single structured clone into one IDB row** (`lib/idb.ts:745–752`). Every subsequent price edit re-downloads and rewrites the entire blob. IndexedDB itself will not "crash" — modern quotas are GB-scale — but:
   - The **localStorage boot mirror will throw QuotaExceededError** (~5 MB). It's swallowed silently (`lib/idb.ts:735–742`), so after app restart the synchronous boot path (`loadCatalogBootCacheSync`) returns null/stale → empty grid until the async IDB read lands. Note: at the **current ~6.6k SKUs the JSON is likely already brushing 5 MB** — this may be failing intermittently today.
   - Without `navigator.storage.persist()` the origin stays "best-effort": Chrome **can evict `pos_local_db` under disk pressure**, destroying the offline queue and catalog with no warning. For an offline-first POS this is the single most dangerous property in the codebase.
4. **Runtime:** whole `ProductMap`+`BarcodeMap`+`BarcodeIndex` live in zustand (150–400 MB JS heap at 50k). `SmartSearchModal` scans all entries and Arabic-normalizes every name per debounced keystroke (`components/pos/SmartSearchModal.tsx:31–66`; its own comment says "~6,600 products").
5. **Invalidation:** any field added to the snapshot shape changes the JSON → hash mismatch → **every device fully re-downloads after each deploy that touches the shape**.

### Will it crash? 
IndexedDB: no crash, but multi-second blocking writes and eviction risk. Memory: OOM-adjacent on 4 GB Android/Electron terminals. UX: cold start regresses from ~1 s to 30 s+.

### Recommendations (long-term)

| Horizon | Action |
|---|---|
| Now | Call `navigator.storage.persist()` at register login; add a storage-health probe (`estimate()`) surfaced in the admin hub. |
| Now | Guard `writeBootCacheSync`: skip persisting boot mirrors > ~1 MB; treat them as best-effort only. |
| Weeks | Re-key `catalog_cache` to **per-product rows** (object store keyed by product id + category/barcode stores). Upserts become incremental; no more monolithic clones. |
| Weeks | Replace full-snapshot hashing with a **watermark protocol**: server-side `catalog_delta(store_id, since updated_at)` returning only changed rows (requires `updated_at` trigger on products/variants/categories + index on `(store_id, updated_at)`). Devices converge incrementally; deploys stop triggering fleet-wide refetches. |
| Weeks | Keyset pagination (`order store_id,name,id … where (name,id) > (last)`) or a Postgres function returning the catalog as one streamed JSON aggregate — kills the per-page sort. |
| Months | Move search matching into a **pre-built normalized-name index store** (updated incrementally) or a Web Worker; keep the main thread free. |
| Months | If >20k SKU tenants become a target segment, migrate local persistence to **SQLite/WASM over OPFS** (transactional, indexed, no per-key limits). IndexedDB row-per-product remains fine to ~10–15k SKUs. |

---

## 4. Scenario B — 3 days offline, 10,000 queued invoices, then reconnect

### Queue growth while offline
- `SYNCED` records are never removed (`markSyncCompleted` flips status, `clearSyncQueue` has **no caller in the pipeline**, `lib/idb.ts:533–548, 667`). After years of use the queue *is* the invoice archive: `listInvoices()` does `db.getAll(STORE)` and sorts in JS (`lib/idb.ts:680–693`). 10k invoices ≈ 20–80 MB of IDB before the reconnect even starts.
- Every return flow runs `isInvoiceReturned()` = full `getAll(STORE)` scan (`lib/idb.ts:654–664`). `buildPriceMemoryCache` replays the entire invoice list too (`lib/idb.ts:969`).

### The drain itself
Per 15 s tick (`hooks/useBackgroundSync.ts:9`):
1. Badge refresh calls `getSyncsByStatus("PENDING")` — **deserializes every pending payload** (with items arrays) into JS, filters tenant in JS (`useBackgroundSync.ts:11–21`).
2. `processSyncQueue` runs ≤20 rounds × 50 events (`services/syncService.ts:13–20`); **each round re-fetches the entire PENDING set again** (`syncService.ts:81`). That's 21 full materializations per tick — at 10k × ~4 KB payloads this is ~100 MB of GC churn per minute, sustained for hours. On 4 GB registers: jank at best, renderer OOM at worst.
3. Mirroring is **strictly serial per event**, and each invoice issues roughly: variant batch lookup + product-cost lookup + existing-invoice probe + insert + items/payments probes + inserts + debt lookups + loyalty lookups + **one stock RPC per line** + risk signals ⇒ **~10–15 HTTPS round trips per invoice** (`lib/syncMirror.ts:1976–2037`). 
   - **Math:** 10,000 invoices × ~12 requests ≈ 120,000 requests. At 40 ms each ≈ **80 minutes of pure network time** — if nothing fails and the tab stays foregrounded. Background-tab throttling (timers ≥1/min) stretches this to many hours or indefinitely; closing the register stops it entirely (S14).
   - The browser will not "crash the server," but one device sustaining ~2–3 req/s against PostgREST for hours — multiplied by several branches reconnecting Monday 8 AM — is a self-inflicted load spike: connection-pool saturation, statement timeouts, and egress cost.
4. **SHIFT_CLOSED starvation:** closes defer until their shift's invoices are mirrored (`shift_ledger_incomplete`, `syncMirror.ts:1519–1520`). Each retry re-runs `assessShiftLedgerCompleteness`, which selects **every** ledger event ≤ closeTime for the store (no LIMIT, no composite index) and filters `payload->>shiftId` in the browser (`syncMirror.ts:1448–1460`). During a backlog drain, closed shifts sit in early batches and burn heavy queries every round for hours. Worse: PostgREST caps responses at `max-rows` — **silent truncation makes the completeness set wrong**, which can prematurely freeze a partial Z-report.
5. **Quarantine storm:** `MAX_SERVER_ATTEMPTS = 8` counts any mirror failure where the server *responded* (`syncService.ts:117–129`). Under reconnect load, transient failures — Postgres deadlocks between concurrent drains on hot products (`record_inventory_movement` takes `FOR UPDATE` per line, `db/migrations/024:178–181`), statement timeouts, 5xx from Supabase — are all "responses." Eight of them and a **perfectly valid sale is quarantined** at peak stress. Network failures correctly don't count, but server-transient failures do; that distinction is too coarse.
6. Ack bookkeeping is serial per id: `markSyncCompleted`/`markSyncAttemptFailed` do get+put per record (`lib/idb.ts:533–548, 624–638`) — 100 sequential ops per full batch instead of one transaction.

### Server-side storage
Every invoice payload is stored **three times**: locally until purge, in `sync_events.payload` **forever**, and again in `sales_invoices.payload` **forever** (`lib/syncMirror.ts:1950–1956, 464`). `sync_events` also carries single-column indexes only (002:22–24, 006:56, 010:39–40) so any store-scoped query over it degrades year over year.

### Will anything crash?
- Browser: memory pressure from repeated full-queue materialization is the crash vector, not IndexedDB.
- Server: no hard crash, but throttling/timeouts/deadlocks → failed rounds → longer drains → more overlap → more contention (positive feedback loop).

### Recommendations

| Priority | Action | Effect |
|---|---|---|
| **P0** | **Server-side bulk-mirror RPC**: `mirror_events(p_store_id, p_events jsonb)` processing a whole batch transactionally in PL/pgSQL (reuse existing handler logic). One round trip per 50–200 events instead of ~600. | 10k-invoice drain: from ~120k requests to ~50–200; hours → minutes |
| P0 | `navigator.storage.persist()` + purge `SYNCED` rows older than N days (keep receipt-reprint window locally; older history reads go to `sales_invoices` via RPC). | Bounded IDB; removes S4 |
| P1 | Iterate the queue with an **IDB cursor** over the status index (`openCursor(limit)`) instead of `getAllFromIndex`; write acks in one transaction. | Removes the 21× full-deserialization pattern (S3) |
| P1 | Split quarantine aging: count only **deterministic** errors (validation, FK/P0002, 22023); reset counters on 40P01 deadlock / timeout / 5xx, with jittered backoff. | Prevents quarantine storms (S6) |
| P1 | Composite index `(store_id, action_type, client_created_at)` on `sync_events`; replace the completeness probe with a SQL `EXISTS`-per-expected-event check (or maintain `shift_event_counts`); move `computeShiftLedgerSums` aggregation into SQL `SUM()`s. | Fixes S7; unblocks shift closes during drains |
| P2 | Chronological drain order: add a monotonic `seq` (or order by `client_created_at`, tiebreak `sync_id`) instead of UUID keyPath order; keeps supplier-create-before-invoice structurally true rather than via prepass hack. | Simpler, safer ordering |
| P2 | Move draining out of the renderer: Electron main process / Service Worker `Background Sync` (where available) so closing the UI doesn't halt the flush. | Fixes S14 |
| P2 | Retention: monthly partitions (`pg_partman`) for `sync_events` / `inventory_movements` / `sales_invoices` on event time; drop or slim `sales_invoices.payload` once items/payments verified (keep a digest). | Controls S10 bloat |
| P3 | Extend `tests/stress.stress.ts` with a 10k-event soak (real timing) and a two-device contention test exercising deadlock paths. | Regression guard |

---

## 5. Scenario C — Reporting queries & SQL indexes

### Already good
- `sales_invoices (store_id, completed_at DESC)`, cashier/branch/payment composites (021:40–48, 025:6).
- Ledger reporting is **server-side SQL with pagination + aggregates** (`list_sales_ledger`, `sales_ledger_summary`) — the right model; long ranges never leave Postgres.
- Items: `(store_id, product_id)`, partial `(store_id, barcode)`; payments: `(store_id, method)`; movements: `(store_id, occurred_at DESC)`, unique idempotency key; customers/categories name lookups (055).

### Gaps found (evidence-based)

| Missing index | Hurts | Evidence |
|---|---|---|
| `sales_invoices (store_id, shift_id)` | `computeShiftLedgerSums` `.eq(store).eq(shift)` scans the tenant's invoices **during every Z-report finalize** — i.e., precisely during bulk sync crunch | query at `syncMirror.ts:1380`; no such index exists in migrations 001–075 |
| `expenses (store_id, shift_id)` | same query pattern for shift expenses | `syncMirror.ts:1382`; expenses only have `(store_id)` (006:71), `(created_at)` (005:19), `(store_id, created_at)` (029:8) |
| `customer_transactions (store_id, shift_id)` partial on `type='SETTLEMENT'` | settlement sums per shift | `syncMirror.ts:1384`; current composite is `(store_id, customer_id, type)` (055:34) |
| `sync_events (store_id, action_type, client_created_at)` | shift-completeness probe + audit queries | `syncMirror.ts:1448–1453`; only single-column indexes exist (002:22–24, 006:56, 010:39–40, 039:12–15) |
| `products (store_id, name)` | catalog pagination orders by name → per-page sort server-side | `supabase.ts:83`; only `idx_products_store_id` (006:46) |
| pg_trgm GIN on `sales_invoices (cashier_name, customer_name)` (+ expression on `sync_id::text`) | `ILIKE '%…%'` filters fall back to seq scan whenever search text is provided | `037:113–118` |

Suggested DDL sketch (additive, safe):

```sql
CREATE INDEX CONCURRENTLY idx_sales_invoices_store_shift
  ON sales_invoices (store_id, shift_id);
CREATE INDEX CONCURRENTLY idx_expenses_store_shift
  ON expenses (store_id, shift_id);
CREATE INDEX CONCURRENTLY idx_sync_events_store_action_client
  ON sync_events (store_id, action_type, client_created_at);
CREATE INDEX CONCURRENTLY idx_products_store_name
  ON products (store_id, name);
```

### Structural (12-month horizon)
1. **Partitioning:** `sales_invoices`, `inventory_movements`, `sync_events` monthly-partitioned on event time once a tenant approaches tens of millions of rows; BRIN on `completed_at` for append-only scans.
2. **Kill the dual barcode reality.** 062 dropped `product_barcodes`; 070 restored it "for the manifest" (`070:62–112`), yet the stock RPC still validates barcodes against it (`024:188–196`) while the client mirror writes Quick-Add barcodes only to `product_variants` (`syncMirror.ts:995–1001`). Result: those SKUs' stock movements raise `22023 barcode_not_owned_by_product` and are **silently skipped** (`syncMirror.ts:1832–1843`). Either recreate `record_inventory_movement` against `product_variants` (preferred — one source of truth) or make the mirror write both. This bug compounds with scale because bulk sync is when it fires en masse.
3. **Lock-order discipline:** process receiving/invoice lines in stable `product_id` order and add client-side retry-on-`40P01` to eliminate cross-terminal deadlocks during parallel drains.
4. **Trust model note:** ledger access is grant-scoped with permissive RLS (`USING (true)`, 074:46–50) and the anon key in the browser. Fine for a trusted LAN deployment; revisit row-level tenant enforcement before multi-tenant scale-out, since any leaked anon key can write cross-store ledgers today.

---

## 6. What's Already Right (keep these)

- Idempotency everywhere: `sync_id` inbox, deterministic ids, movement idempotency keys — retries can't double-post.
- Poison **quarantine instead of deletion** — a lost sale is impossible by construction.
- SHIFT_CLOSED deferral concept (ledger-complete-before-freeze) is correct; only its implementation scales badly (S7).
- Server-side reporting RPCs with pagination/aggregation — the right boundary.
- Debounced persist writes (`lib/persistStorage.ts`) already solved the stringify-per-keystroke problem.
- Existing stress suite (`tests/stress.stress.ts`) covers batch caps/races — extend rather than rebuild.

## 7. Suggested Roadmap

**Week 1 (no-schema-change quick wins)**
1. `navigator.storage.persist()` + storage-health indicator.
2. Size-guard the localStorage boot mirrors.
3. Cursor-based PENDING iteration + transactional acks in `syncService`.
4. Purge `SYNCED` rows past retention window.
5. Add the five missing indexes above (CONCURRENTLY).

**Weeks 2–6 (structural)**
6. Bulk `mirror_events` RPC; switch `mirrorSyncBatch` to one call per batch.
7. Delta-catalog watermark protocol; row-per-product IDB cache; drop full-catalog hashing.
8. Recreate `record_inventory_movement` on `product_variants`; retire `product_barcodes`.
9. Transient-vs-deterministic error classification for quarantine aging.

**Months 2–4 (scale-out)**
10. Table partitioning + payload retention policy.
11. Search index store / worker; evaluate SQLite-WASM for >15k SKU tenants.
12. Out-of-renderer sync engine (Electron main / SW background sync).
13. Observability: queue depth, drain duration, failure-class counters surfaced in Admin Hub; alert on poison growth.

---
*Audit performed read-only against working tree @ C:\Projects\pos. All file:line references correspond to the tree as of 2026-08-24.*
