"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  KeyRound,
  Loader2,
  Mail,
  Pencil,
  Power,
  ShieldCheck,
  Trash2,
  UserCog,
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
import RoleEditorModal from "@/components/admin/staff/RoleEditorModal";
import { PageHeader } from "@/components/ui/Card";
import KpiCard from "@/components/admin/dashboard/KpiCard";
import { SearchInput } from "@/components/admin/SearchInput";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { normalizeArabicText } from "@/lib/arabic";
import { fetchCashiers, fetchRoles, type RoleDraft, type StaffRole } from "@/lib/staffClient";

interface CashierRow {
  id: string;
  name: string;
  username?: string;
  role: string;
  roleId?: string | null;
  isActive?: boolean;
}

function toRoleOption(role: StaffRole): StaffRoleOption {
  return {
    id: role.id,
    code: role.code,
    name: role.name,
    description: role.description ?? "",
    capabilities: role.capabilities ?? [],
    limits: (role.limits ?? {}) as StaffRoleOption["limits"],
  };
}

/**
 * Back-office cashier + role management. Reads the safe roster through the
 * `list_cashiers_public` RPC and roles through the operator-granted SELECT on
 * staff_roles. Every mutation (cashier or role) is gated by the owner's
 * dashboard password through the proof-per-call RPCs (migrations 078 / 097).
 */
export default function AdminStaffPage() {
  const requestSecondaryAuth = usePosStore((s) => s.requestSecondaryAuth);
  const isSecondaryAuthOpen = usePosStore((s) => s.isSecondaryAuthOpen);
  const owner = usePosStore((s) => s.adminSession);

  const [cashiers, setCashiers] = useState<CashierRow[] | null>(null);
  const [roles, setRoles] = useState<StaffRoleOption[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [modal, setModal] = useState<{
    open: boolean;
    editing?: CashierRow;
    mode?: "full" | "pin";
  }>({ open: false });
  const [roleModal, setRoleModal] = useState<{
    open: boolean;
    role?: StaffRoleOption;
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

  const roleNameOf = useCallback(
    (c: CashierRow) => roles?.find((role) => role.id === c.roleId)?.name ?? c.role,
    [roles],
  );

  const membersByRole = useMemo(() => {
    const map: Record<string, number> = {};
    if (cashiers) {
      for (const c of cashiers) {
        const key = c.roleId ?? c.role;
        if (key) map[key] = (map[key] ?? 0) + 1;
      }
    }
    return map;
  }, [cashiers]);

  const loadRoster = useCallback(async (): Promise<{
    rows: CashierRow[] | null;
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
    (result: { rows: CashierRow[] | null; serverError?: string }) => {
      const { rows, serverError } = result;
      if (rows === null) {
        setCashiers(null);
        setLoadError(
          serverError
            ? `تعذر تحميل الكاشير — ${serverError}`
            : "تعذر تحميل الكاشير — تأكد من اتصال الشبكة ثم أعد المحاولة.",
        );
      } else {
        setCashiers(rows);
        setLoadError("");
      }
    },
    [],
  );

  const loadRolesData = useCallback(async (): Promise<{
    rows: StaffRoleOption[] | null;
    serverError?: string;
  }> => {
    try {
      const data = await fetchRoles();
      return { rows: data.map(toRoleOption) };
    } catch (err) {
      return {
        rows: null,
        serverError: err instanceof Error && err.message ? err.message : undefined,
      };
    }
  }, []);

  const applyRoles = useCallback(
    (result: { rows: StaffRoleOption[] | null; serverError?: string }) => {
      const { rows, serverError } = result;
      if (rows === null) {
        setRoles(null);
        setLoadError(
          serverError
            ? `تعذر تحميل الأدوار والصلاحيات — ${serverError}`
            : "تعذر تحميل الأدوار والصلاحيات — أعد المحاولة.",
        );
      } else {
        setRoles(rows);
        setLoadError("");
      }
    },
    [],
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
    loadRolesData().then((result) => {
      if (!cancelled) applyRoles(result);
    });
    return () => {
      cancelled = true;
    };
  }, [loadRolesData, applyRoles]);

  // Refresh once after a secondary-auth action (cashier or role) closes.
  const prevAuthOpen = useRef(false);
  useEffect(() => {
    const shouldRefresh = prevAuthOpen.current && !isSecondaryAuthOpen;
    prevAuthOpen.current = isSecondaryAuthOpen;
    if (!shouldRefresh) return;
    let cancelled = false;
    loadRoster().then((result) => {
      if (!cancelled) applyRoster(result);
    });
    loadRolesData().then((result) => {
      if (!cancelled) applyRoles(result);
    });
    return () => {
      cancelled = true;
    };
  }, [isSecondaryAuthOpen, loadRoster, applyRoster, loadRolesData, applyRoles]);

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

  const openNewRole = () => setRoleModal({ open: true });
  const openEditRole = (role: StaffRoleOption) => setRoleModal({ open: true, role });

  const handleSaveRole = (draft: RoleDraft) => {
    setRoleModal({ open: false });
    requestSecondaryAuth({ type: "save_role", role: draft });
  };

  const handleDeleteRole = (role: StaffRoleOption) => {
    setRoleModal({ open: false });
    requestSecondaryAuth({ type: "delete_role", roleId: role.id, name: role.name });
  };

  const totalStaff = cashiers === null ? null : cashiers.length;
  const activeStaff =
    cashiers === null ? null : cashiers.filter((c) => c.isActive !== false).length;
  const suspendedStaff =
    cashiers === null ? null : cashiers.filter((c) => c.isActive === false).length;

  const renderRoleList = () => {
    if (roles === null) {
      return (
        <div className="px-5 py-10 text-center">
          <Loader2 className="mx-auto mb-2 h-6 w-6 animate-spin text-muted" />
          <p className="text-sm font-semibold text-muted">جارٍ تحميل الأدوار…</p>
        </div>
      );
    }
    if (roles.length === 0) {
      return (
        <div className="px-5 py-10 text-center">
          <UserCog className="mx-auto mb-2 h-8 w-8 text-muted" />
          <p className="text-sm font-bold text-foreground">لا توجد أدوار بعد</p>
        </div>
      );
    }
    return (
      <div className="divide-y divide-border/60">
        {roles.map((role) => (
          <button
            key={role.id}
            type="button"
            onClick={() => openEditRole(role)}
            className="group flex w-full items-center gap-3 px-5 py-3.5 text-right transition hover:bg-surface-muted"
          >
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary transition group-hover:bg-primary/15">
              <UserCog className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate text-sm font-black text-foreground">{role.name}</span>
                {role.isSystem && (
                  <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-black text-primary">
                    نظام
                  </span>
                )}
              </div>
              <p className="mt-0.5 truncate text-xs font-semibold text-muted">
                {role.description || role.code}
              </p>
            </div>
            <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-surface-muted px-2.5 py-1 text-xs font-black text-muted">
              <Users className="h-3.5 w-3.5" />
              {membersByRole[role.id] ?? 0}
            </span>
            <span className="shrink-0 text-xs font-bold text-muted">
              {role.capabilities.length} صلاحية
            </span>
          </button>
        ))}
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="الموظفون والصلاحيات"
        subtitle="حسابات PIN بأدوار واضحة وحدود تشغيلية لكل موظف"
        action={
          <button
            type="button"
            onClick={() => setModal({ open: true })}
            disabled={!roles?.length}
            className="flex items-center gap-2 rounded-xl bg-primary px-5 py-3 text-base font-black text-primary-foreground shadow-sm transition hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            <UserPlus className="h-5 w-5" />
            إضافة موظف
          </button>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard
          label="إجمالي الموظفين"
          value={totalStaff === null ? "…" : String(totalStaff)}
          icon={Users}
          hint="حسابات نقطة البيع النشطة والموقوفة"
        />
        <KpiCard
          label="نشط"
          value={activeStaff === null ? "…" : String(activeStaff)}
          icon={UserRound}
          tone="success"
          hint="يستطيع تسجيل الدخول بالرمز"
        />
        <KpiCard
          label="موقوف"
          value={suspendedStaff === null ? "…" : String(suspendedStaff)}
          icon={Power}
          tone={(suspendedStaff ?? 0) > 0 ? "destructive" : "default"}
          hint="لا يستطيع تسجيل الدخول"
        />
        <KpiCard
          label="أدوار الصلاحيات"
          value={roles === null ? "…" : String(roles.length)}
          icon={ShieldCheck}
          tone="primary"
          hint="نظامية ومخصصة"
        />
      </div>

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

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)] xl:items-start">
        <section className="overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
          <div className="flex flex-col gap-3 border-b border-border px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
            <h2 className="flex items-center gap-2 text-sm font-black text-foreground">
              <UserRound className="h-4 w-4 text-primary" />
              فريق المتجر
            </h2>
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
                    <td
                      colSpan={5}
                      className="px-5 py-10 text-center text-sm font-semibold text-muted"
                    >
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
                          {roleNameOf(c)}
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

        <section className="overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
          <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-3.5">
            <h2 className="flex items-center gap-2 text-sm font-black text-foreground">
              <ShieldCheck className="h-4 w-4 text-primary" />
              الأدوار والصلاحيات
            </h2>
            <button
              type="button"
              onClick={openNewRole}
              className="flex items-center gap-1.5 rounded-lg border border-primary/30 px-3 py-1.5 text-xs font-black text-primary transition hover:bg-primary/10"
            >
              <UserCog className="h-3.5 w-3.5" />
              دور جديد
            </button>
          </header>
          {renderRoleList()}
          <footer className="border-t border-border bg-surface-muted/40 px-5 py-3 text-xs font-semibold text-muted">
            تغييرات الصلاحيات تسري على الموظف عند تسجيل الدخول التالي؛ أدوار النظام لا يمكن حذفها.
          </footer>
        </section>
      </div>

      {loadError && (
        <p className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm font-bold text-destructive">
          {loadError}
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

      {roleModal.open && (
        <RoleEditorModal
          initial={roleModal.role ?? null}
          roles={roles ?? []}
          onClose={() => setRoleModal({ open: false })}
          onSave={handleSaveRole}
          onDelete={handleDeleteRole}
        />
      )}

      <SecondaryAuthModal />
    </div>
  );
}