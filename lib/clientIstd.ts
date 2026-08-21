import { posFetch } from "@/lib/tenantClient";
import { patchSyncRecordPayload, setIstdState } from "@/lib/idb";
import type { CompletedInvoice } from "@/types/pos.types";

export type ClientIstdOutcome = {
  cleared: boolean;
  uuid?: string;
  qrCode?: string;
  code?: string;
};

/**
 * Fire-and-forget ISTD push from the POS checkout.
 *
 * The checkout MUST NOT await this: it runs detached and the local TLV QR
 * keeps the receipt valid until (and unless) JoFotara returns the official
 * one. On success the sync record is patched (so /api/sync never resubmits)
 * and the callback is invoked with the cleared invoice for receipt refresh.
 *
 * Per-invoice submission state is persisted to IndexedDB (`istd_state`) so a
 * failure is never silent: FAILED invoices keep counting toward the pending
 * badge and are surfaced to the owner for a manual retry.
 */
export async function pushInvoiceToIstd(
  invoice: CompletedInvoice,
  onCleared?: (invoice: CompletedInvoice) => void,
): Promise<ClientIstdOutcome> {
  try {
    await setIstdState(invoice.syncId, { status: "SUBMITTING" });

    const res = await posFetch("/api/istd/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sync_id: invoice.syncId,
        payload: {
          completed_at: invoice.completed_at,
          total: invoice.total,
          tax: invoice.tax,
          discount: invoice.discount,
          paymentMethod: invoice.paymentMethod,
          customerName: invoice.customerName,
          customerId: invoice.customerId,
          customerPhone: invoice.customerPhone,
        },
      }),
    });

    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      uuid?: string;
      qrCode?: string;
      code?: string;
      error?: string;
    };

    if (res.ok && body.ok && body.uuid) {
      await patchSyncRecordPayload(invoice.syncId, {
        istd_uuid: body.uuid,
        istd_qr: body.qrCode,
      });
      await setIstdState(invoice.syncId, {
        status: "SUBMITTED",
        istd_uuid: body.uuid,
        istd_qr: body.qrCode,
      });
      const cleared: CompletedInvoice = {
        ...invoice,
        istdUuid: body.uuid,
        istdQr: body.qrCode,
      };
      onCleared?.(cleared);
      return { cleared: true, uuid: body.uuid, qrCode: body.qrCode };
    }

    const code = body.code ?? body.error ?? "unknown";
    await setIstdState(invoice.syncId, { status: "FAILED", error: code });
    return { cleared: false, code };
  } catch (err) {
    const code = err instanceof Error ? err.message : "network";
    await setIstdState(invoice.syncId, { status: "FAILED", error: code });
    return { cleared: false, code };
  }
}
