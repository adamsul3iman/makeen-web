"use client";

/**
 * B2B accounts + ذمم ledger store (Phase 2).
 *
 * Strictly decoupled from `usePosStore` (no imports from the monolith).
 * Offline-first: accounts/transactions hydrate from IndexedDB, then reconcile
 * with the server. The ledger itself is append-only server-side — this store
 * only mirrors rows and the trigger-maintained balance.
 */
import { create } from "zustand";
import {
  loadB2BBootCacheSync,
  loadB2BCache,
  saveB2BCache,
} from "@/lib/idb";
import { getTenantStoreId } from "@/lib/tenantClient";
import {
  createB2BAccount,
  fetchB2BAccounts,
  fetchB2BTransactions,
  recordB2BLedgerEntry,
  updateB2BAccount,
  type CreateB2BAccountInput,
  type UpdateB2BAccountInput,
} from "@/lib/b2bClient";
import type { B2BAccount, B2BTransaction } from "@/types/b2b.types";

interface B2BState {
  accounts: B2BAccount[];
  /** Recent ledger rows (mixed accounts), newest first. */
  transactions: B2BTransaction[];
  hydrated: boolean;
  loading: boolean;
  lastSyncError: string | null;

  hydrate: () => Promise<void>;
  addAccount: (input: CreateB2BAccountInput) => Promise<B2BAccount | null>;
  editAccount: (id: string, patch: UpdateB2BAccountInput) => Promise<B2BAccount | null>;
  /**
   * Append a PAYMENT (سند قبض) or signed ADJUSTMENT; returns the updated
   * account (trigger-computed balance) or null on failure.
   */
  postLedgerEntry: (input: {
    accountId: string;
    type: "PAYMENT" | "ADJUSTMENT";
    amount: number;
    note?: string;
    actorName?: string;
    shiftId?: string;
  }) => Promise<{ transaction: B2BTransaction; account: B2BAccount } | null>;
}

const TXN_RETENTION = 200;

function persist(accounts: B2BAccount[], transactions: B2BTransaction[]): void {
  const storeId = getTenantStoreId();
  void saveB2BCache(
    {
      storeId: storeId ?? null,
      accounts,
      transactions,
      updatedAt: new Date().toISOString(),
    },
    storeId,
  ).catch(() => undefined);
}

export const useB2BStore = create<B2BState>()((set, get) => ({
  accounts: [],
  transactions: [],
  hydrated: false,
  loading: false,
  lastSyncError: null,

  hydrate: async () => {
    if (get().loading) return;
    const storeId = getTenantStoreId();
    set({ loading: true });

    const boot = loadB2BBootCacheSync(storeId);
    if (boot && !get().hydrated) {
      set({
        accounts: boot.accounts,
        transactions: boot.transactions,
        hydrated: true,
      });
    }

    try {
      const cache = await loadB2BCache(storeId);
      if (cache && (!get().hydrated || (cache.updatedAt || "") >= (boot?.updatedAt ?? ""))) {
        set({ accounts: cache.accounts, transactions: cache.transactions, hydrated: true });
      }
    } catch {
      // IDB unavailable: boot mirror already applied when present.
    }

    // Server reconciliation (guarded).
    const [accountsResult, txnsResult] = await Promise.all([
      fetchB2BAccounts(),
      fetchB2BTransactions(undefined, TXN_RETENTION),
    ]);
    if (accountsResult.ok) {
      set({ accounts: accountsResult.data, lastSyncError: null });
    } else {
      set({ lastSyncError: accountsResult.error });
    }
    if (txnsResult.ok) {
      set({
        transactions: txnsResult.data.slice(0, TXN_RETENTION),
        lastSyncError: null,
      });
    }

    persist(get().accounts, get().transactions);
    set({ hydrated: true, loading: false });
  },

  addAccount: async (input) => {
    const result = await createB2BAccount(input);
    if (!result.ok) {
      set({ lastSyncError: result.error });
      return null;
    }
    set((state) => ({
      accounts: [...state.accounts.filter((a) => a.id !== result.data.id), result.data].sort(
        (a, b) => a.name.localeCompare(b.name),
      ),
      lastSyncError: null,
    }));
    persist(get().accounts, get().transactions);
    return result.data;
  },

  editAccount: async (id, patch) => {
    const result = await updateB2BAccount(id, patch);
    if (!result.ok) {
      set({ lastSyncError: result.error });
      return null;
    }
    set((state) => ({
      accounts: state.accounts.map((a) => (a.id === id ? result.data : a)),
      lastSyncError: null,
    }));
    persist(get().accounts, get().transactions);
    return result.data;
  },

  postLedgerEntry: async (input) => {
    const result = await recordB2BLedgerEntry(input);
    if (!result.ok) {
      set({ lastSyncError: result.error });
      return null;
    }
    set((state) => ({
      transactions: [result.data.transaction, ...state.transactions].slice(0, TXN_RETENTION),
      accounts: state.accounts.map((a) =>
        a.id === result.data.account.id ? result.data.account : a,
      ),
      lastSyncError: null,
    }));
    persist(get().accounts, get().transactions);
    return result.data;
  },
}));
