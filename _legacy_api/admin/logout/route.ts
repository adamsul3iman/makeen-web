import { clearAdminSessionCookieHeader } from "@/lib/adminSession";
import { clearDeviceSessionCookieHeader } from "@/lib/deviceSession";

/**
 * Sign the admin out: clears both HttpOnly session cookies (admin + device).
 * The client-facing state is dropped locally by the shared `logoutToLogin`
 * helper in lib/clientLogout.ts; this just revokes the server-side credential
 * so any subsequent back-office call is rejected.
 */
export async function POST(): Promise<Response> {
  const res = Response.json({ ok: true });
  res.headers.set("Set-Cookie", clearAdminSessionCookieHeader());
  res.headers.append("Set-Cookie", clearDeviceSessionCookieHeader());
  return res;
}
