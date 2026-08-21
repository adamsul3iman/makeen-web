-- 055_perf_indexes.sql
-- Hot-path indexes for the queries a register touches on every scan,
-- checkout and login. All are additive; none alter existing behavior.
--
-- Rationale (from the performance audit):
--   * The movements screen runs  .eq(store_id) + ORDER BY occurred_at DESC
--     + LIMIT every time inventory is opened. Only (store_id, product_id,
--     occurred_at) existed, so the planner could not satisfy the sort from
--     the index and fell back to a store-wide sort+limit.
--   * The sync drain resolves customers by .eq(name).eq(store_id) (and the
--     CSV import by category .eq(name).eq(store_id)); only a bare store_id
--     index existed, forcing a scan of every customer/category row.
--   * The customer-transaction idempotency probe filters
--     (store_id, customer_id, type) before the description ilike; a
--     dedicated composite narrows the probe to the single matching ledger.

SET search_path = public, extensions;

-- Inventory movements: store-scoped sort by occurred_at.
CREATE INDEX IF NOT EXISTS idx_inventory_movements_store_occurred
  ON inventory_movements (store_id, occurred_at DESC);

-- Customer resolution by name within a tenant (sync drain + CSV import).
CREATE INDEX IF NOT EXISTS idx_customers_store_name
  ON customers (store_id, name);

-- Category resolution by name within a tenant (CSV import).
CREATE INDEX IF NOT EXISTS idx_categories_store_name
  ON categories (store_id, name);

-- Ledger idempotency probe: (store_id, customer_id, type) narrows the scan
-- before the description ilike marker check.
CREATE INDEX IF NOT EXISTS idx_customer_transactions_store_customer_type
  ON customer_transactions (store_id, customer_id, type);

-- Supplier payment lookups during accounts-payable settlement.
CREATE INDEX IF NOT EXISTS idx_supplier_payments_store_invoice
  ON supplier_payments (store_id, invoice_id);
