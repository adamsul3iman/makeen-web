"use client";

import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Plus, Wallet } from "lucide-react";
import { ListPagination } from "@/components/admin/ListPagination";
import { SearchInput } from "@/components/admin/SearchInput";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { normalizeArabicText } from "@/lib/arabic";
import { formatMoney } from "@/lib/format";
import { posFetch } from "@/lib/tenantClient";
import {
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_LABELS,
  type ExpenseEntry,
} from "@/lib/mock-admin-data";

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

export default function AdminExpensesPage() {
  const [expenses, setExpenses] = useState<ExpenseEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterCategory, setFilterCategory] = useState<string>("");
  const [formCategory, setFormCategory] = useState<string>("");
  const [amount, setAmount] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [q, setQ] = useState("");
  const debouncedQ = useDebouncedValue(q.trim(), 300);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  useEffect(() => {
    posFetch("/api/expenses", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (Array.isArray(data?.expenses)) {
          // Live rows use snake_case (created_at) and expose cashier_id rather
          // than a display name — normalize to the UI shape.
          setExpenses(
            data.expenses.map(
              (e: Partial<ExpenseEntry> & { created_at?: string }) => ({
                id: e.id ?? "",
                category: e.category ?? "",
                amount: typeof e.amount === "number" ? e.amount : 0,
                notes: e.notes ?? "",
                cashier: e.cashier ?? "",
                createdAt: e.created_at ?? e.createdAt ?? new Date().toISOString(),
              }),
            ),
          );
        }
      })
      .catch(() => {
        setError("تعذر تحميل المصروفات — تحقق من الاتصال");
      })
      .finally(() => setLoading(false));
  }, [refreshKey]);

  const refresh = () => setRefreshKey((k) => k + 1);

  const filteredByCategory = filterCategory
    ? expenses.filter((e) => e.category === filterCategory)
    : expenses;

  const filtered = useMemo(() => {
    const needle = normalizeArabicText(debouncedQ);
    if (!needle) return filteredByCategory;
    return filteredByCategory.filter((e) => {
      const haystack = normalizeArabicText(
        `${e.notes} ${e.cashier} ${EXPENSE_CATEGORY_LABELS[e.category as keyof typeof EXPENSE_CATEGORY_LABELS] ?? e.category}`,
      );
      return haystack.includes(needle);
    });
  }, [filteredByCategory, debouncedQ]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const paged = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);
  const total = round2(filteredByCategory.reduce((acc, e) => acc + e.amount, 0));
  const categoryTotal: Record<(typeof EXPENSE_CATEGORIES)[number], number> = {
    transport: 0,
    utilities: 0,
    general: 0,
    supplies: 0,
    maintenance: 0,
  };
  for (const key of EXPENSE_CATEGORIES) {
    categoryTotal[key] = round2(
      expenses.filter((e) => e.category === key).reduce((s, e) => s + e.amount, 0),
    );
  }

  const amountValue = parseFloat(amount) || 0;
  const canSubmit = amountValue > 0 && !saving;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setError("");
    setSaving(true);
    try {
      const res = await posFetch("/api/expenses", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-pos-role": "admin" },
        body: JSON.stringify({
          category: formCategory || "general",
          amount: amountValue,
          notes: notes.trim() || null,
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? "تعذر تسجيل المصروف");
        return;
      }
      setAmount("");
      setNotes("");
      setFormCategory("");
      refresh();
    } catch {
      setError("تعذر تسجيل المصروف — تحقق من الاتصال");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-black text-foreground">المصروفات والنقدية</h1>
        <p className="mt-1 text-sm font-semibold text-muted">
          النفقات المسحوبة من درج الصندوق (مصروفات نثرية) خلال الورديات
        </p>
      </header>

      <section className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        <div className="rounded-2xl border border-border bg-surface p-4">
          <p className="flex items-center gap-1 text-xs font-bold text-muted">
            <Wallet className="h-3.5 w-3.5" /> إجمالي المصروفات
          </p>
          <p className="mt-1 text-2xl font-black tabular-nums text-destructive">
            {formatMoney(round2(expenses.reduce((acc, e) => acc + e.amount, 0)))}
          </p>
        </div>
        {EXPENSE_CATEGORIES.map((key) => (
          <div key={key} className="rounded-2xl border border-border bg-surface p-4">
            <p className="text-xs font-bold text-muted">{EXPENSE_CATEGORY_LABELS[key]}</p>
            <p className="mt-1 text-2xl font-black tabular-nums text-amber-600">
              {formatMoney(categoryTotal[key] ?? 0)}
            </p>
          </div>
        ))}
      </section>

      <section className="grid gap-6 lg:grid-cols-3">
        <form
          className="h-fit space-y-4 rounded-2xl border border-border bg-surface p-5 shadow-sm lg:col-span-1"
          onSubmit={(e) => {
            e.preventDefault();
            void handleSubmit();
          }}
        >
          <h2 className="text-lg font-black text-foreground">تسجيل مصروف</h2>
          <div className="space-y-1">
            <label htmlFor="exp-cat" className="block text-sm font-bold text-muted">
              الفئة
            </label>
            <select
              id="exp-cat"
              value={formCategory || "general"}
              onChange={(e) => setFormCategory(e.target.value)}
              className="w-full rounded-xl border border-border bg-white px-4 py-3 text-base font-bold outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
            >
              {EXPENSE_CATEGORIES.map((key) => (
                <option key={key} value={key}>
                  {EXPENSE_CATEGORY_LABELS[key]}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label htmlFor="exp-amount" className="block text-sm font-bold text-muted">
              المبلغ
            </label>
            <input
              id="exp-amount"
              inputMode="decimal"
              dir="ltr"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="w-full rounded-xl border border-border bg-white px-4 py-3 text-left text-2xl font-bold tabular-nums outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="exp-notes" className="block text-sm font-bold text-muted">
              ملاحظات
            </label>
            <input
              id="exp-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="مثال: توصيل طلبيات"
              className="w-full rounded-xl border border-border bg-white px-4 py-3 text-base font-bold outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
            />
          </div>
          {error && <p className="text-sm font-bold text-destructive">{error}</p>}
          <button
            type="submit"
            disabled={!canSubmit}
            className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-destructive text-base font-black text-destructive-foreground transition hover:bg-destructive-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving ? (
              "جارٍ الحفظ…"
            ) : (
              <>
                <Plus className="h-5 w-5" />
                إضافة المصروف
              </>
            )}
          </button>
        </form>

        <section className="overflow-hidden rounded-2xl border border-border bg-surface shadow-sm lg:col-span-2">
          <div className="flex flex-col gap-3 border-b border-border px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
            <h2 className="text-base font-black text-foreground">سجل المصروفات</h2>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <SearchInput
                value={q}
                onChange={(value) => {
                  setQ(value);
                  setPage(1);
                }}
                placeholder="ابحث في الملاحظات أو الكاشير…"
                className="sm:w-64"
              />
              <select
                value={filterCategory}
                onChange={(e) => {
                  setFilterCategory(e.target.value);
                  setPage(1);
                }}
                className="rounded-lg border border-border bg-white px-3 py-2.5 text-sm font-bold outline-none focus:border-primary"
              >
                <option value="">كل الفئات</option>
                {EXPENSE_CATEGORIES.map((key) => (
                  <option key={key} value={key}>
                    {EXPENSE_CATEGORY_LABELS[key]}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {loading ? (
            <p className="px-5 py-8 text-center text-sm font-semibold text-muted">جارٍ التحميل…</p>
          ) : (
            <div className="scrollbar-hidden overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-surface-muted text-right text-xs font-black text-muted">
                    <th className="px-5 py-3">التاريخ</th>
                    <th className="px-5 py-3">الفئة</th>
                    <th className="px-5 py-3">الملاحظات</th>
                    <th className="px-5 py-3">الكاشير</th>
                    <th className="px-5 py-3">المبلغ</th>
                  </tr>
                </thead>
                <tbody>
                  {paged.map((e) => (
                    <tr key={e.id} className="border-b border-border/60 text-right">
                      <td className="px-5 py-3 font-bold text-foreground">
                        {new Date(e.createdAt).toLocaleDateString("en-US", {
                          day: "2-digit",
                          month: "2-digit",
                          year: "numeric",
                        })}
                      </td>
                      <td className="px-5 py-3">
                        <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-black text-amber-700">
                          {EXPENSE_CATEGORY_LABELS[e.category as keyof typeof EXPENSE_CATEGORY_LABELS] ??
                            e.category}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-muted">{e.notes || "—"}</td>
                      <td className="px-5 py-3 text-muted">{e.cashier || "—"}</td>
                      <td className="px-5 py-3 font-black tabular-nums text-destructive">
                        {formatMoney(e.amount)}
                      </td>
                    </tr>
                  ))}
                  {filtered.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-5 py-8 text-center text-sm font-semibold text-muted">
                        لا توجد مصروفات مسجلة
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
          <footer className="flex items-center justify-between border-t border-border px-5 py-3 text-xs font-semibold text-muted">
            <span className="flex items-center gap-1">
              <CheckCircle2 className="h-3.5 w-3.5" />
              {filtered.length} سجل • الإجمالي المعروض {formatMoney(total)}
            </span>
          </footer>
          <ListPagination
            page={safePage}
            totalPages={totalPages}
            total={filtered.length}
            pageSize={pageSize}
            onPageChange={setPage}
            onPageSizeChange={(size) => {
              setPageSize(size);
              setPage(1);
            }}
          />
        </section>
      </section>
    </div>
  );
}
