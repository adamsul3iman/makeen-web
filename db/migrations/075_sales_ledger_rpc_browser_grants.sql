-- 075_sales_ledger_rpc_browser_grants.sql
-- Restores EXECUTE on the sales-ledger reporting RPCs for authenticated
-- browser sessions. Migration 041 revoked anon/authenticated access when the
-- legacy server route was the sole caller; lib/reportsClient.fetchSalesReport
-- now calls these directly from the admin Sales Ledger page, so the browser
-- client needs the grant again. Deliberately tighter than pre-041 posture
-- (authenticated only, no anon).
GRANT EXECUTE ON FUNCTION list_sales_ledger(
  uuid, timestamptz, timestamptz, uuid, uuid, uuid, text, text, text, integer, integer
) TO authenticated;
GRANT EXECUTE ON FUNCTION sales_ledger_summary(
  uuid, timestamptz, timestamptz, uuid, uuid, uuid, text, text, text
) TO authenticated;
GRANT EXECUTE ON FUNCTION sales_ledger_quality(
  uuid, timestamptz, timestamptz, uuid, uuid, uuid, text, text, text
) TO authenticated;
