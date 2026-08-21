/**
 * Client-side tenant plumbing.
 *
 * Keeps the active `store_id` in a module-level variable (written by the
 * zustand store on login / rehydrate) so every network call — catalog,
 * sync, and the admin back-office — automatically carries the
 * `x-pos-store-id` header and stays inside its store's partition.
 */

import { STORE_HEADER } from "./tenant";

let currentStoreId: string | null = null;

export function setTenantStoreId(storeId: string | null): void {
  currentStoreId = storeId;
}

export function getTenantStoreId(): string | null {
  return currentStoreId;
}

/**
 * fetch wrapper that injects the active store id. Merge-safe: any headers
 * supplied by the caller (e.g. `x-pos-role`) are preserved.
 */
export async function posFetch(
  input: string | URL | Request,
  init: RequestInit = {},
): Promise<Response> {
  const storeId = getTenantStoreId();
  if (!storeId) return fetch(input, init);

  const headers = new Headers(init.headers);
  if (!headers.has(STORE_HEADER)) headers.set(STORE_HEADER, storeId);
  return fetch(input, { ...init, headers });
}
