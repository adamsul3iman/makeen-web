"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Building2,
  Check,
  Loader2,
  MonitorSmartphone,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { SearchInput } from "@/components/admin/SearchInput";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { normalizeArabicText } from "@/lib/arabic";
import {
  createBranch,
  createTerminal,
  deleteBranch,
  deleteTerminal,
  fetchBranches,
  updateBranch,
  updateTerminal,
} from "@/lib/branchesClient";

interface AdminTerminal {
  id: string;
  name: string;
}

interface AdminBranch {
  id: string;
  name: string;
  terminals: AdminTerminal[];
}

/**
 * Branch (فرع) and terminal (كاشير) management. Every store owns branches,
 * each branch owns cash registers with independent drawers and shifts.
 * Reads and writes go straight to Supabase (store-scoped by RLS); writes
 * require the admin role.
 */
export default function AdminBranchesPage() {
  const [branches, setBranches] = useState<AdminBranch[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ tone: "success" | "error"; message: string } | null>(null);
  const [newBranch, setNewBranch] = useState("");
  const [newTerminal, setNewTerminal] = useState<Record<string, string>>({});
  const [editingBranch, setEditingBranch] = useState<Record<string, string>>({});
  const [editingTerminal, setEditingTerminal] = useState<Record<string, string>>({});
  const [q, setQ] = useState("");
  const debouncedQ = useDebouncedValue(q.trim(), 300);

  const filteredBranches = useMemo(() => {
    const needle = normalizeArabicText(debouncedQ);
    if (!needle) return branches;
    return branches.filter(
      (b) =>
        normalizeArabicText(b.name).includes(needle) ||
        b.terminals.some((t) => normalizeArabicText(t.name).includes(needle)),
    );
  }, [branches, debouncedQ]);

  const load = useCallback(async () => {
    try {
      const rows = await fetchBranches();
      setBranches(rows);
      setStatus(null);
    } catch (err) {
      setStatus({ tone: "error", message: err instanceof Error ? err.message : "تعذر التحميل" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const mutate = async (action: () => Promise<unknown>, fallback: string) => {
    setBusy(true);
    setStatus(null);
    try {
      await action();
      await load();
      return true;
    } catch (err) {
      setStatus({ tone: "error", message: err instanceof Error ? err.message : fallback });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const del = async (label: string, action: () => Promise<unknown>) => {
    if (!window.confirm(`حذف "${label}"؟`)) return;
    if (await mutate(action, "فشل الحذف")) {
      setStatus({ tone: "success", message: "تم الحذف" });
    }
  };

  const addBranch = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = newBranch.trim();
    if (!name) return;
    if (await mutate(() => createBranch(name), "فشل الإجراء")) {
      setNewBranch("");
      setStatus({ tone: "success", message: "تم إنشاء الفرع مع كاشير افتراضي" });
    }
  };

  const addTerminal = async (branchId: string) => {
    const name = (newTerminal[branchId] ?? "").trim();
    if (!name) return;
    if (await mutate(() => createTerminal(branchId, name), "فشل الإجراء")) {
      setNewTerminal((prev) => ({ ...prev, [branchId]: "" }));
      setStatus({ tone: "success", message: "تمت إضافة الكاشير" });
    }
  };

  const saveBranchName = async (branchId: string) => {
    const name = (editingBranch[branchId] ?? "").trim();
    if (!name) return;
    if (await mutate(() => updateBranch(branchId, name), "فشل التعديل")) {
      setEditingBranch((prev) => ({ ...prev, [branchId]: "" }));
    }
  };

  const saveTerminalName = async (terminalId: string) => {
    const name = (editingTerminal[terminalId] ?? "").trim();
    if (!name) return;
    if (await mutate(() => updateTerminal(terminalId, name), "فشل التعديل")) {
      setEditingTerminal((prev) => ({ ...prev, [terminalId]: "" }));
    }
  };

  const totalTerminals = branches.reduce((sum, b) => sum + b.terminals.length, 0);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-black text-foreground">
            <Building2 className="h-6 w-6 text-primary" />
            الفروع والكاشيرات
          </h1>
          <p className="mt-1 text-sm font-semibold text-muted">
            أضف فروعاً لمتجرك، ولكل فرع كاشيرات مستقلة بدرج نقدي ووردياته الخاصة.
          </p>
        </div>
      </header>

      {status && (
        <div
          className={`rounded-xl border px-4 py-3 text-sm font-bold ${
            status.tone === "success"
              ? "border-success/40 bg-success/10 text-success"
              : "border-destructive/40 bg-destructive/10 text-destructive"
          }`}
        >
          {status.message}
        </div>
      )}

      <form
        onSubmit={addBranch}
        className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-5 shadow-sm sm:flex-row sm:items-center"
      >
        <input
          value={newBranch}
          onChange={(e) => setNewBranch(e.target.value)}
          placeholder="اسم الفرع الجديد (مثال: فرع المدينة)"
          className="flex-1 rounded-xl border border-border bg-white px-4 py-3 text-sm font-bold text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
        />
        <button
          type="submit"
          disabled={busy || !newBranch.trim()}
          className="flex items-center justify-center gap-2 rounded-xl bg-primary px-5 py-3 text-sm font-black text-primary-foreground shadow-sm transition hover:bg-primary-hover disabled:opacity-40"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          إضافة فرع
        </button>
      </form>

      <div className="sm:w-72">
        <SearchInput
          value={q}
          onChange={setQ}
          placeholder="ابحث عن فرع أو كاشير…"
        />
      </div>

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-sm font-bold text-muted">
          <Loader2 className="h-5 w-5 animate-spin" />
          جارٍ التحميل…
        </div>
      ) : branches.length === 0 ? (
        <section className="rounded-2xl border border-dashed border-border bg-surface p-10 text-center text-sm font-bold text-muted">
          لا توجد فروع بعد — أضف فرعك الأول أعلاه.
        </section>
      ) : filteredBranches.length === 0 ? (
        <section className="rounded-2xl border border-dashed border-border bg-surface p-10 text-center text-sm font-bold text-muted">
          لا فروع مطابقة للبحث.
        </section>
      ) : (
        <div className="grid gap-5 md:grid-cols-2">
          {filteredBranches.map((branch) => (
            <section
              key={branch.id}
              className="overflow-hidden rounded-2xl border border-border bg-surface shadow-sm"
            >
              <header className="flex items-center justify-between border-b border-border bg-surface-muted px-4 py-3">
                {editingBranch[branch.id] !== undefined && editingBranch[branch.id] !== "" ? (
                  <div className="flex flex-1 items-center gap-2">
                    <input
                      autoFocus
                      value={editingBranch[branch.id]}
                      onChange={(e) =>
                        setEditingBranch((prev) => ({ ...prev, [branch.id]: e.target.value }))
                      }
                      className="min-w-0 flex-1 rounded-lg border border-border bg-white px-3 py-1.5 text-sm font-bold text-foreground outline-none focus:border-primary"
                    />
                    <button
                      type="button"
                      onClick={() => void saveBranchName(branch.id)}
                      disabled={busy}
                      className="grid h-8 w-8 place-items-center rounded-lg bg-success text-success-foreground disabled:opacity-40"
                      aria-label="حفظ"
                    >
                      <Check className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingBranch((prev) => ({ ...prev, [branch.id]: "" }))}
                      className="grid h-8 w-8 place-items-center rounded-lg bg-surface text-muted"
                      aria-label="إلغاء"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                ) : (
                  <>
                    <h2 className="flex items-center gap-2 text-base font-black text-foreground">
                      <Building2 className="h-4 w-4 text-primary" />
                      {branch.name}
                    </h2>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => setEditingBranch((prev) => ({ ...prev, [branch.id]: branch.name }))}
                        disabled={busy}
                        className="grid h-8 w-8 place-items-center rounded-lg text-muted transition hover:bg-surface disabled:opacity-40"
                        aria-label="تعديل"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => void del(branch.name, () => deleteBranch(branch.id))}
                        disabled={busy}
                        className="grid h-8 w-8 place-items-center rounded-lg text-destructive transition hover:bg-destructive/10 disabled:opacity-40"
                        aria-label="حذف"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </>
                )}
              </header>

              <ul className="divide-y divide-border/60">
                {branch.terminals.map((terminal) => (
                  <li key={terminal.id} className="flex items-center justify-between px-4 py-2.5">
                    {editingTerminal[terminal.id] !== undefined && editingTerminal[terminal.id] !== "" ? (
                      <div className="flex flex-1 items-center gap-2">
                        <input
                          autoFocus
                          value={editingTerminal[terminal.id]}
                          onChange={(e) =>
                            setEditingTerminal((prev) => ({ ...prev, [terminal.id]: e.target.value }))
                          }
                          className="min-w-0 flex-1 rounded-lg border border-border bg-white px-3 py-1.5 text-sm font-bold text-foreground outline-none focus:border-primary"
                        />
                        <button
                          type="button"
                          onClick={() => void saveTerminalName(terminal.id)}
                          disabled={busy}
                          className="grid h-8 w-8 place-items-center rounded-lg bg-success text-success-foreground disabled:opacity-40"
                          aria-label="حفظ"
                        >
                          <Check className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingTerminal((prev) => ({ ...prev, [terminal.id]: "" }))}
                          className="grid h-8 w-8 place-items-center rounded-lg bg-surface text-muted"
                          aria-label="إلغاء"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </div>
                    ) : (
                      <>
                        <span className="flex items-center gap-2 text-sm font-bold text-foreground">
                          <MonitorSmartphone className="h-4 w-4 text-muted" />
                          {terminal.name}
                        </span>
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() =>
                              setEditingTerminal((prev) => ({ ...prev, [terminal.id]: terminal.name }))
                            }
                            disabled={busy}
                            className="grid h-8 w-8 place-items-center rounded-lg text-muted transition hover:bg-surface disabled:opacity-40"
                            aria-label="تعديل"
                          >
                            <Pencil className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => void del(terminal.name, () => deleteTerminal(terminal.id))}
                            disabled={busy}
                            className="grid h-8 w-8 place-items-center rounded-lg text-destructive transition hover:bg-destructive/10 disabled:opacity-40"
                            aria-label="حذف"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </>
                    )}
                  </li>
                ))}
              </ul>

              <footer className="flex items-center gap-2 border-t border-border px-4 py-3">
                <input
                  value={newTerminal[branch.id] ?? ""}
                  onChange={(e) =>
                    setNewTerminal((prev) => ({ ...prev, [branch.id]: e.target.value }))
                  }
                  placeholder="اسم كاشير جديد…"
                  className="min-w-0 flex-1 rounded-lg border border-border bg-white px-3 py-2 text-sm font-bold text-foreground outline-none transition focus:border-primary"
                />
                <button
                  type="button"
                  onClick={() => void addTerminal(branch.id)}
                  disabled={busy || !(newTerminal[branch.id] ?? "").trim()}
                  className="flex items-center gap-1.5 rounded-lg bg-surface-muted px-3 py-2 text-sm font-black text-muted transition hover:bg-primary hover:text-primary-foreground disabled:opacity-40"
                >
                  <Plus className="h-4 w-4" />
                  كاشير
                </button>
              </footer>
            </section>
          ))}
        </div>
      )}

      <footer className="text-xs font-semibold text-muted">
        {branches.length} فرعاً • {totalTerminals} كاشيراً — كل كاشير يملك درج نقد ووردية مستقلة.
        {debouncedQ && <span> • النتائج المعروضة: {filteredBranches.length}</span>}
      </footer>
    </div>
  );
}
