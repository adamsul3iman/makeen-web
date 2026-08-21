import { createHmac, randomBytes, timingSafeEqual } from "crypto";

/**
 * Pure HMAC-signed session primitives (no `next/headers`).
 *
 * These are safe to run anywhere — route handlers, `proxy.ts`, plain Node —
 * because signing/verifying takes only the raw cookie string. `next/headers`
 * is intentionally NOT imported here so the app-root proxy can verify cookies
 * itself instead of trusting caller-supplied headers.
 */

interface SessionEnvelope<T> {
  version: 1;
  issuedAt: number;
  expiresAt: number;
  payload: T;
}

let fallbackSecret: string | null = null;

function rootSecret(): string {
  const configured =
    process.env.ADMIN_SESSION_SECRET ||
    process.env.SESSION_SECRET ||
    process.env.PLATFORM_OPS_SECRET ||
    process.env.DATABASE_URL;
  if (configured) return configured;
  fallbackSecret ??= randomBytes(32).toString("hex");
  return fallbackSecret;
}

function namespaceSecret(namespace: string): string {
  return createHmac("sha256", rootSecret()).update(`pos-session:${namespace}:v1`).digest("hex");
}

function signature(namespace: string, body: string): string {
  return createHmac("sha256", namespaceSecret(namespace)).update(body).digest("hex");
}

export function createSignedSession<T>(
  namespace: string,
  payload: T,
  maxAgeSeconds: number,
  now = Date.now(),
): string {
  const envelope: SessionEnvelope<T> = {
    version: 1,
    issuedAt: now,
    expiresAt: now + maxAgeSeconds * 1000,
    payload,
  };
  const body = Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
  return `${body}.${signature(namespace, body)}`;
}

export function verifySignedSession<T>(
  namespace: string,
  raw: string,
  validatePayload: (value: unknown) => value is T,
  now = Date.now(),
): T | null {
  const dot = raw.lastIndexOf(".");
  if (dot <= 0 || dot === raw.length - 1) return null;

  const body = raw.slice(0, dot);
  const suppliedBuffer = Buffer.from(raw.slice(dot + 1), "hex");
  const expectedBuffer = Buffer.from(signature(namespace, body), "hex");
  if (
    suppliedBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(suppliedBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    const envelope = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    ) as Partial<SessionEnvelope<unknown>>;
    if (
      envelope.version !== 1 ||
      typeof envelope.issuedAt !== "number" ||
      typeof envelope.expiresAt !== "number" ||
      envelope.issuedAt > now + 60_000 ||
      envelope.expiresAt <= now ||
      !validatePayload(envelope.payload)
    ) {
      return null;
    }
    return envelope.payload;
  } catch {
    return null;
  }
}

function secureAttribute(): string {
  return process.env.NODE_ENV === "production" ? "; Secure" : "";
}

export function signedSessionCookieHeader(
  name: string,
  value: string,
  maxAgeSeconds: number,
): string {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secureAttribute()}`;
}

export function clearSignedSessionCookieHeader(name: string): string {
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureAttribute()}`;
}
