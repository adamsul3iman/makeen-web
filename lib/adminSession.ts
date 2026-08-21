import {
  clearSignedSessionCookieHeader,
  createSignedSession,
  readSignedSession,
  signedSessionCookieHeader,
} from "@/lib/signedSession";
import {
  ADMIN_SESSION_COOKIE,
  ADMIN_SESSION_NAMESPACE,
  validAdminPayload,
  type AdminSessionPayload,
} from "@/lib/sessionTypes";
import { getDeviceSession } from "@/lib/deviceSession";

/**
 * Short-lived owner session used exclusively by privileged back-office APIs.
 * Store scope and owner identity are signed by the server and never inferred
 * from caller-controlled headers.
 */
export type { AdminSessionPayload } from "@/lib/sessionTypes";

const MAX_AGE_SECONDS = 12 * 60 * 60;

export function adminSessionCookieHeader(session: AdminSessionPayload): string {
  return signedSessionCookieHeader(
    ADMIN_SESSION_COOKIE,
    createSignedSession(ADMIN_SESSION_NAMESPACE, session, MAX_AGE_SECONDS),
    MAX_AGE_SECONDS,
  );
}

export function clearAdminSessionCookieHeader(): string {
  return clearSignedSessionCookieHeader(ADMIN_SESSION_COOKIE);
}

export async function getAdminSession(request?: Request): Promise<AdminSessionPayload | null> {
  const session = await readSignedSession(
    request,
    ADMIN_SESSION_COOKIE,
    ADMIN_SESSION_NAMESPACE,
    validAdminPayload,
  );
  if (!session) return null;

  // A later cashier login on the same register must immediately suppress an
  // older owner cookie, even if that cookie has not expired yet.
  const device = await getDeviceSession(request);
  return device?.role === "cashier" ? null : session;
}
