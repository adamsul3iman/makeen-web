-- 010_branches_terminals.sql
-- Multi-branch / multi-terminal (cash register) architecture.
--
-- A store (متجر) can now operate several physical branches (فروع), and each
-- branch can run multiple POS terminals (كاشيرات) with independent cash
-- drawers and shifts. Every operational record flows through the sync_events
-- ledger (invoices = sales, SHIFT_OPENED/SHIFT_CLOSED = shifts), so the two
-- new id columns are attached there — the single sink for both sales and
-- shifts in this event-sourced architecture.
--
-- Backward compatibility: the columns are NULLABLE so older offline devices
-- that do not yet stamp branch/terminal keep syncing untouched. Auto-seeding
-- creates a "الفرع الرئيسي" + "الكاشير الرئيسي" for EVERY existing store and
-- backfills all of its historical events to those ids — zero broken relations,
-- zero data loss. New deployments keep working because every store now has at
-- least one branch and one terminal from the start.

CREATE TABLE IF NOT EXISTS branches (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id   UUID NOT NULL REFERENCES stores(id),
  name       TEXT NOT NULL CHECK (name <> ''),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS terminals (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id  UUID NOT NULL REFERENCES branches(id),
  name       TEXT NOT NULL CHECK (name <> ''),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_branches_store_name ON branches (store_id, name);
CREATE UNIQUE INDEX IF NOT EXISTS uq_terminals_branch_name ON terminals (branch_id, name);
CREATE INDEX IF NOT EXISTS idx_branches_store_id ON branches (store_id);
CREATE INDEX IF NOT EXISTS idx_terminals_branch_id ON terminals (branch_id);

ALTER TABLE sync_events ADD COLUMN IF NOT EXISTS branch_id UUID REFERENCES branches(id);
ALTER TABLE sync_events ADD COLUMN IF NOT EXISTS terminal_id UUID REFERENCES terminals(id);
CREATE INDEX IF NOT EXISTS idx_sync_events_branch_id ON sync_events (branch_id);
CREATE INDEX IF NOT EXISTS idx_sync_events_terminal_id ON sync_events (terminal_id);

DO $$
DECLARE
  s RECORD;
  b UUID;
  t UUID;
BEGIN
  FOR s IN SELECT id FROM stores LOOP
    SELECT id INTO b FROM branches WHERE store_id = s.id AND name = 'الفرع الرئيسي' LIMIT 1;
    IF b IS NULL THEN
      INSERT INTO branches (store_id, name) VALUES (s.id, 'الفرع الرئيسي') RETURNING id INTO b;
    END IF;

    SELECT id INTO t FROM terminals WHERE branch_id = b AND name = 'الكاشير الرئيسي' LIMIT 1;
    IF t IS NULL THEN
      INSERT INTO terminals (branch_id, name) VALUES (b, 'الكاشير الرئيسي') RETURNING id INTO t;
    END IF;

    -- Backfill every historical sale/shift event to the main branch/register.
    UPDATE sync_events
       SET branch_id = b, terminal_id = t
     WHERE store_id = s.id
       AND (branch_id IS NULL OR terminal_id IS NULL);
  END LOOP;
END $$;
