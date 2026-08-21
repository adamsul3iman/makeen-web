"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Loader2, Search } from "lucide-react";
import { normalizeArabicText } from "@/lib/arabic";
import { posFetch } from "@/lib/tenantClient";

export interface AsyncProductOption {
  id: string;
  name: string;
  baseUnit: string;
  stock: number;
  barcodes: Array<{
    barcode: string;
    variantLabel: string;
    unitName: string;
    multiplier: number;
  }>;
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
const SEARCH_HEADER_HEIGHT = 57;
const OPTION_ROW_HEIGHT = 44;
const LIST_PADDING = 8;
const DEBOUNCE_MS = 250;

/**
 * Server-side search combobox for products.
 * Does NOT load all products on mount — fires a debounced fetch to
 * `/api/catalog/products/search?q=...` only when the user types.
 * Returns at most 15 results to keep the DOM lightweight.
 */
export default function AsyncProductCombobox({
  id,
  label,
  value,
  selectedLabel,
  placeholder,
  required = false,
  disabled = false,
  autoFocus = false,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  selectedLabel?: string;
  placeholder: string;
  required?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  onChange: (product: AsyncProductOption) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<AsyncProductOption[]>([]);
  const [searching, setSearching] = useState(false);
  const [position, setPosition] = useState<DropdownPosition | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchProducts = useCallback(async (q: string) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setSearching(true);
    try {
      const params = new URLSearchParams({ limit: "15" });
      if (q.trim()) params.set("q", q.trim());
      const res = await posFetch(`/api/catalog/products/search?${params}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!res.ok) return;
      const data = (await res.json()) as { products?: AsyncProductOption[] };
      if (Array.isArray(data.products)) setOptions(data.products);
    } catch {
      // aborted or network error — silently ignore
    } finally {
      setSearching(false);
    }
  }, []);

  const handleQueryChange = useCallback(
    (value: string) => {
      setQuery(value);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => void fetchProducts(value), DEBOUNCE_MS);
    },
    [fetchProducts],
  );

  const computePosition = useCallback((): DropdownPosition | null => {
    const trigger = triggerRef.current;
    if (!trigger) return null;
    const rect = trigger.getBoundingClientRect();
    const viewportHeight = window.innerHeight;
    const spaceBelow = viewportHeight - rect.bottom - VIEWPORT_MARGIN;
    const spaceAbove = rect.top - VIEWPORT_MARGIN;
    const rows = Math.min(options.length, 5);
    const estimatedHeight =
      SEARCH_HEADER_HEIGHT + LIST_PADDING + rows * OPTION_ROW_HEIGHT;
    const base: DropdownPosition = { left: rect.left, width: rect.width };
    if (estimatedHeight <= spaceBelow) {
      return { ...base, top: rect.bottom + DROPDOWN_GAP, maxHeight: Math.max(200, spaceBelow) };
    }
    if (spaceAbove >= spaceBelow) {
      return { ...base, bottom: viewportHeight - rect.top + DROPDOWN_GAP, maxHeight: Math.max(200, spaceAbove) };
    }
    return { ...base, top: rect.bottom + DROPDOWN_GAP, maxHeight: Math.max(200, spaceBelow) };
  }, [options.length]);

  const handleToggle = useCallback(() => {
    if (open) {
      setOpen(false);
      return;
    }
    setPosition(computePosition());
    setOpen(true);
    if (!options.length) void fetchProducts("");
  }, [open, computePosition, options.length, fetchProducts]);

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

  useEffect(() => {
    return () => {
      debounceRef.current && clearTimeout(debounceRef.current);
      abortRef.current?.abort();
    };
  }, []);

  return (
    <div ref={rootRef} className="relative min-w-0" dir="rtl">
      <label id={`${id}-label`} className="mb-1.5 block text-sm font-bold text-muted">
        {label}{required && <span className="text-destructive"> *</span>}
      </label>
      <button
        id={id}
        ref={triggerRef}
        type="button"
        aria-labelledby={`${id}-label`}
        aria-haspopup="listbox"
        aria-expanded={open}
        autoFocus={autoFocus}
        disabled={disabled}
        onClick={handleToggle}
        className="flex h-11 w-full items-center justify-between gap-2 rounded-lg border border-border bg-white px-3 text-right text-sm font-bold outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span className={`min-w-0 flex-1 truncate ${selectedLabel ? "text-foreground" : "text-muted"}`}>
          {selectedLabel || placeholder}
        </span>
        <ChevronDown className={`h-4 w-4 shrink-0 text-muted transition ${open ? "rotate-180" : ""}`} />
      </button>

      {open && position &&
        createPortal(
          <div
            ref={listRef}
            className="fixed z-[70]"
            style={{ top: position.top, bottom: position.bottom, left: position.left, width: position.width }}
          >
            <div
              className="flex flex-col overflow-hidden rounded-lg border border-border bg-white shadow-xl"
              style={{ maxHeight: position.maxHeight }}
            >
              <div className="shrink-0 border-b border-border p-2">
                <div className="flex items-center gap-2 rounded-md bg-surface-muted px-2.5">
                  {searching ? (
                    <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
                  ) : (
                    <Search className="h-4 w-4 shrink-0 text-muted" />
                  )}
                  <input
                    ref={searchRef}
                    value={query}
                    onChange={(event) => handleQueryChange(event.target.value)}
                    placeholder={`ابحث عن منتج بالاسم أو المعرّف...`}
                    className="h-10 min-w-0 flex-1 bg-transparent text-sm font-bold outline-none"
                  />
                </div>
              </div>
              <div
                role="listbox"
                aria-labelledby={`${id}-label`}
                className="min-h-0 max-h-56 flex-1 overflow-y-auto p-1.5"
              >
                {!required && (
                  <button
                    type="button"
                    role="option"
                    aria-selected={!value}
                    onClick={() => {
                      onChange({ id: "", name: "", baseUnit: "", stock: 0, barcodes: [] });
                      setOpen(false);
                      setQuery("");
                    }}
                    className="flex min-h-10 w-full items-center gap-2 rounded-md px-2.5 py-2 text-right text-sm font-bold text-muted transition hover:bg-surface-muted"
                  >
                    <Check className={`h-4 w-4 shrink-0 text-primary ${!value ? "opacity-100" : "opacity-0"}`} />
                    بدون اختيار
                  </button>
                )}
                {options.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    role="option"
                    aria-selected={option.id === value}
                    onClick={() => {
                      onChange(option);
                      setOpen(false);
                      setQuery("");
                    }}
                    className="flex min-h-10 w-full items-center gap-2 rounded-md px-2.5 py-2 text-right transition hover:bg-surface-muted"
                  >
                    <Check className={`h-4 w-4 shrink-0 text-primary ${option.id === value ? "opacity-100" : "opacity-0"}`} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-black text-foreground">{option.name}</span>
                      <span className="block truncate text-xs font-semibold text-muted">
                        {new Intl.NumberFormat("ar-JO", { maximumFractionDigits: 3 }).format(option.stock)} {option.baseUnit}
                      </span>
                    </span>
                  </button>
                ))}
                {options.length === 0 && !searching && (
                  <p className="px-3 py-5 text-center text-sm font-bold text-muted">
                    {query.trim() ? "لا توجد نتائج — جرّب كلمة أخرى" : "ابحث عن منتج"}
                  </p>
                )}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
