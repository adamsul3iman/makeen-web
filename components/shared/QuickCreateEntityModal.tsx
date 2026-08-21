"use client";

import { useState } from "react";
import { Loader2, Plus, X } from "lucide-react";
import EntityCombobox, { type EntityOption } from "@/components/shared/EntityCombobox";

export default function QuickCreateEntityModal({
  title,
  nameLabel,
  namePlaceholder,
  withPhone = false,
  initialName = "",
  parentOptions,
  parentLabel,
  parentPlaceholder = "بدون تصنيف أب",
  parentInitialValue = "",
  parentHint,
  onClose,
  onCreate,
}: {
  title: string;
  nameLabel: string;
  namePlaceholder: string;
  withPhone?: boolean;
  initialName?: string;
  parentOptions?: EntityOption[];
  parentLabel?: string;
  parentPlaceholder?: string;
  parentInitialValue?: string;
  parentHint?: string;
  onClose: () => void;
  onCreate: (data: { name: string; phone: string; parentId?: string | null }) => Promise<void> | void;
}) {
  const [name, setName] = useState(initialName);
  const [phone, setPhone] = useState("");
  const [parentId, setParentId] = useState(parentInitialValue);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const hasParentPicker = Boolean(parentLabel && parentOptions);

  const submit = async () => {
    if (!name.trim() || saving) return;
    setSaving(true);
    setError("");
    try {
      await onCreate({
        name: name.trim(),
        phone: phone.trim(),
        parentId: hasParentPicker ? parentId || null : undefined,
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "تعذر الحفظ");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/45 p-4"
      dir="rtl"
      onClick={(event) => {
        event.stopPropagation();
        onClose();
      }}
    >
      <form
        className="flex max-h-[85vh] w-full max-w-sm flex-col overflow-hidden rounded-lg bg-white shadow-2xl"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-base font-black text-foreground">{title}</h2>
          <button
            type="button"
            aria-label="إغلاق"
            onClick={onClose}
            className="grid h-9 w-9 place-items-center rounded-md text-muted hover:bg-surface-muted"
          >
            <X className="h-5 w-5" />
          </button>
        </header>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          <label className="block text-sm font-bold text-muted">
            {nameLabel} <span className="text-destructive">*</span>
            <input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={namePlaceholder}
              className="mt-1.5 h-11 w-full rounded-lg border border-border px-3 font-bold outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
          </label>

          {hasParentPicker && parentLabel && parentOptions && (
            <div>
              <EntityCombobox
                id="quick-create-parent"
                label={parentLabel}
                value={parentId}
                options={parentOptions}
                placeholder={parentPlaceholder}
                onChange={setParentId}
              />
              {parentHint && (
                <p className="mt-1 text-xs font-semibold text-muted">{parentHint}</p>
              )}
            </div>
          )}

          {withPhone && (
            <label className="block text-sm font-bold text-muted">
              رقم الهاتف (اختياري)
              <input
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                inputMode="tel"
                dir="ltr"
                placeholder="07xxxxxxxx"
                className="mt-1.5 h-11 w-full rounded-lg border border-border px-3 text-left font-bold outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
              />
            </label>
          )}

          {error && (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm font-bold text-destructive">
              {error}
            </p>
          )}
        </div>
        <footer className="flex gap-2 border-t border-border p-4">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="h-11 flex-1 rounded-lg border border-border text-sm font-black text-muted"
          >
            إلغاء
          </button>
          <button
            type="submit"
            disabled={!name.trim() || saving}
            className="flex h-11 flex-[2] items-center justify-center gap-2 rounded-lg bg-success text-sm font-black text-success-foreground disabled:opacity-40"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            {saving ? "جارٍ الحفظ..." : "إضافة واختيار"}
          </button>
        </footer>
      </form>
    </div>
  );
}
