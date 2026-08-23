import type {
  BarcodeIndex,
  BarcodeMap,
  Cashier,
  CategoryMap,
  ProductMap,
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
  pin: string | null;
  pin_salt: string | null;
  pin_hash: string | null;
  role: string;
  role_id: string | null;
  is_active: boolean | null;
}

interface StaffRoleRow {
  id: string;
  code: string;
  name: string;
  capabilities: string[] | null;
  limits: StaffLimits | null;
}

function pinSaltFor(storeId: string): string {
  return sha256Hex(`pos:pin-salt:${storeId}`).slice(0, 16);
}

function cashierPin(c: CashierRow, storeId: string): { pinHash: string; pinSalt: string } {
  const pinSalt = c.pin_salt ?? pinSaltFor(storeId);
  const pinHash = c.pin_hash ?? (c.pin ? sha256Hex(c.pin + pinSalt) : "");
  return { pinHash, pinSalt };
}

function catalogVersionOf(value: unknown): string {
  return sha256Hex(JSON.stringify(value));
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

    const [categories, brands, suppliers, products, variants, cashierRows, staffRoles] = await Promise.all([
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
      fetchAllRows<CashierRow>(sb, "cashiers", "id,name,pin,role,role_id,pin_salt,pin_hash,is_active", storeId, "name"),
      fetchAllRows<StaffRoleRow>(sb, "staff_roles", "id,code,name,capabilities,limits", storeId, "sort_order"),
    ]);

    const fallbackSalt = pinSaltFor(storeId);
    const roleById = new Map(staffRoles.map((role) => [role.id, role]));

    const cashiers: Cashier[] = cashierRows
      .filter((c) => c.is_active !== false)
      .map((c) => {
        const { pinHash, pinSalt } = cashierPin(c, storeId);
        const roleRow = c.role_id ? roleById.get(c.role_id) : undefined;
        const roleCode = roleRow?.code ?? normalizeStaffRoleCode(c.role);
        const preset = STAFF_ROLE_PRESETS[normalizeStaffRoleCode(roleCode)];
        return {
          id: c.id,
          name: c.name,
          pinHash,
          pinSalt: pinSalt ?? fallbackSalt,
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
      quickKeys,
      cashiers,
      pinSalt: fallbackSalt,
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
      quickKeys,
      cashiers,
      pinSalt: fallbackSalt,
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
