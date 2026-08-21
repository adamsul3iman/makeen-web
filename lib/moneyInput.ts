/**
 * Strict money-input parsing for POS modal fields (Risk 7).
 *
 * A USB keyboard-wedge barcode scanner types its digits + Enter wherever
 * focus sits. Mid-checkout that means the tendered-amount field (or the
 * discount field) receives a 13-digit barcode and the wedge's Enter submits
 * it as garbage. Every money field therefore accepts ONLY digits plus a
 * single decimal separator, bounded to a plausible JOD amount — a barcode
 * string can never parse and can never reach `completeCheckout`.
 */

/** Max integer digits of a valid tendered/discount amount (≤ 999,999.99 JOD). */
const MAX_INTEGER_DIGITS = 6;
/** Max decimals — JOD money has at most 2 fils. */
const MAX_DECIMAL_DIGITS = 2;

const MONEY_INPUT_RE = new RegExp(
  `^\\d{0,${MAX_INTEGER_DIGITS}}(?:\\.\\d{0,${MAX_DECIMAL_DIGITS}})?$`,
);

/** Normalize a raw input string to a parseable money form (`,` → `.`). */
export function normalizeMoneyInput(raw: string): string {
  return raw.trim().replace(/,/g, ".");
}

/**
 * True when the raw input is a well-formed money value (or empty). Used by
 * onChange so a 13-digit barcode burst is rejected keystroke-by-keystroke.
 */
export function isValidMoneyInput(raw: string): boolean {
  const normalized = normalizeMoneyInput(raw);
  if (normalized === "") return true;
  return MONEY_INPUT_RE.test(normalized);
}

/**
 * Parse a money input into a finite number. Returns `0` for an empty value
 * (nothing tendered) and `null` for anything not shaped like money — the
 * caller MUST treat `null` as "reject, never submit".
 */
export function parseMoneyInput(raw: string): number | null {
  const normalized = normalizeMoneyInput(raw);
  if (normalized === "") return 0;
  if (!MONEY_INPUT_RE.test(normalized)) return null;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}
