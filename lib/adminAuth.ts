import { supabase } from "@/lib/supabase";
import { MOCK_SUPER_ADMIN_PIN, SUPER_ADMIN_HEADER } from "@/lib/tenant";
import { rateLimit, rateLimited } from "@/lib/rateLimit";

/**
 * Server-only super-admin gate for the provisioning endpoints. In live mode
 * the `x-pos-super-admin-pin` header must match a `super_admins` row (the
 * platform owner, not a store's cashier); in mock mode the seeded pin 7777
 * is accepted so local provisioning stays testable.
 */
export async function isSuperAdmin(request: Request): Promise<boolean> {
  const pin = request.headers.get(SUPER_ADMIN_HEADER)?.trim();
  if (!pin) return false;
  if (!supabase) return pin === MOCK_SUPER_ADMIN_PIN;

  const { data } = await supabase
    .from("super_admins")
    .select("id")
    .eq("pin", pin)
    .maybeSingle();
  return data !== null;
}

/**
 * Verify the super-admin PIN and enforce the brute-force attempt budget.
 *
 * Only a PRESENT-but-WRONG PIN consumes the strict (IP-scoped) budget, so a
 * valid PIN holder — an authenticated platform operator — is never throttled:
 * listing stores, provisioning tenants and suspending stores work freely.
 * Requests without a PIN are not brute-force attempts (they fail 403
 * regardless) and never count against the budget.
 *
 * Returns a terminal Response (403/429) when the caller must be stopped, or
 * null when the caller is an authorized super-admin and may proceed.
 */
export async function requireSuperAdmin(request: Request): Promise<Response | null> {
  const pin = request.headers.get(SUPER_ADMIN_HEADER)?.trim();
  if (!pin) return superAdminDenied();
  if (await isSuperAdmin(request)) return null;
  // Mock mode has no real accounts to protect; skip so local tooling/tests
  // stay deterministic.
  if (!supabase) return superAdminDenied();
  const gate = rateLimit(request, "super-admin-pin-guess", 5, 15 * 60 * 1000);
  if (!gate.ok) return rateLimited(gate.retryAfter ?? 1);
  return superAdminDenied();
}

export function superAdminDenied(): Response {
  return Response.json(
    { error: "غير مصرح — صلاحية مدير النظام مطلوبة" },
    { status: 403 },
  );
}
