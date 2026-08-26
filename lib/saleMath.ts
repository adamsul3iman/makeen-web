import type { DiscountInput, SaleItem, SaleTotals } from "@/types/pos.types";

export interface FiscalLine {
  priceBasis: number;
  invoiceDiscount: number;
  adjustedBasis: number;
  net: number;
  tax: number;
  gross: number;
  taxPercent: number;
  taxIncluded: boolean;
}

export interface FiscalBreakdown {
  lines: FiscalLine[];
  subtotal: number;
  tax: number;
  total: number;
}

/**
 * Round a monetary value to the nearest fils (0.01 JOD).
 *
 * This is the ONE shared half-up rounding rule for every fils decision in the
 * fiscal engine — line discounts, invoice-level VAT, and the largest-remainder
 * allocator all resolve through it. Exact halves round away from zero
 * (1.005 -> 1.01, -1.005 -> -1.01), so Σ lines always equals the invoice total
 * with no 1-fils drift that ISTD/JoFotara TLV validation would flag.
 */
export function roundHalfUp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const scaled = value * 100;
  const compensated = scaled >= 0 ? scaled + 1e-9 : scaled - 1e-9;
  return Math.trunc(compensated + 0.5 * Math.sign(compensated)) / 100;
}

export function roundMoney(value: number): number {
  return roundHalfUp(value);
}

export function normalizeTaxPercent(value: unknown, fallback = 16): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) return fallback;
  return roundMoney(parsed);
}

export function discountAmount(input: DiscountInput | null, base: number): number {
  if (!input || !Number.isFinite(input.value) || input.value <= 0 || base <= 0) return 0;
  if (input.type === "PERCENT") {
    const percent = Math.min(100, Math.max(0, input.value));
    return roundMoney((base * percent) / 100);
  }
  return roundMoney(Math.min(input.value, base));
}

/**
 * Distribute an exact fils `amount` across `weights` by largest remainder.
 * The parts always sum EXACTLY to `amount` (no residue) and every part is a
 * 2dp fils value. Sign is symmetric: a negative amount (returns) yields
 * negative parts that still sum to `amount`. Remainder ties go to the earlier
 * weight so the outcome is deterministic regardless of input order.
 */
export function allocateByLargestRemainder(
  amount: number,
  weights: readonly number[],
): number[] {
  const count = weights.length;
  if (count === 0) return [];
  const magnitudes = weights.map((w) => (Number.isFinite(w) ? Math.abs(w) : 0));
  const totalMagnitude = magnitudes.reduce((sum, m) => sum + m, 0);
  if (!Number.isFinite(amount) || totalMagnitude <= 0) return magnitudes.map(() => 0);
  if (amount < 0) {
    return allocateByLargestRemainder(-amount, magnitudes).map((v) => (Object.is(v, -0) ? 0 : -v));
  }

  const entries = magnitudes
    .map((magnitude, index) => ({ index, share: (magnitude / totalMagnitude) * amount }))
    .sort(
      (a, b) =>
        b.share - Math.floor(b.share) - (a.share - Math.floor(a.share)) || a.index - b.index,
    );

  const parts = magnitudes.map(() => 0);
  let remaining = amount;
  for (const entry of entries) {
    const floor = Math.floor(entry.share + 1e-9);
    parts[entry.index] = roundHalfUp(Math.max(0, Math.min(floor, remaining)));
    remaining = roundHalfUp(remaining - parts[entry.index]);
  }

  let filsRemaining = Math.round(remaining * 100);
  for (const entry of entries) {
    if (filsRemaining <= 0) break;
    const fils = Math.round((entry.share - Math.floor(entry.share)) * 100);
    const give = Math.min(filsRemaining, fils);
    if (give <= 0) continue;
    parts[entry.index] = roundHalfUp(parts[entry.index] + give / 100);
    filsRemaining -= give;
  }
  if (filsRemaining > 0 && entries.length > 0) {
    parts[entries[0].index] = roundHalfUp(parts[entries[0].index] + filsRemaining / 100);
  }
  return parts;
}

function allocateInvoiceDiscount(items: SaleItem[], amount: number): number[] {
  const baseTotal = items.reduce((sum, item) => sum + Math.max(0, roundMoney(item.lineTotal)), 0);
  const target = roundMoney(Math.min(Math.max(0, amount), roundMoney(baseTotal)));
  if (target <= 0 || baseTotal <= 0 || items.length === 0) return items.map(() => 0);
  return allocateByLargestRemainder(target, items.map((item) => Math.max(0, roundMoney(item.lineTotal))));
}

export function computeFiscalBreakdown(
  items: SaleItem[],
  invoiceDiscount = 0,
  fallbackTaxPercent = 16,
): FiscalBreakdown {
  const allocations = allocateInvoiceDiscount(items, invoiceDiscount);

  const lines = items.map((item, index): FiscalLine => {
    const priceBasis = roundMoney(item.lineTotal);
    const allocatedDiscount = allocations[index] ?? 0;
    const adjustedBasis = roundMoney(priceBasis - allocatedDiscount);
    const taxPercent = normalizeTaxPercent(item.taxPercent, fallbackTaxPercent);
    const taxIncluded = item.taxIncluded ?? false;
    return {
      priceBasis,
      invoiceDiscount: allocatedDiscount,
      adjustedBasis,
      net: adjustedBasis,
      tax: 0,
      gross: adjustedBasis,
      taxPercent,
      taxIncluded,
    };
  });

  // Group lines by rate, compute the invoice-level tax per group half-up, then
  // distribute it across the group's lines by largest remainder so
  // Σ line.tax === group tax EXACTLY (no per-line 1-fils drift).
  const groups = new Map<string, number[]>();
  lines.forEach((line, index) => {
    const key = `${line.taxPercent}|${line.taxIncluded ? 1 : 0}`;
    const list = groups.get(key);
    if (list) list.push(index);
    else groups.set(key, [index]);
  });

  for (const indices of groups.values()) {
    const rate = lines[indices[0]].taxPercent / 100;
    const taxIncluded = lines[indices[0]].taxIncluded;
    if (rate <= 0) continue;
    const rawTaxes = indices.map((index) => {
      const basis = lines[index].adjustedBasis;
      return taxIncluded ? basis - basis / (1 + rate) : basis * rate;
    });
    const groupTax = roundHalfUp(rawTaxes.reduce((sum, value) => sum + value, 0));
    const parts = allocateByLargestRemainder(groupTax, rawTaxes);
    indices.forEach((index, position) => {
      const line = lines[index];
      const lineTax = parts[position] ?? 0;
      line.tax = lineTax;
      if (taxIncluded) line.net = roundMoney(line.adjustedBasis - lineTax);
      else line.gross = roundMoney(line.adjustedBasis + lineTax);
    });
  }

  let subtotal = 0;
  let tax = 0;
  let total = 0;
  for (const line of lines) {
    subtotal = roundMoney(subtotal + line.net);
    tax = roundMoney(tax + line.tax);
    total = roundMoney(total + line.gross);
  }

  return { lines, subtotal, tax, total };
}

export function computeSaleTotals(
  items: SaleItem[],
  invoiceDiscount: DiscountInput | null = null,
  fallbackTaxPercent = 16,
  deliveryFee = 0,
): SaleTotals {
  const itemDiscount = roundMoney(items.reduce((sum, item) => sum + Math.max(0, item.discount ?? 0), 0));
  const invoiceBase = roundMoney(items.reduce((sum, item) => sum + Math.max(0, item.lineTotal), 0));
  const invoiceDiscountMoney = discountAmount(invoiceDiscount, invoiceBase);
  const fiscal = computeFiscalBreakdown(items, invoiceDiscountMoney, fallbackTaxPercent);
  const fee = Number.isFinite(deliveryFee) ? roundMoney(Math.max(0, deliveryFee)) : 0;
  return {
    subtotal: fiscal.subtotal,
    tax: fiscal.tax,
    discount: roundMoney(itemDiscount + invoiceDiscountMoney),
    deliveryFee: fee,
    total: roundMoney(fiscal.total + fee),
    itemCount: roundMoney(items.reduce((sum, item) => sum + Math.round(item.qty / (item.unitMultiplier || 1)), 0)),
  };
}

/**
 * Phase 4 (B2B application): derive the cart priced for a B2B account.
 *
 * Cart items stay canonical at BASE prices; the markup is applied at the
 * choke points that consume them — totals computation, checkout payload and
 * the receipt line display. This keeps the transform idempotent (no
 * double-apply on qty edits), park/restore-safe and ledger-consistent
 * (Σ marked-up lines always equals the marked-up invoice total).
 *
 * A 0/negative/NaN pct is a no-op returning the same array reference, so
 * non-B2B carts never allocate.
 */
export function withB2BMarkup(items: SaleItem[], markupPct: number): SaleItem[] {
  if (!Number.isFinite(markupPct) || markupPct <= 0) return items;
  const factor = 1 + markupPct / 100;
  return items.map((item) => {
    const unitPrice = roundMoney(item.unitPrice * factor);
    return { ...item, unitPrice, lineTotal: roundMoney(unitPrice * item.qty) };
  });
}
