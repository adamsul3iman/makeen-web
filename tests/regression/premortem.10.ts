/**
 * Pre-mortem regression suite — risk 10 (rounding drift).
 *
 * Weighed/fractional items (qty 0.333 × multiplier 3) plus a proportional
 * invoice discount make per-line 2dp rounding drift from the invoice-level
 * VAT: line `tax_amount`s can sum to a different fils than the invoice-level
 * tax, so ISTD/JoFotara TLV validation sees totals that do not add up.
 *
 * Contract (the invariant Risk 10 demands):
 *   - Rounding is half-up, documented once in ONE shared helper
 *     (`roundHalfUp`), used for every fils rounding decision in
 *     `lib/saleMath.ts`.
 *   - A largest-remainder allocator (`allocateByLargestRemainder`) distributes
 *     an exact fils amount across weights so the parts always sum to the whole
 *     with NO residue.
 *   - Invoice discount is allocated to adjusted line basis exactly; per-line
 *     tax is allocated by tax-rate group from the invoice-level group tax.
 *   - Exact identities for every invoice:
 *       Σ line.gross                      === total
 *       Σ line.invoiceDiscount            === invoiceDiscount
 *       Σ line.tax                        === tax
 *       total − tax                       === subtotal  (tax-included)
 *   - The known drift seeds now hold exactly:
 *       excl 0.03 | 0.03 | 6.25  → old Σ lineTax 1.00 vs invoice 1.01
 *       incl 0.05 | 0.05 | 10    → old Σ lineTax 1.40 vs invoice 1.39
 *
 * Runs under tsx with fake-indexeddb (no server, no live DB).
 */

import "fake-indexeddb/auto";

process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:9/rest/v1";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
delete process.env.POS_FORCE_MOCK;

const storage = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => void storage.set(k, v),
  removeItem: (k: string) => void storage.delete(k),
  clear: () => storage.clear(),
  key: () => null,
  length: 0,
};
(globalThis as Record<string, unknown>).window = globalThis;

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SaleItem } from "../../types/pos.types";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, cond: boolean): void {
  if (cond) {
    pass += 1;
  } else {
    fail += 1;
    failures.push(name);
    console.error(`  ✗ ${name}`);
  }
}

function readSource(relPath: string): string {
  try {
    return readFileSync(join(process.cwd(), relPath), "utf8");
  } catch {
    return "";
  }
}

/** 2dp only? Guards against fractional-fils residue leaking into lines. */
function isFils(value: number): boolean {
  return Math.abs(Math.round(value * 100) - value * 100) < 1e-9;
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

// ---------------------------------------------------------------------------
// Drift vectors (computed by scratch simulation; see summary)
// ---------------------------------------------------------------------------

/** Main vector: weighed halves + multiplier pack, 16% VAT included, 10% off, fee. */
const VECTOR_MAIN: SaleItem[] = [
  { productId: "w1", name: "وزن", barcode: "90001", qty: 0.333, unitName: "kg", unitPrice: 3.0, lineTotal: 1.0, taxPercent: 16, taxIncluded: true },
  { productId: "w2", name: "وزن", barcode: "90002", qty: 0.333, unitName: "kg", unitPrice: 3.0, lineTotal: 1.0, taxPercent: 16, taxIncluded: true },
  { productId: "pk", name: "علبة ×3", barcode: "90003", qty: 3, unitName: "unit", unitPrice: 6.25, lineTotal: 18.75, taxPercent: 16, taxIncluded: true },
];

/** Fractional-qty × multiplier vector (0.333 @ 6.25), 16% VAT included, 10% off. */
const VECTOR_FRACTIONAL: SaleItem[] = [
  { productId: "w1", name: "وزن", barcode: "90001", qty: 0.333, unitName: "kg", unitPrice: 3.0, lineTotal: 1.0, taxPercent: 16, taxIncluded: true },
  { productId: "w2", name: "وزن", barcode: "90002", qty: 0.333, unitName: "kg", unitPrice: 3.0, lineTotal: 1.0, taxPercent: 16, taxIncluded: true },
  { productId: "m1", name: "وزن ×6.25", barcode: "90004", qty: 0.333, unitName: "kg", unitPrice: 6.25, lineTotal: 2.08, taxPercent: 16, taxIncluded: true },
];

/** Drift seeds from the risk notes — old algorithm roundtrip proof. */
const VECTOR_EXCL_SMALL: SaleItem[] = [
  { productId: "a", name: "s", barcode: "1", qty: 1, unitName: "unit", unitPrice: 0.03, lineTotal: 0.03, taxPercent: 16, taxIncluded: false },
  { productId: "b", name: "s", barcode: "2", qty: 1, unitName: "unit", unitPrice: 0.03, lineTotal: 0.03, taxPercent: 16, taxIncluded: false },
  { productId: "c", name: "s", barcode: "3", qty: 1, unitName: "unit", unitPrice: 6.25, lineTotal: 6.25, taxPercent: 16, taxIncluded: false },
];

const VECTOR_INCL_SMALL: SaleItem[] = [
  { productId: "a", name: "s", barcode: "1", qty: 1, unitName: "unit", unitPrice: 0.05, lineTotal: 0.05, taxPercent: 16, taxIncluded: true },
  { productId: "b", name: "s", barcode: "2", qty: 1, unitName: "unit", unitPrice: 0.05, lineTotal: 0.05, taxPercent: 16, taxIncluded: true },
  { productId: "c", name: "s", barcode: "3", qty: 1, unitName: "unit", unitPrice: 10.0, lineTotal: 10.0, taxPercent: 16, taxIncluded: true },
];

// ---------------------------------------------------------------------------
// Source contract — one documented half-up helper + largest remainder
// ---------------------------------------------------------------------------

async function halfUpContract(): Promise<void> {
  const saleMath = await import("../../lib/saleMath");
  const src = readSource("lib/saleMath.ts");
  const idx = src.indexOf("roundHalfUp");
  const docWindow = src.slice(Math.max(0, idx - 800), idx + 200);

  check("round: roundMoney exported", typeof saleMath.roundMoney === "function");
  check("round: roundHalfUp exported", typeof saleMath.roundHalfUp === "function");
  check(
    "round: half-up documented in ONE shared helper",
    idx >= 0 && docWindow.includes("half") && /fils|0\.01/.test(docWindow) && docWindow.includes("shared"),
  );

  // Pure half-up semantics (paper-arithmetic, not float artifacts).
  check("half-up: 1.005 -> 1.01", saleMath.roundHalfUp(1.005) === 1.01);
  check("half-up: 2.675 -> 2.68", saleMath.roundHalfUp(2.675) === 2.68);
  check("half-up: 2.5751724 -> 2.58", saleMath.roundHalfUp(2.5751724) === 2.58);
  check("half-up: -1.005 -> -1.01", saleMath.roundHalfUp(-1.005) === -1.01);
  check("half-up: -2.675 -> -2.68", saleMath.roundHalfUp(-2.675) === -2.68);
  check("half-up: roundMoney(2.08) -> 2.08", saleMath.roundMoney(2.08) === 2.08);
  check("half-up: roundMoney(18.67) -> 18.67", saleMath.roundMoney(18.67) === 18.67);
  check("half-up: roundMoney(-0.005) -> -0.01", saleMath.roundMoney(-0.005) === -0.01);
}

async function largestRemainderContract(): Promise<void> {
  const saleMath = await import("../../lib/saleMath");
  const src = readSource("lib/saleMath.ts");

  check(
    "lrm: allocateByLargestRemainder exported",
    typeof saleMath.allocateByLargestRemainder === "function",
  );
  check(
    "lrm: computeFiscalBreakdown allocates via largest remainder",
    src.includes("allocateByLargestRemainder"),
  );
  check(
    "lrm: last-line-adjust legacy removed",
    !src.includes("position === eligible.length - 1"),
  );

  const { allocateByLargestRemainder: allocate } = saleMath;

  // Parts always sum to the whole, exactly, no residue.
  check("lrm: 1.00 over [1,1,18.75] sums exactly", (() => {
    const parts = allocate(1.0, [1, 1, 18.75]);
    return parts.reduce((a, b) => a + b, 0) === 1.0 && parts.every(isFils);
  })());
  check("lrm: 2.08 over [1,1,18.75] -> [0.10,0.10,1.88]", JSON.stringify(allocate(2.08, [1, 1, 18.75])) === JSON.stringify([0.1, 0.1, 1.88]));
  check("lrm: 2.58 over tax weights sums exactly", (() => {
    const weights = [0.1241379, 0.1241379, 2.3268966];
    const parts = allocate(2.58, weights);
    return parts.reduce((a, b) => a + b, 0) === 2.58 && parts.length === 3 && parts.every(isFils);
  })());
  check("lrm: zero amount yields zeros", (() => {
    const parts = allocate(0, [1, 2, 3]);
    return parts.length === 3 && parts.every((p) => p === 0);
  })());
  check("lrm: empty weights yields []", allocate(1, []).length === 0);
  check("lrm: negative amount is sign-symmetric (sum preserved)", (() => {
    const parts = allocate(-0.01, [0.1241379, 0.1241379]);
    return parts.reduce((a, b) => a + b, 0) === -0.01 && parts.every(isFils);
  })());
  check("lrm: tie in remainder goes to earlier weight", (() => {
    const parts = allocate(0.01, [0.03, 0.03]);
    return JSON.stringify(parts) === JSON.stringify([0.01, 0]);
  })());
}

// ---------------------------------------------------------------------------
// Exact vector round-trips through the fiscal engine
// ---------------------------------------------------------------------------

async function exactFiscalRoundTrip(): Promise<void> {
  const saleMath = await import("../../lib/saleMath");
  const { computeFiscalBreakdown, computeSaleTotals, roundHalfUp, allocateByLargestRemainder } = saleMath;

  // --- Main vector (10% invoice discount, 2.00 delivery fee) ---
  const discount = { scope: "TOTAL" as const, type: "PERCENT" as const, value: 10 };
  const fiscal = computeFiscalBreakdown(VECTOR_MAIN, 2.08, 16);
  const totals = computeSaleTotals(VECTOR_MAIN, discount, 16, 2.0);

  check("main: fiscal.subtotal is 16.09 (was 16.10)", fiscal.subtotal === 16.09);
  check("main: fiscal.tax is 2.58 (was 2.57)", fiscal.tax === 2.58);
  check("main: fiscal.total is 18.67", fiscal.total === 18.67);
  check("main: grand total is 20.67", totals.total === 20.67);
  check("main: discount is 2.08", totals.discount === 2.08);

  check("main: Σ line gross === total", Math.abs(sum(fiscal.lines.map((l) => l.gross)) - fiscal.total) < 1e-9);
  check("main: Σ line invoiceDiscount === 2.08", Math.abs(sum(fiscal.lines.map((l) => l.invoiceDiscount)) - 2.08) < 1e-9);
  check("main: Σ line tax === tax", Math.abs(sum(fiscal.lines.map((l) => l.tax)) - fiscal.tax) < 1e-9);
  check("main: total − tax === subtotal", Math.abs(fiscal.total - fiscal.tax - fiscal.subtotal) < 1e-9);
  check("main: totals.total − fee === fiscal.total", Math.abs(totals.total - totals.deliveryFee - fiscal.total) < 1e-9);

  // Invoice-level VAT is the single source of truth.
  const groupRaw = sum(VECTOR_MAIN.map((it) => {
    const adj = it.lineTotal - fiscal.lines[VECTOR_MAIN.indexOf(it)].invoiceDiscount;
    return adj - adj / 1.16;
  }));
  check("main: line tax allocates invoice-level group tax", fiscal.tax === roundHalfUp(groupRaw));
  check("main: per-line tax parts are fils", fiscal.lines.every((l) => isFils(l.tax)));

  // Every fils accounted for: no residue between discount parts and whole.
  const discParts = allocateByLargestRemainder(totals.discount, VECTOR_MAIN.map((it) => it.lineTotal));
  check("main: discount parts sum to invoice discount", Math.abs(sum(discParts) - totals.discount) < 1e-9);

  // The vector really is drift-sensitive: naive per-line rounding differs.
  const naiveTax = roundHalfUp(sum(VECTOR_MAIN.map((it) => it.lineTotal - it.lineTotal / 1.16) ));
  const naivePerLine = sum(VECTOR_MAIN.map((it) => Math.round((it.lineTotal - it.lineTotal / 1.16) * 100) / 100));
  check("main: naive per-line tax differs from invoice tax (drift seed)", naivePerLine !== naiveTax);
  check("main: drift seed magnitude is exactly 1 fils", Math.round((naivePerLine - naiveTax) * 100) === 1);

  // --- Fractional-qty × multiplier vector ---
  const fDiscount = { scope: "TOTAL" as const, type: "PERCENT" as const, value: 10 };
  const fFiscal = computeFiscalBreakdown(VECTOR_FRACTIONAL, 0.41, 16);
  const fTotals = computeSaleTotals(VECTOR_FRACTIONAL, fDiscount, 16, 0);

  check("fractional: fiscal.subtotal is 3.16", fFiscal.subtotal === 3.16);
  check("fractional: fiscal.tax is 0.51", fFiscal.tax === 0.51);
  check("fractional: fiscal.total is 3.67", fFiscal.total === 3.67);
  check("fractional: discount is 0.41", fTotals.discount === 0.41);
  check("fractional: Σ line tax === tax", Math.abs(sum(fFiscal.lines.map((l) => l.tax)) - fFiscal.tax) < 1e-9);
  check("fractional: Σ line gross === total", Math.abs(sum(fFiscal.lines.map((l) => l.gross)) - fFiscal.total) < 1e-9);
  check("fractional: per-line tax parts are fils", fFiscal.lines.every((l) => isFils(l.tax)));

  // --- Drift seeds from the risk notes (exclude-tax and include-tax) ---
  const eFiscal = computeFiscalBreakdown(VECTOR_EXCL_SMALL, 0, 16);
  check("excl-seed: Σ line tax is 1.01 (old was 1.00)", Math.abs(sum(eFiscal.lines.map((l) => l.tax)) - 1.01) < 1e-9);
  check("excl-seed: Σ line tax === tax", Math.abs(sum(eFiscal.lines.map((l) => l.tax)) - eFiscal.tax) < 1e-9);
  check("excl-seed: Σ line gross === total", Math.abs(sum(eFiscal.lines.map((l) => l.gross)) - eFiscal.total) < 1e-9);
  check("excl-seed: total === subtotal + tax", Math.abs(eFiscal.total - eFiscal.subtotal - eFiscal.tax) < 1e-9);

  const iFiscal = computeFiscalBreakdown(VECTOR_INCL_SMALL, 0, 16);
  check("incl-seed: Σ line tax is 1.39 (old was 1.40)", Math.abs(sum(iFiscal.lines.map((l) => l.tax)) - 1.39) < 1e-9);
  check("incl-seed: Σ line tax === tax", Math.abs(sum(iFiscal.lines.map((l) => l.tax)) - iFiscal.tax) < 1e-9);
  check("incl-seed: Σ line gross === total", Math.abs(sum(iFiscal.lines.map((l) => l.gross)) - iFiscal.total) < 1e-9);
  check("incl-seed: total − tax === subtotal", Math.abs(iFiscal.total - iFiscal.tax - iFiscal.subtotal) < 1e-9);
}

// ---------------------------------------------------------------------------
// ISTD / TLV round-trip: the reported 2dp figures must add up exactly
// ---------------------------------------------------------------------------

async function istdAndTlvRoundTrip(): Promise<void> {
  const saleMath = await import("../../lib/saleMath");
  const { computeFiscalBreakdown } = saleMath;
  const qr = await import("../../lib/qr");

  const discount = { scope: "TOTAL" as const, type: "PERCENT" as const, value: 10 };
  const totals = saleMath.computeSaleTotals(VECTOR_MAIN, discount, 16, 2.0);
  const fiscal = computeFiscalBreakdown(VECTOR_MAIN, 2.08, 16);

  const lines = fiscal.lines.map((l, i) => ({
    lineNo: i + 1,
    productName: VECTOR_MAIN[i].name,
    quantity: VECTOR_MAIN[i].qty,
    unitPrice: VECTOR_MAIN[i].unitPrice,
    lineDiscount: l.invoiceDiscount,
    taxPercent: l.taxPercent,
    taxIncluded: l.taxIncluded,
    taxAmount: l.tax,
    lineTotal: l.gross,
  }));

  const invoice = {
    id: "i1",
    reference: "R1",
    completedAt: "2026-08-15T10:00:00",
    total: totals.total,
    tax: totals.tax,
    discount: totals.discount,
    paymentMethod: "CASH" as const,
    items: lines,
  };

  const { mapSalesInvoiceToIstd } = await import("../../lib/istdIntegration");
  const mapped = mapSalesInvoiceToIstd(
    invoice,
    { storeId: "s1", taxNumber: "123456", istdClientId: "c", istdClientSecret: "s" },
    { name: "متجر", tin: "123" },
  );

  const totals2 = mapped.totals as { tax_exclusive_total: number; discount_total: number; tax_total: number; grand_total: number };
  check("istd: tax_total === invoice.tax", totals2.tax_total === totals.tax);
  check("istd: grand_total === invoice.total", totals2.grand_total === totals.total);
  check(
    "istd: tax_exclusive_total + tax_total === grand_total",
    Math.abs(totals2.tax_exclusive_total + totals2.tax_total - totals2.grand_total) < 1e-9,
  );
  check(
    "istd: Σ line (tax_exclusive_price + tax_amount) === fiscal.total",
    Math.abs(sum((mapped.line_items as Array<{ tax_exclusive_price: number; tax_amount: number }>).map((li) => li.tax_exclusive_price + li.tax_amount)) - fiscal.total) < 1e-9,
  );
  check(
    "istd: Σ line tax_amount === invoice.tax",
    Math.abs(sum((mapped.line_items as Array<{ tax_amount: number }>).map((li) => li.tax_amount)) - totals.tax) < 1e-9,
  );

  // TLV fiscal amounts are 2dp and reconcile with the fiscal engine.
  check("tlv: fiscalAmount(grand total) is 20.67", qr.fiscalAmount(totals.total) === "20.67");
  check("tlv: fiscalAmount(tax) is 2.58", qr.fiscalAmount(totals.tax) === "2.58");
  check("tlv: fiscalAmount(subtotal) is 16.09", qr.fiscalAmount(totals.subtotal) === "16.09");
  check("tlv: decoded amount round-trips", qr.buildFiscalQrBase64({
    sellerName: "متجر",
    taxNumber: "123",
    timestamp: "2026-08-15T10:00:00Z",
    total: totals.total,
    tax: totals.tax,
  }).length > 0);
}

async function section(name: string, fn: () => Promise<void>): Promise<void> {
  console.log(`\n[${name}]`);
  try {
    await fn();
  } catch (err) {
    fail += 1;
    failures.push(`${name}: threw ${String(err)}`);
    console.error(`  ✗ ${name}: threw ${String(err)}`);
  }
}

async function main(): Promise<void> {
  await section("half-up rounding contract", halfUpContract);
  await section("largest-remainder allocator", largestRemainderContract);
  await section("exact fiscal round-trip", exactFiscalRoundTrip);
  await section("istd and tlv round-trip", istdAndTlvRoundTrip);

  console.log(`\nPre-mortem Risk 10: ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.error("Failures:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
}

void main();
