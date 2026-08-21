-- Keep supplier invoices and payments behind authenticated Next.js routes.
-- The server uses the public Supabase client, so privileged RPCs also require
-- the server-only platform token before delegating to the internal functions.

REVOKE ALL ON TABLE supplier_invoices, supplier_invoice_items, supplier_payments
  FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON FUNCTION create_supplier_invoice(uuid, uuid, text, date, date, text, uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION record_supplier_payment(uuid, uuid, numeric, text, text, text, timestamptz)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION list_supplier_invoices(uuid, date, date, uuid, text, text, integer, integer)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION supplier_accounting_summary(uuid, timestamptz, timestamptz)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION secure_create_supplier_invoice(
  p_store_id uuid,
  p_supplier_id uuid,
  p_invoice_number text,
  p_invoice_date date,
  p_due_date date,
  p_notes text,
  p_purchase_order_id uuid,
  p_items jsonb,
  p_token text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  IF p_token IS NULL OR p_token <> (SELECT value FROM platform_secrets WHERE name = 'ops_token') THEN
    RAISE EXCEPTION 'permission_denied' USING ERRCODE = '42501';
  END IF;
  RETURN create_supplier_invoice(
    p_store_id, p_supplier_id, p_invoice_number, p_invoice_date, p_due_date,
    p_notes, p_purchase_order_id, p_items
  );
END;
$$;

CREATE OR REPLACE FUNCTION secure_record_supplier_payment(
  p_store_id uuid,
  p_invoice_id uuid,
  p_amount numeric,
  p_method text,
  p_reference text,
  p_notes text,
  p_paid_at timestamptz,
  p_token text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  IF p_token IS NULL OR p_token <> (SELECT value FROM platform_secrets WHERE name = 'ops_token') THEN
    RAISE EXCEPTION 'permission_denied' USING ERRCODE = '42501';
  END IF;
  RETURN record_supplier_payment(
    p_store_id, p_invoice_id, p_amount, p_method, p_reference, p_notes, p_paid_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION secure_list_supplier_invoices(
  p_store_id uuid,
  p_from date,
  p_to date,
  p_supplier_id uuid DEFAULT NULL,
  p_status text DEFAULT 'ALL',
  p_search text DEFAULT NULL,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0,
  p_token text DEFAULT NULL
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
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  IF p_token IS NULL OR p_token <> (SELECT value FROM platform_secrets WHERE name = 'ops_token') THEN
    RAISE EXCEPTION 'permission_denied' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT * FROM list_supplier_invoices(
    p_store_id, p_from, p_to, p_supplier_id, p_status, p_search, p_limit, p_offset
  );
END;
$$;

CREATE OR REPLACE FUNCTION secure_supplier_accounting_summary(
  p_store_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_token text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  IF p_token IS NULL OR p_token <> (SELECT value FROM platform_secrets WHERE name = 'ops_token') THEN
    RAISE EXCEPTION 'permission_denied' USING ERRCODE = '42501';
  END IF;
  RETURN supplier_accounting_summary(p_store_id, p_from, p_to);
END;
$$;

CREATE OR REPLACE FUNCTION supplier_invoice_detail(
  p_store_id uuid,
  p_invoice_id uuid,
  p_token text
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_result jsonb;
BEGIN
  IF p_token IS NULL OR p_token <> (SELECT value FROM platform_secrets WHERE name = 'ops_token') THEN
    RAISE EXCEPTION 'permission_denied' USING ERRCODE = '42501';
  END IF;

  SELECT jsonb_build_object(
    'id', invoice.id,
    'supplierId', invoice.supplier_id,
    'supplierName', supplier.name,
    'purchaseOrderId', invoice.purchase_order_id,
    'invoiceNumber', invoice.invoice_number,
    'invoiceDate', invoice.invoice_date,
    'dueDate', invoice.due_date,
    'subtotal', invoice.subtotal,
    'taxAmount', invoice.tax_amount,
    'totalAmount', invoice.total_amount,
    'paidAmount', invoice.paid_amount,
    'balanceDue', invoice.balance_due,
    'status', invoice.status,
    'notes', COALESCE(invoice.notes, ''),
    'itemCount', (SELECT COUNT(*) FROM supplier_invoice_items item WHERE item.invoice_id = invoice.id),
    'paymentCount', (SELECT COUNT(*) FROM supplier_payments payment WHERE payment.invoice_id = invoice.id),
    'isOverdue', invoice.balance_due > 0 AND invoice.due_date < (now() AT TIME ZONE 'Asia/Amman')::date,
    'createdAt', invoice.created_at,
    'items', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', item.id,
        'lineNo', item.line_no,
        'productId', item.product_id,
        'description', item.description,
        'quantity', item.quantity,
        'unitCost', item.unit_cost,
        'taxPercent', item.tax_percent,
        'netAmount', item.net_amount,
        'taxAmount', item.tax_amount,
        'totalAmount', item.total_amount
      ) ORDER BY item.line_no)
      FROM supplier_invoice_items item
      WHERE item.invoice_id = invoice.id AND item.store_id = p_store_id
    ), '[]'::jsonb),
    'payments', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', payment.id,
        'amount', payment.amount,
        'method', payment.method,
        'reference', COALESCE(payment.reference, ''),
        'notes', COALESCE(payment.notes, ''),
        'paidAt', payment.paid_at
      ) ORDER BY payment.paid_at DESC)
      FROM supplier_payments payment
      WHERE payment.invoice_id = invoice.id AND payment.store_id = p_store_id
    ), '[]'::jsonb)
  ) INTO v_result
  FROM supplier_invoices invoice
  JOIN suppliers supplier ON supplier.id = invoice.supplier_id AND supplier.store_id = p_store_id
  WHERE invoice.id = p_invoice_id AND invoice.store_id = p_store_id;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION secure_create_supplier_invoice(uuid, uuid, text, date, date, text, uuid, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION secure_record_supplier_payment(uuid, uuid, numeric, text, text, text, timestamptz, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION secure_list_supplier_invoices(uuid, date, date, uuid, text, text, integer, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION secure_supplier_accounting_summary(uuid, timestamptz, timestamptz, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION supplier_invoice_detail(uuid, uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION secure_create_supplier_invoice(uuid, uuid, text, date, date, text, uuid, jsonb, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION secure_record_supplier_payment(uuid, uuid, numeric, text, text, text, timestamptz, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION secure_list_supplier_invoices(uuid, date, date, uuid, text, text, integer, integer, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION secure_supplier_accounting_summary(uuid, timestamptz, timestamptz, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION supplier_invoice_detail(uuid, uuid, text) TO anon, authenticated;
