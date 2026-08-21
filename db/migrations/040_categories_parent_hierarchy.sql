-- 040_categories_parent_hierarchy.sql
-- Canonical adjacency-list categories for infinite parent/child nesting.
-- Existing product references stay intact; deleting a parent category is now
-- restricted until its children are moved or removed explicitly.

ALTER TABLE public.categories
  ADD COLUMN IF NOT EXISTS parent_id UUID;

ALTER TABLE public.categories
  DROP CONSTRAINT IF EXISTS categories_parent_id_fkey;

ALTER TABLE public.categories
  ADD CONSTRAINT categories_parent_id_fkey
  FOREIGN KEY (parent_id) REFERENCES public.categories(id) ON DELETE RESTRICT;

ALTER TABLE public.categories
  DROP CONSTRAINT IF EXISTS categories_parent_id_self_check;

ALTER TABLE public.categories
  ADD CONSTRAINT categories_parent_id_self_check
  CHECK (parent_id IS NULL OR parent_id <> id);

CREATE INDEX IF NOT EXISTS idx_categories_store_parent_sort
  ON public.categories (store_id, parent_id, sort_order, name);
