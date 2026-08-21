"use client";

import { useEffect, useMemo, useState } from "react";
import { Pencil, Plus, Truck, X } from "lucide-react";
import Link from "next/link";
import { ListPagination } from "@/components/admin/ListPagination";
import { SearchInput } from "@/components/admin/SearchInput";
import {
  AdminDataTable,
  AdminTableActions,
  type AdminDataTableColumn,
} from "@/components/ui/AdminDataTable";
import { PageHeader } from "@/components/ui/Card";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { normalizeArabicText } from "@/lib/arabic";
import { formatMoney } from "@/lib/format";
import { posFetch } from "@/lib/tenantClient";
import type { SupplierLedger } from "@/lib/mock-admin-data";

interface SupplierForm {
  name: string;
  phone: string;
  email: string;
  address: string;
}

const EMPTY_FORM: SupplierForm = { name: "", phone: "", email: "", address: "" };

export default function AdminSuppliersPage() {
  const [suppliers, setSuppliers] = useState<SupplierLedger[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<SupplierForm>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [supplierAddresses, setSupplierAddresses] = useState<Record<string, string>>({});
  const [q, setQ] = useState("");
  const debouncedQ = useDebouncedValue(q.trim(), 300);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  useEffect(() => {
    posFetch("/api/suppliers", { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) {
          const err = await res.json().catch(() => ({})) as { error?: string };
          throw new Error(err.error ?? "تعذر تحميل الموردين");
        }
        return res.json();
      })
      .then((data) => {
        if (Array.isArray(data?.suppliers)) {
          setSuppliers(
            data.suppliers.map((s: { id: string; name: string; phone: string; email: string; address: string | null; balance: number }) => ({
              id: s.id,
              name: s.name,
              phone: s.phone ?? "",
              email: s.email ?? "",
              balance: s.balance ?? 0,
            })),
          );
          const addrMap: Record<string, string> = {};
          for (const s of data.suppliers) {
            if (s.address) addrMap[s.id] = s.address;
          }
          setSupplierAddresses(addrMap);
        }
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "تعذر تحميل الموردين — تحقق من الاتصال");
      })
      .finally(() => setLoading(false));
  }, [refreshKey]);

  const refresh = () => setRefreshKey((k) => k + 1);

  const filteredSuppliers = useMemo(() => {
    const needle = normalizeArabicText(debouncedQ);
    if (!needle) return suppliers;
    return suppliers.filter((s) => {
      const haystack = normalizeArabicText(`${s.name} ${s.phone} ${s.email}`);
      return haystack.includes(needle);
    });
  }, [suppliers, debouncedQ]);

  const totalBalance = suppliers.reduce((acc, s) => acc + s.balance, 0);
  const totalPages = Math.max(1, Math.ceil(filteredSuppliers.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pagedSuppliers = filteredSuppliers.slice((safePage - 1) * pageSize, safePage * pageSize);

  const startEdit = (s: SupplierLedger) => {
    setEditingId(s.id);
    setForm({ name: s.name, phone: s.phone, email: s.email, address: supplierAddresses[s.id] ?? "" });
    setError("");
  };

  const cancelEdit = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setError("");
  };

  const handleSubmit = async () => {
    if (!form.name.trim()) {
      setError("اسم المورد مطلوب");
      return;
    }
    setError("");
    setSaving(true);
    try {
      const url = editingId ? `/api/suppliers?id=${encodeURIComponent(editingId)}` : "/api/suppliers";
      const res = await posFetch(url, {
        method: editingId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json", "x-pos-role": "admin" },
        body: JSON.stringify(form),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? "تعذر حفظ المورد");
        return;
      }
      cancelEdit();
      refresh();
    } catch {
      setError("تعذر حفظ المورد — تحقق من الاتصال");
    } finally {
      setSaving(false);
    }
  };

  const supplierColumns: AdminDataTableColumn<SupplierLedger>[] = [
    {
      id: "name",
      header: "الاسم",
      cell: (supplier) => <span className="font-bold">{supplier.name}</span>,
    },
    {
      id: "phone",
      header: "الهاتف",
      cell: (supplier) => <span dir="ltr" className="tabular-nums text-muted">{supplier.phone || "—"}</span>,
    },
    {
      id: "email",
      header: "البريد",
      cell: (supplier) => <span dir="ltr" className="text-muted">{supplier.email || "—"}</span>,
    },
    {
      id: "balance",
      header: "الرصيد",
      cell: (supplier) => <span className="tabular-nums text-warning-strong">{formatMoney(supplier.balance)}</span>,
    },
    {
      id: "actions",
      header: <span className="sr-only">الإجراءات</span>,
      action: true,
      cell: (supplier) => (
        <AdminTableActions>
          <button
            type="button"
            onClick={() => startEdit(supplier)}
            className="inline-flex min-h-9 items-center gap-1 rounded-lg px-2.5 text-xs font-black text-primary transition hover:bg-primary/10"
          >
            <Pencil className="h-3.5 w-3.5" />
            تعديل
          </button>
        </AdminTableActions>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="الموردون"
        subtitle="سجل الموردين وحساباتهم — الأساس لأوامر الشراء"
        action={(
          <Link href="/admin/supplier-accounts" className="inline-flex h-10 items-center justify-center rounded-lg bg-primary px-4 text-sm font-black text-primary-foreground transition hover:bg-primary-hover">
            فواتير الموردين والدفعات
          </Link>
        )}
      />

      <section className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        <div className="rounded-2xl border border-border bg-surface p-4">
          <p className="flex items-center gap-1 text-xs font-bold text-muted">
            <Truck className="h-3.5 w-3.5" /> عدد الموردين
          </p>
          <p className="mt-1 text-2xl font-black tabular-nums">{suppliers.length}</p>
        </div>
        <div className="rounded-2xl border border-border bg-surface p-4">
          <p className="text-xs font-bold text-muted">أرصدة الموردين المستحقة</p>
          <p className="mt-1 text-2xl font-black tabular-nums text-warning-strong">
            {formatMoney(totalBalance)}
          </p>
        </div>
      </section>

      <section className="grid gap-6 lg:grid-cols-3">
        <form
          className="h-fit space-y-4 rounded-2xl border border-border bg-surface p-5 shadow-sm lg:col-span-1"
          onSubmit={(e) => {
            e.preventDefault();
            void handleSubmit();
          }}
        >
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-black text-foreground">
              {editingId ? "تعديل مورد" : "إضافة مورد"}
            </h2>
            {editingId && (
              <button
                type="button"
                onClick={cancelEdit}
                aria-label="إلغاء التعديل"
                className="grid h-8 w-8 place-items-center rounded-lg text-muted transition hover:bg-surface-muted"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          <div className="space-y-1">
            <label htmlFor="sup-name" className="block text-sm font-bold text-muted">
              اسم المورد *
            </label>
            <input
              id="sup-name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="مثال: شركة الأمانة للمواد الغذائية"
              className="w-full rounded-xl border border-border bg-surface px-4 py-3 text-base font-bold outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
            <div className="space-y-1">
              <label htmlFor="sup-phone" className="block text-sm font-bold text-muted">
                الهاتف
              </label>
              <input
                id="sup-phone"
                dir="ltr"
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                placeholder="07xxxxxxxx"
                className="w-full rounded-xl border border-border bg-surface px-4 py-3 text-base font-bold outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="sup-email" className="block text-sm font-bold text-muted">
                البريد
              </label>
              <input
                id="sup-email"
                dir="ltr"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                placeholder="name@mail.com"
                className="w-full rounded-xl border border-border bg-surface px-4 py-3 text-base font-bold outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
              />
            </div>
          </div>
          <div className="space-y-1">
            <label htmlFor="sup-address" className="block text-sm font-bold text-muted">
              العنوان
            </label>
            <input
              id="sup-address"
              value={form.address}
              onChange={(e) => setForm({ ...form, address: e.target.value })}
              placeholder="العنوان (اختياري)"
              className="w-full rounded-xl border border-border bg-surface px-4 py-3 text-base font-bold outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
            />
          </div>
          {error && <p className="text-sm font-bold text-destructive">{error}</p>}
          <button
            type="submit"
            disabled={saving}
            className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-primary text-base font-black text-primary-foreground transition hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving ? (
              "جارٍ الحفظ…"
            ) : (
              <>
                {editingId ? <Pencil className="h-5 w-5" /> : <Plus className="h-5 w-5" />}
                {editingId ? "حفظ التعديلات" : "إضافة المورد"}
              </>
            )}
          </button>
        </form>

        <AdminDataTable
          className="lg:col-span-2"
          caption="سجل الموردين"
          columns={supplierColumns}
          rows={pagedSuppliers}
          getRowKey={(supplier) => supplier.id}
          loading={loading}
          tableClassName="min-w-[680px]"
          toolbar={(
            <div className="flex flex-col gap-3 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
              <h2 className="text-base font-black text-foreground">سجل الموردين</h2>
              <SearchInput
                value={q}
                onChange={(value) => {
                  setQ(value);
                  setPage(1);
                }}
                placeholder="ابحث بالاسم أو الهاتف أو البريد…"
                className="sm:w-64"
              />
            </div>
          )}
          emptyState={suppliers.length === 0 ? "لا يوجد موردون بعد" : "لا موردين مطابقين للبحث"}
          footer={(
            <ListPagination
              page={safePage}
              totalPages={totalPages}
              total={filteredSuppliers.length}
              pageSize={pageSize}
              onPageChange={setPage}
              onPageSizeChange={(size) => {
                setPageSize(size);
                setPage(1);
              }}
            />
          )}
        />
      </section>
    </div>
  );
}
