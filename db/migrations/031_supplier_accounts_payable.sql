-- Supplier invoices, deductible input tax, and accounts payable.
-- Purchase orders move inventory; supplier invoices recognize the payable.

CREATE TABLE IF NOT EXISTS supplier_invoices (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id           UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  supplier_id        UUID NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  purchase_order_id  UUID REFERENCES purchase_orders(id) ON DELETE SET NULL,
  invoice_number     TEXT NOT NULL CHECK (BTRIM(invoice_number) <> ''),
  invoice_date       DATE NOT NULL,
  due_date           DATE NOT NULL,
  subtotal           DECIMAL(12,2) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  tax_amount         DECIMAL(12,2) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  total_amount       DECIMAL(12,2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
  paid_amount        DECIMAL(12,2) NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
  balance_due        DECIMAL(12,2) NOT NULL DEFAULT 0 CHECK (balance_due >= 0),
  status             VARCHAR(16) NOT NULL DEFAULT 'OPEN'
                     CHECK (status IN ('OPEN', 'PARTIAL', 'PAID', 'VOID')),
  notes              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (due_date >= invoice_date),
  CHECK (total_amount = subtotal + tax_amount),
  CHECK (paid_amount <= total_amount),
  CHECK (balance_due = total_amount - paid_amount)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_supplier_invoice_number
  ON supplier_invoices (store_id, supplier_id, invoice_number)
  WHERE status <> 'VOID';
CREATE INDEX IF NOT EXISTS idx_supplier_invoices_store_date
  ON supplier_invoices (store_id, invoice_date DESC);
CREATE INDEX IF NOT EXISTS idx_supplier_invoices_store_due
  ON supplier_invoices (store_id, due_date)
  WHERE balance_due > 0 AND status <> 'VOID';
CREATE INDEX IF NOT EXISTS idx_supplier_invoices_supplier
  ON supplier_invoices (store_id, supplier_id, invoice_date DESC);

CREATE TABLE IF NOT EXISTS supplier_invoice_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id      UUID NOT NULL REFERENCES supplier_invoices(id) ON DELETE CASCADE,
  store_id        UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  line_no         INTEGER NOT NULL CHECK (line_no >= 1),
  product_id      UUID REFERENCES products(id) ON DELETE SET NULL,
  description     TEXT NOT NULL CHECK (BTRIM(description) <> ''),
  quantity        DECIMAL(12,3) NOT NULL CHECK (quantity > 0),
  unit_cost       DECIMAL(12,4) NOT NULL CHECK (unit_cost >= 0),
  tax_percent     DECIMAL(5,2) NOT NULL DEFAULT 0 CHECK (tax_percent >= 0 AND tax_percent <= 100),
  net_amount      DECIMAL(12,2) NOT NULL CHECK (net_amount >= 0),
  tax_amount      DECIMAL(12,2) NOT NULL CHECK (tax_amount >= 0),
  total_amount    DECIMAL(12,2) NOT NULL CHECK (total_amount >= 0),
  UNIQUE (invoice_id, line_no),
  CHECK (total_amount = net_amount + tax_amount)
);

CREATE INDEX IF NOT EXISTS idx_supplier_invoice_items_invoice
  ON supplier_invoice_items (invoice_id, line_no);
CREATE INDEX IF NOT EXISTS idx_supplier_invoice_items_product
  ON supplier_invoice_items (store_id, product_id)
  WHERE product_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS supplier_payments (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id       UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  supplier_id    UUID NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  invoice_id     UUID NOT NULL REFERENCES supplier_invoices(id) ON DELETE RESTRICT,
  amount         DECIMAL(12,2) NOT NULL CHECK (amount > 0),
  method         VARCHAR(16) NOT NULL CHECK (method IN ('CASH', 'BANK', 'CARD')),
  reference      TEXT,
  notes          TEXT,
  paid_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_supplier_payments_invoice
  ON supplier_payments (store_id, invoice_id, paid_at DESC);
CREATE INDEX IF NOT EXISTS idx_supplier_payments_supplier
  ON supplier_payments (store_id, supplier_id, paid_at DESC);

CREATE OR REPLACE FUNCTION create_supplier_invoice(
  p_store_id uuid,
  p_supplier_id uuid,
  p_invoice_number text,
  p_invoice_date date,
  p_due_date date,
  p_notes text,
  p_purchase_order_id uuid,
  p_items jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_invoice_id uuid := gen_random_uuid();
  v_item jsonb;
  v_line integer := 0;
  v_product_id uuid;
  v_description text;
  v_quantity numeric;
  v_unit_cost numeric;
  v_tax_percent numeric;
  v_net numeric;
  v_tax numeric;
  v_total numeric;
  v_subtotal numeric := 0;
  v_tax_total numeric := 0;
  v_invoice_total numeric := 0;
  v_supplier_balance numeric := 0;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM suppliers WHERE id = p_supplier_id AND store_id = p_store_id
  ) THEN
    RAISE EXCEPTION 'supplier_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF NULLIF(BTRIM(p_invoice_number), '') IS NULL OR LENGTH(BTRIM(p_invoice_number)) > 80 THEN
    RAISE EXCEPTION 'invalid_invoice_number' USING ERRCODE = '22023';
  END IF;
  IF p_invoice_date IS NULL OR p_due_date IS NULL OR p_due_date < p_invoice_date THEN
    RAISE EXCEPTION 'invalid_invoice_dates' USING ERRCODE = '22023';
  END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'invoice_items_required' USING ERRCODE = '22023';
  END IF;
  IF p_purchase_order_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM purchase_orders
    WHERE id = p_purchase_order_id AND store_id = p_store_id AND supplier_id = p_supplier_id
  ) THEN
    RAISE EXCEPTION 'purchase_order_not_found' USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO supplier_invoices (
    id, store_id, supplier_id, purchase_order_id, invoice_number,
    invoice_date, due_date, subtotal, tax_amount, total_amount,
    paid_amount, balance_due, status, notes
  ) VALUES (
    v_invoice_id, p_store_id, p_supplier_id, p_purchase_order_id, BTRIM(p_invoice_number),
    p_invoice_date, p_due_date, 0, 0, 0, 0, 0, 'OPEN', NULLIF(BTRIM(p_notes), '')
  );

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items)
  LOOP
    v_line := v_line + 1;
    v_product_id := NULLIF(BTRIM(v_item->>'productId'), '')::uuid;
    v_description := BTRIM(COALESCE(v_item->>'description', ''));
    v_quantity := COALESCE((v_item->>'quantity')::numeric, 0);
    v_unit_cost := COALESCE((v_item->>'unitCost')::numeric, 0);
    v_tax_percent := COALESCE((v_item->>'taxPercent')::numeric, 0);

    IF v_description = '' OR LENGTH(v_description) > 255 THEN
      RAISE EXCEPTION 'invalid_item_description' USING ERRCODE = '22023';
    END IF;
    IF v_quantity <= 0 OR v_unit_cost < 0 OR v_tax_percent < 0 OR v_tax_percent > 100 THEN
      RAISE EXCEPTION 'invalid_invoice_item' USING ERRCODE = '22023';
    END IF;
    IF v_product_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM products WHERE id = v_product_id AND store_id = p_store_id
    ) THEN
      RAISE EXCEPTION 'product_not_found' USING ERRCODE = 'P0002';
    END IF;

    v_net := ROUND(v_quantity * v_unit_cost, 2);
    v_tax := ROUND(v_net * v_tax_percent / 100, 2);
    v_total := v_net + v_tax;
    v_subtotal := v_subtotal + v_net;
    v_tax_total := v_tax_total + v_tax;
    v_invoice_total := v_invoice_total + v_total;

    INSERT INTO supplier_invoice_items (
      invoice_id, store_id, line_no, product_id, description, quantity,
      unit_cost, tax_percent, net_amount, tax_amount, total_amount
    ) VALUES (
      v_invoice_id, p_store_id, v_line, v_product_id, v_description, v_quantity,
      v_unit_cost, v_tax_percent, v_net, v_tax, v_total
    );
  END LOOP;

  UPDATE supplier_invoices
  SET subtotal = ROUND(v_subtotal, 2),
      tax_amount = ROUND(v_tax_total, 2),
      total_amount = ROUND(v_invoice_total, 2),
      balance_due = ROUND(v_invoice_total, 2),
      updated_at = now()
  WHERE id = v_invoice_id;

  UPDATE suppliers
  SET balance = ROUND(balance + v_invoice_total, 2)
  WHERE id = p_supplier_id AND store_id = p_store_id
  RETURNING balance INTO v_supplier_balance;

  RETURN jsonb_build_object(
    'id', v_invoice_id,
    'subtotal', ROUND(v_subtotal, 2),
    'taxAmount', ROUND(v_tax_total, 2),
    'totalAmount', ROUND(v_invoice_total, 2),
    'balanceDue', ROUND(v_invoice_total, 2),
    'status', 'OPEN',
    'supplierBalance', ROUND(v_supplier_balance, 2)
  );
END;
$$;

CREATE OR REPLACE FUNCTION record_supplier_payment(
  p_store_id uuid,
  p_invoice_id uuid,
  p_amount numeric,
  p_method text,
  p_reference text,
  p_notes text,
  p_paid_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_invoice supplier_invoices%ROWTYPE;
  v_payment_id uuid := gen_random_uuid();
  v_paid numeric;
  v_due numeric;
  v_status text;
  v_supplier_balance numeric;
BEGIN
  SELECT * INTO v_invoice
  FROM supplier_invoices
  WHERE id = p_invoice_id AND store_id = p_store_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'supplier_invoice_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_invoice.status IN ('PAID', 'VOID') OR v_invoice.balance_due <= 0 THEN
    RAISE EXCEPTION 'supplier_invoice_not_payable' USING ERRCODE = '22023';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount > v_invoice.balance_due THEN
    RAISE EXCEPTION 'payment_exceeds_balance' USING ERRCODE = '22023';
  END IF;
  IF p_method NOT IN ('CASH', 'BANK', 'CARD') THEN
    RAISE EXCEPTION 'invalid_payment_method' USING ERRCODE = '22023';
  END IF;

  INSERT INTO supplier_payments (
    id, store_id, supplier_id, invoice_id, amount, method,
    reference, notes, paid_at
  ) VALUES (
    v_payment_id, p_store_id, v_invoice.supplier_id, p_invoice_id,
    ROUND(p_amount, 2), p_method, NULLIF(BTRIM(p_reference), ''),
    NULLIF(BTRIM(p_notes), ''), COALESCE(p_paid_at, now())
  );

  v_paid := ROUND(v_invoice.paid_amount + p_amount, 2);
  v_due := ROUND(v_invoice.total_amount - v_paid, 2);
  v_status := CASE WHEN v_due = 0 THEN 'PAID' ELSE 'PARTIAL' END;

  UPDATE supplier_invoices
  SET paid_amount = v_paid, balance_due = v_due, status = v_status, updated_at = now()
  WHERE id = p_invoice_id;

  UPDATE suppliers
  SET balance = ROUND(GREATEST(0, balance - p_amount), 2)
  WHERE id = v_invoice.supplier_id AND store_id = p_store_id
  RETURNING balance INTO v_supplier_balance;

  RETURN jsonb_build_object(
    'paymentId', v_payment_id,
    'invoiceId', p_invoice_id,
    'paidAmount', v_paid,
    'balanceDue', v_due,
    'status', v_status,
    'supplierBalance', ROUND(v_supplier_balance, 2)
  );
END;
$$;

CREATE OR REPLACE FUNCTION list_supplier_invoices(
  p_store_id uuid,
  p_from date,
  p_to date,
  p_supplier_id uuid DEFAULT NULL,
  p_status text DEFAULT 'ALL',
  p_search text DEFAULT NULL,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (
  id uuid,
  supplier_id uuid,
  supplier_name text,
  purchase_order_id uuid,
  invoice_number text,
  invoice_date date,
  due_date date,
  subtotal numeric,
  tax_amount numeric,
  total_amount numeric,
  paid_amount numeric,
  balance_due numeric,
  status varchar,
  notes text,
  item_count bigint,
  payment_count bigint,
  is_overdue boolean,
  created_at timestamptz,
  total_count bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
  SELECT
    invoice.id,
    invoice.supplier_id,
    supplier.name,
    invoice.purchase_order_id,
    invoice.invoice_number,
    invoice.invoice_date,
    invoice.due_date,
    invoice.subtotal,
    invoice.tax_amount,
    invoice.total_amount,
    invoice.paid_amount,
    invoice.balance_due,
    invoice.status,
    invoice.notes,
    (SELECT COUNT(*) FROM supplier_invoice_items item WHERE item.invoice_id = invoice.id),
    (SELECT COUNT(*) FROM supplier_payments payment WHERE payment.invoice_id = invoice.id),
    invoice.balance_due > 0 AND invoice.due_date < (now() AT TIME ZONE 'Asia/Amman')::date,
    invoice.created_at,
    COUNT(*) OVER()
  FROM supplier_invoices invoice
  JOIN suppliers supplier ON supplier.id = invoice.supplier_id
  WHERE invoice.store_id = p_store_id
    AND invoice.invoice_date >= p_from
    AND invoice.invoice_date <= p_to
    AND invoice.status <> 'VOID'
    AND (p_supplier_id IS NULL OR invoice.supplier_id = p_supplier_id)
    AND (
      COALESCE(p_status, 'ALL') = 'ALL'
      OR (p_status = 'OVERDUE' AND invoice.balance_due > 0 AND invoice.due_date < (now() AT TIME ZONE 'Asia/Amman')::date)
      OR (p_status IN ('OPEN', 'PARTIAL', 'PAID') AND invoice.status = p_status)
    )
    AND (
      NULLIF(BTRIM(p_search), '') IS NULL
      OR invoice.invoice_number ILIKE '%' || BTRIM(p_search) || '%'
      OR supplier.name ILIKE '%' || BTRIM(p_search) || '%'
    )
  ORDER BY invoice.invoice_date DESC, invoice.created_at DESC
  LIMIT LEAST(GREATEST(p_limit, 1), 100)
  OFFSET GREATEST(p_offset, 0);
$$;

CREATE OR REPLACE FUNCTION supplier_accounting_summary(
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
  WITH period_invoices AS (
    SELECT *
    FROM supplier_invoices
    WHERE store_id = p_store_id
      AND status <> 'VOID'
      AND invoice_date >= (p_from AT TIME ZONE 'Asia/Amman')::date
      AND invoice_date <= (p_to AT TIME ZONE 'Asia/Amman')::date
  ),
  invoice_totals AS (
    SELECT
      COUNT(*)::bigint AS invoice_count,
      COALESCE(SUM(subtotal), 0)::numeric AS purchases_excluding_tax,
      COALESCE(SUM(tax_amount), 0)::numeric AS input_tax,
      COALESCE(SUM(total_amount), 0)::numeric AS purchases_including_tax
    FROM period_invoices
  ),
  payment_totals AS (
    SELECT COUNT(*)::bigint AS payment_count, COALESCE(SUM(amount), 0)::numeric AS payments
    FROM supplier_payments
    WHERE store_id = p_store_id AND paid_at >= p_from AND paid_at <= p_to
  ),
  open_totals AS (
    SELECT
      COUNT(*) FILTER (WHERE balance_due > 0)::bigint AS open_invoice_count,
      COALESCE(SUM(balance_due) FILTER (WHERE balance_due > 0), 0)::numeric AS outstanding_balance,
      COUNT(*) FILTER (
        WHERE balance_due > 0 AND due_date < (now() AT TIME ZONE 'Asia/Amman')::date
      )::bigint AS overdue_count,
      COALESCE(SUM(balance_due) FILTER (
        WHERE balance_due > 0 AND due_date < (now() AT TIME ZONE 'Asia/Amman')::date
      ), 0)::numeric AS overdue_balance,
      COALESCE(SUM(balance_due) FILTER (
        WHERE balance_due > 0
          AND due_date >= (now() AT TIME ZONE 'Asia/Amman')::date
          AND due_date <= (now() AT TIME ZONE 'Asia/Amman')::date + 7
      ), 0)::numeric AS due_soon_balance
    FROM supplier_invoices
    WHERE store_id = p_store_id AND status <> 'VOID'
  )
  SELECT jsonb_build_object(
    'invoiceCount', invoices.invoice_count,
    'purchasesExcludingTax', ROUND(invoices.purchases_excluding_tax, 2),
    'inputTax', ROUND(invoices.input_tax, 2),
    'purchasesIncludingTax', ROUND(invoices.purchases_including_tax, 2),
    'paymentCount', payments.payment_count,
    'payments', ROUND(payments.payments, 2),
    'openInvoiceCount', open_items.open_invoice_count,
    'outstandingBalance', ROUND(open_items.outstanding_balance, 2),
    'overdueCount', open_items.overdue_count,
    'overdueBalance', ROUND(open_items.overdue_balance, 2),
    'dueSoonBalance', ROUND(open_items.due_soon_balance, 2)
  )
  FROM invoice_totals invoices
  CROSS JOIN payment_totals payments
  CROSS JOIN open_totals open_items;
$$;

GRANT SELECT ON supplier_invoices, supplier_invoice_items, supplier_payments TO anon, authenticated;
GRANT EXECUTE ON FUNCTION create_supplier_invoice(uuid, uuid, text, date, date, text, uuid, jsonb) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION record_supplier_payment(uuid, uuid, numeric, text, text, text, timestamptz) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION list_supplier_invoices(uuid, date, date, uuid, text, text, integer, integer) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION supplier_accounting_summary(uuid, timestamptz, timestamptz) TO anon, authenticated;

ALTER TABLE admin_audit_logs DROP CONSTRAINT IF EXISTS admin_audit_logs_action_type_check;
ALTER TABLE admin_audit_logs ADD CONSTRAINT admin_audit_logs_action_type_check
  CHECK (action_type IN (
    'OVERRIDE_PRICE', 'CANCEL_INVOICE', 'OPEN_DRAWER', 'SAVE_CASHIER',
    'DELETE_CASHIER', 'ENTER_RETURN_MODE', 'ADJUST_STOCK',
    'CREATE_SUPPLIER_INVOICE', 'RECORD_SUPPLIER_PAYMENT'
  ));

CREATE OR REPLACE FUNCTION delete_store(p_store_id uuid, p_token text) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_deleted integer := 0;
BEGIN
  IF p_token IS NULL OR p_token <> (SELECT value FROM platform_secrets WHERE name = 'ops_token') THEN
    RAISE EXCEPTION 'permission_denied' USING ERRCODE = '42501';
  END IF;

  DELETE FROM supplier_payments         WHERE store_id = p_store_id;
  DELETE FROM supplier_invoice_items    WHERE store_id = p_store_id;
  DELETE FROM supplier_invoices         WHERE store_id = p_store_id;
  DELETE FROM sales_payments             WHERE store_id = p_store_id;
  DELETE FROM sales_invoice_items        WHERE store_id = p_store_id;
  DELETE FROM sales_invoices             WHERE store_id = p_store_id;
  DELETE FROM inventory_movements        WHERE store_id = p_store_id;
  DELETE FROM inventory_postings         WHERE store_id = p_store_id;
  DELETE FROM customer_transactions      WHERE store_id = p_store_id;
  DELETE FROM purchase_order_items       WHERE store_id = p_store_id;
  DELETE FROM product_barcodes           WHERE store_id = p_store_id;
  DELETE FROM loyalty_events             WHERE store_id = p_store_id;
  DELETE FROM expenses                   WHERE store_id = p_store_id;
  DELETE FROM sync_events                WHERE store_id = p_store_id;
  DELETE FROM terminals                  WHERE branch_id IN (SELECT id FROM branches WHERE store_id = p_store_id);

  PERFORM set_config('app.allow_audit_log_delete', 'on', true);
  DELETE FROM admin_audit_logs           WHERE store_id = p_store_id;
  PERFORM set_config('app.allow_audit_log_delete', 'off', true);

  DELETE FROM customers                  WHERE store_id = p_store_id;
  DELETE FROM purchase_orders            WHERE store_id = p_store_id;
  DELETE FROM products                   WHERE store_id = p_store_id;
  DELETE FROM product_brands             WHERE store_id = p_store_id;
  DELETE FROM categories                 WHERE store_id = p_store_id;
  DELETE FROM suppliers                  WHERE store_id = p_store_id;
  DELETE FROM cashiers                   WHERE store_id = p_store_id;
  DELETE FROM branches                   WHERE store_id = p_store_id;
  DELETE FROM stores                     WHERE id = p_store_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  RETURN v_deleted > 0;
END;
$$;

GRANT EXECUTE ON FUNCTION delete_store(uuid, text) TO anon, authenticated;
