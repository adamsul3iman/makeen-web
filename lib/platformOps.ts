/**
 * Server-only shared secret for the token-gated RPC functions (migration 015).
 *
 * The privileged SQL functions (provision_new_store, authenticate_admin,
 * update_admin_credentials, delete_store) refuse to run unless the caller
 * passes a token that matches `platform_secrets.ops_token`. That token lives
 * ONLY here (process.env.PLATFORM_OPS_SECRET, never shipped to the browser),
 * so direct calls through the public PostgREST endpoint are impossible and
 * every privileged path must go through a Next.js route that enforces its own
 * gates (super-admin PIN, admin password, rate limiting).
 */

export function opsToken(): string {
  return process.env.PLATFORM_OPS_SECRET ?? "";
}
