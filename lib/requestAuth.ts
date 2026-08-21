import { getAdminSession, type AdminSessionPayload } from "@/lib/adminSession";
import { getDeviceSession, type DeviceSessionPayload } from "@/lib/deviceSession";
import { supabase } from "@/lib/supabase";
import { getStoreId, MOCK_STORE_ID } from "@/lib/tenant";
import {
  hasCapability,
  normalizeStaffRoleCode,
  type StaffCapability,
  type StaffLimits,
} from "@/lib/permissions";

export interface StoreAccess {
  storeId: string;
  actorId: string;
  actorName: string;
  role: "admin" | "cashier";
  /** PIN employee role code (e.g. `inventory_clerk`); null/absent for owners. */
  staffRoleCode?: string;
  source: "admin-session" | "device-session" | "mock-header";
}

export interface AdminAccess {
  storeId: string;
  email: string;
  name: string;
  source: "admin-session" | "mock-header";
}

export interface CapabilityAccess extends StoreAccess {
  roleCode: string;
  roleName: string;
  capabilities: string[];
  limits: StaffLimits | Record<string, number | null>;
}

function fromAdmin(session: AdminSessionPayload): StoreAccess {
  return {
    storeId: session.storeId,
    actorId: session.email,
    actorName: session.name,
    role: "admin",
    source: "admin-session",
  };
}

function fromDevice(session: DeviceSessionPayload): StoreAccess {
  return {
    storeId: session.storeId,
    actorId: session.actorId,
    actorName: session.actorName,
    role: session.role,
    staffRoleCode: session.staffRoleCode,
    source: "device-session",
  };
}

function mockStoreAccess(request: Request): StoreAccess | null {
  const storeId = getStoreId(request);
  if (!storeId) return null;
  const role = request.headers.get("x-pos-role") === "admin" ? "admin" : "cashier";
  return {
    storeId,
    actorId: request.headers.get("x-pos-admin-email") ?? "mock-user",
    actorName: "Mock user",
    role,
    source: "mock-header",
  };
}

export async function getStoreAccess(request: Request): Promise<StoreAccess | null> {
  if (!supabase) return mockStoreAccess(request);
  const admin = await getAdminSession(request);
  if (admin) return fromAdmin(admin);
  const device = await getDeviceSession(request);
  return device ? fromDevice(device) : null;
}

export async function getAdminAccess(request: Request): Promise<AdminAccess | null> {
  if (!supabase) {
    if (request.headers.get("x-pos-role") !== "admin") return null;
    return {
      storeId: getStoreId(request) ?? MOCK_STORE_ID,
      email: request.headers.get("x-pos-admin-email") ?? "admin@demo.test",
      name: "Mock admin",
      source: "mock-header",
    };
  }
  const session = await getAdminSession(request);
  return session ? { ...session, source: "admin-session" } : null;
}

/**
 * Authorize a back-office capability. Owner sessions always pass. PIN staff
 * are reloaded from PostgreSQL on every protected request so revocation does
 * not wait for the 30-day device cookie to expire.
 */
export async function getCapabilityAccess(
  request: Request,
  capability: StaffCapability,
): Promise<CapabilityAccess | null> {
  return getAnyCapabilityAccess(request, [capability]);
}

/**
 * Same as getCapabilityAccess but accepts a list and grants when the actor
 * holds ANY of the listed capabilities — used where a narrow mobile role
 * (e.g. `catalog.add`) shares a route with the broader back-office role
 * (`catalog.manage`).
 */
export async function getAnyCapabilityAccess(
  request: Request,
  capabilities: StaffCapability[],
): Promise<CapabilityAccess | null> {
  if (capabilities.length === 0) return null;

  const admin = await getAdminSession(request);
  if (admin) {
    return {
      ...fromAdmin(admin),
      roleCode: "owner",
      roleName: "مالك المتجر",
      capabilities: [],
      limits: {},
    };
  }

  const device = await getDeviceSession(request);
  if (!device || device.role !== "cashier") return null;

  // Fast deny before I/O. Legacy cookies did not carry a staff role and can
  // keep selling, but they must re-authenticate before entering back office.
  if (
    !device.staffRoleCode ||
    !capabilities.some((cap) => hasCapability({ roleCode: device.staffRoleCode }, cap))
  ) {
    return null;
  }

  if (!supabase) {
    const roleCode = normalizeStaffRoleCode(device.staffRoleCode);
    if (!capabilities.some((cap) => hasCapability({ roleCode }, cap))) return null;
    return {
      ...fromDevice(device),
      roleCode,
      roleName: roleCode,
      capabilities: [],
      limits: {},
    };
  }

  const { data: cashier, error: cashierError } = await supabase
    .from("cashiers")
    .select("id,name,role,role_id,store_id")
    .eq("id", device.actorId)
    .eq("store_id", device.storeId)
    .maybeSingle();
  if (cashierError || !cashier || cashier.role === "admin" || cashier.role === "مدير") return null;

  const { data: role, error: roleError } = await supabase
    .from("staff_roles")
    .select("id,code,name,capabilities,limits")
    .eq("id", cashier.role_id)
    .eq("store_id", device.storeId)
    .maybeSingle();
  if (
    roleError ||
    !role ||
    !capabilities.some((cap) => hasCapability({ capabilities: role.capabilities }, cap))
  ) return null;

  return {
    storeId: device.storeId,
    actorId: cashier.id,
    actorName: cashier.name,
    role: "cashier",
    source: "device-session",
    roleCode: role.code,
    roleName: role.name,
    capabilities: Array.isArray(role.capabilities) ? role.capabilities : [],
    limits: role.limits && typeof role.limits === "object"
      ? (role.limits as Record<string, number | null>)
      : {},
  };
}

export function storeSessionError(): Response {
  return Response.json({ error: "store_session_required" }, { status: 401 });
}

export function adminSessionError(): Response {
  return Response.json({ error: "admin_session_required" }, { status: 401 });
}

export function capabilityError(capability: StaffCapability): Response {
  return Response.json(
    { error: "capability_required", capability },
    { status: 403 },
  );
}

export async function capabilityAuthorizationError(
  request: Request,
  capability: StaffCapability,
): Promise<Response> {
  const authenticated = await getStoreAccess(request);
  return authenticated ? capabilityError(capability) : storeSessionError();
}

export async function authorizedStoreId(request: Request): Promise<string | Response> {
  const access = await getStoreAccess(request);
  return access?.storeId ?? storeSessionError();
}

export async function authorizedAdminStoreId(request: Request): Promise<string | Response> {
  const access = await getAdminAccess(request);
  return access?.storeId ?? adminSessionError();
}

export async function authorizedCapabilityStoreId(
  request: Request,
  capability: StaffCapability,
): Promise<string | Response> {
  const access = await getCapabilityAccess(request, capability);
  return access?.storeId ?? await capabilityAuthorizationError(request, capability);
}

export async function authorizedAnyCapabilityStoreId(
  request: Request,
  capabilities: StaffCapability[],
): Promise<string | Response> {
  const access = await getAnyCapabilityAccess(request, capabilities);
  if (access?.storeId) return access.storeId;
  const authenticated = await getStoreAccess(request);
  const representative = capabilities[0] ?? "backoffice.access";
  return authenticated ? capabilityError(representative) : storeSessionError();
}
