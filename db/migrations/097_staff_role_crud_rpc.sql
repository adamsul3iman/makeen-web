-- 097_staff_role_crud_rpc.sql
-- Role-level RBAC editing for the staff management surface.
--
-- Problem: staff_roles carries capabilities TEXT[] + limits JSONB (migration
-- 045) but browsers only ever got SELECT (migrations 071/072). An owner who
-- wants a tailored cashier role — e.g. a cashier allowed a 15% discount but
-- no refunds — has no supported path: there is no DML grant, enabling one
-- would reopen the takeover surface migration 078 closed, and the old page
-- had no role editor at all.
--
-- Fix (same "proof-per-call" contract as 078):
--   * Role create / update / delete become SECURITY DEFINER RPCs that re-verify
--     the acting ADMIN's email+password inside the function and are scoped to
--     one store. No persistent tokens, no direct table DML from browsers.
--   * System roles (is_system) cannot be deleted; roles still assigned to a
--     cashier cannot be deleted. A role's code is immutable (cashiers.role
--     stores the code textually and normalizing code is what the client POS
--     caches), so only name / description / capabilities / limits are editable.
--   * Capabilities are validated structurally (no empty, no uppercase, no
--     whitespace, max 64) and deduped. This grants nothing by itself: the
--     client's `hasCapability` filters through STAFF_CAPABILITIES, so junk
--     strings are inert. limits must stay a JSON object (column CHECK).
--   * Admin password throttling reuses the 078 ledger (5 fails -> 15 min lock
--     per store+email).
--
-- Compatibility: pure SQL/RPC; browser keeps talking to PostgREST.
-- Idempotent: CREATE OR REPLACE FUNCTION / re-grants are replay-safe.
--
-- Requires: 078 applied (throttle helpers + _staff_assert_store_admin).

BEGIN;

SET search_path = public, extensions;

-- ─────────────────────────────── 1. capability / limits helpers (private) ───
-- Structural validation only; see header for why unknown strings are inert.
-- Non-STRICT: a NULL array must FAIL validation (not short-circuit as NULL),
-- otherwise the NOT NULL column turns it into a 500 instead of a clean error.
CREATE OR REPLACE FUNCTION _staff_role_capabilities_valid(p_capabilities text[])
RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT (
    p_capabilities IS NOT NULL
    AND (cardinality(p_capabilities) IS NULL OR cardinality(p_capabilities) <= 64)
    AND NOT EXISTS (
      SELECT 1
      FROM unnest(p_capabilities) AS cap
      WHERE cap IS NULL
         OR btrim(cap) = ''
         OR cap !~ '^[a-z][a-z0-9_.]*$'
    )
  )
$$;

-- Stable ordering + dedupe so toggling a capability on/off never churns arrays.
-- Defensive NULL handling: validation guarantees non-NULL before this runs.
CREATE OR REPLACE FUNCTION _staff_role_dedupe_capabilities(p_capabilities text[])
RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT COALESCE(
    ARRAY(
      SELECT DISTINCT cap
      FROM unnest(p_capabilities) AS cap
      ORDER BY cap
    ),
    ARRAY[]::text[]
  )
$$;

CREATE OR REPLACE FUNCTION _staff_role_limits_valid(p_limits jsonb)
RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT SET search_path = public AS $$
  SELECT jsonb_typeof(p_limits) = 'object'
$$;

REVOKE EXECUTE ON FUNCTION
  _staff_role_capabilities_valid(text[]),
  _staff_role_dedupe_capabilities(text[]),
  _staff_role_limits_valid(jsonb)
FROM PUBLIC, anon, authenticated;

-- ──────────────────────────────── 2. role management RPCs ───────────────────
-- Each folds the secondary-auth password proof INTO the write (one round-trip,
-- no window between "verified" and "written"), exactly like 078.

CREATE OR REPLACE FUNCTION admin_create_staff_role(
  p_store_id        uuid,
  p_admin_email     text,
  p_admin_password  text,
  p_code            text,
  p_name            text,
  p_description     text,
  p_capabilities    text[],
  p_limits          jsonb
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  v_admin  uuid;
  v_scope  text;
  v_locked integer;
  v_code   text;
  v_name   text;
  v_desc   text;
  v_caps   text[];
  v_limits jsonb;
  v_row    staff_roles%ROWTYPE;
BEGIN
  v_scope := 'admin:' || p_store_id::text || ':' || lower(btrim(COALESCE(p_admin_email, '')));
  v_locked := _staff_throttle_locked_seconds(v_scope);
  IF v_locked > 0 THEN
    RETURN jsonb_build_object('error', 'locked', 'retry_after_seconds', v_locked);
  END IF;

  v_admin := _staff_assert_store_admin(p_store_id, p_admin_email, p_admin_password);
  IF v_admin IS NULL THEN
    PERFORM _staff_throttle_fail(v_scope);
    RETURN jsonb_build_object('error', 'invalid_admin_credentials');
  END IF;
  PERFORM _staff_throttle_reset(v_scope);

  v_code := lower(btrim(COALESCE(p_code, '')));
  v_name := btrim(COALESCE(p_name, ''));
  v_desc := COALESCE(p_description, '');
  v_limits := COALESCE(p_limits, '{}'::jsonb);

  IF v_code = '' OR v_code !~ '^[a-z][a-z0-9_]*$' THEN
    RETURN jsonb_build_object('error', 'code_invalid');
  END IF;
  IF v_name = '' THEN
    RETURN jsonb_build_object('error', 'name_required');
  END IF;
  IF NOT _staff_role_capabilities_valid(p_capabilities) THEN
    RETURN jsonb_build_object('error', 'capabilities_invalid');
  END IF;
  IF NOT _staff_role_limits_valid(v_limits) THEN
    RETURN jsonb_build_object('error', 'limits_invalid');
  END IF;

  v_caps := _staff_role_dedupe_capabilities(p_capabilities);

  INSERT INTO staff_roles (store_id, code, name, description, capabilities, limits, is_system, sort_order)
  VALUES (
    p_store_id, v_code, v_name, v_desc, v_caps, v_limits, FALSE,
    COALESCE((SELECT max(sort_order) FROM staff_roles WHERE store_id = p_store_id), 0) + 10
  )
  RETURNING * INTO v_row;

  RETURN jsonb_build_object(
    'id', v_row.id, 'code', v_row.code, 'name', v_row.name,
    'description', v_row.description,
    'capabilities', to_jsonb(v_row.capabilities),
    'limits', v_row.limits,
    'is_system', v_row.is_system
  );
EXCEPTION
  WHEN unique_violation THEN
    RETURN jsonb_build_object('error', 'duplicate_code');
END;
$$;

CREATE OR REPLACE FUNCTION admin_update_staff_role(
  p_store_id        uuid,
  p_admin_email     text,
  p_admin_password  text,
  p_role_id         uuid,
  p_name            text,
  p_description     text,
  p_capabilities    text[],
  p_limits          jsonb
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  v_admin  uuid;
  v_scope  text;
  v_locked integer;
  v_name   text;
  v_desc   text;
  v_limits jsonb;
  v_row    staff_roles%ROWTYPE;
BEGIN
  v_scope := 'admin:' || p_store_id::text || ':' || lower(btrim(COALESCE(p_admin_email, '')));
  v_locked := _staff_throttle_locked_seconds(v_scope);
  IF v_locked > 0 THEN
    RETURN jsonb_build_object('error', 'locked', 'retry_after_seconds', v_locked);
  END IF;

  v_admin := _staff_assert_store_admin(p_store_id, p_admin_email, p_admin_password);
  IF v_admin IS NULL THEN
    PERFORM _staff_throttle_fail(v_scope);
    RETURN jsonb_build_object('error', 'invalid_admin_credentials');
  END IF;
  PERFORM _staff_throttle_reset(v_scope);

  v_name := btrim(COALESCE(p_name, ''));
  v_desc := COALESCE(p_description, '');
  v_limits := COALESCE(p_limits, '{}'::jsonb);

  IF v_name = '' THEN
    RETURN jsonb_build_object('error', 'name_required');
  END IF;
  IF NOT _staff_role_capabilities_valid(p_capabilities) THEN
    RETURN jsonb_build_object('error', 'capabilities_invalid');
  END IF;
  IF NOT _staff_role_limits_valid(v_limits) THEN
    RETURN jsonb_build_object('error', 'limits_invalid');
  END IF;

  SELECT * INTO v_row FROM staff_roles
  WHERE id = p_role_id AND store_id = p_store_id;
  IF v_row.id IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  -- code / is_system / sort_order are never edited by a role update.
  UPDATE staff_roles SET
    name          = v_name,
    description   = v_desc,
    capabilities  = _staff_role_dedupe_capabilities(p_capabilities),
    limits        = v_limits,
    updated_at    = now()
  WHERE id = p_role_id AND store_id = p_store_id
  RETURNING * INTO v_row;

  RETURN jsonb_build_object(
    'id', v_row.id, 'code', v_row.code, 'name', v_row.name,
    'description', v_row.description,
    'capabilities', to_jsonb(v_row.capabilities),
    'limits', v_row.limits,
    'is_system', v_row.is_system
  );
END;
$$;

CREATE OR REPLACE FUNCTION admin_delete_staff_role(
  p_store_id        uuid,
  p_admin_email     text,
  p_admin_password  text,
  p_role_id         uuid
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  v_admin  uuid;
  v_scope  text;
  v_locked integer;
  v_row    staff_roles%ROWTYPE;
BEGIN
  v_scope := 'admin:' || p_store_id::text || ':' || lower(btrim(COALESCE(p_admin_email, '')));
  v_locked := _staff_throttle_locked_seconds(v_scope);
  IF v_locked > 0 THEN
    RETURN jsonb_build_object('error', 'locked', 'retry_after_seconds', v_locked);
  END IF;

  v_admin := _staff_assert_store_admin(p_store_id, p_admin_email, p_admin_password);
  IF v_admin IS NULL THEN
    PERFORM _staff_throttle_fail(v_scope);
    RETURN jsonb_build_object('error', 'invalid_admin_credentials');
  END IF;
  PERFORM _staff_throttle_reset(v_scope);

  SELECT * INTO v_row FROM staff_roles
  WHERE id = p_role_id AND store_id = p_store_id;
  IF v_row.id IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  IF v_row.is_system THEN
    RETURN jsonb_build_object('error', 'cannot_delete_system');
  END IF;
  IF EXISTS (
    SELECT 1 FROM cashiers
    WHERE role_id = p_role_id AND store_id = p_store_id
  ) THEN
    RETURN jsonb_build_object('error', 'role_in_use');
  END IF;

  DELETE FROM staff_roles WHERE id = p_role_id AND store_id = p_store_id;
  RETURN jsonb_build_object('ok', TRUE);
END;
$$;

-- ──────────────────────────────────── 3. grants ─────────────────────────────
REVOKE EXECUTE ON FUNCTION
  admin_create_staff_role(uuid, text, text, text, text, text, text[], jsonb),
  admin_update_staff_role(uuid, text, text, uuid, text, text, text[], jsonb),
  admin_delete_staff_role(uuid, text, text, uuid)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
  admin_create_staff_role(uuid, text, text, text, text, text, text[], jsonb),
  admin_update_staff_role(uuid, text, text, uuid, text, text, text[], jsonb),
  admin_delete_staff_role(uuid, text, text, uuid)
TO anon, authenticated;

COMMIT;