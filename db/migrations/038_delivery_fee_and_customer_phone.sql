-- 038_delivery_fee_and_customer_phone.sql
-- Phase 2 checkout additions:
--   * delivery_fee   — optional delivery surcharge recorded on the invoice.
--     It is NOT a line item (no inventory, no stock, no cost) and is added
--     to the invoice total after subtotal/tax/discount are computed.
--   * customer_phone — phone captured with the assigned customer so receipts
--     and reports can show it without a join.
--
-- The `customers`/`customer_id` linking columns already exist since
-- 021_sales_accounting_ledger.sql; this migration only extends the invoice
-- row and surfaces both new columns in the ledger listing + summary RPCs.

ALTER TABLE sales_invoices
  ADD COLUMN IF NOT EXISTS delivery_fee DECIMAL(12,2) NOT NULL DEFAULT 0;

ALTER TABLE sales_invoices
  ADD COLUMN IF NOT EXISTS customer_phone TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_sales_invoices_store_customer
  ON sales_invoices (store_id, customer_id, completed_at DESC);

-- Surface delivery_fee + customer_phone in the ledger listing.
-- `CREATE OR REPLACE` cannot change an existing function's return type, so
-- drop first (no dependent objects reference these RPCs).
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
      OR invoice.cashier_name ILIKE '%' || BTRIM(p_search) || '%'
      OR invoice.customer_name ILIKE '%' || BTRIM(p_search) || '%'
      OR invoice.customer_phone ILIKE '%' || BTRIM(p_search) || '%'
    )
  ORDER BY invoice.completed_at DESC, invoice.id DESC
  LIMIT LEAST(GREATEST(p_limit, 1), 100)
  OFFSET GREATEST(p_offset, 0);
$$;

-- Surface delivery_fee in the ledger summary (revenue with no product cost).
DROP FUNCTION IF EXISTS sales_ledger_summary(uuid, timestamptz, timestamptz, uuid, uuid, uuid, text, text, text);
CREATE OR REPLACE FUNCTION sales_ledger_summary(
  p_store_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_branch_id uuid DEFAULT NULL,
  p_terminal_id uuid DEFAULT NULL,
  p_cashier_id uuid DEFAULT NULL,
  p_payment_method text DEFAULT NULL,
  p_kind text DEFAULT 'ALL',
  p_search text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
  WITH filtered AS (
    SELECT invoice.*
    FROM sales_invoices invoice
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
  ),
  invoice_totals AS (
    SELECT
      COUNT(*)::bigint AS invoice_count,
      COUNT(*) FILTER (WHERE total >= 0 AND NOT is_return)::bigint AS sale_count,
      COUNT(*) FILTER (WHERE total < 0 OR is_return)::bigint AS return_count,
      COALESCE(SUM(total) FILTER (WHERE total >= 0 AND NOT is_return), 0)::numeric AS gross_sales,
      ABS(COALESCE(SUM(total) FILTER (WHERE total < 0 OR is_return), 0))::numeric AS returns,
      COALESCE(SUM(total), 0)::numeric AS net_sales,
      COALESCE(SUM(subtotal), 0)::numeric AS subtotal,
      COALESCE(SUM(tax), 0)::numeric AS tax,
      COALESCE(SUM(discount), 0)::numeric AS discounts,
      COALESCE(SUM(delivery_fee), 0)::numeric AS delivery_fee,
      COALESCE(SUM(gross_profit), 0)::numeric AS gross_profit,
      COALESCE(SUM(cash_amount), 0)::numeric AS cash,
      COALESCE(SUM(visa_amount), 0)::numeric AS visa,
      COALESCE(SUM(cliq_amount), 0)::numeric AS cliq,
      COALESCE(SUM(debt_amount), 0)::numeric AS debt,
      COALESCE(SUM(item_count), 0)::numeric AS item_count
    FROM filtered
  ),
  tax_groups AS (
    SELECT
      item.tax_percent,
      item.tax_included,
      COUNT(*)::bigint AS line_count,
      COALESCE(SUM(item.qty), 0)::numeric AS quantity,
      COALESCE(SUM(item.net_total), 0)::numeric AS net_sales,
      COALESCE(SUM(item.tax_amount), 0)::numeric AS tax,
      COALESCE(SUM(item.line_total), 0)::numeric AS gross_sales,
      COALESCE(SUM(item.cost_total), 0)::numeric AS cost,
      COALESCE(SUM(item.gross_profit), 0)::numeric AS gross_profit
    FROM sales_invoice_items item
    JOIN filtered invoice ON invoice.id = item.invoice_id
    GROUP BY item.tax_percent, item.tax_included
  )
  SELECT jsonb_build_object(
    'summary', jsonb_build_object(
      'invoiceCount', totals.invoice_count,
      'saleCount', totals.sale_count,
      'returnCount', totals.return_count,
      'grossSales', ROUND(totals.gross_sales, 2),
      'returns', ROUND(totals.returns, 2),
      'netSales', ROUND(totals.net_sales, 2),
      'subtotal', ROUND(totals.subtotal, 2),
      'tax', ROUND(totals.tax, 2),
      'discounts', ROUND(totals.discounts, 2),
      'deliveryFee', ROUND(totals.delivery_fee, 2),
      'grossProfit', ROUND(totals.gross_profit, 2),
      'profitMargin', CASE
        WHEN totals.subtotal - totals.discounts = 0 THEN 0
        ELSE ROUND((totals.gross_profit / (totals.subtotal - totals.discounts)) * 100, 2)
      END,
      'cash', ROUND(totals.cash, 2),
      'visa', ROUND(totals.visa, 2),
      'cliq', ROUND(totals.cliq, 2),
      'debt', ROUND(totals.debt, 2),
      'itemCount', ROUND(totals.item_count, 3),
      'averageTicket', CASE
        WHEN totals.invoice_count = 0 THEN 0
        ELSE ROUND(totals.net_sales / totals.invoice_count, 2)
      END
    ),
    'taxBreakdown', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'taxPercent', tax_percent,
          'taxIncluded', tax_included,
          'lineCount', line_count,
          'quantity', ROUND(quantity, 3),
          'netSales', ROUND(net_sales, 2),
          'tax', ROUND(tax, 2),
          'grossSales', ROUND(gross_sales, 2),
          'cost', ROUND(cost, 2),
          'grossProfit', ROUND(gross_profit, 2)
        )
        ORDER BY tax_percent, tax_included
      )
      FROM tax_groups
    ), '[]'::jsonb)
  )
  FROM invoice_totals totals;
$$;

GRANT EXECUTE ON FUNCTION list_sales_ledger(
  uuid, timestamptz, timestamptz, uuid, uuid, uuid, text, text, text, integer, integer
) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION sales_ledger_summary(
  uuid, timestamptz, timestamptz, uuid, uuid, uuid, text, text, text
) TO anon, authenticated;
