import type { Store } from "@/types/pos.types";

/**
 * Active-cashier offline unlock cache (P0 remediation, migration 078).
 *
 * Since 078 the staff roster's PIN hashes are no longer readable by the
 * browser — verification happens inside the `verify_staff_pin` SECURITY
 * DEFINER RPC. That would make register unlock impossible during a network
 * outage, so — per the approved business caveat — this module caches ONLY the
 * LAST ACTIVE cashier of a store: their safe profile plus their own PIN
 * verifier (salt + sha256 hash), received over TLS after a successful online
 * verification. The roster is never synced; any other staff member must
 * verify online once.
 *
 * Storage: localStorage under an origin-scoped key (NOT IndexedDB — adding an
 * object store would bump DB_VERSION before MEM-3's versionchange handling
 * lands and deadlock other tabs on upgrade). Cleared on logout/store switch.
 */

export interface CashierSessionProfile {
  id: string;
  name: string;
  username?: string | null;
  role: string;
  roleId?: string;
  roleCode?: string;
  roleName?: string;
  capabilities?: string[];
  limits?: Record<string, number | null>;
}

export interface CachedCashierSession {
  /** Store the verifier belongs to. */
  storeId: string;
  /** Human store code — the offline /login path has no network to translate code → id. */
  storeCode: string;
  /** Login username the cashier signs in with (lowercase). */
  username: string;
  /** hex sha256(pin + pinSalt) — the ACTIVE cashier only. */
  pinHash: string;
  /** Per-cashier salt used with pinHash. */
  pinSalt: string;
  /** Full store snapshot so the login payload can be rebuilt offline. */
  store: Store;
  /** Safe cashier profile (no credential material besides the verifier). */
  cashier: CashierSessionProfile;
  branches: Array<{ id: string; name: string }>;
  terminals: Array<{ id: string; branchId: string; name: string }>;
  defaultBranchId: string | null;
  defaultTerminalId: string | null;
  savedAt: string;
}

const KEY_PREFIX = "pos.cashier-session.";

function keyFor(storeId: string): string {
  return `${KEY_PREFIX}${storeId}`;
}

export function saveCachedCashierSession(entry: CachedCashierSession): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(keyFor(entry.storeId), JSON.stringify(entry));
  } catch {
    // Storage unavailable/full: offline unlock simply degrades to online-only.
  }
}

export function loadCachedCashierSession(storeId: string): CachedCashierSession | null {
  if (typeof localStorage === "undefined" || !storeId) return null;
  try {
    const raw = localStorage.getItem(keyFor(storeId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedCashierSession;
    if (parsed?.storeId !== storeId || !parsed.cashier?.id || !parsed.pinHash) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Resolve a cached session from a human store code (offline /login path). */
export function findCachedCashierSessionByCode(
  storeCode: string,
): CachedCashierSession | null {
  if (typeof localStorage === "undefined" || !storeCode) return null;
  const wanted = storeCode.trim().toUpperCase();
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(KEY_PREFIX)) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as CachedCashierSession;
        if (parsed?.storeCode?.toUpperCase() === wanted && parsed.pinHash) return parsed;
      } catch {
        continue;
      }
    }
  } catch {
    return null;
  }
  return null;
}

export function clearCachedCashierSession(storeId: string | null | undefined): void {
  if (typeof localStorage === "undefined" || !storeId) return;
  try {
    localStorage.removeItem(keyFor(storeId));
  } catch {
    // ignore
  }
}
