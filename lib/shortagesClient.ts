import { getSupabaseBrowser } from "./supabaseBrowser";
import { getTenantStoreId } from "./tenantClient";

const SHORTAGE_FLAG_COLUMNS =
  "id,product_id,product_name,current_stock,reason,cashier_id,cashier_name,branch_id,terminal_id,resolved,resolved_by,resolved_at,created_at";

/** One durable row of the shortage radar (`shortage_flags`). */
export interface ShortageFlag {
  id: string;
  productId: string;
  productName: string;
  /** Stock the reporter saw when flagging (system stock at flag time). */
  currentStock: number;
  reason: string | null;
  cashierId: string | null;
  cashierName: string;
  branchId: string | null;
  terminalId: string | null;
  resolved: boolean;
  resolvedBy: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

export interface ReportShortageInput {
  productId: string;
  productName?: string;
  currentStock?: number;
  reason?: string | null;
  cashierId?: string | null;
  cashierName?: string;
  branchId?: string | null;
  terminalId?: string | null;
}

export interface ResolveShortageInput {
  /** Free-text owner name / note recorded on the flag. */
  resolvedBy?: string | null;
}

/** Minimal supplier pick-list entry for ordering the shortage. */
export interface SupplierOption {
  id: string;
  name: string;
  /** WhatsApp-able contact number; empty when the registry lacks one. */
  phone?: string | null;
}

interface ShortageFlagRow {
  id: string;
  product_id: string;
  product_name: string | null;
  current_stock: number | string | null;
  reason: string | null;
  cashier_id: string | null;
  cashier_name: string | null;
  branch_id: string | null;
  terminal_id: string | null;
  resolved: boolean | null;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
}

function asNumber(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? Math.round((n + Number.EPSILON) * 1000) / 1000 : fallback;
}

function mapShortageFlag(row: ShortageFlagRow): ShortageFlag {
  return {
    id: row.id,
    productId: row.product_id,
    productName: row.product_name ?? "",
    currentStock: Math.max(0, asNumber(row.current_stock)),
    reason: row.reason ?? null,
    cashierId: row.cashier_id ?? null,
    cashierName: row.cashier_name ?? "",
    branchId: row.branch_id ?? null,
    terminalId: row.terminal_id ?? null,
    resolved: Boolean(row.resolved),
    resolvedBy: row.resolved_by ?? null,
    resolvedAt: row.resolved_at ?? null,
    createdAt: row.created_at,
  };
}

/** Durable cashier-flagged stockouts for the store (newest first). */
export async function fetchShortages(): Promise<ShortageFlag[]> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  const { data, error } = await sb
    .from("shortage_flags")
    .select(SHORTAGE_FLAG_COLUMNS)
    .eq("store_id", storeId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);

  return ((data ?? []) as unknown as ShortageFlagRow[]).map(mapShortageFlag);
}

/**
 * Records a manual "Flag as Shortage" report from the register/dashboard.
 * The flag lands on the radar immediately even when system stock disagrees.
 */
export async function reportShortage(data: ReportShortageInput): Promise<ShortageFlag> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  const productId = data.productId?.trim() ?? "";
  if (!productId) throw new Error("معرّف المنتج مطلوب");

  const { data: inserted, error } = await sb
    .from("shortage_flags")
    .insert({
      store_id: storeId,
      product_id: productId,
      product_name: data.productName?.trim() ?? "",
      current_stock: Math.max(0, asNumber(data.currentStock)),
      reason: data.reason?.trim() || null,
      cashier_id: data.cashierId || null,
      cashier_name: data.cashierName?.trim() ?? "",
      branch_id: data.branchId || null,
      terminal_id: data.terminalId || null,
      resolved: false,
    })
    .select(SHORTAGE_FLAG_COLUMNS)
    .single();
  if (error || !inserted) throw new Error(error?.message ?? "تعذر تسجيل علامة النقص");

  return mapShortageFlag(inserted as unknown as ShortageFlagRow);
}

/** Marks a shortage flag as handled by the owner. */
export async function resolveShortage(
  id: string,
  data: ResolveShortageInput = {},
): Promise<ShortageFlag> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  const trimmedId = id.trim();
  if (!trimmedId) throw new Error("معرّف علامة النقص مطلوب");

  const { data: updated, error } = await sb
    .from("shortage_flags")
    .update({
      resolved: true,
      resolved_by: data.resolvedBy?.trim() || null,
      resolved_at: new Date().toISOString(),
    })
    .eq("id", trimmedId)
    .eq("store_id", storeId)
    .select(SHORTAGE_FLAG_COLUMNS)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!updated) throw new Error("علامة النقص غير موجودة");

  return mapShortageFlag(updated as unknown as ShortageFlagRow);
}

/** Store supplier registry (id + name + phone) for shortage order drafting. */
export async function fetchShortageSuppliers(): Promise<SupplierOption[]> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  const { data, error } = await sb
    .from("suppliers")
    .select("id,name,phone")
    .eq("store_id", storeId)
    .order("name", { ascending: true });
  if (error) throw new Error(error.message);

  return ((data ?? []) as Array<{ id: string; name: string; phone: string | null }>).map((row) => ({
    id: row.id,
    name: row.name,
    phone: row.phone || null,
  }));
}
