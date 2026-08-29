"use client";

import { useState } from "react";
import { KeyRound, PlusCircle, ShieldCheck, Trash2, X } from "lucide-react";
import { cn } from "@/lib/cn";
import type { StaffRoleOption } from "@/components/admin/StaffModal";
import type { RoleDraft } from "@/lib/staffClient";
import {
  CAPABILITY_GROUPS,
  CAPABILITY_LABELS,
  ROLE_LIMIT_FIELDS,
  type RoleLimitKey,
} from "./capabilities";

export interface RoleEditorModalProps {
  /** Existing role to edit, or `null` to create a new one. */
  initial?: StaffRoleOption | null;
  /** All roles known to the store — used to suggest a free code when creating. */
  roles: StaffRoleOption[];
  onClose: () => void;
  onSave: (draft: RoleDraft) => void;
  onDelete: (role: StaffRoleOption) => void;
}

function suggestRoleCode(roles: StaffRoleOption[]): string {
  const taken = new Set(roles.map((role) => role.code));
  let candidate = "custom_role";
  let n = 2;
  while (taken.has(candidate)) {
    candidate = `custom_role_${n}`;
    n += 1;
  }
  return candidate;
}

function PermissionToggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-surface-muted/60">
      <span className="min-w-0 text-sm font-bold text-foreground">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative h-6 w-11 shrink-0 rounded-full transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-primary/30",
          checked ? "bg-success" : "bg-border",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-all duration-200",
            checked ? "start-[calc(100%-1.375rem)]" : "start-0.5",
          )}
        />
      </button>
    </label>
  );
}

export default function RoleEditorModal({
  initial,
  roles,
  onClose,
  onSave,
  onDelete,
}: RoleEditorModalProps) {
  const isNew = !initial?.id;
  const isSystem = Boolean(initial?.isSystem);

  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [code, setCode] = useState(() => initial?.code ?? suggestRoleCode(roles));
  const [caps, setCaps] = useState<Record<string, boolean>>(() => {
    const map: Record<string, boolean> = {};
    CAPABILITY_GROUPS.forEach((group) =>
      group.capabilities.forEach((cap) => {
        map[cap] = initial?.capabilities.includes(cap) ?? false;
      }),
    );
    return map;
  });
  const [limits, setLimits] = useState<Record<RoleLimitKey, string>>(() => {
    const map = {} as Record<RoleLimitKey, string>;
    ROLE_LIMIT_FIELDS.forEach((field) => {
      const raw = initial?.limits?.[field.key];
      map[field.key] = typeof raw === "number" ? String(raw) : "";
    });
    return map;
  });
  const [error, setError] = useState("");

  const codeValid = isNew ? /^[a-z][a-z0-9_]*$/.test(code.trim()) : true;
  const allCapabilities = CAPABILITY_GROUPS.flatMap((group) => group.capabilities);
  const enabledCount = allCapabilities.filter((cap) => caps[cap]).length;

  const toggleCapability = (cap: string) => {
    setCaps((current) => ({ ...current, [cap]: !current[cap] }));
    setError("");
  };

  const toggleGroup = (group: (typeof CAPABILITY_GROUPS)[number]) => {
    const allOn = group.capabilities.every((cap) => caps[cap]);
    setCaps((current) => {
      const next = { ...current };
      group.capabilities.forEach((cap) => {
        next[cap] = !allOn;
      });
      return next;
    });
    setError("");
  };

  const handleSave = () => {
    if (!name.trim()) {
      setError("أدخل اسم الدور");
      return;
    }
    if (isNew && !codeValid) {
      setError("رمز الدور — أحرف لاتينية صغيرة وأرقام و _ فقط");
      return;
    }
    const limitsForSave: Record<string, number | null> = { ...(initial?.limits ?? {}) };
    ROLE_LIMIT_FIELDS.forEach((field) => {
      const parsed = Number.parseFloat(limits[field.key].replace(",", "."));
      limitsForSave[field.key] = Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
    });
    onSave({
      id: initial?.id,
      code: code.trim(),
      name: name.trim(),
      description: description.trim() || undefined,
      capabilities: [...allCapabilities.filter((cap) => caps[cap])],
      limits: limitsForSave,
    });
  };

  const handleDelete = () => {
    if (!initial) return;
    if (!window.confirm(`هل أنت متأكد من حذف دور «${initial.name}»؟`)) return;
    onDelete(initial);
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
      dir="rtl"
    >
      <div className="flex max-h-[94vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-surface shadow-elevated">
        <header className="flex items-center justify-between border-b border-border px-5 py-4">
          <div className="flex items-center gap-2 min-w-0">
            <ShieldCheck className="h-5 w-5 shrink-0 text-primary" />
            <div className="min-w-0">
              <h2 className="text-lg font-black text-foreground">
                {isNew ? "دور جديد" : `تعديل دور ${initial?.name ?? ""}`}
              </h2>
              <p className="text-xs font-semibold text-muted">
                {isSystem ? "دور النظام — الرمز البرمجي محمي" : "دور مخصص للمتجر"}
              </p>
            </div>
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

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="role-name" className="mb-1.5 block text-sm font-bold text-muted">
                اسم الدور
              </label>
              <input
                id="role-name"
                autoFocus={isNew}
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  setError("");
                }}
                placeholder="مثال: مشرف مبيعات"
                className="w-full rounded-xl border border-border bg-white px-4 py-3 text-base font-bold outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
              />
            </div>
            <div>
              <label htmlFor="role-desc" className="mb-1.5 block text-sm font-bold text-muted">
                الوصف
              </label>
              <input
                id="role-desc"
                value={description}
                onChange={(event) => {
                  setDescription(event.target.value);
                  setError("");
                }}
                placeholder="مثال: بيع مع خصم حتى 15% دون مراجعة"
                className="w-full rounded-xl border border-border bg-white px-4 py-3 text-base font-bold outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
              />
            </div>
          </div>

          <div>
            <label htmlFor="role-code" className="mb-1.5 block text-sm font-bold text-muted">
              الرمز البرمجي
            </label>
            {isNew ? (
              <input
                id="role-code"
                value={code}
                onChange={(event) => {
                  setCode(event.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""));
                  setError("");
                }}
                dir="ltr"
                placeholder="cashier_supervisor"
                className="w-full rounded-xl border border-border bg-white px-4 py-3 text-base font-black text-center tracking-wide outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
              />
            ) : (
              <div
                className="flex w-full items-center justify-center rounded-xl border border-border bg-surface-muted px-4 py-3 text-base font-black tabular-nums"
                dir="ltr"
              >
                {initial?.code}
              </div>
            )}
            <p className="mt-1 text-xs font-semibold text-muted">
              {isNew
                ? "أحرف لاتينية صغيرة وأرقام و _ فقط — لا يمكن تغييره بعد الإنشاء."
                : "رمز الدور ثابت بعد الإنشاء، وتغييره يتطلب إنشاء دور جديد."}
            </p>
          </div>

          <div>
            <p className="mb-1.5 text-sm font-bold text-muted">حدود التشغيل المالية</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {ROLE_LIMIT_FIELDS.map((field) => (
                <label
                  key={field.key}
                  className="rounded-xl border border-border bg-white px-3 py-2 focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/20"
                >
                  <span className="text-xs font-bold text-muted">{field.label}</span>
                  <div className="mt-0.5 flex items-center gap-2">
                    <input
                      type="number"
                      min={0}
                      inputMode="decimal"
                      dir="ltr"
                      value={limits[field.key]}
                      onChange={(event) => {
                        setLimits((current) => ({
                          ...current,
                          [field.key]: event.target.value,
                        }));
                        setError("");
                      }}
                      placeholder="—"
                      className="w-full min-w-0 bg-transparent text-base font-black tabular-nums outline-none"
                    />
                    <span className="shrink-0 text-xs font-bold text-muted">{field.suffix}</span>
                  </div>
                </label>
              ))}
            </div>
            <p className="mt-1.5 text-xs font-semibold text-muted">
              ترك الحقل فارغاً يعني رفض المبلغ تماماً؛ صفر يعني عدم السماح به.
            </p>
          </div>

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <p className="text-sm font-bold text-muted">
                الصلاحيات <span className="font-semibold text-muted/70">({enabledCount})</span>
              </p>
            </div>
            <div className="space-y-3">
              {CAPABILITY_GROUPS.map((group) => {
                const groupOn = group.capabilities.every((cap) => caps[cap]);
                const groupCount = group.capabilities.filter((cap) => caps[cap]).length;
                return (
                  <div
                    key={group.id}
                    className="overflow-hidden rounded-xl border border-border bg-white"
                  >
                    <button
                      type="button"
                      onClick={() => toggleGroup(group)}
                      className="flex w-full items-center justify-between gap-2 border-b border-border/60 bg-surface-muted/50 px-3 py-2 text-sm font-black text-foreground transition hover:bg-surface-muted"
                    >
                      <span className="flex items-center gap-2">
                        <PlusCircle
                          className={cn(
                            "h-4 w-4 transition-transform",
                            !groupOn && "rotate-45 text-muted",
                          )}
                        />
                        {group.label}
                      </span>
                      <span className="text-xs font-bold text-muted">
                        {groupCount}/{group.capabilities.length}
                      </span>
                    </button>
                    <div className="grid grid-cols-1 divide-y divide-border/40 sm:grid-cols-2 sm:divide-x sm:divide-y-0">
                      {group.capabilities.map((cap) => (
                        <PermissionToggle
                          key={cap}
                          label={CAPABILITY_LABELS[cap]}
                          checked={caps[cap] || false}
                          onChange={() => toggleCapability(cap)}
                        />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {error && (
            <p className="text-sm font-bold text-destructive" aria-live="polite">
              {error}
            </p>
          )}
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-border px-5 py-4">
          {initial && !isSystem ? (
            <button
              type="button"
              onClick={handleDelete}
              className="flex h-12 items-center justify-center gap-2 rounded-xl border border-destructive/30 px-4 text-base font-black text-destructive transition hover:bg-destructive/10"
            >
              <Trash2 className="h-5 w-5" />
              حذف الدور
            </button>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-3">
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
              disabled={!name.trim() || (isNew && !codeValid)}
              className="flex h-12 items-center justify-center gap-2 rounded-xl bg-success px-8 text-base font-black text-white shadow-sm transition hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <KeyRound className="h-5 w-5" />
              حفظ الدور
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}