import { supabase } from "@/lib/supabase";
import { jordanAmount } from "@/lib/qrGenerator";
import type { SalesPaymentMethod } from "@/types/salesLedger.types";

/**
 * Jordan ISTD (JoFotara) e-invoicing — server-only, multi-tenant.
 *
 * Every tenant's JoFotara device credentials live in `tenant_tax_settings`
 * (keyed by store_id) and are fetched from PostgreSQL on EVERY call. Nothing
 * is ever read from .env — a tenant's client_id / secret_key exist only in the
 * DB, scoped to their own store row, so one store can neither see nor submit
 * under another tenant's identity.
 *
 * Endpoints (JoFotara /api reference — confirm exact paths against the ISTD
 * developer portal when credentials are issued):
 *   POST /api/get_token   client_id + secret_key -> Bearer JWT
 *   POST /api/invoice     cleared invoice -> { uuid, qrCode }
 *
 * Real-time CTC: JoFotara validates and clears each invoice synchronously and
 * returns the authoritative QR string; that QR is what the receipt must print.
 */

const ISTD_PRODUCTION_BASE_URL = "https://backend.jofotara.gov.jo";
const ISTD_SANDBOX_BASE_URL = "https://sandbox.jofotara.gov.jo";

export interface TenantTaxSettings {
  storeId: string;
  taxNumber: string;
  istdClientId: string;
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

function configured(settings: TenantTaxSettings): boolean {
  return (
    settings.taxNumber.trim().length > 0 &&
    settings.istdClientId.trim().length > 0 &&
    settings.istdClientSecret.trim().length > 0
  );
}

/**
 * Fetch THIS store's ISTD credentials from the database. Returns null when the
 * row does not exist yet (integration never configured).
 */
export async function getTenantTaxSettings(storeId: string): Promise<TenantTaxSettings | null> {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("tenant_tax_settings")
    .select("store_id,tax_number,istd_client_id,istd_client_secret")
    .eq("store_id", storeId)
    .maybeSingle();
  if (error) throw new IstdError("db_error", error.message);
  if (!data) return null;
  return {
    storeId: data.store_id,
    taxNumber: data.tax_number ?? "",
    istdClientId: data.istd_client_id ?? "",
    istdClientSecret: data.istd_client_secret ?? "",
  };
}

/**
 * Exchange the tenant's JoFotara device credentials for a Bearer JWT.
 * Credentials come from the DB lookup, never from environment variables.
 */
export async function requestIstdToken(
  settings: TenantTaxSettings,
  baseUrl: string = ISTD_PRODUCTION_BASE_URL,
  timeoutMs = 8_000,
): Promise<string> {
  if (!configured(settings)) {
    throw new IstdError(
      "not_configured",
      "بيانات الفوترة الإلكترونية غير مكتملة — أضف الرقم الضريبي وبيانات JoFotara من الإعدادات",
      409,
    );
  }

  let response: Response;
  try {
    response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/get_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: settings.istdClientId,
        client_secret: settings.istdClientSecret,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new IstdError("network", "تعذر الوصول إلى خوادم ISTD — تحقق من الاتصال");
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new IstdError(
        "invalid_credentials",
        "بيانات JoFotara غير مقبولة من ISTD — راجع client_id و secret_key",
        401,
      );
    }
    throw new IstdError(
      "token_failed",
      `فشل الحصول على رمز ISTD (HTTP ${response.status})`,
      response.status,
    );
  }

  const data = (await response.json().catch(() => ({}))) as {
    access_token?: unknown;
    token?: unknown;
  };
  const token = typeof data.access_token === "string"
    ? data.access_token
    : typeof data.token === "string"
      ? data.token
      : "";
  if (!token) throw new IstdError("token_failed", "استجابة ISTD لا تحوي رمز وصول");

  return token;
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

/**
 * Full ISTD pipeline for one store: DB credential lookup -> JWT -> submit.
 * The returned `qrCode` (when ISTD provides it) is the authoritative QR to
 * print on the receipt. Pass `opts.settings` to skip the credential lookup
 * when the caller already fetched them.
 */
export async function submitInvoiceToIstd(
  storeId: string,
  invoice: IstdInvoiceLike,
  supplier: IstdSupplier,
  opts?: { baseUrl?: string; settings?: TenantTaxSettings; timeoutMs?: number },
): Promise<IstdSubmitResult> {
  const settings = opts?.settings ?? (await getTenantTaxSettings(storeId));
  if (!settings) {
    throw new IstdError(
      "not_configured",
      "الفوترة الإلكترونية غير مفعّلة لهذا المتجر — أضف بيانات JoFotara من الإعدادات",
      409,
    );
  }

  const token = await requestIstdToken(settings, opts?.baseUrl, opts?.timeoutMs);
  const payload = mapSalesInvoiceToIstd(invoice, settings, supplier);

  let response: Response;
  try {
    response = await fetch(
      `${(opts?.baseUrl ?? ISTD_PRODUCTION_BASE_URL).replace(/\/$/, "")}/api/invoice`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ invoice: payload }),
        cache: "no-store",
        signal: AbortSignal.timeout(opts?.timeoutMs ?? 15_000),
      },
    );
  } catch {
    throw new IstdError("network", "تعذر إرسال الفاتورة إلى ISTD — تحقق من الاتصال");
  }

  if (!response.ok) {
    throw new IstdError("submission_failed", `رفض ISTD الفاتورة (HTTP ${response.status})`, response.status);
  }

  const data = (await response.json().catch(() => ({}))) as {
    uuid?: unknown;
    qrCode?: unknown;
    qr?: unknown;
  };
  return {
    status: response.status,
    uuid: typeof data.uuid === "string" ? data.uuid : undefined,
    qrCode:
      typeof data.qrCode === "string"
        ? data.qrCode
        : typeof data.qr === "string"
          ? data.qr
          : undefined,
  };
}

export { ISTD_PRODUCTION_BASE_URL, ISTD_SANDBOX_BASE_URL };
