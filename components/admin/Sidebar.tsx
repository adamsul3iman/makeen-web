"use client";

import { useState } from "react";
import {
  ArrowRight,
  LogOut,
  PanelRightClose,
  PanelRightOpen,
  X,
} from "lucide-react";
import Logo from "@/components/shared/Logo";
import { usePosStore } from "@/store/usePosStore";
import { logoutToLogin } from "@/lib/clientLogout";
import { capabilityForAdminPath, hasCapability } from "@/lib/permissions";
import { NAV_GROUPS, type NavGroup } from "@/lib/adminNav";
import { useActiveRoute } from "@/lib/hooks/useActiveRoute";
import { cn } from "@/lib/cn";
import NavGroupComponent from "./NavGroup";
import ConfirmDialog from "@/components/ui/ConfirmDialog";

interface SidebarCoreProps {
  collapsed: boolean;
  onToggleCollapse: () => void;
}

function SidebarCore({ collapsed, onToggleCollapse }: SidebarCoreProps) {
  const currentStore = usePosStore((s) => s.currentStore);
  const currentCashier = usePosStore((s) => s.currentCashier);
  const adminSession = usePosStore((s) => s.adminSession);
  const shiftState = usePosStore((s) => s.shiftState);
  const isActive = useActiveRoute();
  const [confirmLogout, setConfirmLogout] = useState(false);

  const storeName = currentStore?.name || "لوحة التحكم";
  const operatorName = currentCashier?.name || adminSession?.name || "المالك";
  const operatorRole = adminSession ? "مالك المتجر" : currentCashier?.roleName ?? "موظف";
  const shiftLabel = shiftState.status === "OPEN" ? "مفتوحة" : "مغلقة";

  const visibleGroups: NavGroup[] = NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter(({ href }) =>
      Boolean(adminSession || hasCapability(currentCashier, capabilityForAdminPath(href))),
    ),
  })).filter((group) => group.items.length > 0);

  return (
    <>
      <div className="flex items-center justify-between gap-2 border-b border-slate-800 px-3 py-3">
        {collapsed ? (
          <button
            type="button"
            onClick={onToggleCollapse}
            className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-slate-800 text-slate-300 transition hover:bg-white/10 hover:text-white"
            title="توسيع الشريط الجانبي"
            aria-label="توسيع الشريط الجانبي"
          >
            <PanelRightOpen className="h-5 w-5" />
          </button>
        ) : (
          <>
            <div className="flex min-w-0 items-center gap-2">
              <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-white p-1.5 shadow-lg shadow-black/20">
                <Logo className="h-6 w-6" />
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-black text-white">{storeName}</p>
                <p className="text-xs text-slate-500">MAKEEN</p>
              </div>
            </div>
            <button
              type="button"
              onClick={onToggleCollapse}
              className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-slate-800 text-slate-300 transition hover:bg-white/10 hover:text-white"
              title="طي الشريط الجانبي"
              aria-label="طي الشريط الجانبي"
            >
              <PanelRightClose className="h-5 w-5" />
            </button>
          </>
        )}
      </div>

      <div className="px-3 pt-3">
        <a
          href="/pos"
          className={cn(
            "flex items-center justify-center gap-2 rounded-lg bg-primary px-3 py-2.5 text-xs font-black text-white transition hover:bg-primary-hover",
            collapsed && "px-2",
          )}
          title={collapsed ? "العودة لنقطة البيع" : undefined}
        >
          <ArrowRight className="h-4 w-4 shrink-0" />
          {!collapsed && <span>نقطة البيع</span>}
        </a>
      </div>

      <nav className="scrollbar-hidden min-h-0 flex-1 overflow-y-auto px-2 py-3">
        {visibleGroups.map((group) => (
          <NavGroupComponent
            key={group.id}
            group={group}
            isActive={isActive}
            collapsed={collapsed}
          />
        ))}
      </nav>

      <div className={cn("border-t border-slate-800 px-4 py-3", collapsed && "px-2")}>
        {!collapsed && (
          <div className="mb-2 text-xs text-slate-400">
            <p className="font-semibold">الوردية: {shiftLabel}</p>
            <p className="mt-0.5 truncate">
              {operatorName} · {operatorRole}
            </p>
          </div>
        )}
        <div className={cn("flex items-center justify-center", collapsed && "justify-center")}>
          <button
            type="button"
            onClick={() => setConfirmLogout(true)}
            title="تسجيل الخروج"
            aria-label="تسجيل الخروج"
            className="flex h-11 w-11 items-center justify-center rounded-xl bg-slate-800 text-slate-300 transition hover:bg-destructive hover:text-white"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
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
    </>
  );
}

interface SidebarDesktopProps {
  collapsed: boolean;
  onToggleCollapse: () => void;
  width: number;
}

function SidebarDesktop({ collapsed, onToggleCollapse, width }: SidebarDesktopProps) {
  return (
    <aside
      className="fixed inset-y-0 right-0 z-50 hidden flex-col bg-slate-950 text-slate-300 transition-[width] duration-200 md:flex"
      style={{ width }}
    >
      <SidebarCore collapsed={collapsed} onToggleCollapse={onToggleCollapse} />
    </aside>
  );
}

interface SidebarMobileProps {
  open: boolean;
  onClose: () => void;
}

function SidebarMobile({ open, onClose }: SidebarMobileProps) {
  return (
    <>
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm transition-opacity md:hidden"
          onClick={onClose}
        />
      )}
      <aside
        className={cn(
          "fixed inset-y-0 right-0 z-50 flex w-64 flex-col bg-slate-950 text-slate-300 transition-transform duration-200 md:hidden",
          open ? "translate-x-0" : "translate-x-full",
        )}
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute left-3 top-3 z-10 grid h-11 w-11 place-items-center rounded-xl text-slate-400 transition hover:text-white"
          aria-label="إغلاق"
        >
          <X className="h-5 w-5" />
        </button>
        <SidebarCore collapsed={false} onToggleCollapse={() => {}} />
      </aside>
    </>
  );
}

interface SidebarProps {
  collapsed: boolean;
  onToggleCollapse: () => void;
  mobileOpen: boolean;
  onMobileClose: () => void;
  width: number;
}

export default function Sidebar({ collapsed, onToggleCollapse, mobileOpen, onMobileClose, width }: SidebarProps) {
  return (
    <>
      <SidebarDesktop collapsed={collapsed} onToggleCollapse={onToggleCollapse} width={width} />
      <SidebarMobile open={mobileOpen} onClose={onMobileClose} />
    </>
  );
}
