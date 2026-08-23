import { getSupabaseBrowser } from "./supabaseBrowser";
import { getTenantStoreId } from "./tenantClient";

/**
 * Goods-in (استلام بضاعة) data access queried directly from Supabase in the
 * browser (RLS-enforced). Replaces posFetch calls to /api/receiving/suppliers
 * and /api/receiving/price-history.
 */

export interface ReceivingSupplier {
  id: string;
  name: string;
  phone: string | null;
}

export interface PriceHistoryEntry {
  productId: string | null;
  barcode: string;
  productName: string;
  costPrice: number;
  sellingPrice: number;
  wholesalePrice: number;
}

interface SupplierRow {
  id: string;
  name: string;
  phone: string | null;
}

interface VariantPriceRow {
  barcode: string;
  product_id: string | null;
  cost_price: number | string | null;
  selling_price: number | string | null;
  wholesale_price: number | string | null;
}

function toNum(value: number | string | null | undefined): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Vendor directory for the goods-in picker, ordered by name. */
export async function fetchReceivingSuppliers(): Promise<ReceivingSupplier[]> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  const { data, error } = await sb
    .from("suppliers")
    .select("id,name,phone")
    .eq("store_id", storeId)
    .order("name", { ascending: true });
  if (error) throw new Error(error.message);

  return ((data ?? []) as SupplierRow[]).map((row) => ({
    id: row.id,
    name: row.name,
    phone: row.phone ?? null,
  }));
}

/**
 * Current per-barcode prices (cost/retail/wholesale) resolved from
 * product_variants, enriched with the parent product's name so the
 * negotiation shield can display them while scanning goods in.
 */
export async function fetchPriceHistory(barcode: string): Promise<PriceHistoryEntry[]> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  const trimmedBarcode = typeof barcode === "string" ? barcode.trim().slice(0, 120) : "";
  if (!trimmedBarcode) throw new Error("باركود مطلوب");

  const { data, error } = await sb
    .from("product_variants")
    .select("barcode,product_id,cost_price,selling_price,wholesale_price")
    .eq("barcode", trimmedBarcode)
    .eq("store_id", storeId);
  if (error) throw new Error(error.message);

  const variantRows = (data ?? []) as VariantPriceRow[];
  if (variantRows.length === 0) return [];

  const productIds = [...new Set(variantRows.map((v) => v.product_id).filter((id): id is string => Boolean(id)))];
  const namesByProduct = new Map<string, string>();
  for (let i = 0; i < productIds.length; i += 100) {
    const chunk = productIds.slice(i, i + 100);
    const { data: productRows, error: productsError } = await sb
      .from("products")
      .select("id,name")
      .eq("store_id", storeId)
      .in("id", chunk);
    if (productsError) throw new Error(productsError.message);
    for (const row of (productRows ?? []) as Array<{ id: string; name: string }>) {
      namesByProduct.set(row.id, row.name);
    }
  }

  return variantRows.map((v) => ({
    productId: v.product_id,
    barcode: v.barcode,
    productName: (v.product_id ? namesByProduct.get(v.product_id) : undefined) ?? trimmedBarcode,
    costPrice: toNum(v.cost_price),
    sellingPrice: toNum(v.selling_price),
    wholesalePrice: toNum(v.wholesale_price),
  }));
}
