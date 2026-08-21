-- 008_loyalty_points.sql
-- Smart marketing / customer loyalty (v1).
--
-- Phone-based points ledger, fully additive and store-scoped like every other
-- operational table:
--   * customers.loyalty_points         running points balance
--   * stores.loyalty_enabled           per-tenant on/off switch (default ON)
--   * stores.points_per_spend          currency spent to earn 1 point (1.00)
--   * stores.point_value               currency value of 1 point on redeem (0.01)
--   * loyalty_events                   chronological points ledger
--
-- Earning happens server-side exactly once per invoice (see app/api/sync and
-- lib/loyalty.ts), keyed by the sync_id idempotency marker, so offline POS
-- invoices award points when replayed without double-counting. Redeem converts
-- points into a credit against the customer's ذمم balance (existing ledger).

ALTER TABLE customers ADD COLUMN IF NOT EXISTS loyalty_points INTEGER NOT NULL DEFAULT 0;

ALTER TABLE stores ADD COLUMN IF NOT EXISTS loyalty_enabled BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS points_per_spend NUMERIC(10,2) NOT NULL DEFAULT 1.00;
ALTER TABLE stores ADD COLUMN IF NOT EXISTS point_value NUMERIC(10,2) NOT NULL DEFAULT 0.01;

CREATE TABLE IF NOT EXISTS loyalty_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id      UUID NOT NULL REFERENCES stores(id),
  customer_id   UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  type          VARCHAR(20) NOT NULL CHECK (type IN ('EARN', 'REDEEM', 'ADJUST')),
  points        INTEGER NOT NULL CHECK (points <> 0),
  balance_after INTEGER NOT NULL,
  reference     TEXT NOT NULL DEFAULT '',
  description   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_loyalty_events_customer ON loyalty_events (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_loyalty_events_store ON loyalty_events (store_id);
