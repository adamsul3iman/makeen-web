import { cookies } from "next/headers";
import { verifySignedSession } from "@/lib/sessionCrypto";

export {
  clearSignedSessionCookieHeader,
  createSignedSession,
  signedSessionCookieHeader,
  verifySignedSession,
} from "@/lib/sessionCrypto";

function requestCookie(request: Request | undefined, name: string): string | null {
  const header = request?.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim() || null;
  }
  return null;
}

export async function readSignedSession<T>(
  request: Request | undefined,
  cookieName: string,
  namespace: string,
  validatePayload: (value: unknown) => value is T,
): Promise<T | null> {
  let raw = requestCookie(request, cookieName);
  if (!raw) {
    try {
      raw = (await cookies()).get(cookieName)?.value ?? null;
    } catch {
      return null;
    }
  }
  return raw ? verifySignedSession(namespace, raw, validatePayload) : null;
}
