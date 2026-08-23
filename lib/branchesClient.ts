import { getSupabaseBrowser } from "./supabaseBrowser";
import { getTenantStoreId } from "./tenantClient";

export interface BranchTerminal {
  id: string;
  name: string;
  createdAt?: string | null;
}

export interface BranchWithTerminals {
  id: string;
  name: string;
  createdAt?: string | null;
  terminals: BranchTerminal[];
}

/**
 * Store-scoped branch (فرع) registry for the multi-terminal architecture.
 * Every store owns branches, each branch owns cash registers with
 * independent drawers and shifts.
 */
export async function fetchBranches(): Promise<BranchWithTerminals[]> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  const { data: branches, error } = await sb
    .from("branches")
    .select("id,name,created_at")
    .eq("store_id", storeId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);

  const branchRows = (branches ?? []) as Array<{ id: string; name: string; created_at: string }>;
  const branchIds = branchRows.map((b) => b.id);

  const { data: terminals, error: terminalsError } = await sb
    .from("terminals")
    .select("id,branch_id,name,created_at")
    .in("branch_id", branchIds.length > 0 ? branchIds : ["00000000-0000-0000-0000-000000000000"])
    .order("created_at", { ascending: true });
  if (terminalsError) throw new Error(terminalsError.message);

  const terminalRows = (terminals ?? []) as Array<{
    id: string;
    branch_id: string;
    name: string;
    created_at: string;
  }>;

  return branchRows.map((b) => ({
    id: b.id,
    name: b.name,
    createdAt: b.created_at,
    terminals: terminalRows
      .filter((t) => t.branch_id === b.id)
      .map((t) => ({ id: t.id, name: t.name, createdAt: t.created_at })),
  }));
}

/**
 * Creates a branch and auto-creates a default "كاشير 1" terminal, so a new
 * branch is immediately usable at the register. Admin role enforced by RLS.
 */
export async function createBranch(name: string): Promise<BranchWithTerminals> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  const trimmedName = name.trim();
  if (!trimmedName) throw new Error("اسم الفرع مطلوب");
  if (trimmedName.length > 80) throw new Error("اسم الفرع طويل جداً");

  const { data: branch, error } = await sb
    .from("branches")
    .insert({ store_id: storeId, name: trimmedName })
    .select("id,name,created_at")
    .single();
  if (error || !branch) throw new Error(error?.message ?? "تعذر إنشاء الفرع");

  const { data: terminal, error: terminalError } = await sb
    .from("terminals")
    .insert({ branch_id: branch.id, name: "كاشير 1" })
    .select("id,name,created_at")
    .single();

  return {
    id: branch.id,
    name: branch.name,
    createdAt: branch.created_at,
    terminals:
      terminalError || !terminal
        ? []
        : [{ id: terminal.id, name: terminal.name, createdAt: terminal.created_at }],
  };
}

/** Rename a branch (admin role). */
export async function updateBranch(id: string, name: string): Promise<{ id: string; name: string }> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  const trimmedName = name.trim();
  if (!trimmedName) throw new Error("اسم الفرع مطلوب");

  const { data, error } = await sb
    .from("branches")
    .update({ name: trimmedName })
    .eq("id", id)
    .eq("store_id", storeId)
    .select("id,name")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("الفرع غير موجود");
  return { id: data.id, name: data.name };
}

/**
 * Delete a branch (admin role). A branch can only be deleted when it has no
 * terminals and no historical sync_events reference it, so fiscal history is
 * never orphaned.
 */
export async function deleteBranch(id: string): Promise<void> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  const { data: branch, error: branchError } = await sb
    .from("branches")
    .select("id")
    .eq("id", id)
    .eq("store_id", storeId)
    .maybeSingle();
  if (branchError) throw new Error(branchError.message);
  if (!branch) throw new Error("الفرع غير موجود");

  const { data: terminalRows, error: terminalError } = await sb
    .from("terminals")
    .select("id")
    .eq("branch_id", id);
  if (terminalError) throw new Error(terminalError.message);
  if ((terminalRows ?? []).length > 0) {
    throw new Error("لا يمكن حذف فرع يحتوي على كاشيرات");
  }

  const { data: eventRows, error: eventError } = await sb
    .from("sync_events")
    .select("sync_id")
    .eq("branch_id", id)
    .limit(1);
  if (eventError) throw new Error(eventError.message);
  if ((eventRows ?? []).length > 0) {
    throw new Error("لا يمكن حذف فرع لديه سجل مبيعات");
  }

  const { error: deleteError } = await sb.from("branches").delete().eq("id", id);
  if (deleteError) throw new Error(deleteError.message);
}

/**
 * Create a terminal (كاشير) inside one of the store's branches. The branch is
 * verified to belong to the caller's store so a tenant can never attach a
 * register to another tenant's branch.
 */
export async function createTerminal(branchId: string, name: string): Promise<BranchTerminal> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  const trimmedBranchId = branchId.trim();
  const trimmedName = name.trim();
  if (!trimmedBranchId) throw new Error("الفرع مطلوب");
  if (!trimmedName) throw new Error("اسم الكاشير مطلوب");
  if (trimmedName.length > 80) throw new Error("اسم الكاشير طويل جداً");

  const { data: branch, error: branchError } = await sb
    .from("branches")
    .select("id")
    .eq("id", trimmedBranchId)
    .eq("store_id", storeId)
    .maybeSingle();
  if (branchError) throw new Error(branchError.message);
  if (!branch) throw new Error("الفرع غير موجود");

  const { data: terminal, error } = await sb
    .from("terminals")
    .insert({ branch_id: trimmedBranchId, name: trimmedName })
    .select("id,branch_id,name,created_at")
    .single();
  if (error || !terminal) throw new Error(error?.message ?? "تعذر إنشاء الكاشير");

  return { id: terminal.id, name: terminal.name, createdAt: terminal.created_at };
}

/** Rename a terminal (admin role); it must belong to one of the caller's branches. */
export async function updateTerminal(
  id: string,
  name: string,
): Promise<{ id: string; branchId: string; name: string }> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  const trimmedName = name.trim();
  if (!trimmedName) throw new Error("اسم الكاشير مطلوب");

  const { data: terminal, error: readError } = await sb
    .from("terminals")
    .select("id,branch_id")
    .eq("id", id)
    .maybeSingle();
  if (readError) throw new Error(readError.message);
  if (!terminal) throw new Error("الكاشير غير موجود");

  const { data: branch, error: branchError } = await sb
    .from("branches")
    .select("id")
    .eq("id", terminal.branch_id)
    .eq("store_id", storeId)
    .maybeSingle();
  if (branchError) throw new Error(branchError.message);
  if (!branch) throw new Error("الكاشير غير موجود");

  const { data, error } = await sb
    .from("terminals")
    .update({ name: trimmedName })
    .eq("id", id)
    .select("id,branch_id,name")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("الكاشير غير موجود");
  return { id: data.id, branchId: data.branch_id, name: data.name };
}

/**
 * Delete an empty terminal (admin role). Deletion is blocked while any
 * sync_events (sales/shifts) reference it so historical drawer reports stay
 * intact.
 */
export async function deleteTerminal(id: string): Promise<void> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) throw new Error("Supabase غير مهيأة");

  const { data: terminal, error: readError } = await sb
    .from("terminals")
    .select("id,branch_id")
    .eq("id", id)
    .maybeSingle();
  if (readError) throw new Error(readError.message);
  if (!terminal) throw new Error("الكاشير غير موجود");

  const { data: branch, error: branchError } = await sb
    .from("branches")
    .select("id")
    .eq("id", terminal.branch_id)
    .eq("store_id", storeId)
    .maybeSingle();
  if (branchError) throw new Error(branchError.message);
  if (!branch) throw new Error("الكاشير غير موجود");

  const { data: eventRows, error: eventError } = await sb
    .from("sync_events")
    .select("sync_id")
    .eq("terminal_id", id)
    .limit(1);
  if (eventError) throw new Error(eventError.message);
  if ((eventRows ?? []).length > 0) {
    throw new Error("لا يمكن حذف كاشير لديه سجل مبيعات");
  }

  const { error: deleteError } = await sb.from("terminals").delete().eq("id", id);
  if (deleteError) throw new Error(deleteError.message);
}
