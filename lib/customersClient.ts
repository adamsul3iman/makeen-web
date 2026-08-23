import { getSupabaseBrowser } from "./supabaseBrowser";
import { getTenantStoreId } from "./tenantClient";

export interface Customer {
  id: string;
  name: string;
  phone: string | null;
  balance: number;
  created_at: string;
}

export interface CustomerTransaction {
  id: string;
  customer_id: string;
  type: string;
  amount: number;
  balance_after: number;
  description: string | null;
  shift_id: string | null;
  created_at: string;
}

export interface CreateCustomerInput {
  name: string;
  phone?: string;
  balance?: number;
}

export interface UpdateCustomerInput {
  name?: string;
  phone?: string | null;
  balance?: number;
}

export interface CreateCustomerTransactionInput {
  type: string;
  amount: number;
  description?: string;
  shift_id?: string;
}

/**
 * Store-scoped customer (عميل) directory. Optional free-text search matches
 * name or phone via case-insensitive LIKE.
 */
export async function fetchCustomers(q?: string): Promise<Customer[]> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  let query = sb
    .from("customers")
    .select("id,name,phone,balance,created_at")
    .eq("store_id", storeId);

  const term = q?.trim();
  if (term) {
    // Strip characters that would break the PostgREST or() filter grammar.
    const safeTerm = term.replace(/[(),]/g, "");
    query = query.or(`name.ilike.%${safeTerm}%,phone.ilike.%${safeTerm}%`);
  }

  const { data, error } = await query.order("name", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as Customer[];
}

/** Create a customer owned by the caller's store; returns the created row. */
export async function createCustomer(input: CreateCustomerInput): Promise<Customer> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  const name = input.name.trim();
  if (!name) throw new Error("اسم العميل مطلوب");
  const phone = input.phone?.trim() || null;
  const balance = input.balance === undefined ? 0 : Number(input.balance);
  if (!Number.isFinite(balance) || balance < 0) throw new Error("رصيد العميل غير صالح");

  const { data, error } = await sb
    .from("customers")
    .insert({ store_id: storeId, name, phone, balance })
    .select("id,name,phone,balance,created_at")
    .single();
  if (error || !data) throw new Error(error?.message ?? "تعذر إنشاء العميل");
  return data as Customer;
}

/** Update a customer (name/phone); it must belong to the caller's store.
 *  Balance changes MUST go through createCustomerTransaction to maintain the audit ledger. */
export async function updateCustomer(id: string, data: Omit<UpdateCustomerInput, "balance">): Promise<Customer> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  const patch: Omit<UpdateCustomerInput, "balance"> = {};
  if (data.name !== undefined) {
    const name = data.name.trim();
    if (!name) throw new Error("اسم العميل مطلوب");
    patch.name = name;
  }
  if (data.phone !== undefined) patch.phone = data.phone?.trim() || null;

  const { data: updated, error } = await sb
    .from("customers")
    .update(patch)
    .eq("id", id)
    .eq("store_id", storeId)
    .select("id,name,phone,balance,created_at")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!updated) throw new Error("العميل غير موجود");
  return updated as Customer;
}

/** Delete a customer; store scoping keeps other tenants' records safe. */
export async function deleteCustomer(id: string): Promise<void> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  const { error } = await sb
    .from("customers")
    .delete()
    .eq("id", id)
    .eq("store_id", storeId);
  if (error) throw new Error(error.message);
}

/**
 * Ledger of movements (حركات) for one customer: payments, debts, manual
 * adjustments. Newest first so UIs can show a running history.
 */
export async function fetchCustomerTransactions(customerId: string): Promise<CustomerTransaction[]> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  const { data, error } = await sb
    .from("customer_transactions")
    .select("id,customer_id,type,amount,balance_after,description,shift_id,created_at")
    .eq("customer_id", customerId)
    .eq("store_id", storeId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as CustomerTransaction[];
}

/**
 * Record a movement and roll the customer's balance forward.
 *
 * Sign convention (positive balance = customer owes the store):
 *   - "payment" / "SETTLEMENT" → credit (reduces balance)
 *   - "SALE_DEBT" and other types → debit (increases balance)
 *
 * Delegates to the atomic `apply_customer_ledger_event` RPC: it locks the
 * customer row, applies the delta RELATIVELY (never an absolute overwrite),
 * caps credits at the live balance and appends the ledger row in one
 * statement — a manual payment racing a synced DEBT sale can no longer
 * lose an update. `balance_after` snapshots the resulting total so the
 * ledger stays auditable even after later edits.
 */
export async function createCustomerTransaction(
  customerId: string,
  input: CreateCustomerTransactionInput,
): Promise<CustomerTransaction> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  const type = input.type.trim();
  if (!type) throw new Error("نوع الحركة مطلوب");
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("قيمة الحركة غير صالحة");

  // Convention: positive balance = customer owes the store.
  // "payment" and "SETTLEMENT" are credits (reduce what customer owes);
  // "SALE_DEBT" and other types are debits (increase what customer owes).
  const isCredit = type === "payment" || type === "SETTLEMENT";
  const rpcType = isCredit ? "SETTLEMENT" : "SALE_DEBT";

  const { data, error } = await sb.rpc("apply_customer_ledger_event", {
    p_store_id: storeId,
    p_customer_id: customerId,
    p_type: rpcType,
    p_amount: amount,
    p_description: input.description ?? "",
    p_shift_id: input.shift_id ?? null,
  });
  if (error) throw new Error(error.message);

  // PostgREST wraps SETOF-record results in an array.
  const row = (Array.isArray(data) ? data[0] : data) as
    | { transaction_id?: string | null; applied_amount?: number; balance_after?: number }
    | undefined;
  if (!row) throw new Error("تعذر تسجيل حركة العميل");

  return {
    id: row.transaction_id ?? "",
    customer_id: customerId,
    type,
    amount: Number(row.applied_amount ?? amount),
    balance_after: Number(row.balance_after ?? 0),
    description: input.description ?? null,
    shift_id: input.shift_id ?? null,
    created_at: new Date().toISOString(),
  };
}
