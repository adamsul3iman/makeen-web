/**
 * Phase 5 — Shortage Radar.
 *
 * Pure, side-effect-free helpers shared by the POS register, the admin
 * dashboard and the test suite. Two sources feed the radar:
 *
 *   1. `radar`  — automatic: any product whose `reorderLevel > 0` and whose
 *      `totalStock <= reorderLevel`. A threshold of 0 means "no minimum set"
 *      and is deliberately excluded so a defaulted catalog never flags every
 *      zero-stock product.
 *   2. `manual` — the cashier's emergency "Flag as Shortage" from the POS,
 *      which lands in the radar even when system stock says otherwise.
 *
 * The suggested order qty is the gap formula the owner asked for:
 * `(ideal_stock_level - current_stock) = suggested_order_qty`, floored at 0.
 */
import type { LocalProduct, ProductMap, ShortageFlag } from "@/types/pos.types";

export type ShortageSource = "radar" | "manual";

/** One row of the shortage radar (radar-derived or manual flag). */
export interface ShortageItem {
  productId: string;
  name: string;
  baseUnit: string;
  currentStock: number;
  /** Minimum stock threshold (`reorder_level`), 0 when unset. */
  minStockLevel: number;
  /** Target stock threshold (`ideal_stock_level`), 0 when unset. */
  idealStockLevel: number;
  /** `max(0, idealStockLevel - currentStock)` — what to order. */
  suggestedOrderQty: number;
  supplierId?: string;
  supplierName?: string;
  supplierPhone?: string;
  source: ShortageSource;
  /** Set for manual flags (when the cashier raised the shortage). */
  flaggedAt?: string;
  reason?: string;
}

/** One supplier's slice of the radar, ready for a Draft PO / WhatsApp export. */
export interface ShortageGroup {
  supplierId: string | null;
  supplierName: string;
  supplierPhone: string;
  items: ShortageItem[];
  totalOrderQty: number;
}

/** Thresholds default to 0: undefined means "not configured". */
export function shortageThresholds(product: {
  reorderLevel?: number;
  idealStockLevel?: number;
}): { minStockLevel: number; idealStockLevel: number } {
  const minStockLevel = Math.max(0, Math.floor(product.reorderLevel ?? 0));
  const idealStockLevel = Math.max(0, Math.floor(product.idealStockLevel ?? 0));
  return { minStockLevel, idealStockLevel };
}

/** A product is on the radar only when a minimum is set AND stock is at/below it. */
export function isBelowReorderLevel(
  currentStock: number | undefined,
  reorderLevel: number | undefined,
): boolean {
  const min = Math.max(0, Math.floor(reorderLevel ?? 0));
  if (min <= 0) return false;
  return (currentStock ?? 0) <= min;
}

/** `(ideal_stock_level - current_stock)`, floored at 0. */
export function suggestedOrderQty(
  currentStock: number | undefined,
  idealStockLevel: number | undefined,
): number {
  const current = Math.max(0, currentStock ?? 0);
  const ideal = Math.max(0, Math.floor(idealStockLevel ?? 0));
  return Math.max(0, ideal - current);
}

/**
 * Build the radar list. Products at/below their reorder level enter as
 * `radar` rows; unresolved manual flags enter as `manual` rows regardless of
 * stock. Manual flags win the dedupe (keeps a cashier-flagged item pinned
 * until the owner resolves it).
 */
export function computeShortageRadar(
  products: ProductMap,
  manualFlags: ShortageFlag[] = [],
): ShortageItem[] {
  const unresolved = manualFlags.filter((flag) => !flag.resolved);
  const flaggedProductIds = new Set(unresolved.map((flag) => flag.productId));
  const byProduct = new Map(unresolved.map((flag) => [flag.productId, flag]));

  const items: ShortageItem[] = [];
  for (const id of Object.keys(products)) {
    const product = products[id];
    if (!product) continue;
    const { minStockLevel, idealStockLevel } = shortageThresholds(product);
    const currentStock = Math.max(0, product.totalStock ?? 0);
    const flag = byProduct.get(id);
    const onRadar = isBelowReorderLevel(currentStock, product.reorderLevel);
    if (!onRadar && !flag) continue;
    items.push({
      productId: id,
      name: product.name,
      baseUnit: product.baseUnit,
      currentStock,
      minStockLevel,
      idealStockLevel,
      suggestedOrderQty: suggestedOrderQty(currentStock, idealStockLevel),
      supplierId: product.supplierId,
      supplierName: product.supplierName,
      source: flag ? "manual" : "radar",
      flaggedAt: flag?.createdAt,
      reason: flag?.reason,
    });
  }

  // Manual flags on products missing from the snapshot must still surface
  // (e.g. a stale cached catalog) — keep them with the captured stock.
  for (const flag of unresolved) {
    if (flaggedProductIds.has(flag.productId) && products[flag.productId]) continue;
    items.push({
      productId: flag.productId,
      name: flag.productName || flag.productId,
      baseUnit: "",
      currentStock: Math.max(0, flag.currentStock ?? 0),
      minStockLevel: 0,
      idealStockLevel: 0,
      suggestedOrderQty: 0,
      source: "manual",
      flaggedAt: flag.createdAt,
      reason: flag.reason,
    });
  }

  return items.sort((a, b) => a.name.localeCompare(b.name, "ar"));
}

/**
 * Group radar rows by default supplier for Draft PO / WhatsApp export.
 * Rows without a supplier collapse into a single "بدون مورد" group so the
 * export is never silently empty.
 */
export function groupShortagesBySupplier(items: ShortageItem[]): ShortageGroup[] {
  const groups = new Map<string, ShortageGroup>();
  for (const item of items) {
    const key = item.supplierId ?? "";
    const group = groups.get(key) ?? {
      supplierId: item.supplierId ?? null,
      supplierName: item.supplierName || "بدون مورد",
      supplierPhone: item.supplierPhone ?? "",
      items: [],
      totalOrderQty: 0,
    };
    group.items.push(item);
    group.totalOrderQty += item.suggestedOrderQty;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => a.supplierName.localeCompare(b.supplierName, "ar"));
}

/** Arabic WhatsApp order message for one supplier group. */
export function buildShortageWhatsAppText(group: ShortageGroup): string {
  const lines = group.items.map((item) => {
    const qtyLabel = item.suggestedOrderQty > 0
      ? `: ${item.suggestedOrderQty} ${item.baseUnit || "وحدة"}`
      : "";
    return `- ${item.name}${qtyLabel}`;
  });
  return [
    `عاجل — طلب توريد (نقص مخزون) — ${group.supplierName}`,
    ...lines,
    "",
    "الرجاء تجهيز الطلب في أقرب وقت، شكرًا.",
  ].join("\n");
}

/** `https://wa.me/<phone>?text=<message>` — digits only, no +/spaces. */
export function buildWhatsAppUrl(phone: string, message: string): string {
  const digits = (phone ?? "").replace(/\D/g, "");
  if (!digits) return "";
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
}
