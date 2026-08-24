-- ============================================================
-- Migration 082: Parked Orders (الطلبات المفتوحة)
-- ============================================================
-- Shared, cross-device open orders. A parked cart becomes a pos_orders
-- row; it is PURE JSON STORAGE — it never touches inventory or the
-- financial ledger. Only closing an order emits the standard
-- INVOICE_CREATED event through the existing sync mirror, which is the
-- single path that moves stock and money (ledger safety by construction).
--
-- Lifecycle:
--   OPEN      → parked; editable/resumable on any register of the store;
--               partial payments accumulate in `payments` JSONB.
--   CLOSED    → invoice_sync_id set (FK-less link to sync_events.sync_id,
--               mirroring how istd_submissions references invoices).
--   CANCELLED → abandoned; cancel_reason recorded; nothing was ever
--               posted, so no reversal is needed.
--
-- IDEMPOTENT: safe to re-run.
-- ============================================================

BEGIN;

SET search_path = public, extensions;

-- ============================================================
-- STEP 1: pos_orders table
-- ============================================================
CREATE TABLE IF NOT EXISTS pos_orders (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id          UUID NOT NULL REFERENCES stores(id),
  branch_id         UUID REFERENCES branches(id),
  terminal_id       UUID REFERENCES terminals(id),
  -- Terminal-prefixed human number minted locally (e.g. "T2-0014").
  order_number      TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'OPEN'
                    CONSTRAINT pos_orders_status_check
                    CHECK (status IN ('OPEN', 'CLOSED', 'CANCELLED')),
  -- Cart snapshot — same shapes as SaleItem[] / SaleTotals client-side.
  items             JSONB NOT NULL DEFAULT '[]'::jsonb,
  totals            JSONB NOT NULL DEFAULT '{}'::jsonb,
  invoice_discount  JSONB,
  delivery_fee      NUMERIC(12,2) NOT NULL DEFAULT 0,
  customer_id       UUID REFERENCES customers(id),
  customer_name     TEXT,
  customer_phone    TEXT,
  cashier_id        UUID,
  cashier_name      TEXT,
  -- Denormalized terminal/device label for the orders card UI.
  device_name       TEXT,
  -- Partial payments taken while OPEN: [{method, amount, at, note}].
  payments          JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Delivery/B2B account attached when the order was parked.
  b2b_account_id    UUID REFERENCES b2b_accounts(id),
  b2b_markup_pct    NUMERIC(5,2) NOT NULL DEFAULT 0,
  -- Set ONLY when the order closes (sync_events.sync_id of the invoice).
  invoice_sync_id   TEXT,
  cancel_reason     TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at         TIMESTAMPTZ,

  CONSTRAINT pos_orders_closed_needs_invoice
    CHECK (status <> 'CLOSED' OR invoice_sync_id IS NOT NULL),
  CONSTRAINT uq_pos_orders_store_number UNIQUE (store_id, order_number)
);

-- Orders tab queries: newest-first per status for one store.
CREATE INDEX IF NOT EXISTS idx_pos_orders_board
  ON pos_orders (store_id, status, updated_at DESC);
-- Return/lookup by originating invoice.
CREATE INDEX IF NOT EXISTS idx_pos_orders_invoice
  ON pos_orders (store_id, invoice_sync_id) WHERE invoice_sync_id IS NOT NULL;

-- ============================================================
-- STEP 2: updated_at trigger
-- ============================================================
DROP TRIGGER IF EXISTS trg_pos_orders_updated_at ON pos_orders;
CREATE TRIGGER trg_pos_orders_updated_at
  BEFORE UPDATE ON pos_orders
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- ============================================================
-- STEP 3: Grants — registers create/update orders from the browser.
-- DELETE is deliberately withheld: cancellation is a STATUS update, so
-- order history can never be erased (audit posture per migration 076).
-- ============================================================
GRANT SELECT, INSERT, UPDATE ON TABLE pos_orders TO anon, authenticated;

COMMIT;
