import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  BarcodeIndex,
  BarcodeMap,
  Cashier,
  CategoryMap,
  LocalBarcode,
  LocalCategory,
  LocalProduct,
  PosSnapshot,
  ProductMap,
  QuickKeyItem,
} from "@/types/pos.types";
import { fetchAllRows, supabase, detectColumnExists } from "@/lib/supabase";
import { MOCK_STORE_ID } from "@/lib/tenant";
import { authorizedStoreId } from "@/lib/requestAuth";
import { sha256Hex } from "@/lib/sha256";
import { mockBarcodes, mockCategories, mockProducts, mockQuickKeys } from "@/lib/mockCatalogData";
import {
  STAFF_ROLE_PRESETS,
  normalizeStaffRoleCode,
  type StaffLimits,
} from "@/lib/permissions";

/** SQL row shapes as returned by the Supabase tables (Phase 5 production schema). */
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

/** Row shape from product_variants (replaces the dropped product_barcodes table). */
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

/**
 * Per-store fallback salt for rows provisioned before F3 (backfilled with a
 * random per-cashier salt by migration 016). Never used for new cashiers.
 */
function pinSaltFor(storeId: string): string {
  return sha256Hex(`pos:pin-salt:${storeId}`).slice(0, 16);
}

/** Resolve the salt + hash to ship for one cashier row (prefers F3 columns). */
function cashierPin(c: CashierRow, storeId: string): { pinHash: string; pinSalt: string } {
  const pinSalt = c.pin_salt ?? pinSaltFor(storeId);
  const pinHash = c.pin_hash ?? (c.pin ? sha256Hex(c.pin + pinSalt) : "");
  return { pinHash, pinSalt };
}

function catalogVersionOf(value: unknown): string {
  return sha256Hex(JSON.stringify(value));
}

/**
 * Simulated live catalog endpoint (stands in for the Supabase fetch).
 * Returns the full denormalized snapshot that the POS hydrates into
 * memory and caches in IndexedDB for offline scanning.
 *
 * When Supabase is configured it streams `categories`, `products`, and
 * `product_variants` and maps them to the local snapshot shape; otherwise
 * it serves the bundled mock catalog so the POS never breaks.
 */
// Owner/cashier separation: the owner row (role 'admin') carries no PIN hash
// at all — only cashier rows hold a PIN and can unlock a register.
const mockCashiers: Cashier[] = [
  { id: "cashier-owner", name: "مدير النظام", pinHash: "", pinSalt: "mock-salt-owner", role: "admin" },
  {
    id: "cashier-ahmed",
    name: "أحمد",
    pinHash: sha256Hex("1234" + "mock-salt-ahmed"),
    pinSalt: "mock-salt-ahmed",
    role: "cashier",
    roleCode: "cashier",
    roleName: STAFF_ROLE_PRESETS.cashier.name,
    capabilities: [...STAFF_ROLE_PRESETS.cashier.capabilities],
    limits: { ...STAFF_ROLE_PRESETS.cashier.limits },
  },
  {
    id: "cashier-mahmoud",
    name: "محمود",
    pinHash: sha256Hex("9999" + "mock-salt-mahmoud"),
    pinSalt: "mock-salt-mahmoud",
    role: "cashier",
    roleCode: "cashier",
    roleName: STAFF_ROLE_PRESETS.cashier.name,
    capabilities: [...STAFF_ROLE_PRESETS.cashier.capabilities],
    limits: { ...STAFF_ROLE_PRESETS.cashier.limits },
  },
];

function buildSnapshot(): PosSnapshot {
  const categoryMap: Record<string, LocalCategory> = {};
  for (const c of mockCategories) categoryMap[c.id] = c;

  const productMap: Record<string, LocalProduct> = {};
  for (const p of mockProducts) productMap[p.id] = p;

  const barcodeMap: Record<string, LocalBarcode> = {};
  for (const b of mockBarcodes) barcodeMap[b.barcode] = b;

  const barcodeIndex: PosSnapshot["barcodeIndex"] = {};
  for (const b of mockBarcodes) {
    barcodeIndex[b.barcode] = {
      product_id: b.productId,
      variantId: b.variantId,
      name: productMap[b.productId].name,
      price: b.price,
      variantLabel: b.variantLabel,
    };
  }
  const sortedQuickKeys = [...mockQuickKeys].sort((a, b) => a.sortOrder - b.sortOrder);
  const pinSalt = pinSaltFor(MOCK_STORE_ID);
  const updatedAt = catalogVersionOf({
    categories: categoryMap,
    products: productMap,
    barcodes: barcodeMap,
    barcodeIndex,
    quickKeys: sortedQuickKeys,
    cashiers: mockCashiers,
    pinSalt,
  });

  return {
    schemaVersion: 1,
    updatedAt,
    categories: categoryMap,
    products: productMap,
    barcodes: barcodeMap,
    barcodeIndex,
    quickKeys: sortedQuickKeys,
    cashiers: mockCashiers,
    pinSalt,
  };
}

/** Map relational Supabase rows into the exact local snapshot shape. */
async function buildSupabaseSnapshot(
  client: SupabaseClient,
  storeId: string,
): Promise<PosSnapshot> {
  const hasCategoryShowInPos = await detectColumnExists(client, "categories", "show_in_pos");
  const categorySelect = hasCategoryShowInPos
    ? "id,name,parent_id,bg_color,is_quick_key,sort_order,show_in_pos"
    : "id,name,parent_id,bg_color,is_quick_key,sort_order";

  const [categories, brands, suppliers, products, variants, cashierRows, staffRoles] = await Promise.all([
    fetchAllRows<CategoryRow>(client, "categories", categorySelect, storeId, "name"),
    fetchAllRows<BrandRow>(client, "product_brands", "id,name", storeId, "name"),
    fetchAllRows<SupplierRow>(client, "suppliers", "id,name", storeId, "name"),
    fetchAllRows<ProductRow>(
      client,
      "products",
      "id,category_id,name,base_unit,total_stock,is_quick_key,brand_id,default_supplier_id,tax_percent,tax_included,is_active,show_in_pos,is_sellable,is_purchasable,allow_price_change,reorder_level,cost_price,selling_price,wholesale_price",
      storeId,
      "name",
    ),
    fetchAllRows<VariantRow>(
      client,
      "product_variants",
      "id,product_id,barcode,variant_label,total_stock,is_active,cost_price,selling_price,wholesale_price",
      storeId,
      "variant_label",
    ),
    fetchAllRows<CashierRow>(client, "cashiers", "id,name,pin,role,role_id,pin_salt,pin_hash,is_active", storeId, "name"),
    fetchAllRows<StaffRoleRow>(client, "staff_roles", "id,code,name,capabilities,limits", storeId, "sort_order"),
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

  // Derive quick keys from the explicitly selected sale package so a carton
  // never appears as a base-unit piece in the register.
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
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const pageParam = url.searchParams.get("page");
  const limitParam = url.searchParams.get("limit");
  const searchParam = url.searchParams.get("search") ?? "";

  // Paginated inventory endpoint: /api/catalog?page=1&limit=50&search=...
  // Returns a lightweight flat list of products + their variants + reference data.
  // The products table is flat (no parent_id). Variants are in product_variants.
  if (pageParam && supabase) {
    const storeId = await authorizedStoreId(request);
    if (storeId instanceof Response) return storeId;

    const page = Math.max(1, parseInt(pageParam, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(limitParam || "50", 10)));
    const offset = (page - 1) * limit;
    const search = searchParam.trim();

    try {
      const [categoryRows, brandRows, supplierRows] = await Promise.all([
        fetchAllRows<{ id: string; name: string; parent_id: string | null; sort_order: number }>(
          supabase, "categories", "id,name,parent_id,sort_order", storeId, "name",
        ),
        fetchAllRows<{ id: string; name: string }>(supabase, "product_brands", "id,name", storeId, "name"),
        fetchAllRows<{ id: string; name: string }>(supabase, "suppliers", "id,name", storeId, "name"),
      ]);

      const categoryMap: Record<string, { id: string; name: string; parentId: string | null; sortOrder: number }> = {};
      for (const c of categoryRows) {
        categoryMap[c.id] = { id: c.id, name: c.name, parentId: c.parent_id, sortOrder: c.sort_order };
      }
      const brandMap = Object.fromEntries(brandRows.map((b) => [b.id, b]));
      const supplierMap = Object.fromEntries(supplierRows.map((s) => [s.id, s]));

      // Count products for pagination
      let countQuery = supabase
        .from("products")
        .select("id", { count: "exact" })
        .eq("store_id", storeId);

      if (search) {
        countQuery = countQuery.ilike("name", `%${search}%`);
      }

      const { count: total, error: countError } = await countQuery;
      if (countError) throw countError;

      // Fetch products for this page
      let productQuery = supabase
        .from("products")
        .select(
          "id,category_id,name,base_unit,total_stock,is_quick_key,brand_id,default_supplier_id,tax_percent,tax_included,is_active,show_in_pos,is_sellable,is_purchasable,allow_price_change,reorder_level,cost_price,selling_price,wholesale_price",
        )
        .eq("store_id", storeId);

      if (search) {
        productQuery = productQuery.ilike("name", `%${search}%`);
      }

      const { data: products, error: productError } = await productQuery
        .order("name", { ascending: true })
        .range(offset, offset + limit - 1);

      if (productError) throw productError;

      const productIds = (products ?? []).map((p) => p.id);

      // Fetch variants for these products
      let variantRows: Array<{ id: string; product_id: string; barcode: string; variant_label: string; total_stock: number; is_active: boolean; cost_price?: number; selling_price?: number; wholesale_price?: number }> = [];
      if (productIds.length > 0) {
        const { data: variants, error: variantError } = await supabase
          .from("product_variants")
          .select("id,product_id,barcode,variant_label,total_stock,is_active,cost_price,selling_price,wholesale_price")
          .eq("store_id", storeId)
          .in("product_id", productIds)
          .order("barcode", { ascending: true });

        if (variantError) throw variantError;
        variantRows = variants ?? [];
      }

      // Index variants by product_id
      const variantsByProduct = new Map<string, typeof variantRows>();
      for (const v of variantRows) {
        const list = variantsByProduct.get(v.product_id) ?? [];
        list.push(v);
        variantsByProduct.set(v.product_id, list);
      }

      // Build flat items list — each product with its variants
      type PaginatedItem = {
        id: string; name: string; categoryId: string; category: string;
        brandId: string; brand: string; supplierId: string; supplier: string;
        baseUnit: string; stock: number; costPrice: number; price: number;
        wholesalePrice: number; taxPercent: number; taxIncluded: boolean;
        isActive: boolean; showInPos: boolean; isSellable: boolean;
        isPurchasable: boolean; allowPriceChange: boolean; isQuickKey: boolean;
        reorderLevel: number;
        parentId: null; variantLabel: string; isVariantRoot: boolean;
        variants: Array<{ id: string; barcode: string; variantLabel: string; costPrice: number; price: number; wholesalePrice: number; isDefaultSale: boolean }>;
      };

      const items: PaginatedItem[] = (products ?? []).map((p) => {
        const productVariants = variantsByProduct.get(p.id) ?? [];
        return {
          id: p.id,
          name: p.name,
          categoryId: p.category_id ?? "",
          category: p.category_id ? categoryMap[p.category_id]?.name ?? "" : "",
          brandId: p.brand_id ?? "",
          brand: p.brand_id ? brandMap[p.brand_id]?.name ?? "" : "",
          supplierId: p.default_supplier_id ?? "",
          supplier: p.default_supplier_id ? supplierMap[p.default_supplier_id]?.name ?? "" : "",
          baseUnit: p.base_unit,
          stock: p.total_stock ?? 0,
          costPrice: Number(p.cost_price ?? 0),
          price: Number(p.selling_price ?? 0),
          wholesalePrice: Number(p.wholesale_price ?? 0),
          taxPercent: Number(p.tax_percent ?? 16),
          taxIncluded: p.tax_included ?? false,
          isActive: p.is_active ?? true,
          showInPos: p.show_in_pos ?? true,
          isSellable: p.is_sellable ?? true,
          isPurchasable: p.is_purchasable ?? true,
          allowPriceChange: p.allow_price_change ?? false,
          isQuickKey: p.is_quick_key ?? false,
          reorderLevel: p.reorder_level ?? 0,
          parentId: null,
          variantLabel: "",
          isVariantRoot: false,
          variants: productVariants.map((v) => ({
            id: `v-${v.barcode}`,
            barcode: v.barcode,
            variantLabel: v.variant_label ?? "",
            costPrice: Number(v.cost_price ?? 0) || Number(p.cost_price ?? 0),
            price: Number(v.selling_price ?? 0) || Number(p.selling_price ?? 0),
            wholesalePrice: Number(v.wholesale_price ?? 0) || Number(p.wholesale_price ?? 0),
            isDefaultSale: true,
          })),
        };
      });

      return Response.json({
        paginated: true,
        page,
        limit,
        total: total ?? 0,
        items,
        categories: categoryMap,
        brands: brandMap,
        suppliers: supplierMap,
      });
    } catch (err) {
      console.error("Paginated catalog fetch failed:", err);
      return Response.json({ error: "تعذر تحميل قائمة المخزون" }, { status: 500 });
    }
  }

  // Full snapshot path (used by POS and background refresh)
  const etag = request.headers.get("if-none-match")?.replace(/"/g, "").trim();
  if (supabase) {
    const storeId = await authorizedStoreId(request);
    if (storeId instanceof Response) return storeId;
    try {
      const snapshot = await buildSupabaseSnapshot(supabase, storeId);
      if (etag && etag === snapshot.updatedAt) {
        return new Response(null, {
          status: 304,
          headers: { ETag: `"${snapshot.updatedAt}"` },
        });
      }
      return Response.json(snapshot, {
        headers: { ETag: `"${snapshot.updatedAt}"` },
      });
    } catch (err) {
      console.error("Supabase catalog fetch failed:", err);
      return Response.json({ error: "تعذر تحميل كتالوج المتجر" }, { status: 500 });
    }
  }
  const snapshot = buildSnapshot();
  if (etag && etag === snapshot.updatedAt) {
    return new Response(null, {
      status: 304,
      headers: { ETag: `"${snapshot.updatedAt}"` },
    });
  }
  return Response.json(snapshot, {
    headers: { ETag: `"${snapshot.updatedAt}"` },
  });
}
