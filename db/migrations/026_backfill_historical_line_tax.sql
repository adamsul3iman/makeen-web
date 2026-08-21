-- 026_backfill_historical_line_tax.sql
-- Migration 022 introduced line-level tax columns. Historical mirrored rows
-- kept the default zeros even when line_total was non-zero. Recover the tax
-- flags from the immutable invoice payload, then rebuild net, tax, and profit.

WITH historical AS (
  SELECT
    item.id,
    CASE
      WHEN COALESCE(payload_item->>'taxPercent', '') ~ '^\d+(\.\d+)?$'
        THEN LEAST(100, GREATEST(0, (payload_item->>'taxPercent')::numeric))
      ELSE 0::numeric
    END AS recovered_tax_percent,
    CASE
      WHEN LOWER(COALESCE(payload_item->>'taxIncluded', 'false')) IN ('true', '1') THEN TRUE
      ELSE FALSE
    END AS recovered_tax_included
  FROM sales_invoice_items item
  JOIN sales_invoices invoice ON invoice.id = item.invoice_id
  CROSS JOIN LATERAL (
    SELECT invoice.payload->'items'->(item.line_no - 1) AS payload_item
  ) payload
  WHERE item.line_total <> 0
    AND item.net_total = 0
    AND item.tax_amount = 0
)
UPDATE sales_invoice_items item
SET
  tax_percent = historical.recovered_tax_percent,
  tax_included = historical.recovered_tax_included,
  net_total = CASE
    WHEN historical.recovered_tax_percent > 0
      THEN ROUND(item.line_total / (1 + historical.recovered_tax_percent / 100), 2)
    ELSE item.line_total
  END,
  tax_amount = CASE
    WHEN historical.recovered_tax_percent > 0
      THEN item.line_total - ROUND(item.line_total / (1 + historical.recovered_tax_percent / 100), 2)
    ELSE 0
  END,
  gross_profit = CASE
    WHEN historical.recovered_tax_percent > 0
      THEN ROUND(item.line_total / (1 + historical.recovered_tax_percent / 100), 2) - item.cost_total
    ELSE item.line_total - item.cost_total
  END
FROM historical
WHERE item.id = historical.id;

UPDATE sales_invoices invoice
SET gross_profit = totals.gross_profit
FROM (
  SELECT invoice_id, ROUND(COALESCE(SUM(gross_profit), 0), 2) AS gross_profit
  FROM sales_invoice_items
  GROUP BY invoice_id
) totals
WHERE invoice.id = totals.invoice_id
  AND invoice.gross_profit IS DISTINCT FROM totals.gross_profit;
