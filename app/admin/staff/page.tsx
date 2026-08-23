"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  KeyRound,
  Loader2,
  Mail,
  Pencil,
  Power,
  ShieldCheck,
  Trash2,
  UserPlus,
  UserRound,
  Users,
} from "lucide-react";
import { usePosStore } from "@/store/usePosStore";
import StaffModal, {
  type StaffFormPayload,
  type StaffRoleOption,
} from "@/components/admin/StaffModal";
import SecondaryAuthModal from "@/components/auth/SecondaryAuthModal";
import { SearchInput } from "@/components/admin/SearchInput";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { normalizeArabicText } from "@/lib/arabic";
import { fetchCashiers, fetchRoles } from "@/lib/staffClient";

interface CashierRow {
  id: string;
  name: string;
  username?: string;
  role: string;
  roleId?: string | null;
  roleName?: string;
  isActive?: boolean;
}

/**
 * Back-office cashier management. Reads the real roster from
 * /api/admin/cashiers (session-scoped, never PIN material) and every
 * create / edit / delete is gated by the owner's dashboard password through
 * the same secondary-auth flow the POS uses.
 */
export default function AdminStaffPage() {
  const requestSecondaryAuth = usePosStore((s) => s.requestSecondaryAuth);
  const isSecondaryAuthOpen = usePosStore((s) => s.isSecondaryAuthOpen);
  const owner = usePosStore((s) => s.adminSession);

  const [cashiers, setCashiers] = useState<CashierRow[] | null>(null);
  const [roles, setRoles] = useState<StaffRoleOption[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [sessionExpired, setSessionExpired] = useState(false);
  const [modal, setModal] = useState<{
    open: boolean;
    editing?: CashierRow;
    mode?: "full" | "pin";
  }>({ open: false });
  const [q, setQ] = useState("");
  const debouncedQ = useDebouncedValue(q.trim(), 300);

  const filteredCashiers = useMemo(() => {
    const needle = normalizeArabicText(debouncedQ);
    if (!needle || cashiers === null) return cashiers;
    return cashiers.filter(
      (c) =>
        normalizeArabicText(c.name).includes(needle) ||
        (c.username ?? "").toLowerCase().includes(needle.toLowerCase()),
    );
  }, [cashiers, debouncedQ]);

  const loadRoster = useCallback(async (): Promise<{
    rows: CashierRow[] | null;
    status?: number;
    serverError?: string;
  }> => {
    try {
      const data = await fetchCashiers();
      return {
        rows: data.map((c) => ({
          id: c.id,
          name: c.name,
          username: c.username ?? undefined,
          role: c.role ?? "",
          roleId: c.roleId ?? undefined,
          isActive: c.isActive,
        })),
      };
    } catch (err) {
      return {
        rows: null,
        serverError: err instanceof Error && err.message ? err.message : undefined,
      };
    }
  }, []);

  const applyRoster = useCallback(
    (result: { rows: CashierRow[] | null; status?: number; serverError?: string }) => {
      const { rows, status, serverError } = result;
      if (rows === null) {
        setCashiers(null);
        setSessionExpired(status === 401);
        setLoadError(
          status === 401
            ? "انتهت جلستك — أعد تسجيل الدخول كمدير المتجر لمشاهدة الكاشير."
            : status && serverError
              ? `تعذر تحميل الكاشير — ${serverError}`
              : "تعذر تحميل الكاشير — تأكد من اتصال الشبكة ثم أعد المحاولة."
        );
      } else {
        setCashiers(rows);
        setSessionExpired(false);
        setLoadError("");
      }
    },
    []
  );

  useEffect(() => {
    let cancelled = false;
    loadRoster().then((result) => {
      if (!cancelled) applyRoster(result);
    });
    return () => {
      cancelled = true;
    };
  }, [loadRoster, applyRoster]);

  useEffect(() => {
    let cancelled = false;
    void fetchRoles()
      .then((data) => {
        if (!cancelled)
          setRoles(
            data.map((r) => ({
              id: r.id,
              code: r.code,
              name: r.name,
              description: r.description ?? "",
              capabilities: r.capabilities ?? [],
              limits: (r.limits ?? {}) as StaffRoleOption["limits"],
            })),
          );
      })
      .catch(() => {
        if (!cancelled) setLoadError("تعذر تحميل الأدوار والصلاحيات — أعد المحاولة.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Refresh once after a secondary-auth action (save / delete) closes.
  const prevAuthOpen = useRef(false);
  useEffect(() => {
    const shouldRefresh = prevAuthOpen.current && !isSecondaryAuthOpen;
    prevAuthOpen.current = isSecondaryAuthOpen;
    if (!shouldRefresh) return;
    let cancelled = false;
    loadRoster().then((result) => {
      if (!cancelled) applyRoster(result);
    });
    return () => {
      cancelled = true;
    };
  }, [isSecondaryAuthOpen, loadRoster, applyRoster]);

  const handleSave = (payload: StaffFormPayload) => {
    setModal({ open: false });
    requestSecondaryAuth({ type: "save_cashier", cashier: payload });
  };

  const handleResetPin = (row: CashierRow) => {
    setModal({ open: true, editing: row, mode: "pin" });
  };

  const handleToggleStatus = (row: CashierRow) => {
    const action = row.isActive === false ? "تفعيل" : "إيقاف";
    if (!window.confirm(`هل أنت متأكد من ${action} الموظف «${row.name}»؟`)) return;
    requestSecondaryAuth({
      type: "save_cashier",
      cashier: {
        id: row.id,
        name: row.name,
        role: row.role,
        roleId: row.roleId ?? undefined,
        pin: "",
        username: row.username,
        isActive: row.isActive === false,
      },
    });
  };

  const handleDelete = (row: CashierRow) => {
    if (!window.confirm(`هل أنت متأكد من حذف الموظف «${row.name}»؟`)) return;
    requestSecondaryAuth({ type: "delete_cashier", cashierId: row.id, name: row.name });
  };

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-black text-foreground">الموظفون والصلاحيات</h1>
          <p className="mt-1 text-sm font-semibold text-muted">
            حسابات PIN بأدوار واضحة وحدود تشغيلية لكل موظف
          </p>
        </div>
        <button
          type="button"
          onClick={() => setModal({ open: true })}
          disabled={!roles?.length}
          className="flex items-center gap-2 rounded-xl bg-primary px-5 py-3 text-base font-black text-primary-foreground shadow-sm transition hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          <UserPlus className="h-5 w-5" />
          إضافة موظف
        </button>
      </header>

      <section className="flex items-center gap-4 rounded-2xl border border-border bg-surface p-5 shadow-sm">
        <div className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-slate-900 text-sky-400">
          <ShieldCheck className="h-7 w-7" />
        </div>
        <div className="min-w-0">
          <p className="text-lg font-black text-foreground">{owner?.name ?? "مالك المتجر"}</p>
          <p className="flex items-center gap-1.5 text-sm font-semibold text-muted">
            <Mail className="h-4 w-4" />
            {owner?.email ?? "—"}
          </p>
        </div>
        <div className="ms-auto shrink-0">
          <span className="rounded-full bg-primary/10 px-3 py-1.5 text-xs font-black text-primary">
            مالك المتجر — يدخل بالبريد الإلكتروني وكلمة المرور
          </span>
        </div>
      </section>

      <section className="overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
        <div className="flex flex-col gap-3 border-b border-border px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="text-base font-black text-foreground">فريق المتجر</h2>
          <SearchInput
            value={q}
            onChange={setQ}
            placeholder="ابحث بالاسم أو اسم المستخدم…"
            className="sm:w-64"
          />
        </div>
        <div className="scrollbar-hidden overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-muted text-right text-xs font-black text-muted">
                <th className="px-5 py-3">الاسم</th>
                <th className="px-5 py-3">اسم المستخدم</th>
                <th className="px-5 py-3">الدور</th>
                <th className="px-5 py-3">الحالة</th>
                <th className="px-5 py-3 text-left">إجراءات</th>
              </tr>
            </thead>
            <tbody>
              {cashiers === null ? (
                <tr>
                  <td colSpan={5} className="px-5 py-10 text-center">
                    <Loader2 className="mx-auto mb-2 h-6 w-6 animate-spin text-muted" />
                    <p className="text-sm font-semibold text-muted">جارٍ التحميل…</p>
                  </td>
                </tr>
              ) : cashiers.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-5 py-10 text-center">
                    <Users className="mx-auto mb-2 h-8 w-8 text-muted" />
                    <p className="text-sm font-bold text-foreground">لا يوجد موظفون بعد</p>
                    <p className="mt-1 text-xs font-semibold text-muted">
                      أضف أول موظف واختر دوره ثم سلّمه رمز PIN الخاص به
                    </p>
                  </td>
                </tr>
              ) : filteredCashiers !== null && filteredCashiers.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-5 py-10 text-center text-sm font-semibold text-muted">
                    لا يوجد موظف مطابق للبحث
                  </td>
                </tr>
              ) : (
                (filteredCashiers ?? []).map((c) => (
                  <tr
                    key={c.id}
                    className={`border-b border-border/60 text-right ${c.isActive === false ? "opacity-60" : ""}`}
                  >
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-3">
                        <div className="grid h-9 w-9 place-items-center rounded-full bg-surface-muted text-muted">
                          <UserRound className="h-4 w-4" />
                        </div>
                        <span className="font-bold text-foreground">{c.name}</span>
                      </div>
                    </td>
                    <td className="px-5 py-3.5" dir="ltr">
                      <span className="font-bold text-muted">{c.username ?? "—"}</span>
                    </td>
                    <td className="px-5 py-3.5">
                      <span className="flex w-fit items-center gap-1.5 rounded-full bg-surface-muted px-2.5 py-1 text-xs font-black text-muted">
                        <UserRound className="h-3.5 w-3.5" />
                        {c.roleName ?? c.role}
                      </span>
                    </td>
                    <td className="px-5 py-3.5">
                      {c.isActive === false ? (
                        <span className="flex w-fit items-center gap-1.5 rounded-full bg-destructive/10 px-2.5 py-1 text-xs font-black text-destructive">
                          موقوف
                        </span>
                      ) : (
                        <span className="flex w-fit items-center gap-1.5 rounded-full bg-success/10 px-2.5 py-1 text-xs font-black text-success">
                          نشط
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-3.5">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => setModal({ open: true, editing: c })}
                          className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-black text-muted transition hover:bg-surface-muted"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                          تعديل
                        </button>
                        <button
                          type="button"
                          onClick={() => handleResetPin(c)}
                          title="إعادة تعيين رمز PIN"
                          className="flex items-center gap-1.5 rounded-lg border border-primary/30 px-3 py-1.5 text-xs font-black text-primary transition hover:bg-primary/10"
                        >
                          <KeyRound className="h-3.5 w-3.5" />
                          إعادة الرمز
                        </button>
                        <button
                          type="button"
                          onClick={() => handleToggleStatus(c)}
                          title={c.isActive === false ? "تفعيل الحساب" : "إيقاف الحساب"}
                          className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-black transition ${
                            c.isActive === false
                              ? "border-success/40 text-success hover:bg-success/10"
                              : "border-destructive/30 text-destructive hover:bg-destructive/10"
                          }`}
                        >
                          <Power className="h-3.5 w-3.5" />
                          {c.isActive === false ? "تفعيل" : "إيقاف"}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDelete(c)}
                          className="flex items-center gap-1.5 rounded-lg border border-destructive/30 px-3 py-1.5 text-xs font-black text-destructive transition hover:bg-destructive/10"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          حذف
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <footer className="flex items-center justify-between border-t border-border px-5 py-3 text-xs font-semibold text-muted">
          <span className="flex items-center gap-1.5">
            <Users className="h-3.5 w-3.5" />
            إجمالي الموظفين: {cashiers?.length ?? "…"}
            {filteredCashiers !== null && debouncedQ && (
              <span> • النتائج: {filteredCashiers.length}</span>
            )}
          </span>
          <span>أي تغيير يتطلب كلمة مرور مالك المتجر</span>
        </footer>
      </section>

      {loadError && (
        <p className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm font-bold text-destructive">
          {loadError}
          {sessionExpired && (
            <Link href="/login" className="ms-2 underline underline-offset-2">
              تسجيل الدخول
            </Link>
          )}
        </p>
      )}

      {modal.open && (
        <StaffModal
          onClose={() => setModal({ open: false })}
          onSave={handleSave}
          initial={modal.editing}
          roles={roles ?? []}
          mode={modal.mode ?? "full"}
        />
      )}

      <SecondaryAuthModal />
    </div>
  );
}
