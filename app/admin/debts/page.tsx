"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import {
  ArrowDownCircle,
  Banknote,
  History,
  Loader2,
  Phone,
  Plus,
  UserPlus,
  X,
} from "lucide-react";
import { ListPagination } from "@/components/admin/ListPagination";
import { SearchInput } from "@/components/admin/SearchInput";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { normalizeArabicText } from "@/lib/arabic";
import { formatMoney } from "@/lib/format";
import { posFetch } from "@/lib/tenantClient";
import {
  type CustomerLedger,
  type CustomerLedgerEntry,
} from "@/lib/mock-admin-data";

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

const TYPE_LABEL: Record<CustomerLedgerEntry["type"], string> = {
  SALE_DEBT: "فاتورة آجلة",
  SETTLEMENT: "سداد",
};

export default function AdminDebtsPage() {
  const [customers, setCustomers] = useState<CustomerLedger[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [entries, setEntries] = useState<Record<string, CustomerLedgerEntry[]>>({});
  const [payAmount, setPayAmount] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<{ tone: "success" | "error"; message: string } | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [q, setQ] = useState("");
  const debouncedQ = useDebouncedValue(q.trim(), 300);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  useEffect(() => {
    posFetch("/api/customers", { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) {
          const err = await res.json().catch(() => ({})) as { error?: string };
          throw new Error(err.error ?? "تعذر تحميل العملاء");
        }
        return res.json();
      })
      .then((data) => {
        if (Array.isArray(data?.customers)) {
          setCustomers(
            data.customers.map((c: Partial<CustomerLedger>) => ({
              id: c.id ?? "",
              name: c.name ?? "",
              phone: c.phone ?? "",
              balance: typeof c.balance === "number" ? c.balance : 0,
            })),
          );
        }
      })
      .catch((err) => {
        setStatus({ tone: "error", message: err instanceof Error ? err.message : "تعذر تحميل العملاء — تحقق من الاتصال" });
      })
      .finally(() => setLoading(false));
  }, []);

  const totalOutstanding = customers.reduce((acc, c) => acc + c.balance, 0);
  const topDebtor = [...customers].sort((a, b) => b.balance - a.balance)[0];

  const filteredCustomers = useMemo(() => {
    const needle = normalizeArabicText(debouncedQ);
    if (!needle) return customers;
    return customers.filter((c) => normalizeArabicText(`${c.name} ${c.phone}`).includes(needle));
  }, [customers, debouncedQ]);

  const totalPages = Math.max(1, Math.ceil(filteredCustomers.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pagedCustomers = filteredCustomers.slice((safePage - 1) * pageSize, safePage * pageSize);

  const toggleEntries = async (customer: CustomerLedger) => {
    if (expandedId === customer.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(customer.id);
    if (entries[customer.id]) return;
    try {
      const res = await posFetch(`/api/customers/${customer.id}/transactions`, { cache: "no-store" });
      if (!res.ok) throw new Error("no data");
      const data = await res.json();
      if (Array.isArray(data.transactions)) {
        // Live rows use snake_case (balance_after, created_at); the UI reads
        // camelCase — normalize here so live mode renders correctly.
        setEntries((prev) => ({
          ...prev,
          [customer.id]: data.transactions.map(
            (t: CustomerLedgerEntry & { balance_after?: number; created_at?: string }) => ({
              id: t.id,
              type: t.type,
              amount: typeof t.amount === "number" ? t.amount : 0,
              balanceAfter: t.balance_after ?? t.balanceAfter ?? 0,
              description: t.description ?? "",
              createdAt: t.created_at ?? t.createdAt,
            }),
          ),
        }));
        return;
      }
      throw new Error("no data");
    } catch {
      setEntries((prev) => ({ ...prev, [customer.id]: [] }));
      setStatus({ tone: "error", message: "تعذر تحميل كشف حركات الزبون" });
    }
  };

  const handlePayment = async (customer: CustomerLedger) => {
    const amount = round2(parseFloat(payAmount[customer.id] || "") || 0);
    if (amount <= 0) return;
    setBusy(customer.id);
    setStatus(null);
    let data: { balanceAfter?: number; transaction?: { id?: string; created_at?: string } } = {};
    try {
      const res = await posFetch(`/api/customers/${customer.id}/transactions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-pos-role": "admin" },
        body: JSON.stringify({ type: "SETTLEMENT", amount, description: "دفعة نقدية" }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? "فشل تسجيل الدفعة");
      }
      data = await res.json();
    } catch (err) {
      setStatus({ tone: "error", message: err instanceof Error ? err.message : "فشل تسجيل الدفعة" });
      setBusy(null);
      return;
    }

    const serverBalanceAfter = typeof data.balanceAfter === "number"
      ? data.balanceAfter
      : round2(customer.balance - amount);
    const txId = data.transaction?.id ?? `tx-${Date.now()}`;
    const txCreatedAt = data.transaction?.created_at ?? new Date().toISOString();

    setCustomers((prev) =>
      prev.map((c) => (c.id === customer.id ? { ...c, balance: serverBalanceAfter } : c)),
    );
    setEntries((prev) => ({
      ...prev,
      [customer.id]: [
        {
          id: txId,
          type: "SETTLEMENT",
          amount,
          balanceAfter: serverBalanceAfter,
          description: "دفعة نقدية",
          createdAt: txCreatedAt,
        },
        ...(prev[customer.id] ?? []),
      ],
    }));
    setPayAmount((prev) => ({ ...prev, [customer.id]: "" }));
    setStatus({ tone: "success", message: `تم تسجيل دفعة ${customer.name} بمبلغ ${formatMoney(amount)}` });
    setBusy(null);
  };

  const handleAddCustomer = async () => {
    const name = newName.trim();
    if (!name) return;
    try {
      const res = await posFetch("/api/customers", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-pos-role": "admin" },
        body: JSON.stringify({ name, phone: newPhone.trim() }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? "فشل إضافة الزبون");
      }
      const data = await res.json();
      setCustomers((prev) => [...prev, data.customer]);
    } catch (err) {
      setStatus({ tone: "error", message: err instanceof Error ? err.message : "فشل إضافة الزبون" });
      return;
    }
    setShowAdd(false);
    setNewName("");
    setNewPhone("");
  };

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-black text-foreground">الذمم والعملاء</h1>
          <p className="mt-1 text-sm font-semibold text-muted">
            أرصدة العملاء وكشف الحركات وتسجيل الدفعات
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowAdd((v) => !v)}
          className="flex items-center gap-2 rounded-xl bg-primary px-5 py-3 text-base font-black text-primary-foreground shadow-sm transition hover:bg-primary-hover"
        >
          {showAdd ? <X className="h-5 w-5" /> : <UserPlus className="h-5 w-5" />}
          {showAdd ? "إلغاء" : "زبون جديد"}
        </button>
      </header>

      {status && (
        <div
          className={`rounded-xl px-4 py-3 text-sm font-bold ${
            status.tone === "success" ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive"
          }`}
        >
          {status.message}
        </div>
      )}

      {showAdd && (
        <div className="flex flex-wrap items-end gap-3 rounded-2xl border border-border bg-surface p-4">
          <label className="flex-1 min-w-52">
            <span className="mb-1 block text-xs font-bold text-muted">اسم الزبون</span>
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="مثال: محلات النور"
              className="w-full rounded-xl border border-border bg-white px-4 py-2.5 text-sm font-bold outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
            />
          </label>
          <label className="flex-1 min-w-40">
            <span className="mb-1 block text-xs font-bold text-muted">الهاتف</span>
            <input
              value={newPhone}
              onChange={(e) => setNewPhone(e.target.value)}
              dir="ltr"
              placeholder="07xxxxxxx"
              className="w-full rounded-xl border border-border bg-white px-4 py-2.5 text-sm font-bold outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
            />
          </label>
          <button
            type="button"
            onClick={handleAddCustomer}
            disabled={!newName.trim()}
            className="flex h-11 items-center gap-2 rounded-xl bg-success px-6 text-sm font-black text-success-foreground transition hover:bg-success-hover disabled:opacity-40"
          >
            <Plus className="h-4 w-4" />
            إضافة
          </button>
        </div>
      )}

      <section className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="rounded-2xl border border-border bg-surface p-5">
          <p className="text-sm font-bold text-muted">إجمالي الذمم</p>
          <p className="mt-1 text-3xl font-black tabular-nums text-destructive">
            {formatMoney(totalOutstanding)}
          </p>
        </div>
        <div className="rounded-2xl border border-border bg-surface p-5">
          <p className="text-sm font-bold text-muted">عدد العملاء</p>
          <p className="mt-1 text-3xl font-black tabular-nums">{customers.length}</p>
        </div>
        <div className="rounded-2xl border border-border bg-surface p-5">
          <p className="text-sm font-bold text-muted">أعلى ذمة</p>
          <p className="mt-1 truncate text-2xl font-black text-primary">
            {topDebtor ? `${topDebtor.name} • ${formatMoney(topDebtor.balance)}` : "—"}
          </p>
        </div>
      </section>

      <section className="overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
        <div className="flex flex-col gap-3 border-b border-border px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="text-base font-black text-foreground">سجل العملاء والذمم</h2>
          <SearchInput
            value={q}
            onChange={(value) => {
              setQ(value);
              setPage(1);
            }}
            placeholder="ابحث بالاسم أو الهاتف…"
            className="sm:w-64"
          />
        </div>
        <div className="scrollbar-hidden overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-muted text-right text-xs font-black text-muted">
                <th className="px-5 py-3">العميل</th>
                <th className="px-5 py-3">الهاتف</th>
                <th className="px-5 py-3">الرصيد المستحق</th>
                <th className="px-5 py-3">إجراءات</th>
              </tr>
            </thead>
            <tbody>
              {pagedCustomers.map((customer) => (
                <Fragment key={customer.id}>
                  <tr className="border-b border-border/60 text-right">
                    <td className="px-5 py-3.5 font-bold text-foreground">{customer.name}</td>
                    <td className="px-5 py-3.5">
                      <span className="flex items-center gap-1.5 tabular-nums text-muted" dir="ltr">
                        <Phone className="h-4 w-4" />
                        {customer.phone || "—"}
                      </span>
                    </td>
                    <td className="px-5 py-3.5">
                      <span
                        className={`rounded-full px-3 py-1 text-sm font-black tabular-nums ${
                          customer.balance > 0
                            ? "bg-destructive/10 text-destructive"
                            : "bg-success/10 text-success"
                        }`}
                      >
                        {formatMoney(customer.balance)}
                      </span>
                    </td>
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => toggleEntries(customer)}
                          className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-bold text-muted transition hover:bg-surface-muted"
                        >
                          <History className="h-4 w-4" />
                          الحركات
                        </button>
                      </div>
                    </td>
                  </tr>
                  {expandedId === customer.id && (
                    <tr>
                      <td colSpan={4} className="bg-surface-muted/50 px-5 py-4">
                        <div className="space-y-3">
                          <div className="flex flex-wrap items-end gap-3">
                            <label className="flex-1 min-w-40">
                              <span className="mb-1 block text-xs font-bold text-muted">
                                مبلغ الدفعة (سداد ذمة)
                              </span>
                              <div className="flex items-center gap-2">
                                <input
                                  inputMode="decimal"
                                  dir="ltr"
                                  value={payAmount[customer.id] ?? ""}
                                  onChange={(e) =>
                                    setPayAmount((prev) => ({ ...prev, [customer.id]: e.target.value }))
                                  }
                                  placeholder="0.00"
                                  className="w-full rounded-xl border border-border bg-white px-4 py-2.5 text-sm font-bold tabular-nums outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
                                />
                                <button
                                  type="button"
                                  onClick={() => handlePayment(customer)}
                                  disabled={busy === customer.id || !(parseFloat(payAmount[customer.id] || "") > 0)}
                                  className="flex h-11 shrink-0 items-center gap-2 rounded-xl bg-success px-5 text-sm font-black text-success-foreground transition hover:bg-success-hover disabled:opacity-40"
                                >
                                  {busy === customer.id ? (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                  ) : (
                                    <Banknote className="h-4 w-4" />
                                  )}
                                  تسجيل دفعة
                                </button>
                              </div>
                            </label>
                          </div>

                          {entries[customer.id] ? (
                            <ul className="space-y-1.5">
                              {entries[customer.id].map((entry) => (
                                <li
                                  key={entry.id}
                                  className="flex items-center justify-between rounded-lg border border-border bg-surface px-4 py-2.5 text-sm"
                                >
                                  <div className="flex items-center gap-3">
                                    <ArrowDownCircle
                                      className={`h-4 w-4 ${
                                        entry.type === "SALE_DEBT" ? "text-destructive" : "text-success"
                                      }`}
                                    />
                                    <span className="font-bold">{TYPE_LABEL[entry.type]}</span>
                                    <span className="text-xs text-muted">
                                      {new Date(entry.createdAt).toLocaleDateString("ar")}
                                    </span>
                                  </div>
                                  <div className="flex items-center gap-4 tabular-nums">
                                    <span
                                      className={`font-black ${
                                        entry.type === "SALE_DEBT" ? "text-destructive" : "text-success"
                                      }`}
                                    >
                                      {entry.type === "SALE_DEBT" ? "+" : "−"}
                                      {formatMoney(entry.amount)}
                                    </span>
                                    <span className="text-xs text-muted">رصيد: {formatMoney(entry.balanceAfter)}</span>
                                  </div>
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <p className="text-sm text-muted">جارٍ تحميل الحركات…</p>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {loading && customers.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-5 py-8 text-center text-sm font-semibold text-muted">
                    <div className="flex flex-col items-center">
                      <Loader2 className="mb-2 h-6 w-6 animate-spin text-primary" />
                      <p>جارٍ تحميل العملاء…</p>
                    </div>
                  </td>
                </tr>
              )}
              {!loading && customers.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-5 py-8 text-center text-sm font-semibold text-muted">
                    لا يوجد عملاء بعد
                  </td>
                </tr>
              )}
              {customers.length > 0 && filteredCustomers.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-5 py-8 text-center text-sm font-semibold text-muted">
                    لا عملاء مطابقين للبحث
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <ListPagination
          page={safePage}
          totalPages={totalPages}
          total={filteredCustomers.length}
          pageSize={pageSize}
          onPageChange={setPage}
          onPageSizeChange={(size) => {
            setPageSize(size);
            setPage(1);
          }}
        />
      </section>
    </div>
  );
}
