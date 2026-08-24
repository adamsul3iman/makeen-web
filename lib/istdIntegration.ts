import type { SalesPaymentMethod } from "@/types/salesLedger.types";
import { jordanAmount } from "@/lib/qrGenerator";

/**
 * Jordan ISTD (JoFotara) e-invoicing — browser-side module, secret-free.
 *
 * Since remediation step 3 (migration 079 + the `jofotara` Edge Function),
 * NO JoFotara credential ever reaches this bundle. The tenant's
 * istd_client_id / istd_client_secret live in `tenant_tax_settings`, which is
 * deny-all for anon/authenticated and readable only by the Edge Function via
 * the service role. This module is a thin transport to that function:
 *
 *   config_get     -> masked fiscal settings for THIS store
 *   invoice_submit -> claim + token exchange + submission happen server-side
 *
 * The invoice MAPPING below stays client-side on purpose: it is a pure,
 * deterministic transform of data the POS already holds, covered by tests.
 */

/** URL of the deployed `jofotara` Edge Function. */
function jofotaraFunctionUrl(): string {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://localhost:54321";
  return `${base.replace(/\/$/, "")}/functions/v1/jofotara`;
}

/**
 * POST one action to the jofotara Edge Function. Resolves with whatever JSON
 * the function returned (callers inspect `ok`). Throws only on network-level
 * failures so offline behaviour stays distinguishable from business errors.
 */
export async function jofotaraInvoke<T = Record<string, unknown>>(
  body: Record<string, unknown>,
  timeoutMs = 25_000,
): Promise<T> {
  const apiKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const response = await fetch(jofotaraFunctionUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { apikey: apiKey, Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  });
  return (await response.json().catch(() => ({ ok: false, code: "bad_json" }))) as T;
}

export interface TenantTaxSettings {
  storeId: string;
  taxNumber: string;
  istdClientId: string;
  /**
   * Always empty in the browser since migration 079 — the secret never leaves
   * the Edge Function. Kept on the shape for legacy callers/tests.
   */
  istdClientSecret: string;
}

export class IstdError extends Error {
  /** Machine-readable code, e.g. "not_configured" | "invalid_credentials". */
  code: string;
  status: number;

  constructor(code: string, message: string, status = 500) {
    super(message);
    this.name = "IstdError";
    this.code = code;
    this.status = status;
  }
}

const PAYMENT_METHOD_ISTD: Record<SalesPaymentMethod, string> = {
  CASH: "cash",
  VISA: "card",
  CLIQ: "cliq",
  SPLIT: "cash_and_card",
  DEBT: "on_account",
  UNKNOWN: "cash",
};

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

export interface IstdSupplier {
  name: string;
  tin: string;
  address?: string;
  phone?: string;
}

/** A line item with authoritative tax figures (as persisted in the ledger). */
export interface IstdInvoiceLine {
  lineNo: number;
  productName: string;
  quantity: number;
  unitPrice: number;
  lineDiscount: number;
  taxPercent: number;
  taxIncluded: boolean;
  taxAmount: number;
  lineTotal: number;
}

/**
 * Minimal structural view of an invoice for ISTD mapping. Both callers (the
 * checkout fast-path and the sync mirror) build this from data they already
 * hold, so they never need the full ledger/detail shapes.
 */
export interface IstdInvoiceLike {
  id: string;
  reference: string;
  completedAt: string;
  total: number;
  tax: number;
  discount: number;
  paymentMethod: SalesPaymentMethod;
  customerName?: string;
  customerPhone?: string;
  customerId?: string;
  /** Optional authoritative line breakdown; omitted -> aggregated single line. */
  items?: IstdInvoiceLine[];
}

/**
 * Map a completed sale onto the JoFotara / ISTD JSON invoice standard. Amounts
 * are JOD, fixed at 2 decimals; line tax splits reuse already-persisted tax
 * figures rather than re-deriving them. Without line items the invoice maps to
 * a single aggregated "مبيعات" line — identical totals, no NaN risk from
 * partial client data.
 */
export function mapSalesInvoiceToIstd(
  invoice: IstdInvoiceLike,
  taxSettings: TenantTaxSettings,
  supplier: IstdSupplier,
): Record<string, unknown> {
  const completedAt = invoice.completedAt;
  const date = completedAt.slice(0, 10);
  const time = completedAt.length > 11 ? completedAt.slice(11, 19) : "";
  const isReturn = invoice.total < 0;

  const items = Array.isArray(invoice.items) && invoice.items.length > 0
    ? invoice.items.map((item) => {
        const gross = round2(item.lineTotal);
        const tax = round2(item.taxAmount);
        return {
          line_id: item.lineNo,
          description: item.productName,
          quantity: item.quantity,
          unit_price: round2(item.unitPrice),
          discount: round2(item.lineDiscount),
          tax_category: "Standard",
          tax_percentage: item.taxPercent,
          tax_exclusive_price: round2(gross - tax),
          tax_amount: tax,
          total: gross,
        };
      })
    : [{
        line_id: 1,
        description: "مبيعات",
        quantity: 1,
        unit_price: round2(invoice.total - invoice.tax),
        discount: 0,
        tax_category: "Standard",
        tax_percentage: invoice.total !== 0 ? round2((invoice.tax / (invoice.total - invoice.tax)) * 100) : 0,
        tax_exclusive_price: round2(invoice.total - invoice.tax),
        tax_amount: round2(invoice.tax),
        total: round2(invoice.total),
      }];

  const buyer: Record<string, unknown> = {};
  if (invoice.customerName) buyer.name = invoice.customerName;
  if (invoice.customerPhone) buyer.phone = invoice.customerPhone;
  if (invoice.customerId) buyer.id = invoice.customerId;

  return {
    invoice_uuid: invoice.id,
    invoice_ref_number: invoice.reference,
    invoice_type: isReturn ? "credit" : "general_sales",
    currency: "JOD",
    issue_date: date,
    issue_time: time,
    payment_method: PAYMENT_METHOD_ISTD[invoice.paymentMethod] ?? "cash",
    supplier: {
      name: supplier.name,
      tin: supplier.tin,
      address: supplier.address ?? "",
      phone: supplier.phone ?? "",
    },
    buyer,
    line_items: items,
    totals: {
      tax_exclusive_total: round2(invoice.total - invoice.tax),
      discount_total: round2(invoice.discount),
      tax_total: round2(invoice.tax),
      grand_total: round2(invoice.total),
    },
    signature: {
      algorithm: "ISTD-SHA256",
      tax_number: taxSettings.taxNumber,
      invoice_total: jordanAmount(invoice.total),
      tax_amount: jordanAmount(invoice.tax),
    },
  };
}

export interface IstdSubmitResult {
  uuid?: string;
  qrCode?: string;
  status: number;
}

/* ──────────────────────── Edge Function transport ──────────────────────── */

interface ConfigGetResponse {
  ok: boolean;
  taxNumber?: string;
  istdClientId?: string;
  configured?: boolean;
  code?: string;
  message?: string;
}

interface InvoiceSubmitResponse {
  ok: boolean;
  uuid?: string;
  qrCode?: string;
  code?: string;
  message?: string;
}

/**
 * Masked fiscal settings for THIS store via the Edge Function. Returns null
 * when the integration was never configured. `istdClientSecret` is always "".
 */
export async function getTenantTaxSettings(storeId: string): Promise<TenantTaxSettings | null> {
  try {
    const data = await jofotaraInvoke<ConfigGetResponse>({ action: "config_get", storeId });
    if (!data.ok) return null;
    return {
      storeId,
      taxNumber: data.taxNumber ?? "",
      istdClientId: data.istdClientId ?? "",
      istdClientSecret: "",
    };
  } catch {
    return null;
  }
}

const EDGE_ERROR_STATUS: Record<string, number> = {
  not_configured: 409,
  invalid_credentials: 401,
};

/**
 * Submit ONE invoice through the Edge Function. The claim bookkeeping, token
 * exchange and JoFotara call all happen server-side; the returned `qrCode`
 * (when provided) is the authoritative QR to print on the receipt.
 */
export async function submitInvoiceToIstd(
  storeId: string,
  invoice: IstdInvoiceLike,
  supplier: IstdSupplier,
  opts?: { baseUrl?: string; settings?: TenantTaxSettings; timeoutMs?: number },
): Promise<IstdSubmitResult> {
  const data = await jofotaraInvoke<InvoiceSubmitResponse>(
    {
      action: "invoice_submit",
      storeId,
      syncId: invoice.id,
      invoice: {
        completed_at: invoice.completedAt,
        total: invoice.total,
        tax: invoice.tax,
        discount: invoice.discount,
        paymentMethod: invoice.paymentMethod,
        customerName: invoice.customerName,
        customerPhone: invoice.customerPhone,
        customerId: invoice.customerId,
        supplier_name: supplier.name,
      },
    },
    opts?.timeoutMs ? opts.timeoutMs + 5_000 : undefined,
  );
  if (!data.ok) {
    throw new IstdError(
      data.code ?? "submission_failed",
      data.message ?? "رفض ISTD الفاتورة",
      EDGE_ERROR_STATUS[data.code ?? ""] ?? 502,
    );
  }
  return { status: 200, uuid: data.uuid, qrCode: data.qrCode };
}
