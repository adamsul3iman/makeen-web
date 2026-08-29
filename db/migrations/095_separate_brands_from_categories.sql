-- ============================================================
-- Migration 095: Separate Brands from POS Categories
-- ============================================================
-- PURPOSE
--   Product "categories" (public.categories) drive POS cashier navigation.
--   "Brands/Suppliers" (public.product_brands) are used for reporting and
--   filtering ONLY. Over time, brand/supplier names (e.g. "ديماس", "الفجر",
--   "علب كريستال") were accidentally entered as category rows, so they appear
--   as navigation categories in the POS.
--
--   This migration is NON-DESTRUCTIVE. It does NOT re-parent or delete any
--   category. It only:
--     1. Deletes nothing.
--     2. Sets show_in_pos = false on any category whose Arabic-normalized
--        name EXACTLY matches an existing brand name, so those rows stop
--        appearing in POS cashier navigation immediately. The category row
--        and its products are left untouched.
--
--   To permanently resolve the data: use the Admin > Categories page to
--   reassign affected products to the correct genuine category, then delete
--   the leftover brand-named category row (or rename it to a real category).
--   Never add a brand name as a category — the app now guards against this.
--
-- IDEMPOTENT: safe to re-run. Re-running only hides the same rows again.
-- ============================================================

BEGIN;

SET search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- STEP 1: Inline Arabic normalization helper (mirrors lib/arabic.ts)
--   - strip tashkeel / tatweel / superscript alef
--   - collapse  أ إ آ -> ا   ,    ة -> ه   ,   ى -> ي
--   - lowercase + trim
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_arabic_category_norm(input TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT lower(btrim(
    translate(
      regexp_replace(input, '[\u064B-\u065F\u0670]', '', 'g'),
      'أإآةى',
      'ااهي'
    )
  ))
$$;

-- ---------------------------------------------------------------------------
-- STEP 2: Preview (review before applying) — run this first if you want to
-- see exactly which categories match a brand name.
-- ---------------------------------------------------------------------------
-- SELECT c.id, c.name AS category_name, b.name AS brand_name, c.show_in_pos
-- FROM public.categories c
-- JOIN public.product_brands b
--   ON b.store_id = c.store_id
--  AND fn_arabic_category_norm(b.name) = fn_arabic_category_norm(c.name)
-- ORDER BY c.store_id, c.name;

-- ---------------------------------------------------------------------------
-- STEP 3: Hide brand-named categories from POS navigation only.
-- ---------------------------------------------------------------------------
UPDATE public.categories c
SET show_in_pos = false
WHERE c.show_in_pos IS NOT FALSE
  AND EXISTS (
    SELECT 1
    FROM public.product_brands b
    WHERE b.store_id = c.store_id
      AND fn_arabic_category_norm(b.name) = fn_arabic_category_norm(c.name)
  );

COMMIT;
