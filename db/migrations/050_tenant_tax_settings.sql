-- 050_tenant_tax_settings.sql
-- Jordan ISTD (JoFotara) e-invoicing per-tenant credentials.
--
-- Makeen is multi-tenant SaaS: every store holds its OWN Jordan TIN and
-- JoFotara device credentials (client_id / secret_key issued by the JoFotara
-- portal). Nothing is read from .env — each request looks up THIS store's row
-- so one tenant can never transmit or read another tenant's credentials.
--
-- The row is created lazily by the settings API (absent row = integration not
-- configured). `tax_number` mirrors stores.tax_number so the receipt QR stays
-- consistent with what the settings page saves.

SET search_path = public, extensions;

CREATE TABLE IF NOT EXISTS tenant_tax_settings (
  store_id           UUID PRIMARY KEY REFERENCES stores(id) ON DELETE CASCADE,
  tax_number         TEXT NOT NULL DEFAULT '',
  istd_client_id     TEXT NOT NULL DEFAULT '',
  istd_client_secret TEXT NOT NULL DEFAULT '',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Strict: credentials are server-side only. The API routes run with the
-- service-role key; no anon/authenticated role may touch the secret.
ALTER TABLE tenant_tax_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE tenant_tax_settings FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE tenant_tax_settings TO service_role;

CREATE OR REPLACE FUNCTION touch_tenant_tax_settings_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, extensions
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tenant_tax_settings_updated_at ON tenant_tax_settings;
CREATE TRIGGER trg_tenant_tax_settings_updated_at
BEFORE UPDATE ON tenant_tax_settings
FOR EACH ROW EXECUTE FUNCTION touch_tenant_tax_settings_updated_at();
