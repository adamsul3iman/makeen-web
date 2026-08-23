"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pin, PinOff, X } from "lucide-react";
import { usePosStore } from "@/store/usePosStore";
import { cn } from "@/lib/cn";
import type { LocalCategory } from "@/types/pos.types";

const MAX_PINS = 6;
const STORAGE_PREFIX = "pos-pinned-categories";

function storageKey(cashierId: string | undefined): string {
  return `${STORAGE_PREFIX}-${cashierId ?? "default"}`;
}

function loadPinned(cashierId: string | undefined): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(storageKey(cashierId));
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

function savePinned(cashierId: string | undefined, ids: string[]): void {
  try {
    localStorage.setItem(storageKey(cashierId), JSON.stringify(ids));
  } catch {}
}

export default function PinnedCategories() {
  const categories = usePosStore((s) => s.categories);
  const activeCategoryId = usePosStore((s) => s.activeCategoryId);
  const setActiveCategoryId = usePosStore((s) => s.setActiveCategoryId);
  const currentCashier = usePosStore((s) => s.currentCashier);

  const cashierId = currentCashier?.id;

  const [pinnedIds, setPinnedIds] = useState<string[]>(() => loadPinned(cashierId));
  const [editing, setEditing] = useState(false);
  const [showAddDropdown, setShowAddDropdown] = useState(false);
  const addDropdownRef = useRef<HTMLDivElement>(null);

  // Close add dropdown on outside click
  useEffect(() => {
    if (!showAddDropdown) return;
    const handler = (e: PointerEvent) => {
      if (!addDropdownRef.current?.contains(e.target as Node)) {
        setShowAddDropdown(false);
      }
    };
    document.addEventListener("pointerdown", handler);
    return () => document.removeEventListener("pointerdown", handler);
  }, [showAddDropdown]);

  // Sync pinned IDs to localStorage
  useEffect(() => {
    savePinned(cashierId, pinnedIds);
  }, [cashierId, pinnedIds]);

  // Auto-pin first 4 root categories on first load
  useEffect(() => {
    if (pinnedIds.length > 0) return;
    const cats = Object.values(categories) as LocalCategory[];
    const roots = cats
      .filter((c) => !c.parentId)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "ar"))
      .slice(0, 4)
      .map((c) => c.id);
    if (roots.length > 0) {
      setPinnedIds(roots);
    }
  }, [categories, pinnedIds.length]);

  const pinnedCategories = useMemo(() => {
    return pinnedIds
      .map((id) => categories[id] as LocalCategory | undefined)
      .filter(Boolean) as LocalCategory[];
  }, [pinnedIds, categories]);

  const unpinnedCategories = useMemo(() => {
    return (Object.values(categories) as LocalCategory[])
      .filter((c) => !pinnedIds.includes(c.id) && !c.parentId)
      .sort((a, b) => a.name.localeCompare(b.name, "ar"));
  }, [categories, pinnedIds]);

  const togglePin = useCallback(
    (categoryId: string) => {
      setPinnedIds((prev) => {
        if (prev.includes(categoryId)) {
          return prev.filter((id) => id !== categoryId);
        }
        if (prev.length >= MAX_PINS) return prev;
        return [...prev, categoryId];
      });
    },
    [],
  );

  const unpinAll = useCallback(() => {
    setPinnedIds([]);
  }, []);

  if (pinnedCategories.length === 0 && !editing) return null;

  return (
    <div className="shrink-0">
      {/* Pin/unpin toggle */}
      <div className="mb-0.5 flex items-center justify-between px-1">
        <div className="flex items-center gap-1.5">
          <Pin className="h-3 w-3 text-slate-400" />
          <span className="text-xs font-bold uppercase tracking-wider text-slate-400">
            وصول سريع
          </span>
        </div>
        <div className="flex items-center gap-1">
          {pinnedCategories.length > 0 && (
            <button
              type="button"
              onClick={unpinAll}
              className="flex h-11 items-center gap-1.5 rounded-lg px-2.5 text-xs font-bold text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
              title="إزالة جميع التثبيتات"
            >
              <PinOff className="h-3 w-3" />
            </button>
          )}
          <button
            type="button"
            onClick={() => setEditing(!editing)}
            className={cn(
              "flex h-11 items-center gap-1.5 rounded-lg px-2.5 text-xs font-bold transition",
              editing
                ? "bg-primary/10 text-primary"
                : "text-slate-400 hover:bg-slate-100 hover:text-slate-600",
            )}
          >
            {editing ? "تم" : "تثبيت"}
          </button>
        </div>
      </div>

      {/* Pinned categories strip */}
      <div className="flex gap-1 overflow-x-auto scrollbar-hidden pb-0.5">
        {pinnedCategories.map((cat) => (
          <button
            key={cat.id}
            type="button"
            onClick={() => {
              if (editing) {
                togglePin(cat.id);
              } else {
                setActiveCategoryId(cat.id);
              }
            }}
            className={cn(
              "group flex h-11 shrink-0 items-center gap-1.5 rounded-lg border px-3 text-xs font-bold transition active:scale-[0.97]",
              activeCategoryId === cat.id
                ? "border-primary bg-primary/10 text-primary"
                : "border-slate-200 bg-white text-slate-700 hover:border-green-300 hover:bg-green-50/40",
            )}
          >
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: cat.bgColor ?? "#64748b" }}
            />
            <span className="max-w-[100px] truncate">{cat.name}</span>
            {editing && (
              <X className="h-3.5 w-3.5 shrink-0 text-slate-400 group-hover:text-destructive" />
            )}
          </button>
        ))}

        {/* Add pin dropdown (in edit mode) */}
        {editing && pinnedCategories.length < MAX_PINS && (
          <div ref={addDropdownRef} className="relative shrink-0">
            <button
              type="button"
              onClick={() => setShowAddDropdown((o) => !o)}
              className="flex h-11 items-center rounded-lg border border-dashed border-slate-300 px-3 text-xs font-bold text-slate-400 transition hover:border-primary/50 hover:text-primary"
            >
              + تثبيت {MAX_PINS - pinnedCategories.length}
            </button>
            {showAddDropdown && (
              <div className="absolute left-0 top-full z-50 mt-1 min-w-[180px] max-h-60 overflow-y-auto rounded-lg border border-slate-200 bg-white p-1 shadow-overlay">
                {unpinnedCategories.length === 0 ? (
                  <span className="block px-3 py-2 text-xs text-slate-400">لا توجد تصنيفات</span>
                ) : (
                  unpinnedCategories.map((cat) => (
                    <button
                      key={cat.id}
                      type="button"
                      onClick={() => {
                        togglePin(cat.id);
                        if (pinnedIds.length + 1 >= MAX_PINS) setShowAddDropdown(false);
                      }}
                      className="flex min-h-11 w-full items-center gap-2 rounded-lg px-3 py-2 text-start text-xs font-bold text-slate-700 transition hover:bg-slate-100"
                    >
                      <span
                        className="h-3 w-3 shrink-0 rounded-full"
                        style={{ backgroundColor: cat.bgColor ?? "#64748b" }}
                      />
                      {cat.name}
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
