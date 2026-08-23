import { getSupabaseBrowser } from "./supabaseBrowser";
import { getTenantStoreId } from "./tenantClient";

export interface Expense {
  id: string;
  cashier_id: string | null;
  category: string;
  amount: number;
  notes: string | null;
  shift_id: string | null;
  created_at: string;
}

export interface CreateExpenseInput {
  category: string;
  amount: number;
  notes?: string;
  cashier_id?: string;
  shift_id?: string;
}

export interface FetchExpensesParams {
  category?: string;
  /** Inclusive ISO timestamp lower bound on created_at. */
  from?: string;
  /** Inclusive ISO timestamp upper bound on created_at. */
  to?: string;
}

/**
 * Store-scoped operating expense (مصروف) log. Rows are always filtered by the
 * tenant store so a branch never sees another tenant's spendings.
 */
export async function fetchExpenses(params?: FetchExpensesParams): Promise<Expense[]> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  let query = sb
    .from("expenses")
    .select("id,cashier_id,category,amount,notes,shift_id,created_at")
    .eq("store_id", storeId);

  if (params?.category) query = query.eq("category", params.category);
  if (params?.from) query = query.gte("created_at", params.from);
  if (params?.to) query = query.lte("created_at", params.to);

  const { data, error } = await query.order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as Expense[];
}

/**
 * Record a new expense against the caller's store (admin role enforced by
 * RLS). Returns the created row so callers can render it immediately.
 */
export async function createExpense(input: CreateExpenseInput): Promise<Expense> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  const category = input.category.trim();
  const amount = Number(input.amount);
  if (!category) throw new Error("تصنيف المصروف مطلوب");
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("قيمة المصروف غير صالحة");

  const { data, error } = await sb
    .from("expenses")
    .insert({
      store_id: storeId,
      category,
      amount,
      notes: input.notes ?? null,
      cashier_id: input.cashier_id ?? null,
      shift_id: input.shift_id ?? null,
    })
    .select("id,cashier_id,category,amount,notes,shift_id,created_at")
    .single();
  if (error || !data) throw new Error(error?.message ?? "تعذر تسجيل المصروف");
  return data as Expense;
}

/** Delete an expense; store scoping guarantees cross-tenant rows stay untouchable. */
export async function deleteExpense(id: string): Promise<void> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  const { error } = await sb
    .from("expenses")
    .delete()
    .eq("id", id)
    .eq("store_id", storeId);
  if (error) throw new Error(error.message);
}
