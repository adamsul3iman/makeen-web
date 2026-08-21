-- 051_istd_submissions.sql
-- JoFotara (ISTD) e-invoicing lifecycle.
--
-- 1) sales_invoices gains the authoritative ISTD result columns: the UUID and
--    QR returned by the ISTD clearance endpoint are persisted here (and on the
--    sync queue record) so the receipt can reprint the OFFICIAL QR and the
--    sales ledger always shows whether the invoice was cleared.
--
-- 2) istd_submissions is the SINGLE-WRITER claim table. The checkout fast-path
--    and the background sync mirror may race to push the same invoice; the
--    primary key on sync_id lets exactly one worker perform the actual ISTD
--    submission and store its result. The other worker only reads the result.
--    The claim row is created BEFORE the sales_invoices mirror row exists, so
--    sync_id deliberately has no FK to sales_invoices (only to the store).
--
-- 3) list_sales_ledger returns the new columns so the admin ledger can surface
--    clearance status.

ALTER TABLE sales_invoices
  ADD COLUMN IF NOT EXISTS istd_uuid TEXT,
  ADD COLUMN IF NOT EXISTS istd_qr TEXT,
  ADD COLUMN IF NOT EXISTS istd_submitted_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS istd_submissions (
  sync_id          UUID PRIMARY KEY,
  store_id         UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  status           VARCHAR(16) NOT NULL DEFAULT 'PENDING'
                   CHECK (status IN ('PENDING', 'SUBMITTED', 'FAILED')),
  istd_uuid        TEXT,
  istd_qr          TEXT,
  error            TEXT,
  last_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_istd_submissions_store_pending
  ON istd_submissions (store_id, status, last_attempt_at);

ALTER TABLE istd_submissions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE istd_submissions FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE istd_submissions TO service_role;

DROP FUNCTION IF EXISTS list_sales_ledger(uuid, timestamptz, timestamptz, uuid, uuid, uuid, text, text, text, integer, integer);
CREATE FUNCTION list_sales_ledger(
  p_store_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_branch_id uuid DEFAULT NULL,
  p_terminal_id uuid DEFAULT NULL,
  p_cashier_id uuid DEFAULT NULL,
  p_payment_method text DEFAULT NULL,
  p_kind text DEFAULT 'ALL',
  p_search text DEFAULT NULL,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (
  id uuid,
  sync_id uuid,
  branch_id uuid,
  branch_name text,
  terminal_id uuid,
  terminal_name text,
  shift_id uuid,
  cashier_id uuid,
  cashier_name text,
  customer_id uuid,
  customer_name text,
  customer_phone text,
  payment_method varchar,
  subtotal numeric,
  tax numeric,
  discount numeric,
  delivery_fee numeric,
  total numeric,
  cash_amount numeric,
  visa_amount numeric,
  cliq_amount numeric,
  debt_amount numeric,
  item_count numeric,
  gross_profit numeric,
  profit_reliable boolean,
  is_return boolean,
  is_cancellation boolean,
  original_invoice_sync_id uuid,
  completed_at timestamptz,
  istd_uuid text,
  istd_qr text,
  total_count bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
  SELECT
    invoice.id,
    invoice.sync_id,
    invoice.branch_id,
    COALESCE(branch.name, ''),
    invoice.terminal_id,
    COALESCE(terminal.name, ''),
    invoice.shift_id,
    invoice.cashier_id,
    invoice.cashier_name,
    invoice.customer_id,
    invoice.customer_name,
    invoice.customer_phone,
    invoice.payment_method,
    invoice.subtotal,
    invoice.tax,
    invoice.discount,
    invoice.delivery_fee,
    invoice.total,
    invoice.cash_amount,
    invoice.visa_amount,
    invoice.cliq_amount,
    invoice.debt_amount,
    invoice.item_count,
    invoice.gross_profit,
    NOT EXISTS (
      SELECT 1
      FROM sales_invoice_items item
      WHERE item.invoice_id = invoice.id
        AND item.qty <> 0
        AND item.cost_price <= 0
    ),
    invoice.is_return,
    invoice.is_cancellation,
    invoice.original_invoice_sync_id,
    invoice.completed_at,
    invoice.istd_uuid,
    invoice.istd_qr,
    COUNT(*) OVER () AS total_count
  FROM sales_invoices invoice
  LEFT JOIN branches branch ON branch.id = invoice.branch_id
  LEFT JOIN terminals terminal ON terminal.id = invoice.terminal_id
  WHERE invoice.store_id = p_store_id
    AND invoice.completed_at >= p_from
    AND invoice.completed_at <= p_to
    AND (p_branch_id IS NULL OR invoice.branch_id = p_branch_id)
    AND (p_terminal_id IS NULL OR invoice.terminal_id = p_terminal_id)
    AND (p_cashier_id IS NULL OR invoice.cashier_id = p_cashier_id)
    AND (p_payment_method IS NULL OR invoice.payment_method = p_payment_method)
    AND (
      COALESCE(p_kind, 'ALL') = 'ALL'
      OR (p_kind = 'SALE' AND invoice.total >= 0 AND NOT invoice.is_return)
      OR (p_kind = 'RETURN' AND (invoice.total < 0 OR invoice.is_return))
    )
    AND (
      NULLIF(BTRIM(p_search), '') IS NULL
      OR invoice.sync_id::text ILIKE '%' || BTRIM(p_search) || '%'
      OR invoice.cashier_name ILIKE '%' || BTRIM(p_search) || '%'
      OR invoice.customer_name ILIKE '%' || BTRIM(p_search) || '%'
      OR invoice.customer_phone ILIKE '%' || BTRIM(p_search) || '%'
    )
  ORDER BY invoice.completed_at DESC, invoice.id DESC
  LIMIT LEAST(GREATEST(p_limit, 1), 100)
  OFFSET GREATEST(p_offset, 0);
$$;
