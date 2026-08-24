-- 078_staff_security_rpc.sql
-- P0 remediation: closes the cashiers takeover chain (SECURITY_AND_FRAUD_AUDIT
-- C1/C5, NIGHT_AUDIT_REPORT F-01/F-05, roadmap step 2 of REMEDIATION SESSION 1).
--
-- Problem: migrations 071:21-22 / 072:1313 grant SELECT+INSERT+UPDATE+DELETE on
-- cashiers to anon,authenticated and the table has NO RLS. The anon key ships
-- inside the static bundle, so anyone on the internet can
--   UPDATE cashiers SET role='admin', password_hash=<self-made bcrypt> ...
-- and take over any tenant, plus read every pin_salt/pin_hash/password_hash.
--
-- Fix strategy ("proof-per-call", approved 2026-08-24):
--   * Staff CRUD moves into SECURITY DEFINER RPCs that re-verify the acting
--     ADMIN's email+password (pgcrypto crypt/bf) inside the function and are
--     scoped to one store. No persistent tokens are issued.
--   * Staff PIN verification becomes a SECURITY DEFINER RPC returning ONLY
--     safe columns (id/name/role/capabilities). Hash material never leaves the
--     database EXCEPT the matched cashier's own verifier, returned on a
--     successful verification so the device can cache THE ACTIVE CASHIER's
--     verifier for offline re-unlock (business requirement: an open shift must
--     survive Wi-Fi loss). The full roster is never exposed again.
--   * Online brute force is throttled server-side (5 fails -> 15 min lock per
--     store+subject). inet_client_addr() is null behind Supabase poolers, so
--     scoping is store+username/email, not IP.
--   * Direct table access dies: REVOKE all role grants, ENABLE RLS with zero
--     policies (deny-all for anon/authenticated; service_role and the table
--     owner used by SECURITY DEFINER bypass RLS as before).
--   * Owner login-email changes move behind admin proof too
--     (admin_update_owner_email): settings no longer rewrite cashiers.email
--     silently — that column IS the owner's dashboard login identity.
--
-- Compatibility: pure SQL/RPC. Identical behaviour for the Electron static
-- export today and Capacitor (iOS/Android) later — the browser talks to
-- PostgREST either way.
--
-- Requirements:
--   * 076 applied first (plaintext pin column dropped, pin_hash backfilled).
--   * pgcrypto (digest/gen_random_bytes/crypt) — same extensions schema used
--     since 016.
-- Idempotent: CREATE TABLE IF NOT EXISTS / CREATE OR REPLACE FUNCTION /
-- re-grants are replay-safe.

BEGIN;

SET search_path = public, extensions;

-- ─────────────────────────────────────────────────────── 1. throttle table ──
-- Server-side brute-force ledger for PIN + admin-password RPC attempts.
-- Keyed by "<kind>:<store_id>:<subject>" where subject is the username (PIN)
-- or email (password). Never exposed to clients.
CREATE TABLE IF NOT EXISTS staff_pin_throttle (
  scope        text PRIMARY KEY,
  fail_count   integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

REVOKE ALL ON staff_pin_throttle FROM anon, authenticated;

-- Max consecutive failures before a temporary lock.
CREATE OR REPLACE FUNCTION _staff_throttle_max_attempts() RETURNS integer
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT 5
$$;

-- Lock duration once the attempt budget is exhausted.
CREATE OR REPLACE FUNCTION _staff_throttle_lock_seconds() RETURNS integer
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT 900  -- 15 minutes
$$;

-- Returns remaining lock seconds for a scope (0 = not locked).
CREATE OR REPLACE FUNCTION _staff_throttle_locked_seconds(p_scope text)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_until timestamptz;
BEGIN
  DELETE FROM staff_pin_throttle
  WHERE updated_at < now() - interval '7 days';
  SELECT locked_until INTO v_until
  FROM staff_pin_throttle WHERE scope = p_scope;
  IF v_until IS NULL OR v_until <= now() THEN
    RETURN 0;
  END IF;
  RETURN CEIL(EXTRACT(EPOCH FROM (v_until - now())))::integer;
END;
$$;

-- Records one failure; locks the scope at the attempt budget.
CREATE OR REPLACE FUNCTION _staff_throttle_fail(p_scope text)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO staff_pin_throttle (scope, fail_count, updated_at)
  VALUES (p_scope, 1, now())
  ON CONFLICT (scope) DO UPDATE
    SET fail_count = CASE
          WHEN staff_pin_throttle.locked_until IS NOT NULL
            AND staff_pin_throttle.locked_until > now()
          THEN staff_pin_throttle.fail_count            -- frozen while locked
          ELSE staff_pin_throttle.fail_count + 1
        END,
    locked_until = CASE
          WHEN staff_pin_throttle.fail_count + 1 >= _staff_throttle_max_attempts()
            THEN now() + make_interval(secs => _staff_throttle_lock_seconds())
          ELSE staff_pin_throttle.locked_until
        END,
    updated_at = now();
END;
$$;

-- Clears failures after any successful verification.
CREATE OR REPLACE FUNCTION _staff_throttle_reset(p_scope text)
RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $$
  DELETE FROM staff_pin_throttle WHERE scope = p_scope
$$;

REVOKE EXECUTE ON FUNCTION
  _staff_throttle_max_attempts(),
  _staff_throttle_lock_seconds(),
  _staff_throttle_locked_seconds(text),
  _staff_throttle_fail(text),
  _staff_throttle_reset(text)
FROM PUBLIC, anon, authenticated;

-- ─────────────────────────────────────────────── 2. PIN verification RPC ────
-- Replaces the browser's roster download + local sha256 compare. Mirrors the
-- exact eligibility rules the client enforced until today:
--   * non-admin rows only (role <> 'admin' AND role <> 'مدير'),
--   * is_active rows only,
--   * optional exact username match,
--   * sha256(pin || salt) hex compare, falling back to the deterministic
--     per-store legacy salt sha256('pos:pin-salt:'||store_id)[1..16].
-- On success ALSO returns the matched cashier's own verifier so the register
-- can cache the ACTIVE cashier for offline unlock. Nothing else ever exposes
-- pin_salt/pin_hash again.
CREATE OR REPLACE FUNCTION verify_staff_pin(
  p_store_id  uuid DEFAULT NULL,
  p_store_code text DEFAULT NULL,
  p_username  text DEFAULT NULL,
  -- 42P13: every parameter after the first defaulted one needs a default too.
  -- NULL pin short-circuits to {"status":"invalid"} in the body.
  p_pin       text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  v_store       stores%ROWTYPE;
  v_fallback    text;
  v_scope       text;
  v_locked      integer;
  v_row         cashiers%ROWTYPE;
  v_role        staff_roles%ROWTYPE;
  v_effective   text;   -- salt actually used for the stored hash
BEGIN
  IF p_pin IS NULL OR btrim(p_pin) = '' THEN
    RETURN jsonb_build_object('status', 'invalid');
  END IF;

  -- Resolve the store exactly like the client did (id preferred, else code).
  IF p_store_id IS NOT NULL THEN
    SELECT * INTO v_store FROM stores WHERE id = p_store_id;
  ELSIF p_store_code IS NOT NULL THEN
    SELECT * INTO v_store FROM stores
    WHERE code = upper(btrim(p_store_code));
  ELSE
    RETURN jsonb_build_object('status', 'invalid');
  END IF;

  IF v_store.id IS NULL THEN
    RETURN jsonb_build_object('status', 'invalid_store');
  END IF;
  IF v_store.subscription_status = 'suspended' THEN
    RETURN jsonb_build_object('status', 'store_suspended');
  END IF;

  -- Throttle key: one bucket per store+username (anonymous attempts share the
  -- '·' bucket so spraying across usernames cannot evade the budget).
  v_scope := 'pin:' || v_store.id::text || ':' ||
             COALESCE(lower(btrim(COALESCE(p_username, ''))), '·');
  v_locked := _staff_throttle_locked_seconds(v_scope);
  IF v_locked > 0 THEN
    RETURN jsonb_build_object('status', 'locked', 'retry_after_seconds', v_locked);
  END IF;

  v_fallback := substr(
    encode(digest('pos:pin-salt:' || v_store.id::text, 'sha256'), 'hex'), 1, 16);

  SELECT * INTO v_row
  FROM cashiers c
  WHERE c.store_id = v_store.id
    AND c.role IS DISTINCT FROM 'admin'
    AND c.role IS DISTINCT FROM 'مدير'
    AND (c.is_active IS TRUE OR c.is_active IS NULL)
    AND c.pin_hash IS NOT NULL
    AND (
      p_username IS NULL
      OR lower(btrim(c.username)) = lower(btrim(p_username))
    )
    AND c.pin_hash = encode(
      digest(p_pin || COALESCE(c.pin_salt, v_fallback), 'sha256'), 'hex')
  LIMIT 1;

  IF NOT FOUND THEN
    -- Suspended accounts stay discoverable so the UI can say "الحساب موقوف"
    -- instead of a generic wrong-PIN error (parity with the previous flow).
    IF p_username IS NOT NULL AND EXISTS (
      SELECT 1 FROM cashiers c
      WHERE c.store_id = v_store.id
        AND c.role IS DISTINCT FROM 'admin'
        AND c.role IS DISTINCT FROM 'مدير'
        AND c.is_active = FALSE
        AND lower(btrim(c.username)) = lower(btrim(p_username))
    ) THEN
      RETURN jsonb_build_object('status', 'account_suspended');
    END IF;

    PERFORM _staff_throttle_fail(v_scope);
    RETURN jsonb_build_object(
      'status', 'invalid',
      'retry_after_seconds', _staff_throttle_locked_seconds(v_scope)
    );
  END IF;

  PERFORM _staff_throttle_reset(v_scope);

  v_effective := COALESCE(v_row.pin_salt, v_fallback);
  IF v_row.role_id IS NOT NULL THEN
    SELECT * INTO v_role FROM staff_roles r
    WHERE r.id = v_row.role_id AND r.store_id = v_store.id;
  END IF;

  RETURN jsonb_build_object(
    'status', 'ok',
    'cashier', jsonb_build_object(
      'id',       v_row.id,
      'name',     v_row.name,
      'username', v_row.username,
      'role',     v_row.role,
      'role_id',  v_row.role_id
    ),
    'role', CASE
      WHEN v_role.id IS NULL THEN NULL
      ELSE jsonb_build_object(
        'id',           v_role.id,
        'code',         v_role.code,
        'name',         v_role.name,
        'capabilities', to_jsonb(v_role.capabilities),
        'limits',       to_jsonb(v_role.limits)
      )
    END,
    -- Active-cashier offline-unlock material (see header). Single cashier,
    -- issued only over TLS after a verified match, never part of any listing.
    'verifier', jsonb_build_object(
      'salt', v_effective,
      'hash', v_row.pin_hash
    )
  );
END;
$$;

-- ────────────────────────────────────────────── 3. safe roster listing RPC ──
-- Feeds the Sales-Ledger cashier filter and the admin staff page. Safe columns
-- only — no email, no pin_salt/pin_hash/password_hash.
CREATE OR REPLACE FUNCTION list_cashiers_public(
  p_store_id        uuid,
  p_include_inactive boolean DEFAULT FALSE
) RETURNS TABLE (
  id         uuid,
  name       text,
  username   text,
  role       text,
  role_id    uuid,
  is_active  boolean
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  -- NOTE: cashiers has no created_at column in this deployment, so ordering
  -- and the returned shape use name only.
  SELECT c.id, c.name, c.username, c.role, c.role_id, c.is_active
  FROM cashiers c
  WHERE c.store_id = p_store_id
    AND (p_include_inactive OR c.is_active IS NOT FALSE)
    AND c.role IS DISTINCT FROM 'admin'      -- owner never appears in rosters
    AND c.role IS DISTINCT FROM 'مدير'
  ORDER BY c.name ASC
$$;

-- ──────────────────────────────────────── 4. admin-proof helper (private) ───
-- Shared "proof-per-call" credential check: resolves the store-scoped admin
-- cashier row and verifies its bcrypt password hash via pgcrypto crypt().
-- Returns the admin row id, or NULL on failure. Callers translate NULL into
-- {'error':'invalid_admin_credentials'}.
CREATE OR REPLACE FUNCTION _staff_assert_store_admin(
  p_store_id      uuid,
  p_admin_email   text,
  p_admin_password text
) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  v_admin_id uuid;
BEGIN
  IF p_admin_email IS NULL OR p_admin_password IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT c.id INTO v_admin_id
  FROM cashiers c
  WHERE c.store_id = p_store_id
    AND c.role = 'admin'
    AND c.email IS NOT NULL
    AND c.password_hash IS NOT NULL
    AND lower(c.email) = lower(btrim(p_admin_email))
    AND c.password_hash = crypt(p_admin_password, c.password_hash)
  LIMIT 1;
  RETURN v_admin_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION
  _staff_assert_store_admin(uuid, text, text)
FROM PUBLIC, anon, authenticated;

-- ───────────────────────────────────────────── 5. staff management RPCs ─────
-- Each folds the SecondaryAuthModal password proof INTO the write itself: one
-- round-trip, no direct table DML from browsers, no window between "verified"
-- and "written". Store-scoped: an admin of another store can never pass.

CREATE OR REPLACE FUNCTION admin_create_cashier(
  p_store_id       uuid,
  p_admin_email    text,
  p_admin_password text,
  p_name           text,
  p_role           text,
  p_username       text DEFAULT NULL,
  p_role_id        uuid DEFAULT NULL,
  p_pin            text DEFAULT NULL,
  p_is_active      boolean DEFAULT TRUE
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  v_admin    uuid;
  v_scope    text;
  v_locked   integer;
  v_salt     text;
  v_row      cashiers%ROWTYPE;
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

  IF p_name IS NULL OR btrim(p_name) = '' THEN
    RETURN jsonb_build_object('error', 'name_required');
  END IF;
  IF p_role IS NULL OR btrim(p_role) = '' THEN
    RETURN jsonb_build_object('error', 'role_required');
  END IF;

  v_salt := encode(gen_random_bytes(8), 'hex');   -- 16 hex chars, client parity

  INSERT INTO cashiers (store_id, name, username, role, role_id,
                        pin_salt, pin_hash, is_active)
  VALUES (
    p_store_id,
    btrim(p_name),
    NULLIF(lower(btrim(COALESCE(p_username, ''))), ''),
    btrim(p_role),
    p_role_id,
    CASE WHEN p_pin IS NOT NULL AND btrim(p_pin) <> '' THEN v_salt END,
    CASE WHEN p_pin IS NOT NULL AND btrim(p_pin) <> ''
         THEN encode(digest(btrim(p_pin) || v_salt, 'sha256'), 'hex') END,
    COALESCE(p_is_active, TRUE)
  )
  RETURNING * INTO v_row;

  RETURN jsonb_build_object(
    'id', v_row.id, 'name', v_row.name, 'username', v_row.username,
    'role', v_row.role, 'role_id', v_row.role_id,
    'is_active', v_row.is_active
  );
EXCEPTION
  WHEN unique_violation THEN
    RETURN jsonb_build_object('error', 'duplicate_username');
END;
$$;

CREATE OR REPLACE FUNCTION admin_update_cashier(
  p_store_id       uuid,
  p_admin_email    text,
  p_admin_password text,
  p_cashier_id     uuid,
  p_name           text DEFAULT NULL,
  p_username       text DEFAULT NULL,
  p_role           text DEFAULT NULL,
  p_role_id        uuid DEFAULT NULL,
  p_is_active      boolean DEFAULT NULL,
  p_pin            text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  v_admin  uuid;
  v_scope  text;
  v_locked integer;
  v_salt   text;
  v_row    cashiers%ROWTYPE;
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

  SELECT * INTO v_row FROM cashiers
  WHERE id = p_cashier_id AND store_id = p_store_id;
  IF v_row.id IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;

  -- Rotate the verifier material exactly once so the stored salt is the salt
  -- that was hashed with (byte-compatible with the browser's offline check:
  -- sha256(pin + salt) hex).
  IF p_pin IS NOT NULL AND btrim(p_pin) <> '' THEN
    v_salt := encode(gen_random_bytes(8), 'hex');  -- 16 hex chars, client parity
  END IF;

  UPDATE cashiers c SET
    name      = COALESCE(NULLIF(btrim(p_name), ''), c.name),
    username  = COALESCE(NULLIF(lower(btrim(p_username)), ''), c.username),
    role      = COALESCE(NULLIF(btrim(p_role), ''), c.role),
    role_id   = COALESCE(p_role_id, c.role_id),
    is_active = COALESCE(p_is_active, c.is_active),
    pin_salt  = COALESCE(v_salt, c.pin_salt),
    pin_hash  = CASE
                  WHEN v_salt IS NOT NULL THEN
                    encode(digest(btrim(p_pin) || v_salt, 'sha256'), 'hex')
                  ELSE c.pin_hash
                END
  WHERE c.id = p_cashier_id AND c.store_id = p_store_id
  RETURNING * INTO v_row;

  RETURN jsonb_build_object(
    'id', v_row.id, 'name', v_row.name, 'username', v_row.username,
    'role', v_row.role, 'role_id', v_row.role_id,
    'is_active', v_row.is_active
  );
EXCEPTION
  WHEN unique_violation THEN
    RETURN jsonb_build_object('error', 'duplicate_username');
END;
$$;

CREATE OR REPLACE FUNCTION admin_delete_cashier(
  p_store_id       uuid,
  p_admin_email    text,
  p_admin_password text,
  p_cashier_id     uuid
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  v_admin  uuid;
  v_scope  text;
  v_locked integer;
  v_role   text;
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

  SELECT role INTO v_role FROM cashiers
  WHERE id = p_cashier_id AND store_id = p_store_id;
  IF v_role IS NULL THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  IF v_role = 'admin' OR v_role = 'مدير' THEN
    RETURN jsonb_build_object('error', 'cannot_delete_admin');
  END IF;

  DELETE FROM cashiers WHERE id = p_cashier_id AND store_id = p_store_id;
  RETURN jsonb_build_object('ok', TRUE);
END;
$$;

-- Owner login-email change (settings screen). The admin row's email IS the
-- dashboard login identity, so it must never be writable without proof.
-- Atomic: cashiers.email + stores.email move together in one transaction.
CREATE OR REPLACE FUNCTION admin_update_owner_email(
  p_store_id       uuid,
  p_admin_email    text,
  p_admin_password text,
  p_new_email      text
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  v_admin     uuid;
  v_scope     text;
  v_locked    integer;
  v_new_email text;
BEGIN
  v_scope := 'admin:' || p_store_id::text || ':' || lower(btrim(COALESCE(p_admin_email, '')));
  v_locked := _staff_throttle_locked_seconds(v_scope);
  IF v_locked > 0 THEN
    RETURN jsonb_build_object('error', 'locked', 'retry_after_seconds', v_locked);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM stores WHERE id = p_store_id) THEN
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  IF (SELECT subscription_status FROM stores WHERE id = p_store_id) = 'suspended' THEN
    RETURN jsonb_build_object('error', 'store_inactive');
  END IF;

  v_admin := _staff_assert_store_admin(p_store_id, p_admin_email, p_admin_password);
  IF v_admin IS NULL THEN
    PERFORM _staff_throttle_fail(v_scope);
    RETURN jsonb_build_object('error', 'invalid_admin_credentials');
  END IF;
  PERFORM _staff_throttle_reset(v_scope);

  v_new_email := lower(btrim(COALESCE(p_new_email, '')));
  IF v_new_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
    RETURN jsonb_build_object('error', 'invalid_email');
  END IF;

  -- uq_cashiers_email is global across tenants; keep honouring it here so the
  -- friendly error surfaces before the constraint does.
  IF EXISTS (
    SELECT 1 FROM cashiers c
    WHERE c.email = v_new_email AND c.id <> v_admin
  ) THEN
    RETURN jsonb_build_object('error', 'duplicate_email');
  END IF;

  UPDATE cashiers SET email = v_new_email WHERE id = v_admin;
  UPDATE stores  SET email = v_new_email WHERE id = p_store_id;
  RETURN jsonb_build_object('ok', TRUE);
END;
$$;

-- ────────────────────────────────────────────── 6. grants on the new RPCs ───
REVOKE EXECUTE ON FUNCTION
  verify_staff_pin(uuid, text, text, text),
  list_cashiers_public(uuid, boolean),
  admin_create_cashier(uuid, text, text, text, text, text, uuid, text, boolean),
  admin_update_cashier(uuid, text, text, uuid, text, text, text, uuid, boolean, text),
  admin_delete_cashier(uuid, text, text, uuid),
  admin_update_owner_email(uuid, text, text, text)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION verify_staff_pin(uuid, text, text, text)
  TO anon, authenticated;
GRANT EXECUTE ON FUNCTION list_cashiers_public(uuid, boolean)
  TO anon, authenticated;
GRANT EXECUTE ON FUNCTION
  admin_create_cashier(uuid, text, text, text, text, text, uuid, text, boolean),
  admin_update_cashier(uuid, text, text, uuid, text, text, text, uuid, boolean, text),
  admin_delete_cashier(uuid, text, text, uuid),
  admin_update_owner_email(uuid, text, text, text)
TO anon, authenticated;

-- ──────────────────────────────────────── 7. close the takeover chain ───────
-- After the RPC family above exists, direct table access is pure attack
-- surface. RLS enabled with ZERO policies = deny-all for anon/authenticated
-- (service_role and the definer owner keep working: seed/provision functions
-- and scripts unaffected).
REVOKE ALL ON cashiers FROM anon;
REVOKE ALL ON cashiers FROM authenticated;
ALTER TABLE cashiers ENABLE ROW LEVEL SECURITY;

COMMIT;
