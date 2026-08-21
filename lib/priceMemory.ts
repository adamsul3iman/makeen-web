/**
 * Phase 4 — Dynamic Customer Pricing / Customer Memory (pure rules).
 *
 * Pure helpers for the last-price memory feature: composite cache keys,
 * the discount-aware effective unit price, and the exact badge label the UI
 * renders. No I/O here — the IndexedDB persistence lives in `lib/idb.ts`.
 */

/** One cached last-price row for a (customer x product/barcode) pair. */
export interface PriceMemoryEntry {
  /** O(1) direct-key: `${storeId}|${customerId}|p:${productId}|b:${barcode}`. */
  key: string;
  storeId: string;
  customerId: string;
  /** Indexed partition: `${storeId}|${customerId}` (drives the `customer` index). */
  customerKey: string;
  /** Product ledger id, or "" for ad-hoc (barcode-only) lines. */
  productId: string;
  barcode: string;
  /** Effective unit price the customer last paid (discount-aware). */
  unitPrice: number;
  unitName: string;
  /** ISO timestamp of the sale that produced this price. */
  completedAt: string;
  updatedAt: string;
  /** How many times the pair has been sold (incremented on upsert). */
  saleCount: number;
}

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Identity used by the in-memory badge index. A cart line with a product id
 * keys on the product; a barcode-only (ad-hoc) line keys on the barcode.
 * Returns null when the line has no cacheable identity.
 */
export function priceMemoryLookupKey(productId: string, barcode: string): string | null {
  if (productId) return `p:${productId}`;
  if (barcode) return `b:${barcode}`;
  return null;
}

/** IDB `customer` index partition for one tenant + customer. */
export function customerPriceMemoryKey(storeId: string, customerId: string): string {
  return `${storeId}|${customerId}`;
}

/**
 * O(1) direct lookup key in the `price_memory` object store. Deterministic
 * and tenant-scoped so a demo snapshot can never leak into a live store.
 */
export function priceMemoryKey(
  storeId: string,
  customerId: string,
  productId: string,
  barcode: string,
): string | null {
  const lookup = priceMemoryLookupKey(productId, barcode);
  if (!lookup) return null;
  return `${customerPriceMemoryKey(storeId, customerId)}|${lookup}`;
}

/**
 * What the customer actually paid per unit: the line total (net of the line
 * discount) divided by the quantity, so a discounted sale is remembered at
 * its real price rather than the shelf price. Falls back to unitPrice when
 * the quantity is missing or zero.
 */
export function effectiveUnitPrice(item: { qty: number; lineTotal: number; unitPrice: number }): number {
  if (!item.qty || !Number.isFinite(item.lineTotal)) return round2(item.unitPrice);
  return round2(Math.abs(item.lineTotal) / Math.abs(item.qty));
}

/**
 * Exact badge text rendered on the cart line:
 * `Last price: X.XX JOD (YYYY-MM-DD)`.
 */
export function priceMemoryLabel(entry: { unitPrice: number; completedAt: string }): string {
  const price = Number.isFinite(entry.unitPrice) ? entry.unitPrice : 0;
  const date = (entry.completedAt ?? "").slice(0, 10);
  return `Last price: ${price.toFixed(2)} JOD (${date})`;
}
