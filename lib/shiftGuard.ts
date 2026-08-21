export type ShiftCloseGuardReason = "pending_sync";

export interface ShiftCloseGuardInput {
  /** Events still awaiting server acknowledgment. */
  pendingSyncCount: number;
  /** Browser/network online flag from the store. */
  isOnline: boolean;
  /** Blind-count input already validated: finite number >= 0. */
  actualCashValid: boolean;
  /** A settlement/checkout/sync is already running. */
  isCompleting: boolean;
}

export interface ShiftCloseGuardResult {
  canClose: boolean;
  blockingReason?: ShiftCloseGuardReason;
}

/**
 * The Z-report is recomputed server-side from the shift-bound ledger when the
 * SHIFT_CLOSED event is finalized. If the device is online and events are
 * still waiting in the queue, closing would enqueue SHIFT_CLOSED while that
 * ledger may be missing the same-batch events the server has to sum — freezing
 * a report that disagrees with the cashier's drawer count.
 *
 * Offline closes are allowed: the queue drains in FIFO order, so the server
 * replays every invoice before it finalizes the close (and the server defers
 * finalize while any shift-bound ledger row is still missing).
 */
export function evaluateShiftCloseGuard(
  input: ShiftCloseGuardInput,
): ShiftCloseGuardResult {
  if (!input.actualCashValid || input.isCompleting) return { canClose: false };
  if (input.isOnline && input.pendingSyncCount > 0) {
    return { canClose: false, blockingReason: "pending_sync" };
  }
  return { canClose: true };
}
