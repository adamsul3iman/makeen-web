import { authorizedStoreId } from "@/lib/requestAuth";
import {
  buildInvoiceLikeFromPayload,
  submitInvoiceToIstdOnce,
} from "@/lib/istdSync";
import type { InvoiceCreatedPayload } from "@/lib/idb";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Checkout fast-path for ISTD/JoFotara e-invoicing.
 *
 * The POS calls this the instant a sale settles (fire-and-forget, never
 * awaited, so the cashier's cart clears in the same frame). The server claims
 * the invoice in `istd_submissions` and — only when this worker wins the
 * single-writer claim — clears it with JoFotara and returns the official
 * UUID + QR. If the tenant has no credentials, or ISTD is slow/down, the
 * client silently falls back to the local TLV QR generator: the receipt still
 * prints instantly. A later /api/sync pass re-runs any invoice that was not
 * cleared here.
 */
export async function POST(request: Request): Promise<Response> {
  const storeAccess = await authorizedStoreId(request);
  if (typeof storeAccess !== "string") return storeAccess;
  const storeId = storeAccess;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, code: "invalid_json" }, { status: 400 });
  }

  const input = body as { sync_id?: unknown; payload?: unknown };
  if (typeof input.sync_id !== "string" || !UUID_RE.test(input.sync_id)) {
    return Response.json({ ok: false, code: "invalid_sync_id" }, { status: 400 });
  }
  const payload = input.payload as Partial<InvoiceCreatedPayload> | undefined;
  if (!payload || typeof payload !== "object") {
    return Response.json({ ok: false, code: "invalid_payload" }, { status: 400 });
  }
  if (
    typeof payload.completed_at !== "string" ||
    typeof payload.total !== "number" ||
    typeof payload.tax !== "number" ||
    typeof payload.discount !== "number" ||
    typeof payload.paymentMethod !== "string"
  ) {
    return Response.json({ ok: false, code: "invalid_payload" }, { status: 400 });
  }

  const outcome = await submitInvoiceToIstdOnce(
    storeId,
    input.sync_id,
    buildInvoiceLikeFromPayload(input.sync_id, payload as InvoiceCreatedPayload),
    { timeoutMs: 8_000 },
  );

  if (outcome.status === "submitted" || outcome.status === "already") {
    return Response.json({
      ok: true,
      uuid: outcome.uuid,
      qrCode: outcome.qrCode,
      status: outcome.status,
    });
  }
  return Response.json({
    ok: false,
    code: outcome.status,
    error: outcome.error,
  });
}
