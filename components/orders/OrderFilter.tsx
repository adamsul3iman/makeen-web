"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Filter, X } from "lucide-react";

export interface OrderFilterState {
  date: "all" | "today" | "yesterday" | "date";
  dateValue?: string; // yyyy-mm-dd when date === "date"
  status: "all" | "COMPLETED" | "CANCELLED";
}

export const EMPTY_FILTER: OrderFilterState = {
  date: "all",
  dateValue: undefined,
  status: "all",
};

function isFilterActive(f: OrderFilterState): boolean {
  return f.date !== "all" || f.status !== "all";
}

const STATUS_OPTIONS: { key: OrderFilterState["status"]; label: string }[] = [
  { key: "all", label: "الكل" },
  { key: "COMPLETED", label: "مكتمل" },
  { key: "CANCELLED", label: "ملغى" },
];

const DATE_OPTIONS: { key: OrderFilterState["date"]; label: string }[] = [
  { key: "all", label: "الكل" },
  { key: "today", label: "اليوم" },
  { key: "yesterday", label: "الأمس" },
  { key: "date", label: "تاريخ محدد" },
];

function FilterRow({
  children,
}: {
  children: React.ReactNode;
}) {
  return <div className="px-1.5">{children}</div>;
}

function filterChip(label: string, active: boolean, onClick: () => void) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 text-xs font-black transition ${
        active
          ? "bg-primary text-primary-foreground"
          : "border border-border bg-white text-muted hover:bg-surface-muted hover:text-foreground"
      }`}
    >
      {active && <Check className="h-3.5 w-3.5" />}
      {label}
    </button>
  );
}

export default function OrderFilter({
  value,
  onChange,
}: {
  value: OrderFilterState;
  onChange: (next: OrderFilterState) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent | TouchEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("touchstart", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("touchstart", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const active = isFilterActive(value);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label="تصفية الطلبات"
        title="تصفية الطلبات"
        className={`relative grid h-11 w-11 shrink-0 place-items-center rounded-xl border transition ${
          active
            ? "border-primary bg-primary/10 text-primary"
            : "border-border bg-white text-muted hover:bg-surface-muted hover:text-foreground"
        }`}
      >
        <Filter className="h-4.5 w-4.5" />
        {active && (
          <span className="absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-primary px-0.5 text-[10px] font-black text-primary-foreground">
            •
          </span>
        )}
      </button>

      {open && (
        <div className="absolute left-0 top-full z-30 mt-2 w-72 space-y-3 rounded-2xl border border-border bg-white p-3 shadow-card">
          <div className="flex items-center justify-between">
            <p className="text-xs font-black text-muted">تصفية الطلبات</p>
            <button
              type="button"
              onClick={() => onChange(EMPTY_FILTER)}
              className="flex h-7 items-center gap-1 rounded-md px-1.5 text-[11px] font-bold text-muted transition hover:bg-surface-muted hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
              إزالة الكل
            </button>
          </div>

          <FilterRow>
            <p className="mb-1.5 text-[11px] font-black text-muted">التاريخ</p>
            <div className="flex flex-wrap gap-1.5">
              {DATE_OPTIONS.map((o) =>
                filterChip(o.label, value.date === o.key, () =>
                  onChange({ ...value, date: o.key }),
                ),
              )}
            </div>
            {value.date === "date" && (
              <input
                type="date"
                value={value.dateValue ?? ""}
                onChange={(e) => onChange({ ...value, date: "date", dateValue: e.target.value })}
                className="mt-1.5 h-9 w-full rounded-lg border border-border bg-white px-2 text-xs font-bold outline-none focus:border-primary focus:ring-2 focus:ring-primary/30"
              />
            )}
          </FilterRow>

          <FilterRow>
            <p className="mb-1.5 text-[11px] font-black text-muted">الحالة</p>
            <div className="flex flex-wrap gap-1.5">
              {STATUS_OPTIONS.map((o) =>
                filterChip(o.label, value.status === o.key, () =>
                  onChange({ ...value, status: o.key }),
                ),
              )}
            </div>
          </FilterRow>
        </div>
      )}
    </div>
  );
}
