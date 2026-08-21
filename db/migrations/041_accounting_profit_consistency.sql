-- Make every accounting report use the same revenue and profit semantics.
-- `subtotal` is already net of all discounts; delivery_fee is separate
-- revenue. Profit remains NULL whenever a sold line has no recorded cost.

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
      AND NOT invoice.is_cancellation
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
      COALESCE(SUM(gross_profit), 0)::numeric AS gross_profit_candidate,
      COALESCE(SUM(cash_amount), 0)::numeric AS cash,
      COALESCE(SUM(visa_amount), 0)::numeric AS visa,
      COALESCE(SUM(cliq_amount), 0)::numeric AS cliq,
      COALESCE(SUM(debt_amount), 0)::numeric AS debt,
      COALESCE(SUM(item_count), 0)::numeric AS item_count
    FROM filtered
  ),
  line_quality AS (
    SELECT COUNT(*) FILTER (
      WHERE item.qty <> 0 AND item.cost_price <= 0
    )::bigint AS zero_cost_line_count
    FROM sales_invoice_items item
    JOIN filtered invoice ON invoice.id = item.invoice_id
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
      COALESCE(SUM(item.gross_profit), 0)::numeric AS gross_profit_candidate,
      COUNT(*) FILTER (WHERE item.qty <> 0 AND item.cost_price <= 0)::bigint AS zero_cost_line_count
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
      'grossProfitCandidate', ROUND(totals.gross_profit_candidate, 2),
      'grossProfit', CASE WHEN quality.zero_cost_line_count = 0
        THEN ROUND(totals.gross_profit_candidate, 2) ELSE NULL END,
      'profitReliable', quality.zero_cost_line_count = 0,
      'profitMargin', CASE
        WHEN quality.zero_cost_line_count <> 0 OR totals.subtotal + totals.delivery_fee = 0 THEN NULL
        ELSE ROUND((totals.gross_profit_candidate / (totals.subtotal + totals.delivery_fee)) * 100, 2)
      END,
      'cash', ROUND(totals.cash, 2),
      'visa', ROUND(totals.visa, 2),
      'cliq', ROUND(totals.cliq, 2),
      'debt', ROUND(totals.debt, 2),
      'itemCount', ROUND(totals.item_count, 3),
      'averageTicket', CASE WHEN totals.invoice_count = 0 THEN 0
        ELSE ROUND(totals.net_sales / totals.invoice_count, 2) END
    ),
    'taxBreakdown', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'taxPercent', tax_percent,
        'taxIncluded', tax_included,
        'lineCount', line_count,
        'quantity', ROUND(quantity, 3),
        'netSales', ROUND(net_sales, 2),
        'tax', ROUND(tax, 2),
        'grossSales', ROUND(gross_sales, 2),
        'cost', ROUND(cost, 2),
        'grossProfitCandidate', ROUND(gross_profit_candidate, 2),
        'grossProfit', CASE WHEN zero_cost_line_count = 0
          THEN ROUND(gross_profit_candidate, 2) ELSE NULL END,
        'profitReliable', zero_cost_line_count = 0
      ) ORDER BY tax_percent, tax_included)
      FROM tax_groups
    ), '[]'::jsonb)
  )
  FROM invoice_totals totals
  CROSS JOIN line_quality quality;
$$;

CREATE OR REPLACE FUNCTION sales_ledger_quality(
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
    SELECT invoice.id
    FROM sales_invoices invoice
    WHERE invoice.store_id = p_store_id
      AND invoice.completed_at >= p_from
      AND invoice.completed_at <= p_to
      AND NOT invoice.is_cancellation
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
  )
  SELECT jsonb_build_object(
    'zeroCostLineCount', COUNT(*) FILTER (WHERE item.qty <> 0 AND item.cost_price <= 0),
    'zeroCostNetSales', COALESCE(SUM(ABS(item.net_total)) FILTER (
      WHERE item.qty <> 0 AND item.cost_price <= 0
    ), 0),
    'missingBarcodeLineCount', COUNT(*) FILTER (WHERE BTRIM(item.barcode) = ''),
    'unknownProductLineCount', COUNT(*) FILTER (WHERE item.product_id IS NULL)
  )
  FROM sales_invoice_items item
  JOIN filtered invoice ON invoice.id = item.invoice_id;
$$;

CREATE OR REPLACE FUNCTION profitability_statement(
  p_store_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
  WITH filtered_invoices AS (
    SELECT invoice.*
    FROM sales_invoices invoice
    WHERE invoice.store_id = p_store_id
      AND invoice.completed_at >= p_from
      AND invoice.completed_at <= p_to
      AND NOT invoice.is_cancellation
  ),
  invoice_totals AS (
    SELECT
      COUNT(*)::bigint AS invoice_count,
      COUNT(*) FILTER (WHERE total >= 0 AND NOT is_return)::bigint AS sale_count,
      COUNT(*) FILTER (WHERE total < 0 OR is_return)::bigint AS return_count,
      COALESCE(SUM(subtotal + delivery_fee), 0)::numeric AS net_revenue,
      COALESCE(SUM(tax), 0)::numeric AS output_tax,
      COALESCE(SUM(total), 0)::numeric AS receipts_including_tax,
      COALESCE(SUM(discount), 0)::numeric AS discounts,
      ABS(COALESCE(SUM(subtotal + delivery_fee) FILTER (
        WHERE total < 0 OR is_return
      ), 0))::numeric AS returns_excluding_tax,
      ABS(COALESCE(SUM(total) FILTER (
        WHERE total < 0 OR is_return
      ), 0))::numeric AS returns_including_tax
    FROM filtered_invoices
  ),
  line_totals AS (
    SELECT
      COALESCE(SUM(item.cost_total), 0)::numeric AS known_cogs,
      COALESCE(SUM(ABS(item.net_total)) FILTER (
        WHERE item.qty <> 0 AND item.cost_price <= 0
      ), 0)::numeric AS zero_cost_net_sales,
      COUNT(*) FILTER (WHERE item.qty <> 0 AND item.cost_price <= 0)::bigint AS zero_cost_line_count,
      COUNT(*) FILTER (WHERE BTRIM(item.barcode) = '')::bigint AS missing_barcode_line_count,
      COUNT(*) FILTER (WHERE item.product_id IS NULL)::bigint AS unknown_product_line_count
    FROM sales_invoice_items item
    JOIN filtered_invoices invoice ON invoice.id = item.invoice_id
  ),
  expense_rows AS (
    SELECT expense.category, expense.amount, expense.created_at
    FROM expenses expense
    WHERE expense.store_id = p_store_id
      AND expense.created_at >= p_from
      AND expense.created_at <= p_to
  ),
  expense_totals AS (
    SELECT COUNT(*)::bigint AS expense_count,
      COALESCE(SUM(amount), 0)::numeric AS operating_expenses
    FROM expense_rows
  ),
  expense_groups AS (
    SELECT category, COUNT(*)::bigint AS entry_count, SUM(amount)::numeric AS amount
    FROM expense_rows GROUP BY category
  ),
  received_purchases AS (
    SELECT COUNT(*)::bigint AS order_count,
      COALESCE(SUM(total_amount), 0)::numeric AS order_value
    FROM purchase_orders
    WHERE store_id = p_store_id AND status = 'received'
      AND received_at >= p_from AND received_at <= p_to
  ),
  pending_purchases AS (
    SELECT COUNT(*)::bigint AS order_count,
      COALESCE(SUM(total_amount), 0)::numeric AS order_value
    FROM purchase_orders
    WHERE store_id = p_store_id AND status = 'pending' AND created_at <= p_to
  ),
  item_by_invoice AS (
    SELECT item.invoice_id,
      SUM(item.cost_total)::numeric AS cogs,
      COUNT(*) FILTER (WHERE item.qty <> 0 AND item.cost_price <= 0)::bigint AS zero_cost_lines
    FROM sales_invoice_items item
    JOIN filtered_invoices invoice ON invoice.id = item.invoice_id
    GROUP BY item.invoice_id
  ),
  sales_daily AS (
    SELECT (invoice.completed_at AT TIME ZONE 'Asia/Amman')::date AS day,
      SUM(invoice.subtotal + invoice.delivery_fee)::numeric AS revenue,
      SUM(invoice.tax)::numeric AS tax,
      SUM(COALESCE(items.cogs, 0))::numeric AS cogs,
      SUM(COALESCE(items.zero_cost_lines, 0))::bigint AS zero_cost_lines
    FROM filtered_invoices invoice
    LEFT JOIN item_by_invoice items ON items.invoice_id = invoice.id
    GROUP BY (invoice.completed_at AT TIME ZONE 'Asia/Amman')::date
  ),
  expense_daily AS (
    SELECT (created_at AT TIME ZONE 'Asia/Amman')::date AS day,
      SUM(amount)::numeric AS expenses
    FROM expense_rows
    GROUP BY (created_at AT TIME ZONE 'Asia/Amman')::date
  ),
  trend_days AS (
    SELECT day FROM sales_daily UNION SELECT day FROM expense_daily
  ),
  trend_rows AS (
    SELECT days.day,
      COALESCE(sales.revenue, 0)::numeric AS revenue,
      COALESCE(sales.cogs, 0)::numeric AS cogs,
      COALESCE(sales.tax, 0)::numeric AS tax,
      COALESCE(expense.expenses, 0)::numeric AS expenses,
      COALESCE(sales.zero_cost_lines, 0)::bigint AS zero_cost_lines
    FROM trend_days days
    LEFT JOIN sales_daily sales ON sales.day = days.day
    LEFT JOIN expense_daily expense ON expense.day = days.day
  )
  SELECT jsonb_build_object(
    'statement', jsonb_build_object(
      'invoiceCount', invoices.invoice_count,
      'saleCount', invoices.sale_count,
      'returnCount', invoices.return_count,
      'netRevenue', ROUND(invoices.net_revenue, 2),
      'outputTax', ROUND(invoices.output_tax, 2),
      'receiptsIncludingTax', ROUND(invoices.receipts_including_tax, 2),
      'discounts', ROUND(invoices.discounts, 2),
      'returnsExcludingTax', ROUND(invoices.returns_excluding_tax, 2),
      'returnsIncludingTax', ROUND(invoices.returns_including_tax, 2),
      'knownCogs', ROUND(lines.known_cogs, 2),
      'grossProfitCandidate', ROUND(invoices.net_revenue - lines.known_cogs, 2),
      'grossProfit', CASE WHEN lines.zero_cost_line_count = 0
        THEN ROUND(invoices.net_revenue - lines.known_cogs, 2) ELSE NULL END,
      'operatingExpenses', ROUND(expenses.operating_expenses, 2),
      'expenseCount', expenses.expense_count,
      'operatingProfitCandidate', ROUND(invoices.net_revenue - lines.known_cogs - expenses.operating_expenses, 2),
      'operatingProfit', CASE WHEN lines.zero_cost_line_count = 0
        THEN ROUND(invoices.net_revenue - lines.known_cogs - expenses.operating_expenses, 2) ELSE NULL END,
      'operatingMargin', CASE
        WHEN lines.zero_cost_line_count <> 0 OR invoices.net_revenue = 0 THEN NULL
        ELSE ROUND(((invoices.net_revenue - lines.known_cogs - expenses.operating_expenses) / invoices.net_revenue) * 100, 2)
      END
    ),
    'purchases', jsonb_build_object(
      'receivedCount', received.order_count,
      'receivedValue', ROUND(received.order_value, 2),
      'pendingCount', pending.order_count,
      'pendingValue', ROUND(pending.order_value, 2)
    ),
    'quality', jsonb_build_object(
      'profitReliable', lines.zero_cost_line_count = 0,
      'zeroCostLineCount', lines.zero_cost_line_count,
      'zeroCostNetSales', ROUND(lines.zero_cost_net_sales, 2),
      'missingBarcodeLineCount', lines.missing_barcode_line_count,
      'unknownProductLineCount', lines.unknown_product_line_count,
      'inputTaxTracked', false
    ),
    'expenseBreakdown', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'category', category,
        'entryCount', entry_count,
        'amount', ROUND(amount, 2)
      ) ORDER BY amount DESC, category) FROM expense_groups
    ), '[]'::jsonb),
    'trend', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'date', day::text,
        'revenue', ROUND(revenue, 2),
        'cogs', ROUND(cogs, 2),
        'tax', ROUND(tax, 2),
        'expenses', ROUND(expenses, 2),
        'profitReliable', zero_cost_lines = 0,
        'operatingProfit', CASE WHEN zero_cost_lines = 0
          THEN ROUND(revenue - cogs - expenses, 2) ELSE NULL END
      ) ORDER BY day) FROM trend_rows
    ), '[]'::jsonb)
  )
  FROM invoice_totals invoices
  CROSS JOIN line_totals lines
  CROSS JOIN expense_totals expenses
  CROSS JOIN received_purchases received
  CROSS JOIN pending_purchases pending;
$$;

REVOKE ALL ON FUNCTION list_sales_ledger(uuid, timestamptz, timestamptz, uuid, uuid, uuid, text, text, text, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION sales_ledger_summary(uuid, timestamptz, timestamptz, uuid, uuid, uuid, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION sales_ledger_quality(uuid, timestamptz, timestamptz, uuid, uuid, uuid, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION profitability_statement(uuid, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION list_sales_ledger(uuid, timestamptz, timestamptz, uuid, uuid, uuid, text, text, text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION sales_ledger_summary(uuid, timestamptz, timestamptz, uuid, uuid, uuid, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION sales_ledger_quality(uuid, timestamptz, timestamptz, uuid, uuid, uuid, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION profitability_statement(uuid, timestamptz, timestamptz) TO service_role;
