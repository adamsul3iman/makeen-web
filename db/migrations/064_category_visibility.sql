-- 064_category_visibility.sql
-- Add show_in_pos flag to categories so the store owner can hide
-- entire category trees from the POS terminal without deleting them.

ALTER TABLE categories
  ADD COLUMN IF NOT EXISTS show_in_pos BOOLEAN NOT NULL DEFAULT TRUE;
