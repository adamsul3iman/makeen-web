-- 096_sales_invoice_number.sql
-- Terminal-scoped human-readable receipt number (e.g. T1-0007).
--
-- The register mints a sequential number per terminal at checkout
-- (offline-first) and carries it on the INVOICE_CREATED sync payload. This
-- migration adds the column so the mirror can persist the SAME number the
-- receipt printed, and surfaces it in the ledger listing for reports.
--
-- Numbering is per-terminal with a unique prefix, so across 3 cashier
-- machines the numbers are collision-free without a centralized sequence.

ALTER TABLE sales_invoices
  ADD COLUMN IF NOT EXISTS invoice_number TEXT;

CREATE INDEX IF NOT EXISTS idx_sales_invoices_store_invoice_number
  ON sales_invoices (store_id, invoice_number);

-- Surface invoice_number in the ledger listing. `CREATE OR REPLACE` cannot
-- change the return type, so drop first (no dependent objects reference it).
DROP FUNCTION IF EXISTS list_sales_ledger(uuid, timestamptz, timestamptz, uuid, uuid, uuid, text, text, text, integer, integer);
CREATE OR REPLACE FUNCTION list_sales_ledger(
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
  invoice_number text,
  total numeric,
  cash_amount numeric,
  visa_amount numeric,
  cliq_amount numeric,
  debt_amount numeric,
  item_count numeric,
  gross_profit numeric,
  is_return boolean,
  is_cancellation boolean,
  original_invoice_sync_id uuid,
  completed_at timestamptz,
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
    invoice.invoice_number,
    invoice.total,
    invoice.cash_amount,
    invoice.visa_amount,
    invoice.cliq_amount,
    invoice.debt_amount,
    invoice.item_count,
    invoice.gross_profit,
    invoice.is_return,
    invoice.is_cancellation,
    invoice.original_invoice_sync_id,
    invoice.completed_at,
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
      OR invoice.invoice_number ILIKE '%' || BTRIM(p_search) || '%'
      OR invoice.cashier_name ILIKE '%' || BTRIM(p_search) || '%'
      OR invoice.customer_name ILIKE '%' || BTRIM(p_search) || '%'
      OR invoice.customer_phone ILIKE '%' || BTRIM(p_search) || '%'
    )
  ORDER BY invoice.completed_at DESC, invoice.id DESC
  LIMIT LEAST(GREATEST(p_limit, 1), 100)
  OFFSET GREATEST(p_offset, 0);
$$;

GRANT EXECUTE ON FUNCTION list_sales_ledger(
  uuid, timestamptz, timestamptz, uuid, uuid, uuid, text, text, text, integer, integer
) TO anon, authenticated;
