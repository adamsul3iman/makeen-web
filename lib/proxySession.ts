import { verifySignedSession } from "@/lib/sessionCrypto";
import {
  ADMIN_SESSION_COOKIE,
  ADMIN_SESSION_NAMESPACE,
  DEVICE_SESSION_COOKIE,
  DEVICE_SESSION_NAMESPACE,
  validAdminPayload,
  validDevicePayload,
  type AdminSessionPayload,
  type DeviceSessionPayload,
} from "@/lib/sessionTypes";

/**
 * Request-scoped session decoding for the app-root `proxy.ts`.
 *
 * Unlike `lib/deviceSession.ts` / `lib/adminSession.ts` this module never
 * touches `next/headers` — it reads the raw `Cookie` header off the incoming
 * Request, so it can run inside `proxy.ts` (Next 16 forbids `next/headers`
 * there).
 */

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim() || null;
  }
  return null;
}

export function getDeviceSessionFromRequest(request: Request): DeviceSessionPayload | null {
  const raw = readCookie(request.headers.get("cookie"), DEVICE_SESSION_COOKIE);
  return raw ? verifySignedSession(DEVICE_SESSION_NAMESPACE, raw, validDevicePayload) : null;
}

export function getAdminSessionFromRequest(request: Request): AdminSessionPayload | null {
  const raw = readCookie(request.headers.get("cookie"), ADMIN_SESSION_COOKIE);
  return raw ? verifySignedSession(ADMIN_SESSION_NAMESPACE, raw, validAdminPayload) : null;
}
