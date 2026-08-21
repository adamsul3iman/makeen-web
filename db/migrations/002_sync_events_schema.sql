-- 002_sync_events_schema.sql
-- Event-sourcing log for the offline POS.
-- Every queued transaction (invoice, shift open/close, debt settlement)
-- is upserted here verbatim so backend workers/triggers can replay the
-- JSON into relational tables with zero data loss.
--
-- Idempotency is guaranteed by the sync_id primary key: the offline POS
-- may retry the same event if the network drops mid-response, and an
-- INSERT ... ON CONFLICT (sync_id) DO NOTHING prevents duplicate sales.

CREATE TABLE sync_events (
    sync_id           UUID PRIMARY KEY,
    action_type       VARCHAR(50) NOT NULL,
    payload           JSONB NOT NULL,
    -- When the server received the event.
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- When the event actually happened on the device (extracted from the
    -- payload: completed_at / openedAt / closeTime).
    client_created_at TIMESTAMPTZ
);

CREATE INDEX idx_sync_events_created_at ON sync_events (created_at);
CREATE INDEX idx_sync_events_action_type ON sync_events (action_type);
CREATE INDEX idx_sync_events_client_created_at ON sync_events (client_created_at);
