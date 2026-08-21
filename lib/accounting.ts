export interface ProfitResolution {
  candidate: number;
  value: number | null;
  margin: number | null;
  reliable: boolean;
}

export function roundAccounting(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Invoice subtotal is already net of line and invoice discounts. Delivery is
 * separate operating revenue, so subtracting the discount again understates
 * both revenue and profit.
 */
export function recognizedRevenue(subtotal: number, deliveryFee = 0): number {
  return roundAccounting(subtotal + deliveryFee);
}

export function resolveGrossProfit(
  candidate: number,
  revenue: number,
  zeroCostLineCount: number,
): ProfitResolution {
  const normalizedCandidate = roundAccounting(candidate);
  const reliable = zeroCostLineCount <= 0;
  return {
    candidate: normalizedCandidate,
    value: reliable ? normalizedCandidate : null,
    margin:
      reliable && revenue !== 0
        ? roundAccounting((normalizedCandidate / revenue) * 100)
        : null,
    reliable,
  };
}
