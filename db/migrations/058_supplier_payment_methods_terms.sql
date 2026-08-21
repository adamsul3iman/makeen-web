-- 058_supplier_payment_methods_terms.sql
-- Phase 3.5 Smart Payment Engine: widen the supplier payment methods to the
-- payment center's full set (CASH/BANK/CARD/CLIQ/WALLET) and let suppliers
-- carry default payment terms so goods-in auto-computes the due date.

-- 1. Suppliers: default payment terms in days (0 = due on receipt / manual).
ALTER TABLE suppliers
  ADD COLUMN IF NOT EXISTS payment_terms_days INTEGER NOT NULL DEFAULT 0
  CHECK (payment_terms_days >= 0);

-- 2. Widen the payment-method constraint on the payables ledger.
ALTER TABLE supplier_payments
  DROP CONSTRAINT IF EXISTS supplier_payments_method_check;
ALTER TABLE supplier_payments
  ADD CONSTRAINT supplier_payments_method_check
  CHECK (method IN ('CASH', 'BANK', 'CARD', 'CLIQ', 'WALLET'));

-- 3. Recreate record_supplier_payment with the wider method set (signature
--    unchanged so secure_record_supplier_payment keeps delegating to it).
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
  IF p_method NOT IN ('CASH', 'BANK', 'CARD', 'CLIQ', 'WALLET') THEN
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

-- 4. Audit the price mutations the receiving mirror applies to barcodes.
ALTER TABLE admin_audit_logs DROP CONSTRAINT IF EXISTS admin_audit_logs_action_type_check;
ALTER TABLE admin_audit_logs ADD CONSTRAINT admin_audit_logs_action_type_check
  CHECK (action_type IN (
    'OVERRIDE_PRICE', 'CANCEL_INVOICE', 'OPEN_DRAWER', 'SAVE_CASHIER',
    'DELETE_CASHIER', 'ENTER_RETURN_MODE', 'ADJUST_STOCK',
    'CREATE_SUPPLIER_INVOICE', 'RECORD_SUPPLIER_PAYMENT', 'RECEIVING_PRICE_UPDATE'
  ));
