-- 044_receipt_professional_columns.sql
-- Backfill professional receipt-table controls while preserving every merchant choice.

SET search_path = public, extensions;

UPDATE print_templates
SET config = config || jsonb_build_object(
  'itemColumnMode', coalesce(config->'itemColumnMode', '"full"'::jsonb),
  'tableHeaderStyle', coalesce(config->'tableHeaderStyle', '"dark"'::jsonb),
  'summaryStyle', coalesce(config->'summaryStyle', '"grid"'::jsonb),
  'totalStyle', coalesce(config->'totalStyle', '"rules"'::jsonb),
  'totalScale', coalesce(config->'totalScale', '1'::jsonb),
  'zebraRows', coalesce(config->'zebraRows', 'true'::jsonb),
  'showLineNumbers', coalesce(config->'showLineNumbers', 'false'::jsonb),
  'showItemUnit', coalesce(config->'showItemUnit', 'true'::jsonb),
  'showItemDiscount', coalesce(config->'showItemDiscount', 'true'::jsonb),
  'showCustomerPhone', coalesce(config->'showCustomerPhone', 'true'::jsonb),
  'showBranchTerminal', coalesce(config->'showBranchTerminal', 'true'::jsonb)
)
WHERE kind = 'RECEIPT';

CREATE OR REPLACE FUNCTION seed_store_print_templates()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  INSERT INTO print_templates(store_id, kind, name, is_default, config)
  VALUES
    (NEW.id, 'RECEIPT', 'الفاتورة الحرارية الأساسية', TRUE,
      '{"version":1,"paperWidth":80,"density":"standard","fontScale":1,"logoSize":"medium","dividerStyle":"dashed","itemStyle":"grid","itemColumnMode":"full","tableHeaderStyle":"dark","summaryStyle":"grid","totalStyle":"rules","totalScale":1,"zebraRows":true,"showLineNumbers":false,"showItemUnit":true,"showItemDiscount":true,"showItemBarcode":false,"showItemTax":true,"showCustomerPhone":true,"showBranchTerminal":true,"showTaxNumber":true,"showCashierTime":true,"showInvoiceBarcode":true,"showFiscalQr":true,"sections":[{"id":"branding","visible":true},{"id":"document","visible":true},{"id":"meta","visible":true},{"id":"customer","visible":true},{"id":"items","visible":true},{"id":"summary","visible":true},{"id":"total","visible":true},{"id":"payment","visible":true},{"id":"codes","visible":true},{"id":"footer","visible":true}]}'::jsonb),
    (NEW.id, 'BARCODE_LABEL', 'ملصق 40 × 25', TRUE,
      '{"version":1,"widthMm":40,"heightMm":25,"gapMm":2,"paddingMm":1,"fontScale":1,"barcodeHeightMm":7,"borderStyle":"solid","showStoreName":false,"showName":true,"showBarcodeText":true,"showUnit":true,"showPrice":true,"order":["store","name","barcode","barcodeText","unit","price"]}'::jsonb);
  RETURN NEW;
END;
$$;
