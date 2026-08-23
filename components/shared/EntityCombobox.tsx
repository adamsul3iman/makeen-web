"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Plus, Search } from "lucide-react";
import { normalizeArabicText } from "@/lib/arabic";

export interface EntityOption {
  id: string;
  name: string;
  description?: string;
}

interface DropdownPosition {
  top?: number;
  bottom?: number;
  left: number;
  width: number;
  maxHeight?: number;
}

const DROPDOWN_GAP = 4;
const VIEWPORT_MARGIN = 8;
const MIN_LIST_HEIGHT = 120;
const SEARCH_HEADER_HEIGHT = 57;
const ADD_FOOTER_HEIGHT = 58;
const OPTION_ROW_HEIGHT = 44;
const LIST_PADDING = 8;

export default function EntityCombobox({
  id,
  label,
  value,
  options,
  placeholder,
  emptyLabel = "لا توجد نتائج",
  addLabel,
  onChange,
  onAdd,
  disabled = false,
  required = false,
  autoFocus = false,
  size = "md",
}: {
  id: string;
  /** Optional — omitted renders a compact, label-less control (filter bars). */
  label?: string;
  value: string;
  options: EntityOption[];
  placeholder: string;
  emptyLabel?: string;
  addLabel?: string;
  onChange: (id: string) => void;
  onAdd?: (draftQuery?: string) => void;
  disabled?: boolean;
  required?: boolean;
  autoFocus?: boolean;
  size?: "sm" | "md";
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [position, setPosition] = useState<DropdownPosition | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const selected = options.find((option) => option.id === value);

  const filtered = useMemo(() => {
    const needle = normalizeArabicText(query.trim());
    if (!needle) return options;
    return options.filter((option) =>
      normalizeArabicText(`${option.name} ${option.description ?? ""}`).includes(needle),
    );
  }, [options, query]);

  const computePosition = useCallback((): DropdownPosition | null => {
    const trigger = triggerRef.current;
    if (!trigger) return null;
    const rect = trigger.getBoundingClientRect();
    const viewportHeight = window.innerHeight;
    const spaceBelow = viewportHeight - rect.bottom - VIEWPORT_MARGIN;
    const spaceAbove = rect.top - VIEWPORT_MARGIN;

    // Estimate the rendered height (rows scroll inside a 224px listbox, so
    // only ~5 rows are ever visible before the inner list scrolls).
    const rows = Math.min(options.length, 5);
    const estimatedHeight =
      SEARCH_HEADER_HEIGHT + LIST_PADDING + rows * OPTION_ROW_HEIGHT + (onAdd ? ADD_FOOTER_HEIGHT : 0);

    const base: DropdownPosition = { left: rect.left, width: rect.width };
    if (estimatedHeight <= spaceBelow) {
      return { ...base, top: rect.bottom + DROPDOWN_GAP, maxHeight: Math.max(MIN_LIST_HEIGHT, spaceBelow) };
    }
    if (estimatedHeight <= spaceAbove) {
      return { ...base, bottom: viewportHeight - rect.top + DROPDOWN_GAP, maxHeight: Math.max(MIN_LIST_HEIGHT, spaceAbove) };
    }
    if (spaceAbove >= spaceBelow) {
      return { ...base, bottom: viewportHeight - rect.top + DROPDOWN_GAP, maxHeight: Math.max(MIN_LIST_HEIGHT, spaceAbove) };
    }
    return { ...base, top: rect.bottom + DROPDOWN_GAP, maxHeight: Math.max(MIN_LIST_HEIGHT, spaceBelow) };
  }, [options.length, onAdd]);

  const handleToggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    setPosition(computePosition());
    setOpen(true);
  };

  // Reposition on scroll/resize so the portaled list stays glued to the trigger.
  useEffect(() => {
    if (!open) return;
    const reposition = () => setPosition(computePosition());
    window.addEventListener("resize", reposition);
    document.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      document.removeEventListener("scroll", reposition, true);
    };
  }, [open, computePosition]);

  useEffect(() => {
    if (!open) return;
    const handlePointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !listRef.current?.contains(target)) setOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointer);
    document.addEventListener("keydown", handleKey);
    requestAnimationFrame(() => searchRef.current?.focus());
    return () => {
      document.removeEventListener("pointerdown", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative min-w-0" dir="rtl">
      {label ? (
        <label id={`${id}-label`} className="mb-1.5 block text-sm font-bold text-muted">
          {label}{required && <span className="text-destructive"> *</span>}
        </label>
      ) : null}
      <button
        id={id}
        ref={triggerRef}
        type="button"
        aria-label={label ? undefined : placeholder}
        aria-labelledby={label ? `${id}-label` : undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
        autoFocus={autoFocus}
        disabled={disabled}
        onClick={handleToggle}
        className={`flex w-full items-center justify-between gap-2 rounded-lg border border-border bg-white px-3 text-right font-bold outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-50 ${
          size === "sm" ? "h-9 text-xs" : "h-11 text-sm"
        }`}
      >
        <span className={`min-w-0 flex-1 truncate ${selected ? "text-foreground" : "text-muted"}`}>
          {selected?.name ?? placeholder}
        </span>
        <ChevronDown className={`h-4 w-4 shrink-0 text-muted transition ${open ? "rotate-180" : ""}`} />
      </button>

      {open && position &&
        createPortal(
          <div
            ref={listRef}
            className="fixed z-[85]"
            style={{ top: position.top, bottom: position.bottom, left: position.left, width: position.width }}
          >
            <div
              className="flex flex-col overflow-hidden rounded-lg border border-border bg-white shadow-xl"
              style={{ maxHeight: position.maxHeight }}
            >
              <div className="shrink-0 border-b border-border p-2">
                <div className="flex items-center gap-2 rounded-md bg-surface-muted px-2.5">
                  <Search className="h-4 w-4 shrink-0 text-muted" />
                  <input
                    ref={searchRef}
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={`ابحث في ${label ?? placeholder}`}
                    className="h-10 min-w-0 flex-1 bg-transparent text-sm font-bold outline-none"
                  />
                </div>
              </div>
              <div
                role="listbox"
                aria-label={label ?? placeholder}
                className="min-h-0 max-h-56 flex-1 overflow-y-auto p-1.5"
              >
                {!required && (
                  <button
                    type="button"
                    role="option"
                    aria-selected={!value}
                    onClick={() => {
                      onChange("");
                      setOpen(false);
                      setQuery("");
                    }}
                    className="flex min-h-10 w-full items-center gap-2 rounded-md px-2.5 py-2 text-right text-sm font-bold text-muted transition hover:bg-surface-muted"
                  >
                    <Check className={`h-4 w-4 shrink-0 text-primary ${!value ? "opacity-100" : "opacity-0"}`} />
                    بدون اختيار
                  </button>
                )}
                {filtered.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    role="option"
                    aria-selected={option.id === value}
                    onClick={() => {
                      onChange(option.id);
                      setOpen(false);
                      setQuery("");
                    }}
                    className="flex min-h-10 w-full items-center gap-2 rounded-md px-2.5 py-2 text-right transition hover:bg-surface-muted"
                  >
                    <Check className={`h-4 w-4 shrink-0 text-primary ${option.id === value ? "opacity-100" : "opacity-0"}`} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-black text-foreground">{option.name}</span>
                      {option.description && <span className="block truncate text-xs font-semibold text-muted">{option.description}</span>}
                    </span>
                  </button>
                ))}
                {filtered.length === 0 && (
                  <p className="px-3 py-5 text-center text-sm font-bold text-muted">{emptyLabel}</p>
                )}
              </div>
              {onAdd && addLabel && (
                <div className="shrink-0 border-t border-border p-2">
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      onAdd(query.trim());
                    }}
                    className="flex h-10 w-full items-center justify-center gap-2 rounded-md bg-primary/10 text-sm font-black text-primary transition hover:bg-primary/15"
                  >
                    <Plus className="h-4 w-4" />
                    {addLabel}
                  </button>
                </div>
              )}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
