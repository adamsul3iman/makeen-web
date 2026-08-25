import { getSupabaseBrowser } from "./supabaseBrowser";
import { notifyLocalCatalogWrite } from "./catalogInvalidation";

/**
 * Browser client for Tier 3.5 packaging units (`product_units`, migration
 * 080). The table is anon-writable by design (same posture as categories and
 * brands since 071), so the admin inventory manager CRUDs it directly.
 *
 * Unit barcodes share ONE per-store namespace with variant barcodes —
 * Postgres cannot express that cross-table unique constraint, so every write
 * validates both tables first (see assertUnitBarcodeFree).
 */

export interface ProductUnitRow {
  id: string;
  productId: string;
  unitName: string;
  qtyMultiplier: number;
  costPrice: number;
  sellingPrice: number;
  wholesalePrice: number;
  barcode: string | null;
  isDefaultSale: boolean;
  isActive: boolean;
  sortOrder: number;
}

/** New rows omit `id`; existing rows carry it for the upsert target. */
export type SaveProductUnitInput = Omit<ProductUnitRow, "productId" | "id"> & {
  productId: string;
  id?: string;
};

const UNIT_COLUMNS =
  "id,product_id,unit_name,qty_multiplier,cost_price,selling_price,wholesale_price,barcode,is_default_sale,is_active,sort_order";

function num(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function mapRow(row: Record<string, unknown>): ProductUnitRow {
  return {
    id: String(row.id),
    productId: String(row.product_id),
    unitName: String(row.unit_name ?? ""),
    qtyMultiplier: num(row.qty_multiplier, 1),
    costPrice: num(row.cost_price),
    sellingPrice: num(row.selling_price),
    wholesalePrice: num(row.wholesale_price),
    barcode: (row.barcode as string | null) ?? null,
    isDefaultSale: row.is_default_sale === true,
    isActive: row.is_active !== false,
    sortOrder: num(row.sort_order),
  };
}

function requireClient() {
  const sb = getSupabaseBrowser();
  if (!sb) throw new Error("Supabase غير مهيأة");
  return sb;
}

/** All units of one product, purchase-friendly order (multiplier asc). */
export async function fetchProductUnits(
  storeId: string,
  productId: string,
): Promise<ProductUnitRow[]> {
  const sb = requireClient();
  const { data, error } = await sb
    .from("product_units")
    .select(UNIT_COLUMNS)
    .eq("store_id", storeId)
    .eq("product_id", productId)
    .order("sort_order", { ascending: true });
  if (error) throw new Error(error.message);
  return ((data ?? []) as Record<string, unknown>[]).map(mapRow);
}

/**
 * A unit barcode must be free in BOTH tables of the shared per-store
 * namespace. `excludeUnitId` allows re-saving a row with its own barcode.
 */
async function assertUnitBarcodeFree(
  sb: NonNullable<ReturnType<typeof getSupabaseBrowser>>,
  storeId: string,
  productId: string,
  barcode: string,
  excludeUnitId?: string,
): Promise<void> {
  const [variantHit, unitHits] = await Promise.all([
    sb.from("product_variants").select("id").eq("store_id", storeId).eq("barcode", barcode).limit(1),
    sb.from("product_units").select("id,product_id").eq("store_id", storeId).eq("barcode", barcode),
  ]);
  if (variantHit.error) throw new Error(variantHit.error.message);
  if ((variantHit.data ?? []).length > 0) {
    throw new Error(`الباركود مستخدم مسبقاً لباركود صنف: ${barcode}`);
  }
  if (unitHits.error) throw new Error(unitHits.error.message);
  const conflict = ((unitHits.data ?? []) as Array<{ id: string; product_id: string }>).find(
    (row) => row.id !== excludeUnitId || row.product_id !== productId,
  );
  if (conflict && conflict.product_id === productId && conflict.id === excludeUnitId) return;
  if (conflict) throw new Error(`الباركود مستخدم مسبقاً لوحدة أخرى: ${barcode}`);
}

/**
 * Upsert one packaging unit. Exactly-one-default-sale is enforced by a
 * partial unique index, so setting a new default first clears the old one.
 */
export async function saveProductUnit(
  storeId: string,
  input: SaveProductUnitInput,
): Promise<ProductUnitRow> {
  const sb = requireClient();
  const name = input.unitName.trim();
  if (!name) throw new Error("اسم الوحدة مطلوب");
  if (!(Number.isFinite(input.qtyMultiplier) && input.qtyMultiplier > 0)) {
    throw new Error("معامل التحويل يجب أن يكون أكبر من صفر");
  }
  if (input.barcode && input.barcode.trim()) {
    await assertUnitBarcodeFree(sb, storeId, input.productId, input.barcode.trim(), input.id || undefined);
  }

  if (input.isDefaultSale) {
    await sb.from("product_units").update({ is_default_sale: false }).match({ store_id: storeId, product_id: input.productId, is_default_sale: true });
  }

  const values = {
    store_id: storeId,
    product_id: input.productId,
    id: input.id || undefined,
    unit_name: name.slice(0, 60),
    qty_multiplier: input.qtyMultiplier,
    cost_price: input.costPrice || 0,
    selling_price: input.sellingPrice || 0,
    wholesale_price: input.wholesalePrice || 0,
    barcode: input.barcode?.trim() || null,
    is_default_sale: input.isDefaultSale,
    is_active: input.isActive,
    sort_order: input.sortOrder || 0,
  };

  const { data, error } = await sb
    .from("product_units")
    .upsert(values, { onConflict: "id" })
    .select(UNIT_COLUMNS)
    .single();
  if (error) throw new Error(error.message);

  // Converge POS surfaces: unit chips re-price from this table.
  notifyLocalCatalogWrite(storeId);
  return mapRow((data ?? {}) as Record<string, unknown>);
}

export async function deleteProductUnit(storeId: string, unitId: string): Promise<void> {
  const sb = requireClient();
  const { error } = await sb.from("product_units").delete().eq("id", unitId).eq("store_id", storeId);
  if (error) throw new Error(error.message);
  notifyLocalCatalogWrite(storeId);
}
