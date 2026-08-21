import { supabase } from "@/lib/supabase";
import { rateLimit, rateLimited } from "@/lib/rateLimit";
import { staffLoginResponse } from "@/lib/posLogin";

/**
 * Unified staff authentication.
 *
 *   { storeCode, username, pin }   staff sign-in (store code + username + PIN)
 *   { storeId, pin }               legacy register flow (kept for compatibility)
 *
 * Returns the store context every subsequent request echoes via the signed
 * device cookie, plus the role's home path for the proxy to redirect to.
 * Owners sign in on /api/admin/login (email + password) and never reach this
 * endpoint — cashier rows hold the PIN material.
 */
export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const input = body as {
    storeCode?: unknown;
    code?: unknown;
    storeId?: unknown;
    username?: unknown;
    pin?: unknown;
  };
  const storeCode =
    (typeof input.storeCode === "string" ? input.storeCode : typeof input.code === "string" ? input.code : "").trim().toUpperCase();
  const storeId = typeof input.storeId === "string" ? input.storeId.trim() : "";
  const username = typeof input.username === "string" ? input.username.trim() : "";
  const pin = typeof input.pin === "string" ? input.pin.trim() : "";

  if (!pin || pin.length !== 4) {
    return Response.json({ error: "رمز PIN غير صالح" }, { status: 400 });
  }

  if (storeCode) {
    if (!/^[A-Z0-9]{4,12}$/.test(storeCode)) {
      return Response.json({ error: "كود المتجر غير صالح" }, { status: 400 });
    }
    if (!username) {
      return Response.json({ error: "اسم المستخدم مطلوب" }, { status: 400 });
    }
  } else if (!storeId) {
    return Response.json({ error: "بيانات الدخول مطلوبة" }, { status: 400 });
  }

  // Brute-force speed bump: at most 10 PIN attempts per store+IP every 5min.
  // Skipped in mock mode (no real accounts / DB to protect).
  if (supabase) {
    const key = storeCode ? `pos-login:${storeCode}` : `pos-login:${storeId}`;
    const gate = rateLimit(request, key, 10, 5 * 60 * 1000);
    if (!gate.ok) return rateLimited(gate.retryAfter ?? 1);
  }

  return staffLoginResponse({ storeCode: storeCode || undefined, storeId, username, pin });
}
