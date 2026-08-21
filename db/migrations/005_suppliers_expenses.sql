-- 005_suppliers_expenses.sql
-- Enterprise petty-cash expenses plus supplier & purchase-order ledger.
--
-- `expenses` record money taken OUT of the register drawer (petty cash).
-- `suppliers`/`purchase_orders`/`purchase_order_items` track stock
-- replenishment: a PO is created as 'pending' and flips to 'received',
-- at which point product stock is incremented and unit costs are updated.

CREATE TABLE IF NOT EXISTS expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cashier_id UUID,
  category VARCHAR(50) NOT NULL,
  amount DECIMAL(10,2) NOT NULL CHECK (amount > 0),
  notes TEXT,
  shift_id UUID,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS expenses_created_idx ON expenses (created_at DESC);

CREATE TABLE IF NOT EXISTS suppliers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(150) NOT NULL,
  phone VARCHAR(20) NOT NULL DEFAULT '',
  email VARCHAR(150) NOT NULL DEFAULT '',
  address TEXT,
  balance DECIMAL(10,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  total_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'received')),
  received_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS purchase_order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_id UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  product_id UUID REFERENCES products(id) ON DELETE SET NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_cost DECIMAL(10,2) NOT NULL CHECK (unit_cost >= 0),
  total_price DECIMAL(10,2) NOT NULL CHECK (total_price >= 0)
);

CREATE INDEX IF NOT EXISTS purchase_order_items_po_idx ON purchase_order_items (purchase_order_id);
