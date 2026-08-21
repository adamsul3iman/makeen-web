/**
 * Hardware double-read coalescing for barcode scanners.
 *
 * Cheap USB scanners sometimes re-transmit the same code twice within a few
 * milliseconds after a single physical trigger ("double read"). Committing
 * both would add the item twice, which a cashier reads as a duplicate cart
 * line. A human cannot pull the trigger twice inside this window, so
 * dropping the second identical commit here is always safe — and it is the
 * only layer where coalescing cannot break the store contract (the store
 * must still merge N explicit `scanBarcode` calls into one row).
 */
export const SCAN_COALESCE_MS = 120;

export function shouldCoalesceScan(
  lastCode: string | null,
  lastCommittedAt: number,
  code: string,
  now: number,
): boolean {
  return (
    lastCode !== null &&
    lastCode === code &&
    now - lastCommittedAt < SCAN_COALESCE_MS
  );
}
