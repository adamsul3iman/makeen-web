-- 001_initial_schema.sql
-- Local-First POS: categories / products / product_barcodes
-- Base-unit model: every product has a base_unit; each barcode row
-- carries a qty_multiplier (NUMERIC(10,3)) so packages (box/pack) and
-- weighed goods (e.g. 1.5 kg) resolve to base-unit quantities at scan time.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE categories (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL CHECK (name <> ''),
    parent_id   UUID REFERENCES categories(id) ON DELETE CASCADE,
    bg_color    TEXT,
    is_quick_key BOOLEAN NOT NULL DEFAULT FALSE,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    CHECK (parent_id <> id)
);

CREATE INDEX idx_categories_parent_id ON categories(parent_id);
CREATE INDEX idx_categories_quick_key ON categories(is_quick_key, sort_order);

CREATE TABLE products (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    category_id UUID NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    name        TEXT NOT NULL CHECK (name <> ''),
    base_unit   TEXT NOT NULL CHECK (base_unit <> ''),
    is_weighed  BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_products_category_id ON products(category_id);

CREATE TABLE product_barcodes (
    barcode        TEXT PRIMARY KEY,
    product_id     UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    unit_name      TEXT NOT NULL CHECK (unit_name <> ''),
    qty_multiplier NUMERIC(10,3) NOT NULL DEFAULT 1.000 CHECK (qty_multiplier > 0),
    price          NUMERIC(10,2) NOT NULL DEFAULT 0.00 CHECK (price >= 0),
    cost_price     NUMERIC(10,2) NOT NULL DEFAULT 0.00 CHECK (cost_price >= 0)
);

CREATE INDEX idx_product_barcodes_product_id ON product_barcodes(product_id);
