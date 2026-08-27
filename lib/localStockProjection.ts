import type {
  BarcodeIndex,
  BarcodeMap,
  ProductMap,
  SaleItem,
} from "@/types/pos.types";

function round3(value: number): number {
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}

function stockVariantEntries(barcodes: BarcodeMap, productId: string) {
  return Object.values(barcodes).filter(
    (entry) =>
      entry.productId === productId &&
      !entry.unitId &&
      typeof entry.totalStock === "number" &&
      Number.isFinite(entry.totalStock),
  );
}

/** Resolve the real product_variants id behind a sale line, when unambiguous. */
export function resolveStockVariantId(
  barcodes: BarcodeMap,
  productId: string,
  input: Pick<SaleItem, "barcode" | "variantId" | "variantLabel">,
): string | null {
  const candidates = stockVariantEntries(barcodes, productId);
  if (candidates.length === 0) return null;

  if (input.variantId) {
    const explicit = candidates.find((entry) => entry.variantId === input.variantId);
    if (explicit) return explicit.variantId;
  }

  const direct = input.barcode ? barcodes[input.barcode] : undefined;
  if (
    direct?.productId === productId &&
    !direct.unitId &&
    typeof direct.totalStock === "number"
  ) {
    return direct.variantId;
  }

  const label = input.variantLabel?.trim();
  if (label) {
    const labeled = candidates.filter((entry) => entry.variantLabel.trim() === label);
    if (labeled.length === 1) return labeled[0].variantId;
  }

  return candidates.length === 1 ? candidates[0].variantId : null;
}

export interface LocalStockProjection {
  products: ProductMap;
  barcodes: BarcodeMap;
  barcodeIndex: BarcodeIndex;
}

/** Mirror record_inventory_movement locally after the invoice is durable. */
export function projectSaleStock(
  products: ProductMap,
  barcodes: BarcodeMap,
  barcodeIndex: BarcodeIndex,
  items: readonly SaleItem[],
): LocalStockProjection {
  const productDeltas = new Map<string, number>();
  const variantDeltas = new Map<string, number>();

  for (const item of items) {
    if (!item.productId || !Number.isFinite(item.qty) || item.qty === 0) continue;
    const delta = round3(-item.qty);
    productDeltas.set(
      item.productId,
      round3((productDeltas.get(item.productId) ?? 0) + delta),
    );

    const variantId = resolveStockVariantId(barcodes, item.productId, item);
    if (variantId) {
      variantDeltas.set(
        variantId,
        round3((variantDeltas.get(variantId) ?? 0) + delta),
      );
    }
  }

  if (productDeltas.size === 0) return { products, barcodes, barcodeIndex };

  const nextProducts: ProductMap = { ...products };
  for (const [productId, delta] of productDeltas) {
    const product = products[productId];
    if (!product) continue;
    nextProducts[productId] = {
      ...product,
      totalStock: round3((product.totalStock ?? 0) + delta),
    };
  }

  const nextBarcodes: BarcodeMap = { ...barcodes };
  for (const [code, entry] of Object.entries(barcodes)) {
    const delta = variantDeltas.get(entry.variantId);
    if (delta === undefined || typeof entry.totalStock !== "number") continue;
    nextBarcodes[code] = {
      ...entry,
      totalStock: round3(entry.totalStock + delta),
    };
  }

  const nextBarcodeIndex: BarcodeIndex = { ...barcodeIndex };
  for (const [code, entry] of Object.entries(barcodeIndex)) {
    const delta = variantDeltas.get(entry.variantId);
    if (delta === undefined || typeof entry.totalStock !== "number") continue;
    nextBarcodeIndex[code] = {
      ...entry,
      totalStock: round3(entry.totalStock + delta),
    };
  }

  return {
    products: nextProducts,
    barcodes: nextBarcodes,
    barcodeIndex: nextBarcodeIndex,
  };
}
