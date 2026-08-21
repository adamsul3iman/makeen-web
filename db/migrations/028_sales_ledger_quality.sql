-- 028_sales_ledger_quality.sql
-- Report the accounting limitations of historical lines instead of silently
-- treating a missing cost as real zero cost or inventing an old barcode.

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
      )
  )
  SELECT jsonb_build_object(
    'zeroCostLineCount', COUNT(*) FILTER (WHERE item.qty <> 0 AND item.cost_price <= 0),
    'missingBarcodeLineCount', COUNT(*) FILTER (WHERE BTRIM(item.barcode) = ''),
    'unknownProductLineCount', COUNT(*) FILTER (WHERE item.product_id IS NULL)
  )
  FROM sales_invoice_items item
  JOIN filtered invoice ON invoice.id = item.invoice_id;
$$;

GRANT EXECUTE ON FUNCTION sales_ledger_quality(
  uuid, timestamptz, timestamptz, uuid, uuid, uuid, text, text, text
) TO anon, authenticated;
