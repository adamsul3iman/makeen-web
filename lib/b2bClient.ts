/**
 * Server access for B2B accounts and the append-only ذمم ledger
 * (`b2b_accounts` / `b2b_transactions`, migration 081). Guarded result
 * objects, same posture as ordersClient: offline devices keep working from
 * the local cache and reconcile when connectivity returns.
 */
import { getSupabaseBrowser, isSupabaseBrowserConfigured } from "./supabaseBrowser";
import { getTenantStoreId } from "./tenantClient";
import { newUuid } from "./uuid";
import type {
  B2BAccount,
  B2BAccountType,
  B2BTransaction,
  B2BTransactionType,
} from "@/types/b2b.types";

export type B2BResult<T> = { ok: true; data: T } | { ok: false; error: string };

const ACCOUNT_COLUMNS =
  "id,store_id,name,account_type,phone,default_markup_pct,commission_pct,credit_limit,payment_terms_days,balance,notes,is_active,created_at,updated_at";

const TXN_COLUMNS =
  "id,store_id,account_id,type,amount,balance_after,ref_invoice_sync_id,shift_id,note,actor_name,created_at";

type AccountRow = {
  id: string;
  store_id: string;
  name: string;
  account_type: string;
  phone: string | null;
  default_markup_pct: number | string | null;
  commission_pct: number | string | null;
  credit_limit: number | string | null;
  payment_terms_days: number | null;
  balance: number | string | null;
  notes: string | null;
  is_active: boolean | null;
  created_at: string;
  updated_at: string;
};

type TxnRow = {
  id: string;
  store_id: string;
  account_id: string;
  type: string;
  amount: number | string;
  balance_after: number | string | null;
  ref_invoice_sync_id: string | null;
  shift_id: string | null;
  note: string | null;
  actor_name: string | null;
  created_at: string;
};

function num(value: number | string | null | undefined): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function rowToAccount(row: AccountRow): B2BAccount {
  return {
    id: row.id,
    storeId: row.store_id,
    name: row.name,
    accountType: (row.account_type as B2BAccountType) ?? "WHOLESALE",
    phone: row.phone ?? undefined,
    defaultMarkupPct: num(row.default_markup_pct),
    commissionPct: num(row.commission_pct),
    creditLimit: num(row.credit_limit),
    paymentTermsDays: row.payment_terms_days ?? undefined,
    balance: num(row.balance),
    notes: row.notes ?? undefined,
    isActive: row.is_active !== false,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToTxn(row: TxnRow): B2BTransaction {
  return {
    id: row.id,
    storeId: row.store_id,
    accountId: row.account_id,
    type: row.type as B2BTransactionType,
    amount: num(row.amount),
    balanceAfter: row.balance_after == null ? undefined : num(row.balance_after),
    refInvoiceSyncId: row.ref_invoice_sync_id ?? undefined,
    shiftId: row.shift_id ?? undefined,
    note: row.note ?? undefined,
    actorName: row.actor_name ?? undefined,
    createdAt: row.created_at,
  };
}

/** Fetch the store's B2B accounts. */
export async function fetchB2BAccounts(): Promise<B2BResult<B2BAccount[]>> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !isSupabaseBrowserConfigured() || !storeId) {
    return { ok: false, error: "Supabase غير مهيأة" };
  }
  try {
    const { data, error } = await sb
      .from("b2b_accounts")
      .select(ACCOUNT_COLUMNS)
      .eq("store_id", storeId)
      .order("name", { ascending: true });
    if (error) return { ok: false, error: error.message };
    return { ok: true, data: ((data ?? []) as AccountRow[]).map(rowToAccount) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "network" };
  }
}

/** Fetch the most recent ledger transactions for one account (or all). */
export async function fetchB2BTransactions(
  accountId?: string,
  limit = 100,
): Promise<B2BResult<B2BTransaction[]>> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !isSupabaseBrowserConfigured() || !storeId) {
    return { ok: false, error: "Supabase غير مهيأة" };
  }
  try {
    let query = sb
      .from("b2b_transactions")
      .select(TXN_COLUMNS)
      .eq("store_id", storeId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (accountId) query = query.eq("account_id", accountId);
    const { data, error } = await query;
    if (error) return { ok: false, error: error.message };
    return { ok: true, data: ((data ?? []) as TxnRow[]).map(rowToTxn) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "network" };
  }
}

export interface CreateB2BAccountInput {
  name: string;
  accountType: B2BAccountType;
  phone?: string;
  defaultMarkupPct: number;
  commissionPct?: number;
  creditLimit?: number;
  paymentTermsDays?: number;
  notes?: string;
}

/** Create a B2B account. RLS enforces the admin role server-side. */
export async function createB2BAccount(
  input: CreateB2BAccountInput,
): Promise<B2BResult<B2BAccount>> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !isSupabaseBrowserConfigured() || !storeId) {
    return { ok: false, error: "Supabase غير مهيأة" };
  }
  const name = input.name.trim();
  if (!name) return { ok: false, error: "اسم الحساب مطلوب" };
  const markup = Number(input.defaultMarkupPct);
  if (!Number.isFinite(markup) || markup < 0 || markup > 500) {
    return { ok: false, error: "نسبة التسعير يجب أن تكون بين 0 و 500" };
  }
  try {
    const { data, error } = await sb
      .from("b2b_accounts")
      .insert({
        store_id: storeId,
        name,
        account_type: input.accountType,
        phone: input.phone?.trim() || null,
        default_markup_pct: markup,
        commission_pct: input.commissionPct ?? null,
        credit_limit: input.creditLimit ?? null,
        payment_terms_days: input.paymentTermsDays ?? null,
        notes: input.notes?.trim() || null,
      })
      .select(ACCOUNT_COLUMNS)
      .single();
    if (error) return { ok: false, error: error.message };
    return { ok: true, data: rowToAccount(data as AccountRow) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "network" };
  }
}

export interface UpdateB2BAccountInput {
  name?: string;
  phone?: string;
  defaultMarkupPct?: number;
  commissionPct?: number;
  creditLimit?: number;
  paymentTermsDays?: number;
  notes?: string;
  isActive?: boolean;
}

/** Update editable fields of a B2B account (balance is trigger-managed). */
export async function updateB2BAccount(
  id: string,
  patch: UpdateB2BAccountInput,
): Promise<B2BResult<B2BAccount>> {
  const sb = getSupabaseBrowser();
  if (!sb || !isSupabaseBrowserConfigured()) return { ok: false, error: "offline" };
  const values: Record<string, unknown> = {};
  if (patch.name !== undefined) values.name = patch.name.trim();
  if (patch.phone !== undefined) values.phone = patch.phone.trim() || null;
  if (patch.defaultMarkupPct !== undefined) {
    const markup = Number(patch.defaultMarkupPct);
    if (!Number.isFinite(markup) || markup < 0 || markup > 500) {
      return { ok: false, error: "نسبة التسعير يجب أن تكون بين 0 و 500" };
    }
    values.default_markup_pct = markup;
  }
  if (patch.commissionPct !== undefined) values.commission_pct = patch.commissionPct;
  if (patch.creditLimit !== undefined) values.credit_limit = patch.creditLimit;
  if (patch.paymentTermsDays !== undefined) values.payment_terms_days = patch.paymentTermsDays;
  if (patch.notes !== undefined) values.notes = patch.notes.trim() || null;
  if (patch.isActive !== undefined) values.is_active = patch.isActive;
  try {
    const { data, error } = await sb
      .from("b2b_accounts")
      .update(values)
      .eq("id", id)
      .select(ACCOUNT_COLUMNS)
      .maybeSingle();
    if (error) return { ok: false, error: error.message };
    if (!data) return { ok: false, error: "الحساب غير موجود" };
    return { ok: true, data: rowToAccount(data as AccountRow) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "network" };
  }
}

/**
 * Append a PAYMENT (سند قبض) or ADJUSTMENT to the ledger. The
 * `fn_apply_b2b_balance` trigger keeps `balance` authoritative server-side.
 */
export async function recordB2BLedgerEntry(input: {
  accountId: string;
  type: Extract<B2BTransactionType, "PAYMENT" | "ADJUSTMENT">;
  amount: number;
  note?: string;
  actorName?: string;
  shiftId?: string;
}): Promise<B2BResult<{ transaction: B2BTransaction; account: B2BAccount }>> {
  const sb = getSupabaseBrowser();
  if (!sb || !isSupabaseBrowserConfigured()) return { ok: false, error: "offline" };
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount === 0) {
    return { ok: false, error: "المبلغ يجب أن يكون صفراً غير" };
  }
  try {
    const { data: txn, error } = await sb
      .from("b2b_transactions")
      .insert({
        id: newUuid(),
        account_id: input.accountId,
        type: input.type,
        amount,
        note: input.note?.trim() || null,
        actor_name: input.actorName?.trim() || null,
        shift_id: input.shiftId?.trim() || null,
        created_at: new Date().toISOString(),
      })
      .select(TXN_COLUMNS)
      .single();
    if (error) return { ok: false, error: error.message };

    // Re-read the account so the local mirror carries the trigger-computed
    // balance instead of a client-side guess.
    const { data: account, error: accountError } = await sb
      .from("b2b_accounts")
      .select(ACCOUNT_COLUMNS)
      .eq("id", input.accountId)
      .maybeSingle();
    if (accountError) return { ok: false, error: accountError.message };
    if (!account) return { ok: false, error: "الحساب غير موجود" };
    return {
      ok: true,
      data: {
        transaction: rowToTxn(txn as TxnRow),
        account: rowToAccount(account as AccountRow),
      },
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "network" };
  }
}
