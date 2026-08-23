-- 073_customer_ledger_atomic.sql
-- Multi-terminal concurrency hardening for the customer debt ledger (ذمم).
--
-- Two race conditions existed on the customers.balance path:
--
--   1. Lost update: recordDebtLedger (/api/sync) and the client
--      createCustomerTransaction both read customers.balance, computed
--      balance_after in JS, then wrote the absolute value back. Two terminals
--      charging/settling the same customer at the same time wrote from the
--      same stale read — one movement silently vanished from the balance
--      while its transaction row survived.
--
--   2. Partial-failure drift: the sync mirror inserted the transaction row
--      first and updated the balance second; a failure (or a retry after a
--      lost ack) between the two steps left books that disagreed, and the
--      retry dedupe relied on an ILIKE scan of free-text descriptions.
--
-- apply_customer_ledger_event() closes both: it serializes concurrent
-- callers on a `FOR UPDATE` row lock, applies the delta relative to the
-- locked read (never an absolute overwrite), appends the ledger row and
-- rolls the balance forward in a single atomic statement, and dedupes
-- retries via a unique idempotency key.

ALTER TABLE customer_transactions
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_tx_idempotency
  ON customer_transactions (store_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Backfill sync-mirrored rows so events already queued before this deploy
-- stay idempotent across the upgrade boundary. The legacy mirror embedded a
-- `sync:<uuid>` marker in every mirrored description.
UPDATE customer_transactions
SET idempotency_key = 'sync:' || sub.marker
FROM (
  SELECT
    id,
    (regexp_match(description, 'sync:([0-9a-fA-F-]{36})'))[1] AS marker
  FROM customer_transactions
  WHERE description LIKE '%sync:%'
    AND regexp_match(description, 'sync:([0-9a-fA-F-]{36})') IS NOT NULL
) AS sub
WHERE customer_transactions.id = sub.id
  AND customer_transactions.idempotency_key IS NULL;

CREATE OR REPLACE FUNCTION apply_customer_ledger_event(
  p_store_id UUID,
  p_customer_id UUID,
  p_type TEXT,
  p_amount DECIMAL,
  p_description TEXT DEFAULT '',
  p_shift_id UUID DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL,
  p_occurred_at TIMESTAMPTZ DEFAULT now()
)
RETURNS TABLE (
  transaction_id UUID,
  applied_amount DECIMAL(10,2),
  balance_after DECIMAL(10,2)
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_existing RECORD;
  v_before DECIMAL(10,2);
  v_applied DECIMAL(10,2);
  v_after DECIMAL(10,2);
  v_tx_id UUID;
  v_key TEXT := NULLIF(BTRIM(COALESCE(p_idempotency_key, '')), '');
BEGIN
  IF p_store_id IS NULL OR p_customer_id IS NULL THEN
    RAISE EXCEPTION 'store_and_customer_required' USING ERRCODE = '22023';
  END IF;
  IF p_type NOT IN ('SALE_DEBT', 'SETTLEMENT') THEN
    RAISE EXCEPTION 'invalid_transaction_type' USING ERRCODE = '22023';
  END IF;
  IF v_key IS NOT NULL AND LENGTH(v_key) > 180 THEN
    RAISE EXCEPTION 'invalid_idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF p_amount IS NULL OR p_amount = 'NaN'::numeric THEN
    RAISE EXCEPTION 'invalid_amount' USING ERRCODE = '22023';
  END IF;

  -- Idempotent replay: a retried queue drain or double-tap lands here and
  -- returns the original ledger effect instead of re-applying it.
  IF v_key IS NOT NULL THEN
    SELECT t.id, t.amount, t.balance_after INTO v_existing
    FROM customer_transactions t
    WHERE t.store_id = p_store_id
      AND t.customer_id = p_customer_id
      AND t.idempotency_key = v_key;
    IF FOUND THEN
      RETURN QUERY SELECT v_existing.id, v_existing.amount, v_existing.balance_after;
      RETURN;
    END IF;
  END IF;

  -- Serialize concurrent terminals on the customer's row; everything below
  -- computes from this locked read.
  SELECT balance INTO v_before
  FROM customers
  WHERE id = p_customer_id AND store_id = p_store_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'customer_not_found' USING ERRCODE = 'P0002';
  END IF;

  IF p_type = 'SETTLEMENT' THEN
    -- Credits never drive the balance negative: settle only up to what the
    -- customer actually owes.
    v_applied := LEAST(ROUND(p_amount, 2), GREATEST(v_before, 0));
    v_after := ROUND(v_before - v_applied, 2);
    IF v_applied <= 0 THEN
      RETURN QUERY SELECT NULL::UUID, 0::DECIMAL(10,2), v_before;
      RETURN;
    END IF;
  ELSE
    -- SALE_DEBT debits (returns carry a negative amount and lower the balance).
    v_applied := ROUND(p_amount, 2);
    IF v_applied = 0 THEN
      RETURN QUERY SELECT NULL::UUID, 0::DECIMAL(10,2), v_before;
      RETURN;
    END IF;
    v_after := ROUND(v_before + v_applied, 2);
  END IF;

  INSERT INTO customer_transactions (
    customer_id, store_id, type, amount, balance_after,
    description, shift_id, created_at, idempotency_key
  )
  VALUES (
    p_customer_id, p_store_id, p_type, v_applied, v_after,
    COALESCE(NULLIF(BTRIM(COALESCE(p_description, '')), ''), ''),
    p_shift_id, COALESCE(p_occurred_at, now()), v_key
  )
  ON CONFLICT (store_id, idempotency_key) WHERE idempotency_key IS NOT NULL
  DO NOTHING
  RETURNING id INTO v_tx_id;

  IF v_tx_id IS NULL THEN
    -- A racing caller with the same key inserted first (possible when the
    -- pre-check above ran before their commit). Report their row untouched.
    SELECT t.id, t.amount, t.balance_after INTO v_existing
    FROM customer_transactions t
    WHERE t.store_id = p_store_id
      AND t.customer_id = p_customer_id
      AND t.idempotency_key = v_key;
    RETURN QUERY SELECT v_existing.id, v_existing.amount, v_existing.balance_after;
    RETURN;
  END IF;

  UPDATE customers
  SET balance = v_after
  WHERE id = p_customer_id AND store_id = p_store_id;

  RETURN QUERY SELECT v_tx_id, v_applied, v_after;
END;
$$;

GRANT EXECUTE ON FUNCTION apply_customer_ledger_event(
  UUID, UUID, TEXT, DECIMAL, TEXT, UUID, TEXT, TIMESTAMPTZ
) TO anon, authenticated;
