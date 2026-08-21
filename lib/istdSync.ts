import {
  getTenantTaxSettings,
  submitInvoiceToIstd,
  type IstdInvoiceLike,
  type TenantTaxSettings,
} from "@/lib/istdIntegration";
import { supabase } from "@/lib/supabase";
import { invoiceReference } from "@/lib/salesLedger";
import type { InvoiceCreatedPayload } from "@/lib/idb";
import type { SalesPaymentMethod } from "@/types/salesLedger.types";

/**
 * Single-writer ISTD submission shared by the checkout fast-path and the
 * background sync catch-up.
 *
 * `istd_submissions` is keyed by sync_id, so exactly ONE worker ever performs
 * the actual JoFotara clearance for a given invoice:
 *
 *   ensureIstdClaim()  INSERT (never overwrites) — registers the invoice.
 *   takeIstdAttempt()  atomic UPDATE claiming a due attempt (PENDING/FAILED,
 *                      or a SUBMITTING claim whose heartbeat is stale).
 *   mark outcome       SUBMITTED (+ uuid/qr) or FAILED (+ error), always
 *                      touching last_attempt_at so retries back off.
 *
 * Claim rows are created BEFORE the sales_invoices mirror row exists, so
 * sync_id deliberately carries no FK to sales_invoices (only store_id).
 */

/** A fresh claim is due immediately; a claimed attempt is stealable once older. */
const CLAIM_DUE_BACKOFF_MS = 10_000;
/** Hard ceiling on one ISTD request (token + invoice), used by the fast path. */
const FAST_PATH_TIMEOUT_MS = 8_000;

export type IstdSyncStatus =
  | "submitted"
  | "already"
  | "pending"
  | "not_configured"
  | "failed";

export interface IstdSyncOutcome {
  status: IstdSyncStatus;
  uuid?: string;
  qrCode?: string;
  error?: string;
}

const methodOf = (value: unknown): SalesPaymentMethod => {
  const m = typeof value === "string" ? value : "";
  return ["CASH", "VISA", "SPLIT", "DEBT", "CLIQ", "UNKNOWN"].includes(m)
    ? (m as SalesPaymentMethod)
    : "UNKNOWN";
};

/** Build the ISTD invoice view straight from the queued checkout payload. */
export function buildInvoiceLikeFromPayload(
  syncId: string,
  payload: InvoiceCreatedPayload,
): IstdInvoiceLike {
  return {
    id: syncId,
    reference: invoiceReference(syncId),
    completedAt: payload.completed_at,
    total: payload.total,
    tax: payload.tax,
    discount: payload.discount,
    paymentMethod: methodOf(payload.paymentMethod),
    customerName: payload.customerName,
    customerPhone: payload.customerPhone,
    customerId: payload.customerId,
  };
}

interface LedgerRowLike {
  sync_id?: unknown;
  completed_at?: unknown;
  total?: unknown;
  tax?: unknown;
  discount?: unknown;
  payment_method?: unknown;
  customer_name?: unknown;
  customer_phone?: unknown;
  customer_id?: unknown;
}

/** Build the ISTD invoice view from an already-mirrored ledger row. */
export function buildInvoiceLikeFromLedgerRow(row: LedgerRowLike): IstdInvoiceLike {
  const syncId = typeof row.sync_id === "string" ? row.sync_id : "";
  const num = (v: unknown): number => {
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
    return Number.isFinite(n) ? n : 0;
  };
  const text = (v: unknown): string => (typeof v === "string" ? v : "");
  return {
    id: syncId,
    reference: invoiceReference(syncId),
    completedAt: text(row.completed_at),
    total: num(row.total),
    tax: num(row.tax),
    discount: num(row.discount),
    paymentMethod: methodOf(row.payment_method),
    customerName: text(row.customer_name) || undefined,
    customerPhone: text(row.customer_phone) || undefined,
    customerId: text(row.customer_id) || undefined,
  };
}

/** INSERT-only claim; never overwrites a SUBMITTED/already-processed row. */
async function ensureIstdClaim(
  syncId: string,
  storeId: string,
): Promise<string | null> {
  if (!supabase) return null;
  // Insert with an OLD last_attempt_at so the claim is immediately "due".
  const { error } = await supabase
    .from("istd_submissions")
    .insert({
      sync_id: syncId,
      store_id: storeId,
      status: "PENDING",
      last_attempt_at: new Date(Date.now() - 60_000).toISOString(),
    })
    .select("sync_id");
  // 23505 = already registered by another worker — not an error.
  return error && error.code !== "23505" ? error.message : null;
}

/** Atomically claim a due attempt. Returns true only for the single winner. */
async function takeIstdAttempt(
  syncId: string,
  storeId: string,
): Promise<{ owned: boolean; error?: string }> {
  if (!supabase) return { owned: false };
  const cutoff = new Date(Date.now() - CLAIM_DUE_BACKOFF_MS).toISOString();
  const { data, error } = await supabase
    .from("istd_submissions")
    .update({ status: "SUBMITTING", last_attempt_at: new Date().toISOString() })
    .eq("sync_id", syncId)
    .eq("store_id", storeId)
    .in("status", ["PENDING", "FAILED", "SUBMITTING"])
    .lt("last_attempt_at", cutoff)
    .select("sync_id");
  if (error) return { owned: false, error: error.message };
  return { owned: (data?.length ?? 0) === 1 };
}

/** Read the stored clearance result when another worker owns the claim. */
async function readIstdResult(
  syncId: string,
  storeId: string,
): Promise<IstdSyncOutcome> {
  if (!supabase) return { status: "pending" };
  const { data, error } = await supabase
    .from("istd_submissions")
    .select("status,istd_uuid,istd_qr")
    .eq("sync_id", syncId)
    .eq("store_id", storeId)
    .maybeSingle();
  if (error) return { status: "pending", error: error.message };
  if (data?.status === "SUBMITTED" && data.istd_uuid) {
    return {
      status: "already",
      uuid: data.istd_uuid,
      qrCode: data.istd_qr ?? undefined,
    };
  }
  return { status: "pending" };
}

/** Persist the cleared result onto the ledger row (no-op before mirroring). */
async function persistIstdResult(
  syncId: string,
  storeId: string,
  uuid: string,
  qrCode?: string,
): Promise<void> {
  if (!supabase) return;
  await supabase
    .from("sales_invoices")
    .update({
      istd_uuid: uuid,
      istd_qr: qrCode ?? null,
      istd_submitted_at: new Date().toISOString(),
    })
    .eq("sync_id", syncId)
    .eq("store_id", storeId);
}

async function markOutcome(
  syncId: string,
  storeId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  if (!supabase) return;
  await supabase
    .from("istd_submissions")
    .update({ ...patch, last_attempt_at: new Date().toISOString() })
    .eq("sync_id", syncId)
    .eq("store_id", storeId);
}

/** Load the tenant's JoFotara credentials + store name for the supplier block. */
export async function loadIstdContext(
  storeId: string,
): Promise<{ settings: TenantTaxSettings; storeName: string } | null> {
  if (!supabase) return null;
  const settings = await getTenantTaxSettings(storeId);
  if (!settings) return null;
  const { data } = await supabase
    .from("stores")
    .select("name")
    .eq("id", storeId)
    .maybeSingle();
  return { settings, storeName: data?.name?.trim() || "متجر التجزئة" };
}

/**
 * Register + attempt ISTD clearance for ONE invoice. Callers (fast-path and
 * sync catch-up) must already hold the invoice view.
 */
export async function submitInvoiceToIstdOnce(
  storeId: string,
  syncId: string,
  invoiceLike: IstdInvoiceLike,
  opts?: { baseUrl?: string; timeoutMs?: number },
): Promise<IstdSyncOutcome> {
  const context = await loadIstdContext(storeId);
  if (!context) return { status: "not_configured" };

  const claimError = await ensureIstdClaim(syncId, storeId);
  if (claimError) return { status: "failed", error: claimError };

  const take = await takeIstdAttempt(syncId, storeId);
  if (take.error) return { status: "failed", error: take.error };
  if (!take.owned) return readIstdResult(syncId, storeId);

  const { settings, storeName } = context;
  try {
    const result = await submitInvoiceToIstd(
      storeId,
      invoiceLike,
      { name: storeName, tin: settings.taxNumber },
      { baseUrl: opts?.baseUrl, settings, timeoutMs: opts?.timeoutMs },
    );
    if (result.uuid) {
      await markOutcome(syncId, storeId, {
        status: "SUBMITTED",
        istd_uuid: result.uuid,
        istd_qr: result.qrCode ?? null,
        error: null,
      });
      await persistIstdResult(syncId, storeId, result.uuid, result.qrCode);
      return { status: "submitted", uuid: result.uuid, qrCode: result.qrCode };
    }
    await markOutcome(syncId, storeId, { status: "FAILED", error: "no_uuid" });
    return { status: "failed", error: "no_uuid" };
  } catch (err) {
    const code = err instanceof Error && "code" in err && typeof err.code === "string"
      ? err.code
      : "unknown";
    await markOutcome(syncId, storeId, { status: "FAILED", error: code });
    return { status: "failed", error: code };
  }
}

/**
 * Background catch-up: find the store's invoices that were never cleared
 * (offline-generated, or failed fast-path pushes) and submit them, most
 * recent first, bounded per pass. Each invoice is cleared at most once thanks
 * to the single-writer claim; failed attempts back off via last_attempt_at.
 */
export async function runIstdCatchUp(
  storeId: string,
  limit = 5,
  opts?: { baseUrl?: string },
): Promise<void> {
  if (!supabase) return;
  const context = await loadIstdContext(storeId);
  if (!context) return;

  const { data, error } = await supabase
    .from("sales_invoices")
    .select("sync_id,completed_at,total,tax,discount,payment_method,customer_name,customer_phone,customer_id")
    .eq("store_id", storeId)
    .is("istd_uuid", null)
    .eq("is_cancellation", false)
    .gt("total", 0)
    .order("completed_at", { ascending: false })
    .limit(limit);
  if (error || !data || data.length === 0) return;

  for (const row of data) {
    const syncId = typeof row.sync_id === "string" ? row.sync_id : "";
    if (!syncId) continue;
    const outcome = await submitInvoiceToIstdOnce(
      storeId,
      syncId,
      buildInvoiceLikeFromLedgerRow(row),
      { baseUrl: opts?.baseUrl, timeoutMs: FAST_PATH_TIMEOUT_MS },
    );
    // Stop the pass on the first hard failure to keep the sync tick bounded;
    // the next tick (15s) resumes from the newest unsubmitted invoice.
    if (outcome.status === "failed" || outcome.status === "not_configured") return;
  }
}

export { FAST_PATH_TIMEOUT_MS };
