-- 006_multi_tenant_stores.sql
-- Multi-tenant SaaS isolation: every operational row is scoped to a store.
--
-- Adds the `stores` registry plus a `super_admins` table used to provision
-- new tenants. Every core table gains a `store_id` FK; pre-existing rows
-- are backfilled to a seeded default store ("المتجر الرئيسي") so existing
-- single-tenant deployments migrate without data loss.

CREATE TABLE IF NOT EXISTS stores (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name               TEXT NOT NULL CHECK (name <> ''),
  owner_name         TEXT NOT NULL DEFAULT '',
  email              TEXT NOT NULL DEFAULT '',
  phone              TEXT NOT NULL DEFAULT '',
  subscription_status VARCHAR(20) NOT NULL DEFAULT 'active'
                     CHECK (subscription_status IN ('active', 'suspended')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS super_admins (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL CHECK (name <> ''),
  pin        VARCHAR(4) UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
DECLARE main_id UUID;
BEGIN
  INSERT INTO stores (name) VALUES ('المتجر الرئيسي');
  SELECT id INTO main_id FROM stores WHERE name = 'المتجر الرئيسي' LIMIT 1;

  ALTER TABLE cashiers ADD COLUMN IF NOT EXISTS store_id UUID REFERENCES stores(id);
  UPDATE cashiers SET store_id = main_id WHERE store_id IS NULL;
  ALTER TABLE cashiers ALTER COLUMN store_id SET NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_cashiers_store_id ON cashiers (store_id);

  ALTER TABLE categories ADD COLUMN IF NOT EXISTS store_id UUID REFERENCES stores(id);
  UPDATE categories SET store_id = main_id WHERE store_id IS NULL;
  ALTER TABLE categories ALTER COLUMN store_id SET NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_categories_store_id ON categories (store_id);

  ALTER TABLE products ADD COLUMN IF NOT EXISTS store_id UUID REFERENCES stores(id);
  UPDATE products SET store_id = main_id WHERE store_id IS NULL;
  ALTER TABLE products ALTER COLUMN store_id SET NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_products_store_id ON products (store_id);

  ALTER TABLE product_barcodes ADD COLUMN IF NOT EXISTS store_id UUID REFERENCES stores(id);
  UPDATE product_barcodes SET store_id = main_id WHERE store_id IS NULL;
  ALTER TABLE product_barcodes ALTER COLUMN store_id SET NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_product_barcodes_store_id ON product_barcodes (store_id);

  ALTER TABLE sync_events ADD COLUMN IF NOT EXISTS store_id UUID REFERENCES stores(id);
  UPDATE sync_events SET store_id = main_id WHERE store_id IS NULL;
  ALTER TABLE sync_events ALTER COLUMN store_id SET NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_sync_events_store_id ON sync_events (store_id);

  ALTER TABLE customers ADD COLUMN IF NOT EXISTS store_id UUID REFERENCES stores(id);
  UPDATE customers SET store_id = main_id WHERE store_id IS NULL;
  ALTER TABLE customers ALTER COLUMN store_id SET NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_customers_store_id ON customers (store_id);

  ALTER TABLE customer_transactions ADD COLUMN IF NOT EXISTS store_id UUID REFERENCES stores(id);
  UPDATE customer_transactions SET store_id = main_id WHERE store_id IS NULL;
  ALTER TABLE customer_transactions ALTER COLUMN store_id SET NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_customer_transactions_store_id ON customer_transactions (store_id);

  ALTER TABLE expenses ADD COLUMN IF NOT EXISTS store_id UUID REFERENCES stores(id);
  UPDATE expenses SET store_id = main_id WHERE store_id IS NULL;
  ALTER TABLE expenses ALTER COLUMN store_id SET NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_expenses_store_id ON expenses (store_id);

  ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS store_id UUID REFERENCES stores(id);
  UPDATE suppliers SET store_id = main_id WHERE store_id IS NULL;
  ALTER TABLE suppliers ALTER COLUMN store_id SET NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_suppliers_store_id ON suppliers (store_id);

  ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS store_id UUID REFERENCES stores(id);
  UPDATE purchase_orders SET store_id = main_id WHERE store_id IS NULL;
  ALTER TABLE purchase_orders ALTER COLUMN store_id SET NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_purchase_orders_store_id ON purchase_orders (store_id);

  ALTER TABLE purchase_order_items ADD COLUMN IF NOT EXISTS store_id UUID REFERENCES stores(id);
  UPDATE purchase_order_items SET store_id = main_id WHERE store_id IS NULL;
  ALTER TABLE purchase_order_items ALTER COLUMN store_id SET NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_purchase_order_items_store_id ON purchase_order_items (store_id);
END $$;

INSERT INTO super_admins (name, pin) VALUES ('مدير النظام', '7777')
  ON CONFLICT (pin) DO NOTHING;
