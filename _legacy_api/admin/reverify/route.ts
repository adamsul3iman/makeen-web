import { supabase } from "@/lib/supabase";
import { opsToken } from "@/lib/platformOps";
import { getAdminSession } from "@/lib/adminSession";
import { getDeviceSession } from "@/lib/deviceSession";
import { rateLimit, rateLimited } from "@/lib/rateLimit";

/**
 * Secondary authentication for destructive POS actions.
 *
 * The admin session persisted in the store only carries `{ storeId, email,
 * name }` — never the password. Destructive operations that have no server
 * write of their own (opening the cash drawer, cancelling a completed
 * invoice, which only enqueues a local reversal) must re-confirm the owner's
 * dashboard password before executing. This endpoint re-verifies those
 * credentials and returns a thin 200/401, mirroring the `authenticate_admin`
 * check used by /api/admin/login.
 */

const MOCK_ADMIN_EMAIL = "admin@demo.test";
const MOCK_ADMIN_PASSWORD = "12345678";

interface ReverifyInput {
  email?: unknown;
  password?: unknown;
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const input = body as ReverifyInput;
  const password = typeof input.password === "string" ? input.password : "";

  const session = await getAdminSession(request);
  const device = session ? null : await getDeviceSession(request);
  if (!session && !device) {
    return Response.json({ error: "غير مصرح — سجّل دخول كمدير المتجر" }, { status: 401 });
  }
  const storeId = session?.storeId ?? device?.storeId ?? "";

  if (!password) {
    return Response.json({ error: "كلمة المرور مطلوبة" }, { status: 400 });
  }

  if (!supabase) {
    const email = session?.email ?? MOCK_ADMIN_EMAIL;
    if (email !== MOCK_ADMIN_EMAIL || password !== MOCK_ADMIN_PASSWORD) {
      return Response.json({ error: "بيانات الدخول غير صحيحة" }, { status: 401 });
    }
    return Response.json({ ok: true });
  }

  let email = session?.email ?? "";
  if (!email) {
    const { data: owner, error: ownerError } = await supabase
      .from("cashiers")
      .select("email")
      .eq("store_id", storeId)
      .eq("role", "admin")
      .not("email", "is", null)
      .maybeSingle();
    if (ownerError) return Response.json({ error: ownerError.message }, { status: 500 });
    email = owner?.email ?? "";
  }
  if (!email) return Response.json({ error: "بيانات الدخول غير صحيحة" }, { status: 401 });

  const gate = rateLimit(request, `admin-reverify:${storeId}`, 5, 15 * 60 * 1000);
  if (!gate.ok) return rateLimited(gate.retryAfter ?? 1);

  const { data, error } = await supabase.rpc("authenticate_admin", {
    p_email: email,
    p_password: password,
    p_token: opsToken(),
  });
  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
  if (!data || typeof data !== "object") {
    return Response.json({ error: "بيانات الدخول غير صحيحة" }, { status: 401 });
  }

  const store = (data as { store?: { id?: string; subscription_status?: string } }).store;
  if (storeId && store?.id && store.id !== storeId) {
    return Response.json({ error: "store_mismatch" }, { status: 403 });
  }
  if (store?.subscription_status === "suspended") {
    return Response.json({ error: "تم إيقاف هذا المتجر" }, { status: 403 });
  }

  return Response.json({ ok: true });
}
