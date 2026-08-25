import type { SupabaseClient } from "@supabase/supabase-js";
import { notifyLocalCatalogWrite } from "./catalogInvalidation";
import { getSupabaseBrowser, isSupabaseBrowserConfigured } from "./supabaseBrowser";
import { roundMoney } from "./saleMath";

/**
 * Store-scoped barcode conflict rule: a barcode may exist in other stores
 * (shared GTINs) but must be unique per product within a store.
 */
export function barcodeConflictInStore(
  row: { store_id?: string; product_id?: string },
  storeId: string,
  productId?: string,
): boolean {
  if (row.store_id !== storeId) return false;
  if (!productId) return true;
  return row.product_id !== productId;
}

export interface CatalogVariantPayload {
  barcode: string;
  variantLabel: string;
  costPrice: number;
  price: number;
  wholesalePrice: number;
  isDefaultSale: boolean;
}

export interface CatalogProductPayload {
  name: string;
  categoryId: string;
  category: string;
  brandId: string;
  brand: string;
  supplierId: string;
  supplier: string;
  baseUnit: string;
  stock: number;
  taxPercent: number;
  taxIncluded: boolean;
  isActive: boolean;
  showInPos: boolean;
  isSellable: boolean;
  isPurchasable: boolean;
  allowPriceChange: boolean;
  reorderLevel: number;
  isQuickKey: boolean;
  variants: CatalogVariantPayload[];
}

export interface InventoryVariantDto extends CatalogVariantPayload {
  id: string;
}

export interface InventoryProductDto {
  id: string;
  name: string;
  categoryId: string;
  category: string;
  brandId: string;
  brand: string;
  supplierId: string;
  supplier: string;
  baseUnit: string;
  stock: number;
  taxPercent: number;
  taxIncluded: boolean;
  isActive: boolean;
  showInPos: boolean;
  isSellable: boolean;
  isPurchasable: boolean;
  allowPriceChange: boolean;
  reorderLevel: number;
  isQuickKey: boolean;
  variants: InventoryVariantDto[];
}

export class CatalogProductError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "CatalogProductError";
    this.status = status;
  }
}

const MAX_VARIANTS = 30;

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function toNumber(value: unknown, fallback = 0): number {
  if (value == null) return fallback;
  const raw = typeof value === "string" ? value.trim() : value;
  if (raw === "") return fallback;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function toBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on", "نعم"].includes(normalized)) return true;
    if (["false", "0", "no", "off", "لا"].includes(normalized)) return false;
  }
  return fallback;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function normalizeBarcode(barcode: string): string {
  return barcode.replace(/\s+/g, "");
}

export function parseCatalogProductPayload(body: unknown): CatalogProductPayload {
  const input = (body ?? {}) as Record<string, unknown>;
  const name = clean(input.name);
  const categoryId = clean(input.categoryId);
  const category = clean(input.category);
  const brandId = clean(input.brandId);
  const brand = clean(input.brand);
  const supplierId = clean(input.supplierId);
  const supplier = clean(input.supplier);
  const baseUnit = clean(input.baseUnit) || "حبة";
  const stock = Math.max(0, Math.round(toNumber(input.stock, 0)));
  const taxPercent = toNumber(input.taxPercent, 16);
  const taxIncluded = toBoolean(input.taxIncluded, true);
  const isActive = toBoolean(input.isActive, true);
  const showInPos = toBoolean(input.showInPos, true);
  const isSellable = toBoolean(input.isSellable, true);
  const isPurchasable = toBoolean(input.isPurchasable, true);
  const allowPriceChange = toBoolean(input.allowPriceChange, false);
  const isQuickKey = toBoolean(input.isQuickKey, false);
  const reorderLevel = Math.max(0, Math.round(toNumber(input.reorderLevel, 0)));
  const rawVariants = Array.isArray(input.variants) ? input.variants : [];

  if (!name) throw new CatalogProductError("اسم المنتج مطلوب");
  if (name.length > 255) throw new CatalogProductError("اسم المنتج طويل جداً");
  if (category.length > 100) throw new CatalogProductError("اسم الفئة طويل جداً");
  if (brand.length > 120) throw new CatalogProductError("اسم الشركة طويل جداً");
  if (supplier.length > 150) throw new CatalogProductError("اسم المورد طويل جداً");
  if (baseUnit.length > 50) throw new CatalogProductError("اسم الوحدة طويل جداً");
  if (!Number.isFinite(taxPercent) || taxPercent < 0 || taxPercent > 100) {
    throw new CatalogProductError("نسبة الضريبة يجب أن تكون بين 0 و100");
  }
  if (rawVariants.length === 0) throw new CatalogProductError("أضف باركوداً واحداً على الأقل");
  if (rawVariants.length > MAX_VARIANTS) {
    throw new CatalogProductError(`أقصى عدد وحدات باركود للمنتج هو ${MAX_VARIANTS}`);
  }

  const seen = new Set<string>();
  const variants: CatalogVariantPayload[] = rawVariants
    .map((raw) => {
      const row = (raw ?? {}) as Record<string, unknown>;
      const barcode = normalizeBarcode(clean(row.barcode));
      const variantLabel = clean(row.variantLabel);
      const costPrice = toNumber(row.costPrice, 0);
      const price = toNumber(row.price, 0);
      const wholesalePrice = toNumber(row.wholesalePrice, 0);
      const isDefaultSale = toBoolean(row.isDefaultSale, false);
      return { barcode, variantLabel, costPrice, price, wholesalePrice, isDefaultSale };
    })
    .filter((row) => row.barcode.length > 0);

  if (variants.length === 0) throw new CatalogProductError("أضف باركوداً واحداً على الأقل");

  for (const row of variants) {
    if (seen.has(row.barcode)) throw new CatalogProductError(`الباركود مكرر داخل النموذج: ${row.barcode}`);
    seen.add(row.barcode);
    if (row.variantLabel.length > 120) throw new CatalogProductError("وصف النكهة أو الرائحة طويل جداً");
    if (!Number.isFinite(row.costPrice) || row.costPrice < 0 || !Number.isFinite(row.price) || row.price < 0 || !Number.isFinite(row.wholesalePrice) || row.wholesalePrice < 0) {
      throw new CatalogProductError(`أسعار غير صالحة للباركود ${row.barcode}`);
    }
  }

  if (variants.filter((row) => row.isDefaultSale).length > 1) {
    throw new CatalogProductError("اختر وحدة بيع افتراضية واحدة فقط");
  }
  if (!variants.some((row) => row.isDefaultSale)) variants[0].isDefaultSale = true;

  return {
    name,
    categoryId,
    category,
    brandId,
    brand,
    supplierId,
    supplier,
    baseUnit,
    stock,
    taxPercent: round2(taxPercent),
    taxIncluded,
    isActive,
    showInPos,
    isSellable,
    isPurchasable,
    allowPriceChange,
    isQuickKey,
    reorderLevel,
    variants: variants.map((row) => ({
      ...row,
      costPrice: round2(row.costPrice),
      price: round2(row.price),
      wholesalePrice: round2(row.wholesalePrice),
    })),
  };
}

async function getOrCreateCategory(
  client: SupabaseClient,
  storeId: string,
  name: string,
): Promise<string | null> {
  if (!name) return null;
  const found = await client
    .from("categories")
    .select("id")
    .eq("store_id", storeId)
    .eq("name", name)
    .maybeSingle();
  if (found.error) throw new CatalogProductError(found.error.message, 500);
  if (found.data?.id) return found.data.id;

  const created = await client
    .from("categories")
    .insert({ store_id: storeId, name })
    .select("id")
    .single();
  if (created.error || !created.data?.id) {
    throw new CatalogProductError(created.error?.message ?? "تعذر إنشاء الفئة", 500);
  }
  return created.data.id;
}

async function resolveCategory(
  client: SupabaseClient,
  storeId: string,
  id: string,
  name: string,
): Promise<string | null> {
  if (!id) return getOrCreateCategory(client, storeId, name);
  const found = await client
    .from("categories")
    .select("id")
    .eq("id", id)
    .eq("store_id", storeId)
    .maybeSingle();
  if (found.error) throw new CatalogProductError(found.error.message, 500);
  if (!found.data) throw new CatalogProductError("الفئة المحددة غير موجودة", 400);
  return found.data.id;
}

async function getOrCreateBrand(
  client: SupabaseClient,
  storeId: string,
  name: string,
): Promise<string | null> {
  if (!name) return null;
  const found = await client
    .from("product_brands")
    .select("id")
    .eq("store_id", storeId)
    .ilike("name", name)
    .maybeSingle();
  if (found.error) throw new CatalogProductError(found.error.message, 500);
  if (found.data?.id) return found.data.id;

  const created = await client
    .from("product_brands")
    .insert({ store_id: storeId, name })
    .select("id")
    .single();
  if (created.error || !created.data?.id) {
    throw new CatalogProductError(created.error?.message ?? "تعذر إنشاء الشركة", 500);
  }
  return created.data.id;
}

async function resolveBrand(
  client: SupabaseClient,
  storeId: string,
  id: string,
  name: string,
): Promise<string | null> {
  if (!id) return getOrCreateBrand(client, storeId, name);
  const found = await client
    .from("product_brands")
    .select("id")
    .eq("id", id)
    .eq("store_id", storeId)
    .maybeSingle();
  if (found.error) throw new CatalogProductError(found.error.message, 500);
  if (!found.data) throw new CatalogProductError("الشركة المحددة غير موجودة", 400);
  return found.data.id;
}

async function resolveSupplier(
  client: SupabaseClient,
  storeId: string,
  id: string,
): Promise<string | null> {
  if (!id) return null;
  const found = await client
    .from("suppliers")
    .select("id")
    .eq("id", id)
    .eq("store_id", storeId)
    .maybeSingle();
  if (found.error) throw new CatalogProductError(found.error.message, 500);
  if (!found.data) throw new CatalogProductError("المورد المحدد غير موجود", 400);
  return found.data.id;
}

async function assertNoBarcodeConflict(
  client: SupabaseClient,
  storeId: string,
  barcodes: string[],
  productId?: string,
): Promise<void> {
  if (barcodes.length === 0) return;
  const { data, error } = await client
    .from("product_variants")
    .select("barcode,product_id,store_id")
    .eq("store_id", storeId)
    .in("barcode", barcodes);
  if (error) throw new CatalogProductError(error.message, 500);

  const conflict = (data ?? []).find((row) => {
    if (!productId) return true;
    return row.product_id !== productId;
  });
  if (conflict) {
    throw new CatalogProductError(`الباركود مستخدم مسبقاً: ${conflict.barcode}`, 409);
  }
}

function toDto(productId: string, payload: CatalogProductPayload): InventoryProductDto {
  return {
    id: productId,
    name: payload.name,
    categoryId: payload.categoryId,
    category: payload.category,
    brandId: payload.brandId,
    brand: payload.brand,
    supplierId: payload.supplierId,
    supplier: payload.supplier,
    baseUnit: payload.baseUnit,
    stock: payload.stock,
    taxPercent: payload.taxPercent,
    taxIncluded: payload.taxIncluded,
    isActive: payload.isActive,
    showInPos: payload.showInPos,
    isSellable: payload.isSellable,
    isPurchasable: payload.isPurchasable,
    allowPriceChange: payload.allowPriceChange,
    reorderLevel: payload.reorderLevel,
    isQuickKey: payload.isQuickKey,
    variants: payload.variants.map((v) => ({
      id: `v-${v.barcode}`,
      barcode: v.barcode,
      variantLabel: v.variantLabel,
      costPrice: v.costPrice,
      price: v.price,
      wholesalePrice: v.wholesalePrice,
      isDefaultSale: v.isDefaultSale,
    })),
  };
}

export async function createCatalogProduct(
  client: SupabaseClient,
  storeId: string,
  payload: CatalogProductPayload,
): Promise<InventoryProductDto> {
  const barcodes = payload.variants.map((v) => v.barcode);
  await assertNoBarcodeConflict(client, storeId, barcodes);
  const categoryId = await resolveCategory(client, storeId, payload.categoryId, payload.category);
  const brandId = await resolveBrand(client, storeId, payload.brandId, payload.brand);
  const supplierId = await resolveSupplier(client, storeId, payload.supplierId);

  const defaultVariant = payload.variants.find((v) => v.isDefaultSale) ?? payload.variants[0];
  const product = await client
    .from("products")
    .insert({
      store_id: storeId,
      category_id: categoryId,
      brand_id: brandId,
      default_supplier_id: supplierId,
      name: payload.name,
      base_unit: payload.baseUnit,
      total_stock: 0,
      is_quick_key: payload.isQuickKey,
      tax_percent: payload.taxPercent,
      tax_included: payload.taxIncluded,
      is_active: payload.isActive,
      show_in_pos: payload.showInPos,
      is_sellable: payload.isSellable,
      is_purchasable: payload.isPurchasable,
      allow_price_change: payload.allowPriceChange,
      reorder_level: payload.reorderLevel,
      cost_price: defaultVariant.costPrice,
      selling_price: defaultVariant.price,
      wholesale_price: defaultVariant.wholesalePrice,
    })
    .select("id")
    .single();
  if (product.error || !product.data?.id) {
    throw new CatalogProductError(product.error?.message ?? "تعذر إنشاء المنتج", 500);
  }

  const productId = product.data.id;
  const variants = payload.variants.map((row) => ({
    store_id: storeId,
    product_id: productId,
    barcode: row.barcode,
    variant_label: row.variantLabel,
    cost_price: row.costPrice || 0,
    selling_price: row.price || 0,
    wholesale_price: row.wholesalePrice || 0,
  }));
  const inserted = await client.from("product_variants").insert(variants);
  if (inserted.error) {
    await client.from("products").delete().eq("id", productId).eq("store_id", storeId);
    throw new CatalogProductError(inserted.error.message, 500);
  }

  if (payload.stock > 0) {
    const opening = await client.rpc("record_inventory_movement", {
      p_store_id: storeId,
      p_product_id: productId,
      p_quantity_delta: payload.stock,
      p_movement_type: "OPENING",
      p_idempotency_key: `opening:${productId}`,
      p_unit_quantity: payload.stock,
      p_reference_type: "PRODUCT",
      p_reference_id: productId,
      p_reason: "رصيد افتتاحي عند إنشاء المنتج",
    });
    if (opening.error) {
      await client.from("products").delete().eq("id", productId).eq("store_id", storeId);
      throw new CatalogProductError(opening.error.message, 500);
    }
  }

  notifyLocalCatalogWrite(storeId);
  return toDto(productId, payload);
}

export async function updateCatalogProduct(
  client: SupabaseClient,
  storeId: string,
  productId: string,
  payload: CatalogProductPayload,
): Promise<InventoryProductDto> {
  const existingProduct = await client
    .from("products")
    .select("id,total_stock")
    .eq("id", productId)
    .eq("store_id", storeId)
    .maybeSingle();
  if (existingProduct.error) throw new CatalogProductError(existingProduct.error.message, 500);
  if (!existingProduct.data) throw new CatalogProductError("المنتج غير موجود", 404);

  const barcodes = payload.variants.map((v) => v.barcode);
  await assertNoBarcodeConflict(client, storeId, barcodes, productId);
  const categoryId = await resolveCategory(client, storeId, payload.categoryId, payload.category);
  const brandId = await resolveBrand(client, storeId, payload.brandId, payload.brand);
  const supplierId = await resolveSupplier(client, storeId, payload.supplierId);

  const defaultVariant = payload.variants.find((v) => v.isDefaultSale) ?? payload.variants[0];
  const updated = await client
    .from("products")
    .update({
      category_id: categoryId,
      brand_id: brandId,
      default_supplier_id: supplierId,
      name: payload.name,
      base_unit: payload.baseUnit,
      tax_percent: payload.taxPercent,
      tax_included: payload.taxIncluded,
      is_active: payload.isActive,
      show_in_pos: payload.showInPos,
      is_sellable: payload.isSellable,
      is_purchasable: payload.isPurchasable,
      allow_price_change: payload.allowPriceChange,
      is_quick_key: payload.isQuickKey,
      reorder_level: payload.reorderLevel,
      cost_price: defaultVariant.costPrice,
      selling_price: defaultVariant.price,
      wholesale_price: defaultVariant.wholesalePrice,
    })
    .eq("id", productId)
    .eq("store_id", storeId);
  if (updated.error) throw new CatalogProductError(updated.error.message, 500);

  const { data: existingVariants, error: variantsError } = await client
    .from("product_variants")
    .select("barcode")
    .eq("product_id", productId)
    .eq("store_id", storeId);
  if (variantsError) throw new CatalogProductError(variantsError.message, 500);

  const nextBarcodes = new Set(barcodes);
  const removed = (existingVariants ?? [])
    .map((row) => row.barcode)
    .filter((barcode) => !nextBarcodes.has(barcode));
  if (removed.length > 0) {
    const deleted = await client
      .from("product_variants")
      .delete()
      .eq("product_id", productId)
      .eq("store_id", storeId)
      .in("barcode", removed);
    if (deleted.error) throw new CatalogProductError(deleted.error.message, 500);
  }

  const upserted = await client.from("product_variants").upsert(
    payload.variants.map((row) => ({
      store_id: storeId,
      product_id: productId,
      barcode: row.barcode,
      variant_label: row.variantLabel,
      cost_price: row.costPrice || 0,
      selling_price: row.price || 0,
      wholesale_price: row.wholesalePrice || 0,
    })),
    { onConflict: "store_id,barcode" },
  );
  if (upserted.error) throw new CatalogProductError(upserted.error.message, 500);

  notifyLocalCatalogWrite(storeId);
  return toDto(productId, { ...payload, stock: Number(existingProduct.data.total_stock) || 0 });
}

export async function deleteCatalogProduct(
  client: SupabaseClient,
  storeId: string,
  productId: string,
): Promise<void> {
  const existingProduct = await client
    .from("products")
    .select("id")
    .eq("id", productId)
    .eq("store_id", storeId)
    .maybeSingle();
  if (existingProduct.error) throw new CatalogProductError(existingProduct.error.message, 500);
  if (!existingProduct.data) throw new CatalogProductError("المنتج غير موجود", 404);

  const movements = await client
    .from("inventory_movements")
    .select("id", { count: "exact", head: true })
    .eq("product_id", productId)
    .eq("store_id", storeId);
  if (movements.error) throw new CatalogProductError(movements.error.message, 500);
  if ((movements.count ?? 0) > 0) {
    throw new CatalogProductError("لا يمكن حذف منتج له حركات مخزون؛ عطّل المنتج للحفاظ على السجل", 409);
  }

  const removed = await client.from("products").delete().eq("id", productId).eq("store_id", storeId);
  if (removed.error) throw new CatalogProductError(removed.error.message, 500);

  notifyLocalCatalogWrite(storeId);
}

/**
 * PostgREST errors surface as raw English internals (or an opaque 400 when
 * the schema cache / filters are off). Keep one Arabic summarizer so every
 * caller can show the exact reason without leaking driver jargon.
 */
function describePgError(error: { message?: string | null }): string {
  const message = typeof error?.message === "string" ? error.message : "";
  if (/Could not find the .* column/i.test(message)) {
    return "عمود غير موجود في قاعدة البيانات — شغّل الترحيلات";
  }
  if (/row-level security/i.test(message)) {
    return "صلاحيات الجلسة الحالية لا تسمح بالتعديل";
  }
  if (/numeric field overflow|numeric value out of range/i.test(message)) {
    return "السعر يتجاوز الحد المسموح في قاعدة البيانات";
  }
  return message ? message.slice(0, 140) : "خطأ غير معروف";
}

/**
 * Quick price update (Phase 3 "ليونة" drawer). Sets the product's retail
 * selling price on the parent row and every denormalized copy — Tier 4
 * variants AND Tier 3.5 piece-equivalent packaging units (migration 080) —
 * so scans and unit-picker picks charge the new price immediately. Guarded
 * result object; never throws, the drawer renders the failure.
 */
export async function quickUpdateProductPrice(
  storeId: string,
  productId: string,
  salePrice: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const sb = getSupabaseBrowser();
  if (!sb || !isSupabaseBrowserConfigured()) return { ok: false, error: "offline" };
  if (!Number.isFinite(salePrice) || salePrice < 0) {
    return { ok: false, error: "سعر غير صالح" };
  }

  // The columns patched below are canonical (products.selling_price from
  // migration 062; product_variants from 067/072; product_units from 080),
  // so a 400 here means the REQUEST shape was rejected. Pre-validate the two
  // inputs REST answers with an opaque 400: uuid-shaped filters (22P02) and
  // values that fit products.selling_price NUMERIC(12,2) (22003).
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(productId) || !UUID_RE.test(storeId)) {
    return {
      ok: false,
      error: "معرّف المنتج غير صالح — حدّث بيانات الكتالوج ثم أعد المحاولة",
    };
  }
  const next = roundMoney(salePrice);
  if (!Number.isFinite(next) || Math.abs(next) >= 1e10) {
    return { ok: false, error: "السعر أكبر من الحد المسموح في قاعدة البيانات" };
  }

  try {
    const updated = await sb
      .from("products")
      .update({ selling_price: next })
      .eq("id", productId)
      .eq("store_id", storeId);
    if (updated.error) {
      return { ok: false, error: `تعذر تحديث السعر: ${describePgError(updated.error)}` };
    }

    // Denormalized copies must follow the parent or stale rows keep charging
    // the old price at scan time. Both steps are same-store scoped.
    const failures: string[] = [];
    const variants = await sb
      .from("product_variants")
      .update({ selling_price: next })
      .eq("product_id", productId)
      .eq("store_id", storeId);
    if (variants.error) failures.push(`المتغيرات: ${describePgError(variants.error)}`);

    const units = await sb
      .from("product_units")
      .update({ selling_price: next })
      .eq("product_id", productId)
      .eq("store_id", storeId)
      .eq("qty_multiplier", 1);
    if (units.error) failures.push(`وحدات التغليف: ${describePgError(units.error)}`);

    if (failures.length > 0) {
      return {
        ok: false,
        error: `تم تحديث سعر المنتج لكن فشل نشره على (${failures.join("؛ ")})`,
      };
    }

    // Converge every device/tab onto the new price immediately.
    notifyLocalCatalogWrite(storeId);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: `تعذر تحديث السعر: ${error instanceof Error ? error.message : "خطأ شبكة"}`,
    };
  }
}
