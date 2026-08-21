-- 057_shortage_flags.sql
-- Phase 5 — Shortage Radar: durable cashier-flagged stockouts.
--
-- The register raises a SHORTAGE_FLAGGED event (offline-first, via the sync
-- pipeline) even when system stock says otherwise. This table is the durable
-- radar the admin dashboard reads, merging cashier reports with automatic
-- reorder-level rows. `source_event_id` is the idempotency key for the sync
-- mirror (replays never duplicate); admin-side POSTs carry no event and stay
-- NULL (Postgres allows many NULLs under a UNIQUE constraint).

SET search_path = public, extensions;

CREATE TABLE IF NOT EXISTS shortage_flags (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id        UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  product_id      TEXT NOT NULL,
  product_name    TEXT NOT NULL DEFAULT '',
  current_stock   NUMERIC(14,3) NOT NULL DEFAULT 0,
  reason          TEXT,
  cashier_id      UUID REFERENCES cashiers(id) ON DELETE SET NULL,
  cashier_name    TEXT NOT NULL DEFAULT '',
  branch_id       UUID REFERENCES branches(id) ON DELETE SET NULL,
  terminal_id     UUID REFERENCES terminals(id) ON DELETE SET NULL,
  source_event_id UUID REFERENCES sync_events(sync_id) ON DELETE RESTRICT,
  resolved        BOOLEAN NOT NULL DEFAULT FALSE,
  resolved_by     TEXT,
  resolved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_event_id),
  CHECK (current_stock >= 0)
);

CREATE INDEX IF NOT EXISTS idx_shortage_flags_store_created
  ON shortage_flags (store_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shortage_flags_store_open
  ON shortage_flags (store_id, resolved, created_at DESC);
