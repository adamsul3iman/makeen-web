import { randomBytes } from "node:crypto";
import { supabase } from "@/lib/supabase";
import { opsToken } from "@/lib/platformOps";
import { getAdminSession } from "@/lib/adminSession";
import { rateLimit, rateLimited } from "@/lib/rateLimit";
import { sha256Hex } from "@/lib/sha256";
import {
  STAFF_ROLE_PRESETS,
  normalizeStaffRoleCode,
} from "@/lib/permissions";

/**
 * Admin staff management (create / edit / reset PIN / suspend) from inside
 * the back office.
 *
 * Requires the store-owner's dashboard password on every mutating call — the
 * client gates this behind the secondary-auth modal, and the server
 * re-verifies so a leaked admin session can never mutate the roster on its
 * own. The active store and acting admin come from the signed session cookie.
 *
 * Since F3 the server mints a random per-cashier salt and stores
 * `pin_salt` + `pin_hash = sha256(pin + pin_salt)` — the plaintext PIN is
 * never persisted, so the DB contains nothing an anon key reader can crack
 * in bulk and the catalog only ever ships the per-cashier hash + salt.
 *
 * Usernames power the unified /login (store code + username + PIN). They are
 * unique per store (case-insensitive, `uq_cashiers_username_per_store`) and,
 * when omitted on create, derived from the display name exactly like
 * migration 052's backfill (sanitized + numeric-suffixed on collision).
 * Suspended staff (`is_active = false`) can no longer sign in anywhere.
 */

const MOCK_ADMIN_EMAIL = "admin@demo.test";
const MOCK_ADMIN_PASSWORD = "12345678";
const MOCK_STORE_ID = "store-main";

// In-memory roster so the mock stays stateful within one server process:
// creates show up in GET and deletes remove them (resets on restart).
const mockCashiers = new Map<string, {
  id: string;
  name: string;
  username: string;
  role: string;
  roleId: string;
  roleName: string;
  isActive: boolean;
}>();

interface CashierInput {
  id?: unknown;
  name?: unknown;
  role?: unknown;
  roleId?: unknown;
  pin?: unknown;
  username?: unknown;
  isActive?: unknown;
}

interface UpsertBody {
  password?: unknown;
  cashier?: CashierInput;
}

function badInput(message: string): Response {
  return Response.json({ error: message }, { status: 400 });
}

/** Username rules mirrored from migration 052: 1–64 chars, letters, digits,
 * `_`, `-`, `.`, spaces. Unicode letters keep Arabic names (سندس) valid. */
const USERNAME_RE = /^[\p{L}\p{N}_\-\. ]{1,64}$/u;

/**
 * Derive a username from a display name exactly like migration 052's backfill:
 * keep letters/digits/`_`/`-`/`.`/spaces, lowercase, fall back to `user`.
 */
function deriveUsernameBase(name: string): string {
  const base = name.trim().replace(/[^\p{L}\p{N}_\-\. ]/gu, "").toLowerCase();
  return base || "user";
}

/** Find a store-scoped username clash (excluding `excludeId`), matching the
 * `lower(username)` unique index. */
async function findUsernameClash(
  storeId: string,
  username: string,
  excludeId?: string,
): Promise<string | null> {
  if (!supabase) {
    for (const row of mockCashiers.values()) {
      if (row.username.toLowerCase() === username && row.id !== excludeId) return row.id;
    }
    return null;
  }
  const { data, error } = await supabase
    .from("cashiers")
    .select("id,username")
    .eq("store_id", storeId)
    .limit(500);
  if (error) return null;
  const clash = (data ?? []).find(
    (row) => row.id !== excludeId && String(row.username ?? "").toLowerCase() === username,
  );
  return clash?.id ?? null;
}

/**
 * Reserve a unique username in this store.
 * - Explicit `preferred`: validate; a clash is a hard 409 (the owner sees the
 *   real error instead of an unexpected rename).
 * - Auto-derived (no preferred): suffix `-2`, `-3` … on clash, mirroring
 *   migration 052's backfill.
 */
async function reserveUsername(
  storeId: string,
  name: string,
  preferred?: string,
  excludeId?: string,
): Promise<string> {
  if (preferred) {
    const normalized = preferred.trim().toLowerCase();
    if (!USERNAME_RE.test(normalized)) {
      throw new StaffInputError("اسم المستخدم غير صالح — أحرف لاتينية/عربية وأرقام و _-. فقط", 400);
    }
    if (await findUsernameClash(storeId, normalized, excludeId)) {
      throw new StaffInputError("اسم المستخدم مستخدم مسبقاً", 409);
    }
    return normalized;
  }
  const base = deriveUsernameBase(name);
  let candidate = base;
  let suffix = 2;
  while (await findUsernameClash(storeId, candidate, excludeId)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

class StaffInputError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "StaffInputError";
    this.status = status;
  }
}

async function verifyAdmin(
  email: string,
  password: string,
  storeId: string | null,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  if (!supabase) {
    if (
      email === MOCK_ADMIN_EMAIL &&
      password === MOCK_ADMIN_PASSWORD &&
      storeId === MOCK_STORE_ID
    ) {
      return { ok: true };
    }
    return { ok: false, status: 401, error: "بيانات الدخول غير صحيحة" };
  }

  const { data, error } = await supabase.rpc("authenticate_admin", {
    p_email: email,
    p_password: password,
    p_token: opsToken(),
  });
  if (error) return { ok: false, status: 500, error: error.message };
  if (!data || typeof data !== "object") {
    return { ok: false, status: 401, error: "بيانات الدخول غير صحيحة" };
  }

  const authedStore = (data as { store?: { id?: string; subscription_status?: string } }).store;
  const authedStoreId = authedStore?.id;
  if (storeId && authedStoreId && authedStoreId !== storeId) {
    return { ok: false, status: 403, error: "store_mismatch" };
  }
  if (authedStore?.subscription_status === "suspended") {
    return { ok: false, status: 403, error: "تم إيقاف هذا المتجر" };
  }
  return { ok: true };
}

async function requireAdmin(request: Request, password: string): Promise<{ storeId: string } | Response> {
  const session = await getAdminSession();
  if (!session) {
    return Response.json({ error: "غير مصرح — سجّل دخول كمدير المتجر" }, { status: 401 });
  }
  const storeId = session.storeId;
  if (supabase) {
    const gate = rateLimit(request, `admin-cashiers:${session.email}`, 5, 15 * 60 * 1000);
    if (!gate.ok) return rateLimited(gate.retryAfter ?? 1);
  }
  const verification = await verifyAdmin(session.email, password, storeId);
  if (!verification.ok) {
    return Response.json(
      { error: verification.error ?? "غير مصرح" },
      { status: verification.status ?? 401 },
    );
  }
  return { storeId };
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const input = body as UpsertBody;
  const password = typeof input.password === "string" ? input.password : "";
  const cashierRaw = input.cashier;

  if (!cashierRaw || typeof cashierRaw !== "object") {
    return badInput("بيانات الموظف مطلوبة");
  }
  if (!password) {
    return badInput("كلمة المرور مطلوبة");
  }

  const name = typeof cashierRaw.name === "string" ? cashierRaw.name.trim() : "";
  const role = typeof cashierRaw.role === "string" ? cashierRaw.role.trim() : "";
  const requestedRoleId = typeof cashierRaw.roleId === "string" ? cashierRaw.roleId.trim() : "";
  const requestedUsername = typeof cashierRaw.username === "string" ? cashierRaw.username.trim() : "";
  const pin = typeof cashierRaw.pin === "string" ? cashierRaw.pin.trim() : "";
  const id =
    typeof cashierRaw.id === "string" && cashierRaw.id.length > 0
      ? cashierRaw.id
      : null;
  const isActive = typeof cashierRaw.isActive === "boolean" ? cashierRaw.isActive : undefined;

  const isCreate = !id;
  if (isCreate && !name) return badInput("اسم الموظف مطلوب");
  if (isCreate && !role) return badInput("دور الموظف مطلوب");
  if (isCreate && !/^\d{4}$/.test(pin)) return badInput("رمز PIN يجب أن يكون 4 أرقام");
  if (!isCreate && pin.length > 0 && !/^\d{4}$/.test(pin)) {
    return badInput("رمز PIN يجب أن يكون 4 أرقام");
  }
  if (requestedUsername && !USERNAME_RE.test(requestedUsername.toLowerCase())) {
    return badInput("اسم المستخدم غير صالح — أحرف لاتينية/عربية وأرقام و _-. فقط");
  }
  // Owner/cashier separation: the store owner (role 'admin') logs in with
  // email + password and never holds a PIN — it can never be created or
  // edited through the staff management form.
  if (role === "admin" || role === "مدير") {
    return badInput("المدير هو مالك المتجر — سجّل الدخول بالبريد الإلكتروني وكلمة المرور");
  }

  const auth = await requireAdmin(request, password);
  if (auth instanceof Response) return auth;
  const storeId = auth.storeId;

  if (!supabase) {
    // ---- Mock mode --------------------------------------------------------
    if (isCreate) {
      const mockId = `cashier-${Date.now()}`;
      const roleCode = normalizeStaffRoleCode(role);
      const username = await reserveUsername(storeId, name, requestedUsername);
      const row = {
        id: mockId,
        name,
        username,
        role: roleCode,
        roleId: requestedRoleId || `mock-role-${roleCode}`,
        roleName: STAFF_ROLE_PRESETS[roleCode].name,
        isActive: true,
      };
      mockCashiers.set(mockId, row);
      return Response.json({ cashier: row }, { status: 201 });
    }

    const existing = mockCashiers.get(id);
    if (!existing) return Response.json({ error: "الموظف غير موجود" }, { status: 404 });
    const roleCode = role ? normalizeStaffRoleCode(role) : normalizeStaffRoleCode(existing.role);
    const username = requestedUsername
      ? await reserveUsername(storeId, name, requestedUsername, id)
      : existing.username;
    const updated = {
      ...existing,
      ...(name ? { name } : {}),
      ...(role ? { role: roleCode, roleId: requestedRoleId || `mock-role-${roleCode}`, roleName: STAFF_ROLE_PRESETS[roleCode].name } : {}),
      username,
      ...(isActive !== undefined ? { isActive } : {}),
    };
    mockCashiers.set(id, updated);
    return Response.json({ cashier: updated });
  }

  // ---- Real Supabase ------------------------------------------------------
  if (!storeId) {
    return Response.json({ error: "store_id_required" }, { status: 400 });
  }

  try {
    if (isCreate) {
      const username = await reserveUsername(storeId, name, requestedUsername);
      let roleQuery = supabase
        .from("staff_roles")
        .select("id,code,name")
        .eq("store_id", storeId);
      roleQuery = requestedRoleId
        ? roleQuery.eq("id", requestedRoleId)
        : roleQuery.eq("code", normalizeStaffRoleCode(role));
      const { data: staffRole, error: roleError } = await roleQuery.maybeSingle();
      if (roleError) return Response.json({ error: roleError.message }, { status: 500 });
      if (!staffRole) return badInput("الدور المحدد غير موجود في هذا المتجر");

      // Server-minted random salt; only the hash is ever stored for new staff.
      const pinSalt = randomBytes(16).toString("hex");
      const pinHash = sha256Hex(pin + pinSalt);
      const { data: created, error: insertError } = await supabase
        .from("cashiers")
        .insert({
          name,
          username,
          role: staffRole.code,
          role_id: staffRole.id,
          pin_salt: pinSalt,
          pin_hash: pinHash,
          store_id: storeId,
          is_active: true,
        })
        .select("id,name,role,role_id,username,is_active")
        .maybeSingle();
      if (insertError) {
        if (insertError.code === "23505") {
          return Response.json({ error: "اسم المستخدم مستخدم مسبقاً" }, { status: 409 });
        }
        return Response.json({ error: insertError.message }, { status: 500 });
      }
      return Response.json({
        cashier: created
          ? { ...created, roleId: created.role_id, roleName: staffRole.name, isActive: created.is_active }
          : null,
      }, { status: 201 });
    }

    // ---- Edit / reset-PIN / suspend --------------------------------------
    const patch: Record<string, unknown> = {};
    if (name) patch.name = name;
    if (requestedUsername) {
      // Validates + reserves uniqueness (409 on clash, excluding self).
      patch.username = await reserveUsername(storeId, name, requestedUsername, id);
    }
    if (isActive !== undefined) patch.is_active = isActive;
    if (pin) {
      const pinSalt = randomBytes(16).toString("hex");
      patch.pin_salt = pinSalt;
      patch.pin_hash = sha256Hex(pin + pinSalt);
    }

    if (role) {
      let roleQuery = supabase
        .from("staff_roles")
        .select("id,code,name")
        .eq("store_id", storeId);
      roleQuery = requestedRoleId
        ? roleQuery.eq("id", requestedRoleId)
        : roleQuery.eq("code", normalizeStaffRoleCode(role));
      const { data: staffRole, error: roleError } = await roleQuery.maybeSingle();
      if (roleError) return Response.json({ error: roleError.message }, { status: 500 });
      if (!staffRole) return badInput("الدور المحدد غير موجود في هذا المتجر");
      patch.role = staffRole.code;
      patch.role_id = staffRole.id;
    }

    if (Object.keys(patch).length === 0) {
      return badInput("لا توجد تغييرات لحفظها");
    }

    const { data: updated, error: updateError } = await supabase
      .from("cashiers")
      .update(patch)
      .eq("id", id)
      .eq("store_id", storeId)
      .select("id,name,role,role_id,username,is_active")
      .maybeSingle();
    if (updateError) {
      if (updateError.code === "23505") {
        return Response.json({ error: "اسم المستخدم مستخدم مسبقاً" }, { status: 409 });
      }
      return Response.json({ error: updateError.message }, { status: 500 });
    }
    if (!updated) {
      return Response.json({ error: "الموظف غير موجود" }, { status: 404 });
    }
    let roleName: string | undefined;
    if (role) {
      const roleQuery = supabase
        .from("staff_roles")
        .select("name")
        .eq("id", updated.role_id)
        .eq("store_id", storeId)
        .maybeSingle();
      const { data: roleRow } = await roleQuery;
      roleName = roleRow?.name;
    }
    return Response.json({
      cashier: { ...updated, roleId: updated.role_id, roleName, isActive: updated.is_active },
    });
  } catch (error) {
    if (error instanceof StaffInputError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return Response.json({ error: "تعذر حفظ الموظف" }, { status: 500 });
  }
}

/**
 * List the store's staff (name + username + role + status only — never PIN
 * material) for the back-office staff page. Requires the signed admin
 * session; the owner row is not part of the roster.
 */
export async function GET(): Promise<Response> {
  const session = await getAdminSession();
  if (!session) {
    return Response.json({ error: "غير مصرح — سجّل دخول كمدير المتجر" }, { status: 401 });
  }
  const storeId = session.storeId;

  if (!supabase) {
    return Response.json({ cashiers: [...mockCashiers.values()] });
  }

  if (!storeId) {
    return Response.json({ error: "store_id_required" }, { status: 400 });
  }

  const { data: cashiers, error } = await supabase
    .from("cashiers")
    .select("id,name,role,role_id,username,is_active")
    .eq("store_id", storeId)
    .neq("role", "admin")
    .neq("role", "مدير")
    .order("name", { ascending: true })
    .limit(500);
  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
  const roleIds = [...new Set((cashiers ?? []).map((row) => row.role_id).filter(Boolean))] as string[];
  const rolesById = new Map<string, { name: string }>();
  if (roleIds.length > 0) {
    const { data: roles, error: rolesError } = await supabase
      .from("staff_roles")
      .select("id,name")
      .eq("store_id", storeId)
      .in("id", roleIds);
    if (rolesError) return Response.json({ error: rolesError.message }, { status: 500 });
    for (const role of roles ?? []) rolesById.set(role.id, { name: role.name });
  }
  return Response.json({
    cashiers: (cashiers ?? []).map((cashier) => ({
      id: cashier.id,
      name: cashier.name,
      role: cashier.role,
      roleId: cashier.role_id,
      username: cashier.username,
      isActive: cashier.is_active,
      roleName: cashier.role_id ? rolesById.get(cashier.role_id)?.name : undefined,
    })),
  });
}

/**
 * Delete a staff member. Owner credentials are re-verified on every call; the
 * owner row itself can never be deleted through this endpoint.
 */
export async function DELETE(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const password = typeof (body as { password?: unknown }).password === "string"
    ? (body as { password: string }).password
    : "";
  const id = typeof (body as { id?: unknown }).id === "string"
    ? (body as { id: string }).id.trim()
    : "";

  if (!password) return badInput("كلمة المرور مطلوبة");
  if (!id) return badInput("معرّف الموظف مطلوب");

  const auth = await requireAdmin(request, password);
  if (auth instanceof Response) return auth;
  const storeId = auth.storeId;

  if (!supabase) {
    mockCashiers.delete(id);
    return Response.json({ ok: true, deleted: id });
  }

  if (!storeId) {
    return Response.json({ error: "store_id_required" }, { status: 400 });
  }

  const { data: row, error: fetchError } = await supabase
    .from("cashiers")
    .select("id,role")
    .eq("id", id)
    .eq("store_id", storeId)
    .maybeSingle();
  if (fetchError) {
    return Response.json({ error: fetchError.message }, { status: 500 });
  }
  if (!row) {
    return Response.json({ error: "الموظف غير موجود" }, { status: 404 });
  }
  if (row.role === "admin" || row.role === "مدير") {
    return Response.json({ error: "لا يمكن حذف حساب مدير المتجر" }, { status: 403 });
  }

  const { error: deleteError } = await supabase.from("cashiers").delete().eq("id", id);
  if (deleteError) {
    if (String(deleteError.message).toLowerCase().includes("foreign key") || deleteError.code === "23503") {
      return Response.json(
        { error: "لا يمكن حذف هذا الموظف لأنه مرتبط بمعاملات سابقة" },
        { status: 409 },
      );
    }
    return Response.json({ error: deleteError.message }, { status: 500 });
  }
  return Response.json({ ok: true, deleted: id });
}
