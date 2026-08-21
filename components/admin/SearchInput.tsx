"use client";

import { Search, X } from "lucide-react";

interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}

/** Debounce-agnostic Arabic-friendly search field. Pair with
 * `useDebouncedValue` on the parent so expensive filtering stays off the
 * per-keystroke critical path. */
export function SearchInput({
  value,
  onChange,
  placeholder = "بحث…",
  className = "",
}: SearchInputProps) {
  return (
    <div className={`relative ${className}`}>
      <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-xl border border-border bg-white ps-9 pe-9 py-2.5 text-sm font-bold outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
      />
      {value && (
        <button
          type="button"
          aria-label="مسح البحث"
          onClick={() => onChange("")}
          className="absolute end-2 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-full text-muted transition hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
