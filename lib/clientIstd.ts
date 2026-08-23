import { setIstdState } from "@/lib/idb";
import type { CompletedInvoice } from "@/types/pos.types";

export type ClientIstdOutcome = {
  cleared: boolean;
  uuid?: string;
  qrCode?: string;
  code?: string;
};

/** JoFotara credentials and the istd_submissions claim table are service-role-only. */
const ISTD_UNAVAILABLE = "istd_unavailable";

/**
 * Fire-and-forget ISTD push from the POS checkout.
 *
 * The checkout MUST NOT await this: it runs detached and the local TLV QR
 * keeps the receipt valid until (and unless) JoFotara returns the official
 * one.
 *
 * The browser can no longer clear invoices with JoFotara directly: the tenant
 * device credentials (tenant_tax_settings) and the single-writer claim table
 * (istd_submissions) are both locked to the service role, so there is no
 * client-reachable submission path. The invoice is therefore recorded as
 * FAILED in IndexedDB — never silent — and keeps counting toward the pending
 * badge for a manual retry by the owner.
 */
export async function pushInvoiceToIstd(
  invoice: CompletedInvoice,
  onCleared?: (invoice: CompletedInvoice) => void,
): Promise<ClientIstdOutcome> {
  void onCleared;
  console.warn(
    "[istd] الإرسال المباشر لـ JoFotara غير متاح من المتصفح — الفاتورة ستُعلّم كفاشلة للإعادة اليدوية",
    invoice.syncId,
  );
  try {
    await setIstdState(invoice.syncId, { status: "FAILED", error: ISTD_UNAVAILABLE });
  } catch {
    // IndexedDB unavailable — the warn above is all we can surface.
  }
  return { cleared: false, code: ISTD_UNAVAILABLE };
}
