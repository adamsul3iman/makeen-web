/**
 * Cross-tab register lease (pre-mortem risk 6).
 *
 * A register is bound to one store + terminal. Two POS tabs on the same
 * terminal can double-charge one sale or run two shifts against the same
 * drawer, so only one tab may operate a given register at a time.
 *
 * This module implements a localStorage lease with a heartbeat:
 *  - The first tab to acquire the lease owns the register.
 *  - Any other tab sees a fresh foreign lease and is bounced to a read-only
 *    "register in use elsewhere" screen (`PosLayout`).
 *  - A tab that crashes without releasing loses the lease after the TTL, so
 *    the register is never bricked.
 *  - The holder renews the heartbeat on an interval; the loser listens for
 *    the lease key in the `storage` event so it can take over the moment the
 *    winner releases.
 *
 * localStorage is the transport (shared, synchronous, origin-scoped); the
 * storage event gives every other tab immediate notification.
 */

export const REGISTER_LEASE_PREFIX = "pos.register.lease";
/** A holder must renew within this window or the lease is stealable. */
export const REGISTER_LEASE_TTL_MS = 5000;

interface LeaseValue {
  owner: string;
  heartbeat: number;
}

/**
 * Stable per-tab identity: sessionStorage survives a reload of the SAME tab
 * (so a reload keeps its lease) but differs across tabs (so a second tab is
 * detected as foreign). Falls back to a per-module id when sessionStorage is
 * unavailable (non-browser / tests).
 */
function myId(): string {
  if (typeof sessionStorage !== "undefined") {
    let id = sessionStorage.getItem("pos.register.tab");
    if (!id) {
      id = `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      try {
        sessionStorage.setItem("pos.register.tab", id);
      } catch {
        // keep the in-memory fallback
      }
    }
    if (id) return id;
  }
  if (!moduleFallbackId) {
    moduleFallbackId = `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
  return moduleFallbackId;
}

let moduleFallbackId: string | null = null;

function leaseKey(storeId: string, terminalId: string): string {
  return `${REGISTER_LEASE_PREFIX}:${storeId}:${terminalId}`;
}

function readLease(key: string): LeaseValue | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LeaseValue;
    if (typeof parsed?.owner !== "string" || !Number.isFinite(parsed.heartbeat)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeLease(key: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    const value: LeaseValue = { owner: myId(), heartbeat: Date.now() };
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage full / private mode: no lease is better than a dead register.
  }
}

/**
 * Try to take the register for this tab. Returns true when this tab now owns
 * it (fresh acquire, its own lease being extended, or a stale-lease steal);
 * false when another live tab owns it and this tab must go read-only.
 */
export function acquireRegisterLease(storeId: string, terminalId: string): boolean {
  const key = leaseKey(storeId, terminalId);
  const existing = readLease(key);
  const mine = existing?.owner === myId();
  if (existing && !mine && Date.now() - existing.heartbeat < REGISTER_LEASE_TTL_MS) {
    return false;
  }
  writeLease(key);
  return true;
}

/** Renew the heartbeat so a live holder isn't treated as crashed. */
export function renewRegisterLease(storeId: string, terminalId: string): void {
  const key = leaseKey(storeId, terminalId);
  const existing = readLease(key);
  if (existing && existing.owner !== myId()) return;
  writeLease(key);
}

/** Release the lease on unmount (only if this tab still owns it). */
export function releaseRegisterLease(storeId: string, terminalId: string): void {
  if (typeof localStorage === "undefined") return;
  const key = leaseKey(storeId, terminalId);
  const existing = readLease(key);
  if (existing && existing.owner !== myId()) return;
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
}
