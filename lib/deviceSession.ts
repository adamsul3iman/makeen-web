import {
  clearSignedSessionCookieHeader,
  createSignedSession,
  readSignedSession,
  signedSessionCookieHeader,
} from "@/lib/signedSession";
import {
  DEVICE_SESSION_COOKIE,
  DEVICE_SESSION_NAMESPACE,
  validDevicePayload,
  type DeviceSessionPayload,
} from "@/lib/sessionTypes";

export type { DeviceSessionPayload } from "@/lib/sessionTypes";

const MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export function deviceSessionCookieHeader(session: DeviceSessionPayload): string {
  return signedSessionCookieHeader(
    DEVICE_SESSION_COOKIE,
    createSignedSession(DEVICE_SESSION_NAMESPACE, session, MAX_AGE_SECONDS),
    MAX_AGE_SECONDS,
  );
}

export function clearDeviceSessionCookieHeader(): string {
  return clearSignedSessionCookieHeader(DEVICE_SESSION_COOKIE);
}

export async function getDeviceSession(request?: Request): Promise<DeviceSessionPayload | null> {
  return readSignedSession(
    request,
    DEVICE_SESSION_COOKIE,
    DEVICE_SESSION_NAMESPACE,
    validDevicePayload,
  );
}
