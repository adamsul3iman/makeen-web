"use client";

import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import { usePosStore } from "@/store/usePosStore";
import { getPageTitle } from "@/lib/adminNav";

interface TopBarProps {
  onMobileMenuOpen: () => void;
}

export default function TopBar({ onMobileMenuOpen }: TopBarProps) {
  const pathname = usePathname();
  const currentStore = usePosStore((s) => s.currentStore);
  const currentCashier = usePosStore((s) => s.currentCashier);

  const storeName = currentStore?.name || "لوحة التحكم";
  const operatorName = currentCashier?.name || "المالك";
  const pageTitle = getPageTitle(pathname);

  return (
    <header className="sticky top-0 z-20 flex h-14 items-center justify-between gap-3 border-b border-border bg-surface px-4 md:px-6">
      <div className="flex items-center gap-3 min-w-0">
        <button
          type="button"
          onClick={onMobileMenuOpen}
          className="grid h-9 w-9 place-items-center rounded-lg text-muted transition hover:bg-surface-muted md:hidden"
          aria-label="القائمة"
        >
          <Menu className="h-5 w-5" />
        </button>
        <div className="min-w-0">
          <h1 className="truncate text-base font-bold text-foreground">{pageTitle}</h1>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span>{storeName}</span>
            <span className="text-muted-foreground">·</span>
            <span className="truncate">{operatorName}</span>
          </div>
        </div>
      </div>
    </header>
  );
}
