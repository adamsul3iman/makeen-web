-- 027_backfill_legacy_invoice_tax.sql
-- Older POS builds applied the store tax at invoice level and did not stamp
-- taxPercent on each payload item. Allocate the invoice's recorded net and
-- tax across only those legacy lines. Modern explicit zero-rated items have
-- a taxPercent key and are intentionally excluded.

WITH legacy_lines AS (
  SELECT
    item.id,
    item.invoice_id,
    item.cost_total,
    invoice.subtotal - invoice.discount AS invoice_net,
    invoice.tax AS invoice_tax,
    ABS(item.line_total) AS line_weight,
    SUM(ABS(item.line_total)) OVER (PARTITION BY item.invoice_id) AS invoice_weight,
    CASE
      WHEN invoice.subtotal - invoice.discount = 0 THEN 0::numeric
      ELSE ROUND(ABS(invoice.tax / (invoice.subtotal - invoice.discount)) * 100, 2)
    END AS effective_tax_percent
  FROM sales_invoice_items item
  JOIN sales_invoices invoice ON invoice.id = item.invoice_id
  CROSS JOIN LATERAL (
    SELECT invoice.payload->'items'->(item.line_no - 1) AS payload_item
  ) payload
  WHERE invoice.tax <> 0
    AND NOT COALESCE(payload_item ? 'taxPercent', FALSE)
),
allocated AS (
  SELECT
    id,
    cost_total,
    effective_tax_percent,
    CASE WHEN invoice_weight = 0 THEN 0 ELSE ROUND(invoice_net * line_weight / invoice_weight, 2) END AS line_net,
    CASE WHEN invoice_weight = 0 THEN 0 ELSE ROUND(invoice_tax * line_weight / invoice_weight, 2) END AS line_tax
  FROM legacy_lines
)
UPDATE sales_invoice_items item
SET
  tax_percent = allocated.effective_tax_percent,
  tax_included = FALSE,
  net_total = allocated.line_net,
  tax_amount = allocated.line_tax,
  line_total = allocated.line_net + allocated.line_tax,
  gross_profit = allocated.line_net - allocated.cost_total
FROM allocated
WHERE item.id = allocated.id;

UPDATE sales_invoices invoice
SET gross_profit = totals.gross_profit
FROM (
  SELECT invoice_id, ROUND(COALESCE(SUM(gross_profit), 0), 2) AS gross_profit
  FROM sales_invoice_items
  GROUP BY invoice_id
) totals
WHERE invoice.id = totals.invoice_id
  AND invoice.gross_profit IS DISTINCT FROM totals.gross_profit;
