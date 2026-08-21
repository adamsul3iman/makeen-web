-- Reconcile statement revenue and output tax to invoice control totals.
-- Per-line tax allocation may differ by a cent after rounding; invoice headers
-- are the accounting control totals, while item lines remain the COGS source.

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
      COALESCE(SUM(subtotal - discount), 0)::numeric AS net_revenue,
      COALESCE(SUM(tax), 0)::numeric AS output_tax,
      COALESCE(SUM(total), 0)::numeric AS receipts_including_tax,
      COALESCE(SUM(discount), 0)::numeric AS discounts,
      ABS(COALESCE(SUM(subtotal - discount) FILTER (
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
    SELECT
      COUNT(*)::bigint AS expense_count,
      COALESCE(SUM(amount), 0)::numeric AS operating_expenses
    FROM expense_rows
  ),
  expense_groups AS (
    SELECT category, COUNT(*)::bigint AS entry_count, SUM(amount)::numeric AS amount
    FROM expense_rows
    GROUP BY category
  ),
  received_purchases AS (
    SELECT
      COUNT(*)::bigint AS order_count,
      COALESCE(SUM(total_amount), 0)::numeric AS order_value
    FROM purchase_orders
    WHERE store_id = p_store_id
      AND status = 'received'
      AND received_at >= p_from
      AND received_at <= p_to
  ),
  pending_purchases AS (
    SELECT
      COUNT(*)::bigint AS order_count,
      COALESCE(SUM(total_amount), 0)::numeric AS order_value
    FROM purchase_orders
    WHERE store_id = p_store_id
      AND status = 'pending'
      AND created_at <= p_to
  ),
  item_by_invoice AS (
    SELECT
      item.invoice_id,
      SUM(item.cost_total)::numeric AS cogs,
      COUNT(*) FILTER (WHERE item.qty <> 0 AND item.cost_price <= 0)::bigint AS zero_cost_lines
    FROM sales_invoice_items item
    JOIN filtered_invoices invoice ON invoice.id = item.invoice_id
    GROUP BY item.invoice_id
  ),
  sales_daily AS (
    SELECT
      (invoice.completed_at AT TIME ZONE 'Asia/Amman')::date AS day,
      SUM(invoice.subtotal - invoice.discount)::numeric AS revenue,
      SUM(invoice.tax)::numeric AS tax,
      SUM(COALESCE(items.cogs, 0))::numeric AS cogs,
      SUM(COALESCE(items.zero_cost_lines, 0))::bigint AS zero_cost_lines
    FROM filtered_invoices invoice
    LEFT JOIN item_by_invoice items ON items.invoice_id = invoice.id
    GROUP BY (invoice.completed_at AT TIME ZONE 'Asia/Amman')::date
  ),
  expense_daily AS (
    SELECT
      (created_at AT TIME ZONE 'Asia/Amman')::date AS day,
      SUM(amount)::numeric AS expenses
    FROM expense_rows
    GROUP BY (created_at AT TIME ZONE 'Asia/Amman')::date
  ),
  trend_days AS (
    SELECT day FROM sales_daily
    UNION
    SELECT day FROM expense_daily
  ),
  trend_rows AS (
    SELECT
      days.day,
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
      'grossProfit', CASE
        WHEN lines.zero_cost_line_count = 0
          THEN ROUND(invoices.net_revenue - lines.known_cogs, 2)
        ELSE NULL
      END,
      'operatingExpenses', ROUND(expenses.operating_expenses, 2),
      'expenseCount', expenses.expense_count,
      'operatingProfitCandidate', ROUND(invoices.net_revenue - lines.known_cogs - expenses.operating_expenses, 2),
      'operatingProfit', CASE
        WHEN lines.zero_cost_line_count = 0
          THEN ROUND(invoices.net_revenue - lines.known_cogs - expenses.operating_expenses, 2)
        ELSE NULL
      END,
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
      SELECT jsonb_agg(
        jsonb_build_object(
          'category', category,
          'entryCount', entry_count,
          'amount', ROUND(amount, 2)
        )
        ORDER BY amount DESC, category
      )
      FROM expense_groups
    ), '[]'::jsonb),
    'trend', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'date', day::text,
          'revenue', ROUND(revenue, 2),
          'cogs', ROUND(cogs, 2),
          'tax', ROUND(tax, 2),
          'expenses', ROUND(expenses, 2),
          'profitReliable', zero_cost_lines = 0,
          'operatingProfit', CASE
            WHEN zero_cost_lines = 0 THEN ROUND(revenue - cogs - expenses, 2)
            ELSE NULL
          END
        )
        ORDER BY day
      )
      FROM trend_rows
    ), '[]'::jsonb)
  )
  FROM invoice_totals invoices
  CROSS JOIN line_totals lines
  CROSS JOIN expense_totals expenses
  CROSS JOIN received_purchases received
  CROSS JOIN pending_purchases pending;
$$;

GRANT EXECUTE ON FUNCTION profitability_statement(uuid, timestamptz, timestamptz)
  TO anon, authenticated;
