import { rateLimit, rateLimited } from "@/lib/rateLimit";

/**
 * Store provisioning is a platform-owner action.
 *
 * Merchants no longer self-serve on /register: a store may only be created
 * through the Super Admin console (/super-admin, PIN-gated) which calls
 * POST /api/admin/stores. This endpoint is kept as a closed door so old
 * clients / bots get a clear, authenticated-looking response instead of a
 * 404, and the provisioning RPC is never reachable publicly.
 */

export async function POST(request: Request): Promise<Response> {
  const gate = rateLimit(request, "register:blocked", 10, 60 * 1000);
  if (!gate.ok) return rateLimited(gate.retryAfter ?? 1);

  return Response.json(
    { error: "إنشاء المتاجر يتم عبر لوحة مدير النظام فقط" },
    { status: 403 },
  );
}
