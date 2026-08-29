"use client";

import { useState } from "react";
import { LogOut, Menu, PanelLeftClose, PanelLeftOpen, UserRound } from "lucide-react";
import { usePosStore } from "@/store/usePosStore";
import { logoutToLogin } from "@/lib/clientLogout";
import Logo from "@/components/shared/Logo";
import ConfirmDialog from "@/components/ui/ConfirmDialog";

interface TopBarProps {
  collapsed: boolean;
  onToggleCollapse: () => void;
  onMobileMenuOpen: () => void;
}

export default function TopBar({
  collapsed,
  onToggleCollapse,
  onMobileMenuOpen,
}: TopBarProps) {
  // Narrow, stable selectors so TopBar only re-renders when its own slice
  // changes — it is deliberately decoupled from high-frequency store churn
  // (sync counters, held invoices, etc.) elsewhere in the app.
  const currentCashier = usePosStore((s) => s.currentCashier);
  const adminSession = usePosStore((s) => s.adminSession);

  const [confirmLogout, setConfirmLogout] = useState(false);

  const operatorName = currentCashier?.name || adminSession?.name || "المالك";

  return (
    <header className="fixed inset-x-0 top-0 z-30 flex h-16 items-center justify-between gap-3 border-b border-slate-800/70 bg-slate-900 px-3 text-slate-100 shadow-sm md:px-4">
      {/* RTL start: toggle button + transparent MAKEEN brand */}
      <div className="flex min-w-0 items-center gap-1.5">
        <button
          type="button"
          onClick={onMobileMenuOpen}
          className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-slate-300 transition hover:bg-white/10 hover:text-white md:hidden"
          aria-label="القائمة"
        >
          <Menu className="h-5 w-5" />
        </button>
        <button
          type="button"
          onClick={onToggleCollapse}
          className="hidden h-10 w-10 shrink-0 place-items-center rounded-xl text-slate-300 transition hover:bg-white/10 hover:text-white md:grid"
          title={collapsed ? "توسيع الشريط الجانبي" : "طي الشريط الجانبي"}
          aria-label={collapsed ? "توسيع الشريط الجانبي" : "طي الشريط الجانبي"}
        >
          {collapsed ? (
            <PanelLeftOpen className="h-5 w-5" />
          ) : (
            <PanelLeftClose className="h-5 w-5" />
          )}
        </button>

        <a
          href="/admin"
          className="group -ml-1 flex min-w-0 items-center rounded-xl py-1 pr-2 transition-colors hover:bg-white/5"
          aria-label="لوحة التحكم"
        >
          {/* The transparent MAKEEN logo — rendered directly on the navy bar,
              no background card/box, no accompanying text. */}
          <Logo variant="light" className="h-12 w-auto" />
        </a>
      </div>

      {/* RTL end: operator avatar + name + logout */}
      <div className="flex min-w-0 items-center gap-2">
        <div className="flex min-w-0 items-center gap-2.5 rounded-xl px-2 py-1">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-400/30">
            <UserRound className="h-5 w-5" />
          </span>
          <span className="hidden max-w-[11rem] truncate text-sm font-bold text-slate-200 sm:block">
            {operatorName}
          </span>
        </div>
        <button
          type="button"
          onClick={() => setConfirmLogout(true)}
          title="تسجيل الخروج"
          aria-label="تسجيل الخروج"
          className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-slate-300 transition hover:bg-destructive/90 hover:text-white"
        >
          <LogOut className="h-5 w-5" />
        </button>
      </div>

      <ConfirmDialog
        open={confirmLogout}
        onClose={() => setConfirmLogout(false)}
        onConfirm={() => void logoutToLogin()}
        title="تسجيل الخروج"
        message="هل أنت متأكد من رغبتك في تسجيل الخروج؟ سيتم إنهاء جلستك الحالية."
        confirmLabel="خروج"
        confirmTone="destructive"
      />
    </header>
  );
}
