-- 048_reconcile_missing_invoices.sql
-- One-time backfill of sales invoices that never reached the relational
-- ledger. The live sync pipeline used to mirror inventory BEFORE the sales
-- ledger; when a stock RPC failed, the whole event aborted before
-- sales_invoices was written, yet the client had already ACKed the queue
-- record, so the admin Sales Ledger (which reads ONLY sales_invoices) lost
-- the sale entirely.
--
-- sync_events is the immutable event log and holds the exact
-- InvoiceCreatedPayload verbatim, so every lost invoice can be rebuilt
-- losslessly. The math mirrors app/api/sync/route.ts recordSalesInvoiceLedger()
-- exactly (same computeFiscalBreakdown tax/discount allocation, same payment
-- splits, same product_barcodes cost lookup) so reconciled rows are
-- byte-identical to what a live retry would have written.
--
-- Idempotency — safe to re-run any number of times:
--   * Invoice rows: INSERT ... ON CONFLICT (sync_id) DO NOTHING (sync_id is
--     UNIQUE on sales_invoices).
--   * Item / payment rows: inserted only when the invoice has none, so
--     partial writes are healed without ever duplicating children.
--   * The same loop heals invoices whose header already exists but whose
--     items/payments were never written (the old partial-write window),
--     recomputed from the stored payload.

CREATE OR REPLACE FUNCTION public._recon_money(v jsonb) RETURNS numeric
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN jsonb_typeof(v) = 'number' THEN ROUND((v #>> '{}')::numeric, 2)
    WHEN jsonb_typeof(v) = 'string'
         AND (v #>> '{}') ~ '^-?([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][-+]?[0-9]+)?$'
      THEN ROUND((v #>> '{}')::numeric, 2)
    ELSE 0
  END;
$$;

CREATE OR REPLACE FUNCTION public._recon_num(v jsonb) RETURNS numeric
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN jsonb_typeof(v) IN ('number', 'string')
         AND (v #>> '{}') ~ '^-?([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][-+]?[0-9]+)?$'
      THEN (v #>> '{}')::numeric
    ELSE 0
  END;
$$;

CREATE OR REPLACE FUNCTION public._recon_text(v jsonb) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN jsonb_typeof(v) = 'string' THEN BTRIM(v #>> '{}') ELSE '' END;
$$;

CREATE OR REPLACE FUNCTION public._recon_tax_percent(v jsonb) RETURNS numeric
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN NOT (v ? 'taxPercent') THEN 16
    WHEN jsonb_typeof(v->'taxPercent') = 'null' THEN 0
    WHEN jsonb_typeof(v->'taxPercent') NOT IN ('number', 'string') THEN 16
    WHEN (v->>'taxPercent') ~ '^-?([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][-+]?[0-9]+)?$'
         AND (v->>'taxPercent')::numeric BETWEEN 0 AND 100
      THEN ROUND((v->>'taxPercent')::numeric, 2)
    ELSE 16
  END;
$$;

CREATE OR REPLACE FUNCTION public._recon_uuid(v jsonb) RETURNS uuid
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN jsonb_typeof(v) = 'string'
         AND BTRIM(v #>> '{}') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      THEN (BTRIM(v #>> '{}'))::uuid
    ELSE NULL
  END;
$$;

DO $$
DECLARE
  r              record;
  v_alloc_row    record;
  v_src_row      record;
  v_payload      jsonb;
  v_invoice_id   uuid;
  v_has_items    boolean;
  v_has_payments boolean;
  v_inserted     int;
  v_row_count    int;

  v_item_discount   numeric;
  v_invoice_discount numeric;
  v_base_total      numeric;
  v_target          numeric;
  v_allocated       numeric;
  v_eligible_total  int;
  v_eligible_pos    int;
  v_share           numeric;
  v_alloc           numeric;

  v_item           jsonb;
  v_idx            int;
  v_barcode        text;
  v_product_id     uuid;
  v_product_name   text;
  v_variant_label  text;
  v_meta_variant   text;
  v_unit_name      text;
  v_qty            numeric;
  v_unit_price     numeric;
  v_line_subtotal  numeric;
  v_price_basis    numeric;
  v_adjusted       numeric;
  v_tax_percent    numeric;
  v_tax_included   boolean;
  v_rate           numeric;
  v_net            numeric;
  v_line_tax       numeric;
  v_gross          numeric;
  v_line_discount  numeric;
  v_cost           numeric;
  v_cost_total     numeric;
  v_line_profit    numeric;
  v_multiplier     numeric;

  v_subtotal     numeric;
  v_tax          numeric;
  v_discount     numeric;
  v_delivery_fee numeric;
  v_total        numeric;
  v_amount_paid  numeric;
  v_change       numeric;
  v_payment_method text;
  v_cash         numeric;
  v_visa         numeric;
  v_cliq         numeric;
  v_debt         numeric;
  v_gross_profit numeric;
  v_item_count   numeric;
  v_paid_methods int;
  v_completed_at timestamptz;

  v_branch_id    uuid;
  v_terminal_id  uuid;
  v_shift_id     uuid;
  v_cashier_id   uuid;
  v_customer_id  uuid;
  v_original_id  uuid;

  v_iso_re           text;
  v_total_recon      int := 0;
  v_invoices_backfilled int := 0;
  v_item_rows        int := 0;
  v_payment_rows     int := 0;
BEGIN
  v_iso_re := '^[0-9]{4}-[0-9]{2}-[0-9]{2}[Tt ]';

  CREATE TEMP TABLE _recon_src (idx int PRIMARY KEY, item jsonb) ON COMMIT DROP;
  CREATE TEMP TABLE _recon_alloc (idx int PRIMARY KEY, alloc numeric) ON COMMIT DROP;
  CREATE TEMP TABLE _recon_items (
    sync_id uuid, store_id uuid, line_no int,
    product_id uuid, product_name text, barcode text, variant_label text, unit_name text,
    qty numeric, multiplier numeric, unit_price numeric,
    line_subtotal numeric, line_discount numeric, line_total numeric,
    net_total numeric, tax_percent numeric, tax_included boolean, tax_amount numeric,
    cost_price numeric, cost_total numeric, gross_profit numeric
  ) ON COMMIT DROP;
  CREATE TEMP TABLE _recon_payments (sync_id uuid, method text, amount numeric) ON COMMIT DROP;

  FOR r IN
    SELECT e.sync_id, e.payload, e.store_id, e.cashier_name, e.client_created_at
    FROM sync_events e
    WHERE e.action_type = 'INVOICE_CREATED'
    ORDER BY e.client_created_at NULLS LAST, e.sync_id
  LOOP
    v_payload := r.payload;
    IF jsonb_typeof(v_payload) <> 'object' OR jsonb_typeof(v_payload->'items') <> 'array' THEN
      RAISE NOTICE '048: skipped malformed event %', r.sync_id;
      CONTINUE;
    END IF;

    TRUNCATE _recon_src, _recon_alloc, _recon_items, _recon_payments;
    v_total_recon := v_total_recon + 1;

    INSERT INTO _recon_src (idx, item)
    SELECT (ord::int - 1), elem
    FROM jsonb_array_elements(v_payload->'items') WITH ORDINALITY AS t(elem, ord);

    v_subtotal     := _recon_money(v_payload->'subtotal');
    v_tax          := _recon_money(v_payload->'tax');
    v_discount     := _recon_money(v_payload->'discount');
    v_delivery_fee := _recon_money(v_payload->'deliveryFee');
    v_total        := _recon_money(v_payload->'total');
    v_amount_paid  := _recon_money(v_payload->'amountPaid');
    v_change       := _recon_money(v_payload->'change');
    v_payment_method := COALESCE(NULLIF(BTRIM(v_payload->>'paymentMethod'), ''), 'UNKNOWN');

    -- itemDiscount = round2(sum(money(item.discount))); invoice-level discount
    -- is what remains after all line discounts.
    SELECT ROUND(SUM(_recon_money(item->'discount')), 2) INTO v_item_discount FROM _recon_src;
    v_item_discount := COALESCE(v_item_discount, 0);
    v_invoice_discount := ROUND(GREATEST(0, v_discount - v_item_discount), 2);

    -- allocateInvoiceDiscount(): proportional, cents rounded on the largest
    -- eligible line, exactly as lib/saleMath.ts does.
    SELECT ROUND(SUM(GREATEST(0, _recon_money(item->'lineTotal'))), 2) INTO v_base_total FROM _recon_src;
    v_base_total := COALESCE(v_base_total, 0);
    v_target := ROUND(LEAST(GREATEST(0, v_invoice_discount), v_base_total), 2);

    v_allocated := 0;
    IF v_target > 0 AND v_base_total > 0 THEN
      SELECT COUNT(*) INTO v_eligible_total
      FROM _recon_src WHERE GREATEST(0, _recon_money(item->'lineTotal')) > 0;
      v_eligible_pos := 0;
      FOR v_alloc_row IN
        SELECT idx, GREATEST(0, _recon_money(item->'lineTotal')) AS base
        FROM _recon_src
        WHERE GREATEST(0, _recon_money(item->'lineTotal')) > 0
        ORDER BY idx
      LOOP
        v_eligible_pos := v_eligible_pos + 1;
        IF v_eligible_pos = v_eligible_total THEN
          v_share := ROUND(v_target - v_allocated, 2);
        ELSE
          v_share := ROUND((v_alloc_row.base / v_base_total) * v_target, 2);
        END IF;
        v_alloc := LEAST(v_alloc_row.base, v_share);
        INSERT INTO _recon_alloc (idx, alloc) VALUES (v_alloc_row.idx, v_alloc)
          ON CONFLICT (idx) DO UPDATE SET alloc = EXCLUDED.alloc;
        v_allocated := ROUND(v_allocated + v_alloc, 2);
      END LOOP;
    END IF;

    v_gross_profit := 0;
    v_item_count := 0;
    FOR v_src_row IN SELECT idx, item FROM _recon_src ORDER BY idx LOOP
      v_item := v_src_row.item;
      v_idx := v_src_row.idx;

      v_barcode := _recon_text(v_item->'barcode');
      v_qty := _recon_num(v_item->'qty');
      v_unit_price := _recon_num(v_item->'unitPrice');
      v_line_subtotal := ROUND(v_qty * v_unit_price, 2);

      v_cost := 0;
      v_multiplier := 1;
      v_meta_variant := '';
      IF v_barcode <> '' THEN
        SELECT pb.cost_price, pb.multiplier, pb.variant_label
          INTO v_cost, v_multiplier, v_meta_variant
        FROM product_barcodes pb
        WHERE pb.store_id = r.store_id AND pb.barcode = v_barcode
        LIMIT 1;
        IF NOT FOUND THEN v_cost := 0; v_multiplier := 1; v_meta_variant := ''; END IF;
      END IF;
      IF v_multiplier IS NULL OR v_multiplier <= 0 THEN v_multiplier := 1; END IF;

      v_product_id := _recon_uuid(v_item->'productId');
      IF v_product_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM products WHERE id = v_product_id) THEN
        v_product_id := NULL;
      END IF;
      v_product_name := _recon_text(v_item->'name');
      v_variant_label := CASE
        WHEN jsonb_typeof(v_item->'variantLabel') = 'string'
             AND BTRIM(v_item->>'variantLabel') <> '' THEN BTRIM(v_item->>'variantLabel')
        ELSE COALESCE(v_meta_variant, '')
      END;
      v_unit_name := _recon_text(v_item->'unitName');

      -- computeFiscalBreakdown() per line.
      v_price_basis := _recon_money(v_item->'lineTotal');
      SELECT alloc INTO v_alloc FROM _recon_alloc WHERE idx = v_idx;
      v_alloc := COALESCE(v_alloc, 0);
      v_adjusted := ROUND(v_price_basis - v_alloc, 2);
      v_tax_percent := _recon_tax_percent(v_item);
      v_tax_included := CASE
        WHEN jsonb_typeof(v_item->'taxIncluded') = 'boolean'
          THEN (v_item->>'taxIncluded')::boolean ELSE false END;
      v_rate := v_tax_percent / 100;
      IF v_rate > 0 AND v_tax_included THEN
        v_net := ROUND(v_adjusted / (1 + v_rate), 2);
        v_line_tax := ROUND(v_adjusted - v_net, 2);
        v_gross := v_adjusted;
      ELSIF v_rate > 0 THEN
        v_line_tax := ROUND(v_adjusted * v_rate, 2);
        v_gross := ROUND(v_adjusted + v_line_tax, 2);
        v_net := v_adjusted;
      ELSE
        v_net := v_adjusted;
        v_line_tax := 0;
        v_gross := v_adjusted;
      END IF;

      v_line_discount := ROUND(_recon_money(v_item->'discount') + v_alloc, 2);
      v_cost_total := ROUND(v_qty * v_cost, 2);
      v_line_profit := ROUND(v_net - v_cost_total, 2);
      v_gross_profit := ROUND(v_gross_profit + v_line_profit, 2);
      v_item_count := ROUND(v_item_count + ABS(v_qty), 2);

      INSERT INTO _recon_items VALUES (
        r.sync_id, r.store_id, v_idx + 1,
        v_product_id, v_product_name, v_barcode, v_variant_label, v_unit_name,
        v_qty, v_multiplier, v_unit_price,
        v_line_subtotal, v_line_discount, v_gross, v_net, v_tax_percent, v_tax_included, v_line_tax,
        v_cost, v_cost_total, v_line_profit
      );
    END LOOP;

    v_gross_profit := ROUND(v_gross_profit + v_delivery_fee, 2);

    -- Payment splits mirror the route: a single-method sale credits that
    -- method with the full total; SPLIT splits cash/card; zero totals fall
    -- through to an UNKNOWN row.
    v_cash := 0; v_visa := 0; v_cliq := 0; v_debt := 0;
    IF v_payment_method = 'CASH' THEN
      v_cash := v_total;
    ELSIF v_payment_method = 'VISA' THEN
      v_visa := v_total;
    ELSIF v_payment_method = 'CLIQ' THEN
      v_cliq := v_total;
    ELSIF v_payment_method = 'DEBT' THEN
      v_debt := v_total;
    ELSIF v_payment_method = 'SPLIT' THEN
      v_cash := CASE WHEN v_total >= 0 THEN LEAST(v_amount_paid, v_total) ELSE v_total END;
      v_visa := ROUND(v_total - v_cash, 2);
    END IF;
    IF v_cash <> 0 THEN INSERT INTO _recon_payments VALUES (r.sync_id, 'CASH', v_cash); END IF;
    IF v_visa <> 0 THEN INSERT INTO _recon_payments VALUES (r.sync_id, 'VISA', v_visa); END IF;
    IF v_cliq <> 0 THEN INSERT INTO _recon_payments VALUES (r.sync_id, 'CLIQ', v_cliq); END IF;
    IF v_debt <> 0 THEN INSERT INTO _recon_payments VALUES (r.sync_id, 'DEBT', v_debt); END IF;
    SELECT COUNT(*) INTO v_paid_methods FROM _recon_payments;
    IF v_paid_methods = 0 THEN
      INSERT INTO _recon_payments VALUES (r.sync_id, 'UNKNOWN', v_total);
    END IF;

    v_completed_at := CASE
      WHEN jsonb_typeof(v_payload->'completed_at') = 'string'
           AND BTRIM(v_payload->>'completed_at') ~ v_iso_re
        THEN BTRIM(v_payload->>'completed_at')::timestamptz
      ELSE COALESCE(r.client_created_at, now())
    END;

    -- FK references are verified against live rows so a deleted product /
    -- customer / terminal cannot abort the whole backfill (the live route
    -- would have been stuck on such an event forever).
    v_branch_id := _recon_uuid(v_payload->'branchId');
    IF v_branch_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM branches WHERE id = v_branch_id) THEN
      v_branch_id := NULL;
    END IF;
    v_terminal_id := _recon_uuid(v_payload->'terminalId');
    IF v_terminal_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM terminals WHERE id = v_terminal_id) THEN
      v_terminal_id := NULL;
    END IF;
    v_shift_id := _recon_uuid(v_payload->'shiftId');
    v_cashier_id := _recon_uuid(v_payload->'cashierId');
    IF v_cashier_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM cashiers WHERE id = v_cashier_id) THEN
      v_cashier_id := NULL;
    END IF;
    v_customer_id := _recon_uuid(v_payload->'customerId');
    IF v_customer_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM customers WHERE id = v_customer_id) THEN
      v_customer_id := NULL;
    END IF;
    v_original_id := _recon_uuid(v_payload->'originalInvoiceId');

    SELECT id INTO v_invoice_id FROM sales_invoices WHERE sync_id = r.sync_id;
    IF NOT FOUND THEN
      INSERT INTO sales_invoices (
        sync_id, store_id, branch_id, terminal_id, shift_id, cashier_id, cashier_name,
        customer_id, customer_name, customer_phone, payment_method,
        subtotal, tax, discount, delivery_fee, total, amount_paid, change_amount,
        cash_amount, visa_amount, cliq_amount, debt_amount, item_count, gross_profit,
        is_return, is_cancellation, original_invoice_sync_id, completed_at, payload
      ) VALUES (
        r.sync_id, r.store_id,
        v_branch_id, v_terminal_id, v_shift_id, v_cashier_id,
        CASE
          WHEN jsonb_typeof(v_payload->'cashierName') = 'string' THEN BTRIM(v_payload->>'cashierName')
          WHEN v_payload ? 'cashierName' THEN ''
          ELSE r.cashier_name
        END,
        v_customer_id,
        _recon_text(v_payload->'customerName'),
        _recon_text(v_payload->'customerPhone'),
        CASE WHEN v_payment_method IN ('CASH', 'VISA', 'SPLIT', 'DEBT', 'CLIQ')
          THEN v_payment_method ELSE 'UNKNOWN' END,
        v_subtotal, v_tax, v_discount, v_delivery_fee, v_total, v_amount_paid, v_change,
        v_cash, v_visa, v_cliq, v_debt, v_item_count, v_gross_profit,
        v_total < 0,
        CASE WHEN jsonb_typeof(v_payload->'isCancellation') = 'boolean'
          THEN (v_payload->>'isCancellation')::boolean ELSE false END,
        v_original_id,
        v_completed_at,
        v_payload
      )
      ON CONFLICT (sync_id) DO NOTHING;
      GET DIAGNOSTICS v_inserted = ROW_COUNT;
      IF v_inserted > 0 THEN
        v_invoices_backfilled := v_invoices_backfilled + 1;
        SELECT id INTO v_invoice_id FROM sales_invoices WHERE sync_id = r.sync_id;
      ELSE
        -- Lost a race with a concurrent run; reuse the row below.
        SELECT id INTO v_invoice_id FROM sales_invoices WHERE sync_id = r.sync_id;
      END IF;
    END IF;

    IF v_invoice_id IS NOT NULL THEN
      SELECT EXISTS (SELECT 1 FROM sales_invoice_items WHERE invoice_id = v_invoice_id)
        INTO v_has_items;
      SELECT EXISTS (SELECT 1 FROM sales_payments WHERE invoice_id = v_invoice_id)
        INTO v_has_payments;

      IF NOT v_has_items AND EXISTS (SELECT 1 FROM _recon_items) THEN
        INSERT INTO sales_invoice_items (
          invoice_id, store_id, line_no, product_id, product_name, barcode,
          variant_label, unit_name, qty, multiplier, unit_price,
          line_subtotal, line_discount, line_total, net_total, tax_percent,
          tax_included, tax_amount, cost_price, cost_total, gross_profit
        )
        SELECT
          v_invoice_id, store_id, line_no, product_id, product_name, barcode,
          variant_label, unit_name, qty, multiplier, unit_price,
          line_subtotal, line_discount, line_total, net_total, tax_percent,
          tax_included, tax_amount, cost_price, cost_total, gross_profit
        FROM _recon_items;
        GET DIAGNOSTICS v_row_count = ROW_COUNT;
        v_item_rows := v_item_rows + v_row_count;
      END IF;

      IF NOT v_has_payments AND EXISTS (SELECT 1 FROM _recon_payments) THEN
        INSERT INTO sales_payments (invoice_id, store_id, method, amount)
        SELECT v_invoice_id, r.store_id, method, amount FROM _recon_payments;
        GET DIAGNOSTICS v_row_count = ROW_COUNT;
        v_payment_rows := v_payment_rows + v_row_count;
      END IF;

    END IF;
  END LOOP;

  RAISE NOTICE '048 reconciliation complete: % events scanned, % invoices backfilled, % item rows, % payment rows',
    v_total_recon, v_invoices_backfilled, v_item_rows, v_payment_rows;
END $$;

DROP FUNCTION IF EXISTS public._recon_money(jsonb);
DROP FUNCTION IF EXISTS public._recon_num(jsonb);
DROP FUNCTION IF EXISTS public._recon_text(jsonb);
DROP FUNCTION IF EXISTS public._recon_tax_percent(jsonb);
DROP FUNCTION IF EXISTS public._recon_uuid(jsonb);
