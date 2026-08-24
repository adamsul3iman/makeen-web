/**
 * B2B account domain (Phase 2) — delivery partners and wholesale customers
 * with a dynamic markup percentage and an append-only ذمم (debt) ledger.
 * Mirrors migration 081 (`b2b_accounts` / `b2b_transactions`).
 */

export type B2BAccountType = "DELIVERY_PARTNER" | "WHOLESALE";

export interface B2BAccount {
  id: string;
  storeId: string;
  name: string;
  accountType: B2BAccountType;
  phone?: string;
  /** Default markup % applied to cost for this account's orders (0-500). */
  defaultMarkupPct: number;
  /** Commission % the partner earns per order (0-100, delivery partners). */
  commissionPct?: number;
  creditLimit?: number;
  paymentTermsDays?: number;
  /** Signed running balance: positive = owes the store. */
  balance: number;
  notes?: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export type B2BTransactionType = "INVOICE" | "PAYMENT" | "ADJUSTMENT";

export interface B2BTransaction {
  id: string;
  storeId: string;
  accountId: string;
  type: B2BTransactionType;
  /** Signed amount: INVOICE positive (owes more), PAYMENT negative. */
  amount: number;
  /** Running balance right after this transaction (server-authoritative). */
  balanceAfter?: number;
  refInvoiceSyncId?: string;
  shiftId?: string;
  note?: string;
  actorName?: string;
  /** Row creation stamp (`created_at` on b2b_transactions, migration 081). */
  createdAt: string;
}
