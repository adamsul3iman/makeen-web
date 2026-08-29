/**
 * Scan/product resolution — pure, side-effect-free.
 *
 * Houses the O(1) barcode + name-fallback resolution that was previously
 * duplicated inline in `ProductQuantitiesModal`. Both that modal and the
 * inventory "Focus Mode" warehouse screen consume this single source of
 * truth so a scan resolves identically everywhere: first the cache-resident
 * `barcodeIndex` (instant, no network), then a case-insensitive product-name
 * fallback over the local catalog.
 */

import type {
  BarcodeIndex,
  BarcodeLookup,
  LocalProduct,
  LocalUnit,
  ProductMap,
  ProductUnitsMap,
  BarcodeMap,
} from "@/types/pos.types";

interface ResolvedVariant {
  barcode: string;
  variantLabel: string;
  totalStock: number;
  price: number;
  costPrice: number;
}

export type { ResolvedVariant };

export interface ResolvedProduct {
  productId: string;
  productName: string;
  baseUnit: string;
  isWeighed: boolean;
  totalStock: number;
  costPrice: number;
  sellingPrice: number;
  variants: ResolvedVariant[];
  units: LocalUnit[];
}

export interface ScanResolveInput {
  barcodeIndex: BarcodeIndex;
  barcodes: BarcodeMap;
  products: ProductMap;
  productUnits: ProductUnitsMap;
}

/** A product's complete variant list keyed off its parent id. */
function variantsForProduct(
  productId: string,
  barcodes: BarcodeMap,
): ResolvedVariant[] {
  const variants: ResolvedVariant[] = [];
  for (const entry of Object.values(barcodes)) {
    if (entry.productId === productId && typeof entry.totalStock === "number") {
      variants.push({
        barcode: entry.barcode,
        variantLabel: entry.variantLabel || "أساسي",
        totalStock: entry.totalStock ?? 0,
        price: entry.price,
        costPrice: entry.costPrice,
      });
    }
  }
  return variants;
}

function toResolvedProduct(
  product: LocalProduct,
  seed: { productId: string; totalStock?: number; costPrice?: number; sellingPrice?: number; variants?: ResolvedVariant[] },
  input: ScanResolveInput,
  extraVariant?: BarcodeLookup & { barcode: string },
): ResolvedProduct {
  const variants = variantsForProduct(product.id, input.barcodes);
  if (extraVariant) {
    if (!variants.some((v) => v.barcode === extraVariant.barcode)) {
      variants.unshift({
        barcode: extraVariant.barcode,
        variantLabel: extraVariant.variantLabel || "أساسي",
        totalStock: extraVariant.totalStock ?? 0,
        price: extraVariant.price,
        costPrice: 0,
      });
    }
  }
  return {
    productId: product.id,
    productName: product.name,
    baseUnit: product.baseUnit,
    isWeighed: product.isWeighed,
    totalStock: product.totalStock ?? seed.totalStock ?? 0,
    costPrice: product.costPrice,
    sellingPrice: product.price,
    units: input.productUnits[product.id] ?? [],
    variants: variants.length > 0 ? variants : seed.variants ?? [],
  };
}

/**
 * Resolve a raw scan/query against the local catalog.
 *
 * Returns the resolved product, or `null` when the code matches nothing and
 * no name-fallback product exists.
 */
export function resolveScan(
  query: string,
  input: ScanResolveInput,
): ResolvedProduct | null {
  const trimmed = query.trim();
  if (!trimmed) return null;

  // 1. O(1) barcode lookup.
  const hit = input.barcodeIndex[trimmed];
  if (hit) {
    const product = input.products[hit.product_id];
    if (!product) return null;
    return toResolvedProduct(product, { productId: product.id }, input, {
      ...hit,
      barcode: trimmed,
    });
  }

  // 2. Name search fallback.
  const q = trimmed.toLowerCase();
  const match = Object.values(input.products).find((p) =>
    p.name.toLowerCase().includes(q),
  );
  if (match) return toResolvedProduct(match, { productId: match.id }, input);

  return null;
}
