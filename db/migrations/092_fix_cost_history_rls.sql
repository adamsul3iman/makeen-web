-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 092: Fix product_cost_history RLS
--
-- BUG-004: The pch_store_isolation RLS policy depends on
--   current_setting('request.jwt.claims')::jsonb->>'store_id' which is not
--   populated in the browser session's JWT. The INSERT works because
--   log_cost_history() is SECURITY DEFINER, but the SELECT fails — the
--   authenticated user cannot read the rows they just wrote, so the
--   CostHistoryPopover shows "لا سجل بعد" even though data exists.
--
-- FIX: Replace the JWT-dependent policy with USING(true) / WITH CHECK(true),
-- matching the posture of every other ledger table in the app (e.g.
-- cash_movements in migration 074). Store isolation is enforced at the
-- application layer via .eq("store_id", storeId) on every query.
--
-- IDEMPOTENT: safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS pch_store_isolation ON product_cost_history;

CREATE POLICY pch_store_isolation ON product_cost_history
  FOR ALL TO anon, authenticated
  USING (true)
  WITH CHECK (true);

-- Refresh PostgREST cache.
DO $$
BEGIN
  NOTIFY pgrst, 'reload schema';
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;