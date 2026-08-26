/**
 * Stock breakdown display utilities — pure, side-effect-free.
 *
 * Converts a flat base-unit stock count (e.g. 71) into a human-readable
 * breakdown like "5 كرتون و 11 حبة". Handles weighed products (raw
 * decimals), zero stock, fractional units, and products with no carton
 * tier gracefully.
 *
 * All arithmetic uses integer-safe rounding to avoid JS floating-point
 * quirks: the multiplier is scaled to 3 decimal places and division
 * uses the round-half-up pattern already established in saleMath.ts.
 */

import type { LocalUnit, ProductUnitsMap } from "@/types/pos.types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StockBreakdown {
  /** Human-readable Arabic label, e.g. "5 كرتون و 11 حبة". */
  label: string;
  /** Number of largest-tier units (e.g. cartons). Undefined for weighed. */
  majorQty?: number;
  /** Remaining base-unit pieces after major extraction. Undefined for weighed. */
  minorQty?: number;
  /** Always the raw base-unit stock count. */
  raw: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Unit names that signal a weighed product (case-insensitive match). */
const WEIGHED_UNITS = new Set(["كجم", "kg", "kg.", "kilogram", "g", "غرام", "gram", "لتر", "l", "ltr", "liter"]);

/** Exact-match carton-tier name candidates (Arabic + English). */
const CARTON_NAMES = new Set(["كرتون", "carton", "box", "cartons", "boxes", "كراتين"]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Safe integer-safe rounding to avoid floating-point drift.
 * Scales to 3 decimal places (matching DB NUMERIC(12,3) precision),
 * then rounds to nearest integer for the carton/piece split.
 */
function safeRound(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * 1000) / 1000;
}

/**
 * Find the "largest" unit from a product's unit array for breakdown purposes.
 * Priority: exact carton name match → highest qtyMultiplier → undefined.
 */
function findLargestUnit(units: LocalUnit[]): LocalUnit | undefined {
  if (!units || units.length === 0) return undefined;

  // 1. Exact name match for carton-tier
  const carton = units.find(
    (u) => CARTON_NAMES.has(u.unitName.trim().toLowerCase()),
  );
  if (carton) return carton;

  // 2. Fall back to the unit with the highest multiplier (> 1)
  let best: LocalUnit | undefined;
  for (const u of units) {
    if (u.qtyMultiplier > 1 && (!best || u.qtyMultiplier > best.qtyMultiplier)) {
      best = u;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Break down a flat stock count into major (carton) and minor (piece) parts.
 *
 * @param totalStock   - Raw stock in base pieces (e.g. 71).
 * @param units        - Product's active unit array from ProductUnitsMap.
 * @param isWeighed    - Whether the product is weighed (kg, L, etc.).
 * @param baseUnitName - Display name for the base unit (e.g. "حبة", "كجم").
 * @returns            StockBreakdown with a ready-to-render label.
 */
export function breakdownStock(
  totalStock: number | undefined | null,
  units: LocalUnit[] | undefined,
  isWeighed: boolean,
  baseUnitName: string,
): StockBreakdown {
  const raw = safeRound(Number(totalStock) || 0);

  // Weighed products: show raw decimal, no breakdown.
  if (isWeighed) {
    const display = raw > 0 ? `${raw.toFixed(3)} ${baseUnitName}` : `لا رصيد`;
    return { label: display, raw };
  }

  // Zero stock
  if (raw <= 0) {
    return { label: "لا رصيد", raw: 0 };
  }

  // No units configured or base unit only → show flat count
  const majorUnit = findLargestUnit(units ?? []);
  if (!majorUnit || majorUnit.qtyMultiplier <= 1) {
    return {
      label: `${raw} ${baseUnitName}`,
      majorQty: undefined,
      minorQty: undefined,
      raw,
    };
  }

  // Integer-safe division: raw / multiplier
  // Use 3-decimal precision for the quotient, then floor for major qty.
  const multiplier = safeRound(majorUnit.qtyMultiplier);
  if (multiplier <= 0) {
    return { label: `${raw} ${baseUnitName}`, raw };
  }

  const majorQty = Math.floor(raw / multiplier);
  const minorQty = safeRound(raw - majorQty * multiplier);

  // Build label — skip parts that are zero
  const parts: string[] = [];
  if (majorQty > 0) parts.push(`${majorQty} ${majorUnit.unitName}`);
  if (minorQty > 0) parts.push(`${minorQty} ${baseUnitName}`);

  // Should never be both zero (raw > 0 + multiplier > 0), but guard anyway
  const label = parts.length > 0 ? parts.join(" و ") : `${raw} ${baseUnitName}`;

  return { label, majorQty, minorQty, raw };
}

/**
 * Compute the maximum quantity (in a given unit) that can be subtracted
 * from available stock without going negative.
 *
 * @param availableStock - Stock in base pieces.
 * @param unitMultiplier - Pieces per one unit of this tier.
 * @returns              Max whole units purchasable (floor, >= 0).
 */
export function maxUnitsAvailable(
  availableStock: number | undefined | null,
  unitMultiplier: number | undefined | null,
): number {
  const stock = Number(availableStock) || 0;
  const mult = Number(unitMultiplier) || 1;
  if (stock <= 0 || mult <= 0) return 0;
  return Math.floor(stock / mult);
}

/**
 * Format a cost history change direction for display.
 * Returns an arrow string: "↑" (increase), "↓" (decrease), or "→" (same).
 */
export function costDirection(oldCost: number, newCost: number): "up" | "down" | "same" {
  const diff = newCost - oldCost;
  if (Math.abs(diff) < 0.001) return "same";
  return diff > 0 ? "up" : "down";
}
