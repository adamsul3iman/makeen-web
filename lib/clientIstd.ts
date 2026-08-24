import { setIstdState } from "@/lib/idb";
import { jofotaraInvoke } from "@/lib/istdIntegration";
import { getTenantStoreId } from "@/lib/tenantClient";
import type { CompletedInvoice } from "@/types/pos.types";

export type ClientIstdOutcome = {
  cleared: boolean;
  uuid?: string;
  qrCode?: string;
  code?: string;
};

/** Legacy marker for "no submission path available" (unconfigured/offline env). */
const ISTD_UNAVAILABLE = "istd_unavailable";

interface InvoiceSubmitResponse {
  ok: boolean;
  uuid?: string;
  qrCode?: string;
  code?: string;
}

/**
 * ISTD/JoFotara push for one completed invoice.
 *
 * Detached by design: the caller MUST NOT await this on the checkout path —
 * the local TLV QR keeps the receipt valid until (and unless) JoFotara
 * returns the official one via `onCleared`.
 *
 * Since remediation step 3 the submission itself happens inside the
 * `jofotara` Edge Function (claim bookkeeping, token exchange, the JoFotara
 * call and the ledger mirror). The browser only forwards the invoice view —
 * no credential is involved. Any failure lands in IndexedDB as FAILED with a
 * machine-readable `code`, never silent, and stays retryable by the owner.
 */
export async function pushInvoiceToIstd(
  invoice: CompletedInvoice,
  onCleared?: (invoice: CompletedInvoice) => void,
): Promise<ClientIstdOutcome> {
  const storeId = getTenantStoreId();
  if (!storeId) {
    console.warn("[istd] لا يوجد متجر نشط — تعذّر إرسال الفاتورة إلى JoFotara", invoice.syncId);
    await markFailed(invoice.syncId, ISTD_UNAVAILABLE);
    return { cleared: false, code: ISTD_UNAVAILABLE };
  }

  try {
    const data = await jofotaraInvoke<InvoiceSubmitResponse>(
      {
        action: "invoice_submit",
        storeId,
        syncId: invoice.syncId,
        invoice: {
          completed_at: invoice.completed_at,
          total: invoice.total,
          tax: invoice.tax,
          discount: invoice.discount,
          paymentMethod: invoice.paymentMethod,
          customerName: invoice.customerName,
          customerPhone: invoice.customerPhone,
          customerId: invoice.customerId,
        },
      },
      25_000,
    );

    if (data.ok && typeof data.uuid === "string" && data.uuid.length > 0) {
      try {
        await setIstdState(invoice.syncId, {
          status: "SUBMITTED",
          istd_uuid: data.uuid,
          istd_qr: typeof data.qrCode === "string" ? data.qrCode : undefined,
        });
      } catch {
        // IndexedDB unavailable — the outcome still reaches the caller.
      }
      onCleared?.({
        ...invoice,
        istdUuid: data.uuid,
        istdQr: typeof data.qrCode === "string" ? data.qrCode : undefined,
      });
      return { cleared: true, uuid: data.uuid, qrCode: data.qrCode };
    }

    const code = typeof data.code === "string" ? data.code : "submission_failed";
    console.warn(`[istd] فشل إرسال الفاتورة (${code})`, invoice.syncId);
    await markFailed(invoice.syncId, code);
    return { cleared: false, code };
  } catch {
    // Network-level failure (offline / timeout) — retryable by the owner.
    await markFailed(invoice.syncId, "network");
    return { cleared: false, code: "network" };
  }
}

async function markFailed(syncId: string, error: string): Promise<void> {
  try {
    await setIstdState(syncId, { status: "FAILED", error });
  } catch {
    // IndexedDB unavailable — the warn above is all we can surface.
  }
}
