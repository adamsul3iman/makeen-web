-- 042_print_template_studio.sql
-- Versioned, tenant-scoped print templates for receipts and barcode labels.

SET search_path = public, extensions;

CREATE TABLE IF NOT EXISTS print_templates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id    UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('RECEIPT', 'BARCODE_LABEL')),
  name        TEXT NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 80),
  is_default  BOOLEAN NOT NULL DEFAULT FALSE,
  config      JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(config) = 'object'),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_print_templates_store_kind
  ON print_templates(store_id, kind, updated_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_print_templates_default_kind
  ON print_templates(store_id, kind)
  WHERE is_default;

ALTER TABLE print_templates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE print_templates FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE print_templates TO service_role;

CREATE OR REPLACE FUNCTION touch_print_template_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, extensions
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_print_templates_updated_at ON print_templates;
CREATE TRIGGER trg_print_templates_updated_at
BEFORE UPDATE ON print_templates
FOR EACH ROW EXECUTE FUNCTION touch_print_template_updated_at();

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
      '{"version":1,"paperWidth":80,"density":"standard","fontScale":1,"logoSize":"medium","dividerStyle":"dashed","itemStyle":"grid","showItemBarcode":false,"showItemTax":true,"showTaxNumber":true,"showCashierTime":true,"showInvoiceBarcode":true,"showFiscalQr":true,"sections":[{"id":"branding","visible":true},{"id":"document","visible":true},{"id":"meta","visible":true},{"id":"customer","visible":true},{"id":"items","visible":true},{"id":"summary","visible":true},{"id":"total","visible":true},{"id":"payment","visible":true},{"id":"codes","visible":true},{"id":"footer","visible":true}]}'::jsonb),
    (NEW.id, 'BARCODE_LABEL', 'ملصق 40 × 25', TRUE,
      '{"version":1,"widthMm":40,"heightMm":25,"gapMm":2,"paddingMm":1,"fontScale":1,"barcodeHeightMm":7,"borderStyle":"solid","showStoreName":false,"showName":true,"showBarcodeText":true,"showUnit":true,"showPrice":true,"order":["store","name","barcode","barcodeText","unit","price"]}'::jsonb);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_seed_store_print_templates ON stores;
CREATE TRIGGER trg_seed_store_print_templates
AFTER INSERT ON stores
FOR EACH ROW EXECUTE FUNCTION seed_store_print_templates();

INSERT INTO print_templates(store_id, kind, name, is_default, config)
SELECT s.id, 'RECEIPT', 'الفاتورة الحرارية الأساسية', TRUE,
  '{"version":1,"paperWidth":80,"density":"standard","fontScale":1,"logoSize":"medium","dividerStyle":"dashed","itemStyle":"grid","showItemBarcode":false,"showItemTax":true,"showTaxNumber":true,"showCashierTime":true,"showInvoiceBarcode":true,"showFiscalQr":true,"sections":[{"id":"branding","visible":true},{"id":"document","visible":true},{"id":"meta","visible":true},{"id":"customer","visible":true},{"id":"items","visible":true},{"id":"summary","visible":true},{"id":"total","visible":true},{"id":"payment","visible":true},{"id":"codes","visible":true},{"id":"footer","visible":true}]}'::jsonb
FROM stores s
WHERE NOT EXISTS (
  SELECT 1 FROM print_templates p WHERE p.store_id = s.id AND p.kind = 'RECEIPT'
);

INSERT INTO print_templates(store_id, kind, name, is_default, config)
SELECT s.id, 'BARCODE_LABEL', 'ملصق 40 × 25', TRUE,
  '{"version":1,"widthMm":40,"heightMm":25,"gapMm":2,"paddingMm":1,"fontScale":1,"barcodeHeightMm":7,"borderStyle":"solid","showStoreName":false,"showName":true,"showBarcodeText":true,"showUnit":true,"showPrice":true,"order":["store","name","barcode","barcodeText","unit","price"]}'::jsonb
FROM stores s
WHERE NOT EXISTS (
  SELECT 1 FROM print_templates p WHERE p.store_id = s.id AND p.kind = 'BARCODE_LABEL'
);
