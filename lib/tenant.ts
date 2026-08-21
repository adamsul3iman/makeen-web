/**
 * Server-side tenant helpers for the multi-tenant POS.
 *
 * Every `/api/*` route derives the caller's store from the
 * `x-pos-store-id` header (set by the client after `/api/login`). When the
 * Supabase client is live these helpers let routes reject requests that do
 * not identify a store, so a store can never read or write another store's
 * rows.
 */

export const STORE_HEADER = "x-pos-store-id";
export const SUPER_ADMIN_HEADER = "x-pos-super-admin-pin";

export const MOCK_STORE_ID = "store-main";
export const MOCK_STORE_NAME = "المتجر الرئيسي";
export const MOCK_STORE_CODE = "MAIN01";
export const MOCK_SUPER_ADMIN_PIN = "7777";

/** Reads the store id carried by a request, or null when absent. */
export function getStoreId(request: Request): string | null {
  const id = request.headers.get(STORE_HEADER);
  return id && id.trim().length > 0 ? id.trim() : null;
}

/** 400 response for requests that failed to identify their store. */
export function storeIdError(): Response {
  return Response.json(
    { error: `store_id_required — أضف رأس ${STORE_HEADER}` },
    { status: 400 },
  );
}
