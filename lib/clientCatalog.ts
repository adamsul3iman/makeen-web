import type {
  BarcodeIndex,
  BarcodeMap,
  Cashier,
  CategoryMap,
  LocalUnit,
  ProductMap,
  ProductUnitsMap,
  QuickKeyItem,
  PosSnapshot,
} from "@/types/pos.types";
import { detectColumnExists, fetchAllRows } from "./supabase";
import { getSupabaseBrowser, isSupabaseBrowserConfigured } from "./supabaseBrowser";
import { sha256Hex } from "./sha256";
import {
  STAFF_ROLE_PRESETS,
  normalizeStaffRoleCode,
  type StaffLimits,
} from "./permissions";

interface CategoryRow {
  id: string;
  name: string;
  parent_id: string | null;
  bg_color: string | null;
  is_quick_key: boolean;
  sort_order: number;
  show_in_pos?: boolean;
}

interface ProductRow {
  id: string;
  category_id: string | null;
  name: string;
  base_unit: string;
  total_stock: number;
  is_quick_key: boolean;
  brand_id: string | null;
  default_supplier_id: string | null;
  tax_percent: number;
  tax_included: boolean;
  is_active: boolean;
  show_in_pos: boolean;
  is_sellable: boolean;
  is_purchasable: boolean;
  allow_price_change: boolean;
  reorder_level: number;
  cost_price: number;
  selling_price: number;
  wholesale_price: number;
}

interface BrandRow {
  id: string;
  name: string;
}

interface SupplierRow {
  id: string;
  name: string;
}

interface VariantRow {
  id: string;
  product_id: string;
  barcode: string;
  variant_label: string;
  total_stock: number;
  is_active: boolean;
  cost_price?: number;
  selling_price?: number;
  wholesale_price?: number;
}

interface CashierRow {
  id: string;
  name: string;
  role: string;
  role_id: string | null;
  is_active: boolean | null;
}

/** Row shape of `product_units` (migration 080). */
interface ProductUnitRow {
  id: string;
  product_id: string;
  unit_name: string;
  qty_multiplier: number | string;
  cost_price: number | null;
  selling_price: number | null;
  wholesale_price: number | null;
  barcode: string | null;
  is_default_sale: boolean;
  is_active: boolean;
  sort_order: number;
}

interface StaffRoleRow {
  id: string;
  code: string;
  name: string;
  capabilities: string[] | null;
  limits: StaffLimits | null;
}

function catalogVersionOf(value: unknown): string {
  return sha256Hex(JSON.stringify(value));
}

/**
 * Fetch the UoM tier (`product_units`, migration 080). Guarded separately:
 * a store whose migrations have not been applied yet (or an offline device)
 * must still get a full snapshot — units then fall back to per-product
 * synthesis below.
 */
async function fetchProductUnitRows(
  sb: NonNullable<ReturnType<typeof getSupabaseBrowser>>,
  storeId: string,
): Promise<ProductUnitRow[]> {
  try {
    return await fetchAllRows<ProductUnitRow>(
      sb,
      "product_units",
      "id,product_id,unit_name,qty_multiplier,cost_price,selling_price,wholesale_price,barcode,is_default_sale,is_active,sort_order",
      storeId,
      "sort_order",
    );
  } catch {
    return [];
  }
}

/**
 * Safe staff roster via the `list_cashiers_public` SECURITY DEFINER RPC.
 * Migration 078 made `cashiers` deny-all for the browser anon key, so a
 * direct REST select fails with 401 and would take the whole snapshot
 * Promise.all down with it.
 */
async function fetchCashierRowsPublic(
  sb: NonNullable<ReturnType<typeof getSupabaseBrowser>>,
  storeId: string,
): Promise<CashierRow[]> {
  const { data, error } = await sb.rpc("list_cashiers_public", {
    p_store_id: storeId,
    p_include_inactive: true,
  });
  if (error) throw error;
  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    name: String(row.name ?? ""),
    role: String(row.role ?? ""),
    role_id: (row.role_id as string | null) ?? null,
    is_active: row.is_active !== false,
  }));
}

const BASE_UNIT_FALLBACK = "حبة";

/**
 * Build the per-product UoM map from server rows with a synthesis fallback.
 * Every product always ends up with at least one sellable unit (the base
 * piece at the product's own prices), so unit-aware cart paths never need
 * existence checks. Exactly one active unit per product is flagged as the
 * default-sale unit.
 */
export function buildProductUnits(
  products: ProductMap,
  rows: ProductUnitRow[],
): ProductUnitsMap {
  const byProduct = new Map<string, ProductUnitRow[]>();
  for (const row of rows) {
    if (!byProduct.has(row.product_id)) byProduct.set(row.product_id, []);
    byProduct.get(row.product_id)!.push(row);
  }

  const unitsMap: ProductUnitsMap = {};
  for (const product of Object.values(products)) {
    const rowsForProduct = (byProduct.get(product.id) ?? [])
      .filter((r) => r.is_active !== false)
      .sort(
        (a, b) =>
          Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0) ||
          String(a.unit_name).localeCompare(String(b.unit_name)),
      );

    let units: LocalUnit[] = rowsForProduct.map((r) => ({
      id: r.id,
      productId: product.id,
      unitName: String(r.unit_name ?? "").trim() || BASE_UNIT_FALLBACK,
      qtyMultiplier: Math.max(Number(r.qty_multiplier) || 1, 0.001),
      costPrice: Number(r.cost_price ?? 0) || product.costPrice,
      sellingPrice: Number(r.selling_price ?? 0) || product.price,
      wholesalePrice: Number(r.wholesale_price ?? 0) || product.wholesalePrice,
      barcode: r.barcode?.trim() || undefined,
      isDefaultSale: !!r.is_default_sale,
      isActive: true,
      sortOrder: Number(r.sort_order ?? 0),
    }));

    if (units.length === 0) {
      units = [
        {
          id: `${product.id}:base`,
          productId: product.id,
          unitName: product.baseUnit?.trim() || BASE_UNIT_FALLBACK,
          qtyMultiplier: 1,
          costPrice: product.costPrice,
          sellingPrice: product.price,
          wholesalePrice: product.wholesalePrice,
          isDefaultSale: true,
          isActive: true,
          sortOrder: 0,
        },
      ];
    }

    if (!units.some((u) => u.isDefaultSale)) {
      units[0] = { ...units[0], isDefaultSale: true };
    }

    unitsMap[product.id] = units;
  }
  return unitsMap;
}

/**
 * Browser-side rebuild of the POS catalog snapshot (formerly served by
 * /api/catalog). Reads categories/brands/suppliers/products/variants/
 * cashiers/staff_roles directly through the anon-key client and maps them
 * into the exact denormalized shape the register hydrates and caches in
 * IndexedDB. Returns null when Supabase is unreachable or unconfigured so
 * callers can fall back to the local cache.
 */
export async function fetchCatalogSnapshot(storeId: string): Promise<PosSnapshot | null> {
  const sb = getSupabaseBrowser();
  if (!sb || !isSupabaseBrowserConfigured()) return null;

  try {
    const hasCategoryShowInPos = await detectColumnExists(sb, "categories", "show_in_pos");
    const categorySelect = hasCategoryShowInPos
      ? "id,name,parent_id,bg_color,is_quick_key,sort_order,show_in_pos"
      : "id,name,parent_id,bg_color,is_quick_key,sort_order";

    const [categories, brands, suppliers, products, variants, cashierRows, staffRoles, unitRows] = await Promise.all([
      fetchAllRows<CategoryRow>(sb, "categories", categorySelect, storeId, "name"),
      fetchAllRows<BrandRow>(sb, "product_brands", "id,name", storeId, "name"),
      fetchAllRows<SupplierRow>(sb, "suppliers", "id,name", storeId, "name"),
      fetchAllRows<ProductRow>(
        sb,
        "products",
        "id,category_id,name,base_unit,total_stock,is_quick_key,brand_id,default_supplier_id,tax_percent,tax_included,is_active,show_in_pos,is_sellable,is_purchasable,allow_price_change,reorder_level,cost_price,selling_price,wholesale_price",
        storeId,
        "name",
      ),
      fetchAllRows<VariantRow>(
        sb,
        "product_variants",
        "id,product_id,barcode,variant_label,total_stock,is_active,cost_price,selling_price,wholesale_price",
        storeId,
        "variant_label",
      ),
      fetchCashierRowsPublic(sb, storeId),
      fetchAllRows<StaffRoleRow>(sb, "staff_roles", "id,code,name,capabilities,limits", storeId, "sort_order"),
      fetchProductUnitRows(sb, storeId),
    ]);

    const roleById = new Map(staffRoles.map((role) => [role.id, role]));

    // Migration 078: PIN verifiers never leave the database. Snapshot cashiers
    // carry safe profile data only — pinHash is intentionally empty so the
    // legacy local match in loginCashier can never succeed; offline unlock of
    // the ACTIVE cashier goes through the cashierSessionCache instead.
    const cashiers: Cashier[] = cashierRows
      .filter((c) => c.is_active !== false)
      .map((c) => {
        const roleRow = c.role_id ? roleById.get(c.role_id) : undefined;
        const roleCode = roleRow?.code ?? normalizeStaffRoleCode(c.role);
        const preset = STAFF_ROLE_PRESETS[normalizeStaffRoleCode(roleCode)];
        return {
          id: c.id,
          name: c.name,
          pinHash: "",
          role: c.role,
          roleId: c.role_id ?? undefined,
          roleCode,
          roleName: roleRow?.name ?? preset.name,
          capabilities: roleRow?.capabilities ?? [...preset.capabilities],
          limits: roleRow?.limits ?? { ...preset.limits },
        };
      });

    const categoryMap: CategoryMap = {};
    categories.forEach((c) => {
      categoryMap[c.id] = {
        id: c.id,
        name: c.name,
        parentId: c.parent_id,
        bgColor: c.bg_color,
        isQuickKey: c.is_quick_key,
        sortOrder: c.sort_order,
        showInPos: hasCategoryShowInPos ? (c.show_in_pos ?? true) : true,
      };
    });

    const brandMap = Object.fromEntries(brands.map((brand) => [brand.id, brand]));
    const supplierMap = Object.fromEntries(suppliers.map((supplier) => [supplier.id, supplier]));

    const productMap: ProductMap = {};
    for (const p of products) {
      productMap[p.id] = {
        id: p.id,
        categoryId: p.category_id ?? "",
        name: p.name,
        baseUnit: p.base_unit,
        isWeighed: false,
        totalStock: p.total_stock,
        price: p.selling_price ?? 0,
        costPrice: p.cost_price ?? 0,
        wholesalePrice: p.wholesale_price ?? undefined,
        brandId: p.brand_id ?? undefined,
        brandName: p.brand_id ? brandMap[p.brand_id]?.name : undefined,
        supplierId: p.default_supplier_id ?? undefined,
        supplierName: p.default_supplier_id ? supplierMap[p.default_supplier_id]?.name : undefined,
        taxPercent: Number(p.tax_percent),
        taxIncluded: p.tax_included,
        isActive: p.is_active,
        showInPos: p.show_in_pos,
        isSellable: p.is_sellable,
        isPurchasable: p.is_purchasable,
        allowPriceChange: p.allow_price_change,
        reorderLevel: p.reorder_level,
      };
    }

    const barcodeMap: BarcodeMap = {};
    const barcodeIndex: BarcodeIndex = {};
    const orderedVariants = [...variants].sort((a, b) =>
      a.barcode.localeCompare(b.barcode),
    );
    const defaultVariant = new Map<string, VariantRow>();
    for (const v of orderedVariants) {
      const product = productMap[v.product_id];
      if (!product) continue;
      const variantId = v.id;
      barcodeMap[v.barcode] = {
        barcode: v.barcode,
        productId: v.product_id,
        variantId,
        variantLabel: v.variant_label,
        unitName: product.baseUnit,
        qtyMultiplier: 1,
        price: Number(v.selling_price ?? 0) || product.price,
        costPrice: Number(v.cost_price ?? 0) || product.costPrice,
        wholesalePrice: Number(v.wholesale_price ?? 0) || product.wholesalePrice,
        isDefaultSale: true,
        isDefaultPurchase: true,
      };
      barcodeIndex[v.barcode] = {
        product_id: v.product_id,
        variantId,
        name: product.name,
        price: Number(v.selling_price ?? 0) || product.price,
        variantLabel: v.variant_label,
      };
      if (!defaultVariant.has(v.product_id)) defaultVariant.set(v.product_id, v);
    }

    // UoM tier: per-product units with synthesis fallback, plus package
    // barcodes indexed alongside variant codes (variant codes win collisions).
    const productUnits = buildProductUnits(productMap, unitRows);
    for (const units of Object.values(productUnits)) {
      for (const unit of units) {
        const code = unit.barcode?.trim();
        if (!code || barcodeMap[code]) continue;
        barcodeMap[code] = {
          barcode: code,
          productId: unit.productId,
          // Units are not variants; the synthetic id keeps provenance.
          variantId: `${unit.id}:unit`,
          variantLabel: "",
          unitName: unit.unitName,
          qtyMultiplier: unit.qtyMultiplier,
          price: unit.sellingPrice,
          costPrice: unit.costPrice,
          wholesalePrice: unit.wholesalePrice,
          isDefaultSale: false,
          isDefaultPurchase: false,
          unitId: unit.id,
        };
        barcodeIndex[code] = {
          product_id: unit.productId,
          variantId: `${unit.id}:unit`,
          name: productMap[unit.productId]?.name ?? "",
          price: unit.sellingPrice,
          variantLabel: "",
          unitName: unit.unitName,
          qtyMultiplier: unit.qtyMultiplier,
          unitId: unit.id,
        };
      }
    }

    const quickKeys: QuickKeyItem[] = products
      .filter((p) => p.is_active && p.show_in_pos && p.is_sellable)
      .map((p, i) => {
        const defaultUnit = defaultVariant.get(p.id);
        return {
          id: `qk-${p.id}`,
          categoryId: p.category_id ?? "",
          label: p.name,
          bgColor: categoryMap[p.category_id ?? ""]?.bgColor ?? "#0f766e",
          sortOrder: i + 1,
          productId: p.id,
          unitName: defaultUnit ? productMap[p.id]?.baseUnit ?? p.base_unit : p.base_unit,
          price: p.selling_price ?? 0,
          barcode: defaultUnit?.barcode,
          variantLabel: defaultUnit?.variant_label,
          taxPercent: Number(p.tax_percent),
          taxIncluded: p.tax_included,
          brandId: p.brand_id ?? undefined,
          brandName: p.brand_id ? brandMap[p.brand_id]?.name : undefined,
          isQuickKey: p.is_quick_key ?? false,
        };
      });

    const updatedAt = catalogVersionOf({
      categories: categoryMap,
      products: productMap,
      barcodes: barcodeMap,
      barcodeIndex,
      productUnits,
      quickKeys,
      cashiers,
    });

    return {
      schemaVersion: 1,
      updatedAt,
      categories: categoryMap,
      brands: brandMap,
      suppliers: supplierMap,
      products: productMap,
      barcodes: barcodeMap,
      barcodeIndex,
      productUnits,
      quickKeys,
      cashiers,
      pinSalt: "",
    };
  } catch {
    return null;
  }
}

/** Row shape returned by fetchCustomersPayload (mirrors the legacy API rows). */
export interface CustomerDirectoryRow {
  id: string;
  name: string;
  phone: string;
  balance: number;
  created_at: string;
}

function customersVersionOf(customers: CustomerDirectoryRow[]): string {
  return sha256Hex(JSON.stringify(customers));
}

export interface CustomersPayload {
  customers: CustomerDirectoryRow[];
  updatedAt: string;
}

/**
 * Browser-side customer directory read (formerly /api/customers). The
 * updatedAt version hashes exactly like the legacy endpoint so cached
 * versions stay comparable across the migration.
 */
export async function fetchCustomersPayload(storeId: string): Promise<CustomersPayload | null> {
  const sb = getSupabaseBrowser();
  if (!sb || !isSupabaseBrowserConfigured() || !storeId) return null;

  try {
    const rows = await fetchAllRows<{
      id: string;
      name: string;
      phone: string | null;
      balance: number | null;
      created_at: string | null;
    }>(
      sb,
      "customers",
      "id,name,phone,balance,created_at",
      storeId,
      "name",
    );
    const customers: CustomerDirectoryRow[] = rows.map((row) => ({
      id: row.id,
      name: row.name,
      phone: row.phone ?? "",
      balance: Number(row.balance) || 0,
      created_at: row.created_at ?? "",
    }));
    return { customers, updatedAt: customersVersionOf(customers) };
  } catch {
    return null;
  }
}
