"use client";

import { memo, useMemo, useState, useCallback } from "react";
import {
  LayoutGrid,
  Package,
  Plus,
  Zap,
} from "lucide-react";
import { usePosStore } from "@/store/usePosStore";
import { formatMoney } from "@/lib/format";
import { hasCapability } from "@/lib/permissions";
import type { QuickKeyItem } from "@/types/pos.types";
import ActionBar from "./ActionBar";
import CategoryDrawer from "./CategoryDrawer";

const CATEGORY_COLORS: Record<string, string> = {
  "#0f766e": "bg-teal-100 text-teal-700",
  "#1d4ed8": "bg-blue-100 text-blue-700",
  "#b45309": "bg-amber-100 text-amber-700",
  "#15803d": "bg-green-100 text-green-700",
  "#0369a1": "bg-sky-100 text-sky-700",
  "#7c3aed": "bg-violet-100 text-violet-700",
  "#c2410c": "bg-orange-100 text-orange-700",
  "#a16207": "bg-yellow-100 text-yellow-700",
};

function colorClass(bgColor?: string): string {
  if (!bgColor) return "bg-slate-100 text-slate-600";
  return CATEGORY_COLORS[bgColor] ?? "bg-slate-100 text-slate-600";
}

const QuickKeyButton = memo(function QuickKeyButton({
  item,
  onAdd,
}: {
  item: QuickKeyItem;
  onAdd: (item: QuickKeyItem) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onAdd(item)}
      className="flex w-full items-center gap-2 rounded-xl bg-slate-50 p-2 transition hover:bg-slate-100 active:scale-[0.97]"
    >
      <span
        className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${colorClass(item.bgColor)}`}
      >
        <Zap className="h-5 w-5" />
      </span>
      <div className="min-w-0 flex-1 text-start">
        <p className="truncate text-sm font-bold text-slate-800">{item.label}</p>
        <p className="text-xs font-semibold text-slate-500 tabular-nums">
          {formatMoney(item.price ?? 0)}
        </p>
      </div>
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-green-500 text-white shadow-sm transition hover:bg-green-600">
        <Plus className="h-4 w-4" />
      </span>
    </button>
  );
});

export default memo(function SpeedDock() {
  const currentCashier = usePosStore((s) => s.currentCashier);
  const quickKeys = usePosStore((s) => s.quickKeys);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const openDrawer = useCallback(() => setDrawerOpen(true), []);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  const speedItems = useMemo(
    () => quickKeys.filter((k) => k.isQuickKey && k.productId),
    [quickKeys],
  );

  const handleAdd = useCallback((item: QuickKeyItem) => {
    usePosStore.getState().addQuickKeyItem(item);
  }, []);

  return (
    <>
      <aside className="flex h-full min-h-0 min-w-0 w-full flex-col gap-2 overflow-hidden rounded-2xl border border-slate-200/80 bg-white p-2 shadow-[0_2px_16px_rgba(15,23,42,0.06)]">
        <button
          type="button"
          onClick={openDrawer}
          className="flex h-11 shrink-0 items-center justify-center gap-2 rounded-xl bg-slate-800 px-4 text-sm font-bold text-white shadow-md transition hover:bg-slate-700 active:scale-[0.98]"
        >
          <LayoutGrid className="h-4 w-4 shrink-0" />
          تصفح الأصناف
        </button>

        <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto scrollbar-hidden">
          <div className="flex items-center gap-1.5 px-1">
            <Package className="h-3 w-3 text-slate-400" />
            <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
              أصناف سريعة
            </span>
          </div>
          {speedItems.length > 0 ? (
            speedItems.map((item) => (
              <QuickKeyButton key={item.id} item={item} onAdd={handleAdd} />
            ))
          ) : (
            <p className="px-1 py-3 text-center text-[11px] font-semibold text-slate-400">
              لا توجد أصناف سريعة — حدّث المنتج من الإدارة
            </p>
          )}
        </div>

        {hasCapability(currentCashier, "pos.record_expense") ||
        hasCapability(currentCashier, "pos.collect_debt") ||
        hasCapability(currentCashier, "pos.request_return") ? (
          <ActionBar />
        ) : null}
      </aside>

      <CategoryDrawer isOpen={drawerOpen} onClose={closeDrawer} />
    </>
  );
});
