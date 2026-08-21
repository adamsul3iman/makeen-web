/**
 * Neutral session definitions — cookie names, namespaces, payload shapes and
 * validators. Imports NOTHING from `next/headers` (or any server-only module)
 * so the app-root `proxy.ts` can verify cookies without tripping Next 16's
 * server-only boundary.
 */

export const DEVICE_SESSION_COOKIE = "pos_device";
export const DEVICE_SESSION_NAMESPACE = "device";

export interface DeviceSessionPayload {
  storeId: string;
  actorId: string;
  actorName: string;
  role: "admin" | "cashier";
  /** PIN employee role code; omitted for owner sessions and legacy cookies. */
  staffRoleCode?: string;
}

export function validDevicePayload(value: unknown): value is DeviceSessionPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Partial<DeviceSessionPayload>;
  return (
    typeof payload.storeId === "string" &&
    payload.storeId.length > 0 &&
    typeof payload.actorId === "string" &&
    payload.actorId.length > 0 &&
    typeof payload.actorName === "string" &&
    (payload.role === "admin" || payload.role === "cashier") &&
    (payload.staffRoleCode === undefined || typeof payload.staffRoleCode === "string")
  );
}

export const ADMIN_SESSION_COOKIE = "pos_admin";
export const ADMIN_SESSION_NAMESPACE = "admin";

export interface AdminSessionPayload {
  storeId: string;
  email: string;
  name: string;
}

export function validAdminPayload(value: unknown): value is AdminSessionPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Partial<AdminSessionPayload>;
  return (
    typeof payload.storeId === "string" &&
    payload.storeId.length > 0 &&
    typeof payload.email === "string" &&
    payload.email.length > 0 &&
    typeof payload.name === "string"
  );
}
