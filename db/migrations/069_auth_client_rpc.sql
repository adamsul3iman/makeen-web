-- 069_auth_client_rpc.sql
-- Client-safe admin authentication RPC for the Electron static export.
--
-- The existing `authenticate_admin(p_email, p_password, p_token)` is gated by
-- the server-only ops token, so it can never be called from the browser.  This
-- migration adds an overload WITHOUT the token parameter that can be invoked
-- by the public anon key through PostgREST.
--
-- SECURITY MODEL:
--   The function is SECURITY DEFINER so it runs with the owner's superuser
--   privileges (needed for bcrypt).  It still verifies the password via
--   crypt() and returns the same payload shape.  RLS is irrelevant here
--   because SECURITY DEFINER bypasses it — the function itself is the gate:
--   it only returns data after a successful bcrypt match.
--
--   Rate limiting moves to the client side (in-memory lockout in the Zustand
--   store) which is sufficient for an Electron desktop app.  A future hardening
--   step could add an IP-less server-side counter if needed.

CREATE OR REPLACE FUNCTION authenticate_admin_client(
  p_email    text,
  p_password text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_store_id       uuid;
  v_cashier_id     uuid;
  v_cashier_name   text;
  v_cashier_role   text;
  v_cashier_email  text;
  v_result         jsonb;
BEGIN
  SELECT c.store_id, c.id, c.name, c.role, c.email
    INTO v_store_id, v_cashier_id, v_cashier_name, v_cashier_role, v_cashier_email
  FROM cashiers c
  JOIN stores s ON s.id = c.store_id
  WHERE lower(c.email) = lower(p_email)
    AND c.role = 'admin'
    AND c.email IS NOT NULL
    AND c.password_hash IS NOT NULL
    AND c.password_hash = crypt(p_password, c.password_hash)
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT jsonb_build_object(
    'store_id', s.id,
    'cashier', jsonb_build_object(
      'id', v_cashier_id, 'name', v_cashier_name, 'role', v_cashier_role, 'email', v_cashier_email
    ),
    'store', jsonb_build_object(
      'id',                  s.id,
      'code',                s.code,
      'name',                s.name,
      'owner_name',          s.owner_name,
      'email',               s.email,
      'phone',               s.phone,
      'logo_url',            s.logo_url,
      'address',             s.address,
      'receipt_header',      s.receipt_header,
      'receipt_footer',      s.receipt_footer,
      'loyalty_enabled',     s.loyalty_enabled,
      'points_per_spend',    s.points_per_spend,
      'point_value',         s.point_value,
      'tax_percent',         s.tax_percent,
      'tax_number',          s.tax_number,
      'receipt_show_tax_number',     s.receipt_show_tax_number,
      'receipt_show_cashier_time',   s.receipt_show_cashier_time,
      'receipt_show_barcode_qr',     s.receipt_show_barcode_qr,
      'receipt_compact_spacing',     s.receipt_compact_spacing,
      'subscription_status', s.subscription_status
    ),
    'branches', coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', b.id, 'name', b.name) ORDER BY b.created_at)
      FROM branches b WHERE b.store_id = s.id
    ), '[]'::jsonb),
    'terminals', coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', t.id, 'branch_id', t.branch_id, 'name', t.name) ORDER BY t.created_at)
      FROM terminals t JOIN branches b ON t.branch_id = b.id WHERE b.store_id = s.id
    ), '[]'::jsonb)
  ) INTO v_result
  FROM stores s
  WHERE s.id = v_store_id;

  RETURN v_result;
END;
$$;

-- Allow the public anon role to invoke the client-safe overload.
GRANT EXECUTE ON FUNCTION authenticate_admin_client(text, text) TO anon, authenticated;
