import { supabase } from "@/lib/supabase";
import { opsToken } from "@/lib/platformOps";
import { getAdminSession, adminSessionCookieHeader } from "@/lib/adminSession";
import { rateLimit, rateLimited } from "@/lib/rateLimit";

/**
 * Change the store-owner's own dashboard credentials (email and/or password).
 *
 * This is the missing half of the store→admin lifecycle: a store owner could
 * previously NEVER change the email or password seeded at provisioning. The
 * current password is always required and re-verified server-side (the RPC
 * `update_admin_credentials` checks bcrypt before touching anything), and the
 * new email must not belong to another store's admin (global unique index
 * from migration 014). `stores.email` is kept in sync so the owner email has
 * a single source of truth.
 */

const MOCK_ADMIN_EMAIL = "admin@demo.test";
const MOCK_ADMIN_PASSWORD = "12345678";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MIN_PASSWORD_LENGTH = 8;

interface AccountInput {
  current_password?: unknown;
  new_email?: unknown;
  new_password?: unknown;
}

function badInput(message: string): Response {
  return Response.json({ error: message }, { status: 400 });
}

export async function GET(request: Request): Promise<Response> {
  const session = await getAdminSession(request);
  if (!session) {
    return Response.json({ error: "admin_session_required" }, { status: 401 });
  }
  if (supabase) {
    // Legacy development snapshots used `store-main`; reject those sessions
    // before they can reach UUID-scoped PostgreSQL queries.
    if (!UUID_RE.test(session.storeId)) {
      return Response.json({ error: "admin_session_invalid" }, { status: 401 });
    }
    const { data: store, error } = await supabase
      .from("stores")
      .select("id,email,subscription_status")
      .eq("id", session.storeId)
      .eq("email", session.email)
      .maybeSingle();
    if (error) return Response.json({ error: "session_validation_failed" }, { status: 503 });
    if (!store || store.subscription_status === "suspended") {
      return Response.json({ error: "admin_session_invalid" }, { status: 401 });
    }
  }
  return Response.json({ ok: true, session });
}

export async function PATCH(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badInput("invalid_json");
  }

  const input = body as AccountInput;
  const currentPassword = typeof input.current_password === "string" ? input.current_password : "";
  const newEmail = typeof input.new_email === "string" ? input.new_email.trim().toLowerCase() : "";
  const newPassword = typeof input.new_password === "string" ? input.new_password : "";

  if (!currentPassword) return badInput("كلمة المرور الحالية مطلوبة");
  if (!newEmail && !newPassword) {
    return badInput("أدخل بريداً إلكترونياً جديداً أو كلمة مرور جديدة");
  }
  if (newEmail && !EMAIL_RE.test(newEmail)) {
    return badInput("البريد الإلكتروني الجديد غير صالح");
  }
  if (newPassword) {
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      return badInput(`كلمة المرور يجب أن تكون ${MIN_PASSWORD_LENGTH} حرف على الأقل`);
    }
    if (!/[A-Z]/.test(newPassword)) {
      return badInput("كلمة المرور يجب أن تحتوي حرف كبير واحد على الأقل (A-Z)");
    }
    if (!/[0-9]/.test(newPassword)) {
      return badInput("كلمة المرور يجب أن تحتوي رقم واحد على الأقل (0-9)");
    }
  }

  const session = await getAdminSession();
  if (!session) {
    return Response.json({ error: "غير مصرح — سجّل دخول كمدير المتجر" }, { status: 401 });
  }
  const storeId = session.storeId;
  const adminEmail = session.email;

  if (supabase) {
    const gate = rateLimit(request, `admin-account:${adminEmail}`, 5, 15 * 60 * 1000);
    if (!gate.ok) return rateLimited(gate.retryAfter ?? 1);

    const { data, error } = await supabase.rpc("update_admin_credentials", {
      p_current_email: adminEmail,
      p_current_password: currentPassword,
      p_new_email: newEmail,
      p_new_password: newPassword,
      p_token: opsToken(),
    });

    if (error) {
      if (error.code === "22023") {
        return badInput(error.message.includes("password")
          ? `كلمة المرور يجب أن تكون ${MIN_PASSWORD_LENGTH} أحرف على الأقل`
          : "البريد الإلكتروني الجديد غير صالح");
      }
      if (error.code === "23505" || /duplicate key/i.test(error.message ?? "")) {
        return Response.json({ error: "هذا البريد الإلكتروني مستخدم مسبقاً" }, { status: 409 });
      }
      return Response.json({ error: error.message }, { status: 500 });
    }
    if (!data || typeof data !== "object") {
      return Response.json({ error: "كلمة المرور الحالية غير صحيحة" }, { status: 401 });
    }

    // The caller's session was minted from this email's own store row at login,
    // so the update can never touch another tenant. Refresh the HttpOnly
    // session cookie so the new email takes effect immediately.
    const changedEmail = (data as { email?: string }).email ?? "";
    const nextEmail = changedEmail || adminEmail;
    if (nextEmail !== adminEmail) {
      const res = Response.json({ ok: true, email: nextEmail });
      res.headers.set(
        "Set-Cookie",
        adminSessionCookieHeader({ storeId, email: nextEmail, name: session.name }),
      );
      return res;
    }
    return Response.json({ ok: true, email: nextEmail });
  }

  // Mock mode: mirror the same rules for local testing.
  if (
    adminEmail !== MOCK_ADMIN_EMAIL ||
    currentPassword !== MOCK_ADMIN_PASSWORD
  ) {
    return Response.json({ error: "كلمة المرور الحالية غير صحيحة" }, { status: 401 });
  }
  return Response.json({ ok: true, email: newEmail || adminEmail });
}
