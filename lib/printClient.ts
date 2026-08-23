import { getSupabaseBrowser } from "./supabaseBrowser";
import { normalizePrintTemplateConfig } from "./printTemplates";
import { getTenantStoreId } from "./tenantClient";
import type { PrintTemplateConfig, PrintTemplateKind, PrintTemplate } from "@/types/printTemplates";

export type { PrintTemplate };

/**
 * Store-scoped print studio data access: receipt/barcode-label templates,
 * print-server kiosk config, and label generation inputs. Queried directly
 * from Supabase in the browser (RLS-enforced), replacing posFetch calls to
 * /api/print-templates, /api/print-server and /api/catalog/labels.
 */

const TEMPLATE_SELECT = "id,kind,name,is_default,config,created_at,updated_at";

interface PrintTemplateRow {
  id: string;
  kind: PrintTemplateKind;
  name: string;
  is_default: boolean;
  config: unknown;
  created_at: string | null;
  updated_at: string | null;
}

export interface SavePrintTemplateInput {
  kind?: PrintTemplateKind;
  name: string;
  isDefault?: boolean;
  config?: PrintTemplateConfig | Record<string, unknown> | null;
}

function toTemplate(row: PrintTemplateRow): PrintTemplate {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    isDefault: row.is_default === true,
    config: normalizePrintTemplateConfig(row.kind, row.config),
    createdAt: row.created_at ?? "",
    updatedAt: row.updated_at ?? "",
  };
}

/** List the store's print templates (optionally by kind), newest first. */
export async function fetchPrintTemplates(kind?: PrintTemplateKind): Promise<PrintTemplate[]> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  let query = sb
    .from("print_templates")
    .select(TEMPLATE_SELECT)
    .eq("store_id", storeId)
    .order("created_at", { ascending: false });
  if (kind) query = query.eq("kind", kind);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return ((data ?? []) as PrintTemplateRow[]).map(toTemplate);
}

/** Create a template, or update it in place when `id` is provided. */
export async function savePrintTemplate(
  data: SavePrintTemplateInput,
  id?: string,
): Promise<PrintTemplate> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  const name = typeof data.name === "string" ? data.name.trim().slice(0, 80) : "";
  if (!name) throw new Error("اسم القالب مطلوب");
  if (!id && !data.kind) throw new Error("نوع القالب غير صالح");

  const values = {
    name,
    is_default: data.isDefault === true,
    config: data.config ?? null,
  };

  if (id) {
    const { data: row, error } = await sb
      .from("print_templates")
      .update(values)
      .eq("id", id)
      .eq("store_id", storeId)
      .select(TEMPLATE_SELECT)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) throw new Error("القالب غير موجود");
    return toTemplate(row as PrintTemplateRow);
  }

  const { data: row, error } = await sb
    .from("print_templates")
    .insert({ store_id: storeId, kind: data.kind, ...values })
    .select(TEMPLATE_SELECT)
    .single();
  if (error || !row) throw new Error(error?.message ?? "تعذر إنشاء القالب");
  return toTemplate(row as PrintTemplateRow);
}

/** Delete a template owned by the caller's store. */
export async function deletePrintTemplate(id: string): Promise<void> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  const { data: template, error: readError } = await sb
    .from("print_templates")
    .select("id")
    .eq("id", id)
    .eq("store_id", storeId)
    .maybeSingle();
  if (readError) throw new Error(readError.message);
  if (!template) throw new Error("القالب غير موجود");

  const { error } = await sb
    .from("print_templates")
    .delete()
    .eq("id", id)
    .eq("store_id", storeId);
  if (error) throw new Error(error.message);
}

/**
 * Per-store print-server kiosk settings (one row per store). The table is
 * store-unique so saving is an upsert on store_id; unknown deployments may
 * carry extra columns which round-trip through the index signature.
 */
export interface PrintServerConfig {
  store_id?: string;
  endpoint?: string | null;
  token?: string | null;
  enabled?: boolean;
  updated_at?: string | null;
  [key: string]: unknown;
}

/** Read the store's print-server config, or null when none exists yet. */
export async function fetchPrintServerConfig(): Promise<PrintServerConfig | null> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  const { data, error } = await sb
    .from("print_server_configs")
    .select("*")
    .eq("store_id", storeId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as PrintServerConfig | null) ?? null;
}

/** Insert-or-update the store's single print-server config row. */
export async function savePrintServerConfig(data: Omit<PrintServerConfig, "store_id">): Promise<PrintServerConfig> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  const { data: row, error } = await sb
    .from("print_server_configs")
    .upsert({ ...data, store_id: storeId }, { onConflict: "store_id" })
    .select("*")
    .single();
  if (error || !row) throw new Error(error?.message ?? "تعذر حفظ إعدادات خادم الطباعة");
  return row as PrintServerConfig;
}

/** A label job handed to a kiosk by the claim RPC; self-contained payload. */
export interface ClaimedPrintJob {
  id: string;
  kind: string;
  payload: {
    barcode: string;
    name: string;
    variantLabel?: string;
    unitName: string;
    price: number;
    quantity: number;
    templateSize?: { widthMm: number; heightMm: number };
  };
}

/**
 * Atomically claim this store's oldest eligible queued label job for a worker
 * (claim_print_job RPC; SELECT ... FOR UPDATE SKIP LOCKED means two kiosks can
 * never print the same label). Returns null when the queue is empty. Stale
 * claims are requeued and over-capped jobs fail inside the same call.
 */
export async function claimPrintJob(
  workerId: string,
  options?: { timeoutSeconds?: number; maxAttempts?: number },
): Promise<ClaimedPrintJob | null> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  const { data, error } = await sb.rpc("claim_print_job", {
    p_store_id: storeId,
    p_worker_id: workerId || "print-server",
    p_timeout_seconds: options?.timeoutSeconds ?? 120,
    p_max_attempts: options?.maxAttempts ?? 8,
  });
  if (error) throw new Error(error.message);
  return (data as ClaimedPrintJob | null) ?? null;
}

/** Confirm a claimed job printed (or failed) so it leaves CLAIMED limbo. */
export async function resolvePrintJob(jobId: string, printed = true): Promise<{ ok: boolean; status?: string }> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  const { data, error } = await sb.rpc("resolve_print_job", {
    p_store_id: storeId,
    p_job_id: jobId,
    p_printed: printed,
  });
  if (error) throw new Error(error.message);
  return (data as { ok: boolean; status?: string }) ?? { ok: false };
}

export interface LabelVariant {
  barcode: string;
  unitName: string;
  multiplier: number;
  price: number;
}

export interface LabelProduct {
  id: string;
  name: string;
  baseUnit: string;
  categoryId: string | null;
  costPrice: number;
  sellingPrice: number;
  wholesalePrice: number;
  variants: LabelVariant[];
}

export interface GenerateLabelsParams {
  product_ids?: string[];
  category?: string;
  from?: string;
  to?: string;
}

interface ProductLabelRow {
  id: string;
  name: string;
  base_unit: string | null;
  category_id: string | null;
  cost_price: number | string | null;
  selling_price: number | string | null;
  wholesale_price: number | string | null;
  created_at: string | null;
}

interface LabelVariantRow {
  barcode: string;
  product_id: string;
  variant_label: string | null;
  selling_price: number | string | null;
}

function toNum(value: number | string | null | undefined): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Fetch products (+ their active barcodes) matching the picker's filters so
 * labels can be rendered client-side. `from`/`to` bound created_at, `category`
 * is a category_id, and `product_ids` narrows to an explicit selection.
 */
export async function generateLabels(params: GenerateLabelsParams = {}): Promise<LabelProduct[]> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  let query = sb
    .from("products")
    .select("id,name,base_unit,category_id,cost_price,selling_price,wholesale_price,created_at")
    .eq("store_id", storeId)
    .order("created_at", { ascending: false });
  if (params.product_ids && params.product_ids.length > 0) query = query.in("id", params.product_ids);
  if (params.category) query = query.eq("category_id", params.category);
  if (params.from) query = query.gte("created_at", params.from);
  if (params.to) query = query.lte("created_at", params.to);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as ProductLabelRow[];
  if (rows.length === 0) return [];

  const productIds = rows.map((r) => r.id);
  const variants: LabelVariantRow[] = [];
  for (let i = 0; i < productIds.length; i += 100) {
    const chunk = productIds.slice(i, i + 100);
    const { data: variantRows, error: variantsError } = await sb
      .from("product_variants")
      .select("barcode,product_id,variant_label,selling_price")
      .eq("store_id", storeId)
      .in("product_id", chunk)
      .order("barcode", { ascending: true });
    if (variantsError) throw new Error(variantsError.message);
    variants.push(...((variantRows ?? []) as LabelVariantRow[]));
  }

  const variantsByProduct = new Map<string, LabelVariantRow[]>();
  for (const v of variants) {
    const list = variantsByProduct.get(v.product_id) ?? [];
    list.push(v);
    variantsByProduct.set(v.product_id, list);
  }

  return rows.map((p) => {
    const sellingPrice = toNum(p.selling_price);
    return {
      id: p.id,
      name: p.name,
      baseUnit: p.base_unit ?? "",
      categoryId: p.category_id ?? null,
      costPrice: toNum(p.cost_price),
      sellingPrice,
      wholesalePrice: toNum(p.wholesale_price),
      variants: (variantsByProduct.get(p.id) ?? []).map((v) => ({
        barcode: v.barcode,
        unitName: v.variant_label || p.base_unit || "",
        multiplier: 1,
        price: toNum(v.selling_price) || sellingPrice,
      })),
    };
  });
}

/** Point the store at a new logo image (data URL) used across printed output. */
export async function updateLogo(dataUrl: string): Promise<void> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  const trimmed = typeof dataUrl === "string" ? dataUrl.trim() : "";
  if (!trimmed) throw new Error("صورة الشعار مطلوبة");

  const { error } = await sb.from("stores").update({ logo_url: trimmed }).eq("id", storeId);
  if (error) throw new Error(error.message);
}
