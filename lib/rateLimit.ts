/**
 * Minimal fixed-window rate limiter for authentication endpoints.
 *
 * In-memory (per process). This is an anti-brute-force speed bump, not a
 * distributed solution: a single deployed instance / dev server is covered,
 * which matches the app's current single-region deployment. Keys are
 * client-IP scoped (plus a stable bucket like storeId or email).
 */

interface WindowState {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, WindowState>();

/** Best-effort client IP from proxy headers, falls back to a shared key. */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.trim();
  if (forwarded) return forwarded.split(",")[0].trim() || "unknown";
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

export interface RateLimitResult {
  ok: boolean;
  /** Seconds until the window resets (present only when blocked). */
  retryAfter?: number;
  /** Remaining attempts in the current window. */
  remaining: number;
}

/**
 * Fixed-window limiter keyed by `${bucket}:${clientIp}`.
 *
 * @param request request whose IP is used for the key
 * @param bucket stable logical scope (e.g. `login:${storeId}` or `admin:${email}`)
 * @param limit max attempts per window
 * @param windowMs window length
 */
export function rateLimit(
  request: Request,
  bucket: string,
  limit: number,
  windowMs: number,
): RateLimitResult {
  const key = `${bucket}:${clientIp(request)}`;
  const now = Date.now();

  const state = buckets.get(key);
  if (!state || now >= state.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, remaining: limit - 1 };
  }

  if (state.count >= limit) {
    const retryAfter = Math.max(1, Math.ceil((state.resetAt - now) / 1000));
    return { ok: false, retryAfter, remaining: 0 };
  }

  state.count += 1;
  buckets.set(key, state);
  return { ok: true, remaining: limit - state.count };
}

/** Shared HTTP response for a throttled attempt. */
export function rateLimited(retryAfter: number): Response {
  return Response.json(
    { error: "محاولات كثيرة — حاول لاحقاً" },
    { status: 429, headers: { "Retry-After": String(retryAfter) } },
  );
}
