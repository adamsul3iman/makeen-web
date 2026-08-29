"use client";

import { useState } from "react";
import { KeyRound, UserPlus, X } from "lucide-react";
import { Select } from "@/components/ui/Select";

export interface StaffFormPayload {
  id?: string;
  name: string;
  role: string;
  roleId: string;
  pin: string;
  username?: string;
}

export interface StaffRoleOption {
  id: string;
  code: string;
  name: string;
  description: string;
  capabilities: string[];
  limits: Record<string, number | null>;
  isSystem?: boolean;
}

/** Employee PIN, role and sign-in username. The owner remains a separate account. */
export default function StaffModal({
  onClose,
  onSave,
  initial,
  roles,
  mode = "full",
}: {
  onClose: () => void;
  onSave: (payload: StaffFormPayload) => void;
  initial?: {
    id?: string;
    name: string;
    role: string;
    roleId?: string | null;
    username?: string;
  };
  roles: StaffRoleOption[];
  mode?: "full" | "pin";
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [username, setUsername] = useState(initial?.username ?? "");
  const [pin, setPin] = useState("");
  const [roleId, setRoleId] = useState(
    initial?.roleId ?? roles.find((role) => role.code === initial?.role)?.id ?? roles[0]?.id ?? "",
  );
  const [error, setError] = useState("");

  const isEdit = Boolean(initial?.id);
  const isPinOnly = mode === "pin";
  const pinValid = /^\d{4}$/.test(pin) || (isEdit && pin.length === 0 && !isPinOnly);
  const selectedRole = roles.find((role) => role.id === roleId);
  const canSave =
    (isPinOnly || name.trim().length > 0) && pinValid && (isPinOnly || Boolean(selectedRole));

  const handleSave = () => {
    if (!isPinOnly && !name.trim()) {
      setError("أدخل اسم الموظف");
      return;
    }
    if (!pinValid) {
      setError(isPinOnly ? "أدخل رمز PIN جديد مكوّن من 4 أرقام" : "رمز PIN يجب أن يكون 4 أرقام");
      return;
    }
    if (!isPinOnly && !selectedRole) {
      setError("اختر دور الموظف");
      return;
    }
    onSave({
      id: initial?.id,
      name: name.trim(),
      role: selectedRole?.code ?? initial?.role ?? "",
      roleId: selectedRole?.id ?? initial?.roleId ?? "",
      pin,
      ...(isPinOnly || username.trim() ? { username: username.trim() } : {}),
    });
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
      dir="rtl"
    >
      <div className="flex max-h-[92vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl bg-surface shadow-2xl">
        <header className="flex items-center justify-between border-b border-border px-5 py-4">
          <div className="flex items-center gap-2">
            <UserPlus className="h-5 w-5 text-primary" />
            <h2 className="text-lg font-black text-foreground">
              {isPinOnly ? "إعادة تعيين رمز PIN" : isEdit ? "تعديل موظف" : "إضافة موظف"}
            </h2>
          </div>
          <button
            type="button"
            aria-label="إغلاق"
            onClick={onClose}
            className="grid h-9 w-9 place-items-center rounded-lg text-muted transition hover:bg-surface-muted"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-5">
          {isPinOnly ? (
            <div className="rounded-xl border border-primary/20 bg-primary/5 px-4 py-3">
              <p className="text-sm font-bold text-foreground">{initial?.name ?? "الموظف"}</p>
              <p className="mt-0.5 text-xs font-semibold text-muted">
                {initial?.username ? `اسم المستخدم: ${initial.username}` : ""}
              </p>
              <p className="mt-2 text-xs font-semibold text-muted">
                سيتم إبطال الرمز القديم فوراً، وسجّل دخول الموظف بالرمز الجديد فقط.
              </p>
            </div>
          ) : (
            <>
              <div>
                <label htmlFor="staff-name" className="mb-1.5 block text-sm font-bold text-muted">
                  اسم الموظف
                </label>
                <input
                  id="staff-name"
                  autoFocus
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    setError("");
                  }}
                  placeholder="مثال: سندس"
                  className="w-full rounded-xl border border-border bg-white px-4 py-3 text-base font-bold outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
                />
              </div>

              <div>
                <label htmlFor="staff-username" className="mb-1.5 block text-sm font-bold text-muted">
                  اسم المستخدم <span className="font-semibold text-muted/70">(للدخول من شاشة تسجيل الدخول)</span>
                </label>
                <input
                  id="staff-username"
                  value={username}
                  onChange={(e) => {
                    setUsername(e.target.value);
                    setError("");
                  }}
                  dir="ltr"
                  placeholder={isEdit ? "اتركه فارغاً للاحتفاظ بالحالي" : "اختياري — يُولَّد تلقائياً من الاسم"}
                  className="w-full rounded-xl border border-border bg-white px-4 py-3 text-base font-bold outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
                />
                <p className="mt-1 text-xs font-semibold text-muted">
                  أحرف وأرقام و _-. فقط، ويجب أن يكون فريداً داخل المتجر.
                </p>
              </div>
            </>
          )}

          <div>
            <label htmlFor="staff-pin" className="mb-1.5 block text-sm font-bold text-muted">
              {isPinOnly ? "رمز PIN الجديد (4 أرقام)" : `رمز PIN (4 أرقام)${isEdit ? " • اختياري عند التعديل" : ""}`}
            </label>
            <input
              id="staff-pin"
              value={pin}
              onChange={(e) => {
                setPin(e.target.value.replace(/\D/g, "").slice(0, 4));
                setError("");
              }}
              inputMode="numeric"
              dir="ltr"
              autoFocus={isPinOnly}
              placeholder="••••"
              className="w-full rounded-xl border border-border bg-white px-4 py-3 text-center text-2xl font-black tabular-nums tracking-[0.5em] outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
            />
            {pin.length > 0 && !pinValid && (
              <p className="mt-1 text-xs font-bold text-destructive">
                يجب أن يتكون الرمز من 4 أرقام
              </p>
            )}
            {isEdit && !isPinOnly && pin.length === 0 && (
              <p className="mt-1 text-xs font-semibold text-muted">
                اتركه فارغاً للاحتفاظ بالرمز الحالي.
              </p>
            )}
          </div>

          {!isPinOnly && (
<div>
            <span
              id="staff-role-label"
              className="mb-1.5 block text-sm font-bold text-muted"
            >
              الدور الوظيفي
            </span>
            <Select
              value={roleId}
              onChange={(roleIdValue) => {
                setRoleId(roleIdValue);
                setError("");
              }}
              options={roles.map((role) => ({ value: role.id, label: role.name }))}
              placeholder="اختر الدور"
              aria-label="الدور الوظيفي"
              className="w-full"
            />
            {selectedRole && (
              <div className="mt-2 rounded-xl border border-primary/20 bg-primary/5 px-4 py-3">
                <p className="text-sm font-bold text-foreground">{selectedRole.description}</p>
                <div className="mt-2 flex flex-wrap gap-2 text-xs font-black">
                  <span className="rounded-full bg-white px-2.5 py-1 text-muted shadow-sm">
                    {selectedRole.capabilities.length} صلاحية
                  </span>
                  <span className="rounded-full bg-white px-2.5 py-1 text-muted shadow-sm">
                    حد الخصم {selectedRole.limits.maxDiscountPercent ?? 0}%
                  </span>
                  <span className="rounded-full bg-white px-2.5 py-1 text-muted shadow-sm">
                    {selectedRole.capabilities.includes("backoffice.access")
                      ? "يدخل لوحة التحكم"
                      : "نقطة البيع فقط"}
                  </span>
                </div>
              </div>
            )}
          </div>
          )}

          {error && (
            <p className="text-sm font-bold text-destructive" aria-live="polite">
              {error}
            </p>
          )}
        </div>

        <footer className="flex items-center justify-end gap-3 border-t border-border px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            className="h-12 rounded-xl border border-border bg-white px-6 text-base font-black text-muted transition hover:bg-surface-muted"
          >
            إلغاء
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!canSave}
            className="flex h-12 items-center justify-center gap-2 rounded-xl bg-success px-8 text-base font-black text-success-foreground shadow-sm transition hover:bg-success-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            <KeyRound className="h-5 w-5" />
            {isPinOnly ? "تعيين الرمز" : isEdit ? "حفظ التعديل" : "حفظ"}
          </button>
        </footer>
      </div>
    </div>
  );
}
