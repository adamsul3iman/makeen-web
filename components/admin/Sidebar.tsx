"use client";

import {
  ArrowRight,
  X,
} from "lucide-react";
import { usePosStore } from "@/store/usePosStore";
import { capabilityForAdminPath, hasCapability } from "@/lib/permissions";
import { NAV_GROUPS, type NavGroup } from "@/lib/adminNav";
import { useActiveRoute } from "@/lib/hooks/useActiveRoute";
import { cn } from "@/lib/cn";
import NavGroupComponent from "./NavGroup";

interface SidebarCoreProps {
  collapsed: boolean;
}

function SidebarCore({ collapsed }: SidebarCoreProps) {
  const currentCashier = usePosStore((s) => s.currentCashier);
  const adminSession = usePosStore((s) => s.adminSession);
  const isActive = useActiveRoute();

  const visibleGroups: NavGroup[] = NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter(({ href }) =>
      Boolean(adminSession || hasCapability(currentCashier, capabilityForAdminPath(href))),
    ),
  })).filter((group) => group.items.length > 0);

  return (
    <>
      <div className="px-3 pt-4">
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
    </>
  );
}

interface SidebarDesktopProps {
  collapsed: boolean;
  width: number;
}

function SidebarDesktop({ collapsed, width }: SidebarDesktopProps) {
  return (
    <aside
      className="fixed bottom-0 right-0 top-16 z-20 hidden flex-col border-l border-slate-200 bg-white text-slate-700 shadow-sm transition-[width] duration-200 md:flex"
      style={{ width }}
    >
      <SidebarCore collapsed={collapsed} />
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
          "fixed bottom-0 right-0 top-16 z-50 flex w-64 flex-col border-l border-slate-200 bg-white text-slate-700 transition-transform duration-200 md:hidden",
          open ? "translate-x-0" : "translate-x-full",
        )}
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute left-3 top-3 z-10 grid h-11 w-11 place-items-center rounded-xl text-slate-500 transition hover:text-slate-900"
          aria-label="إغلاق"
        >
          <X className="h-5 w-5" />
        </button>
        <SidebarCore collapsed={false} />
      </aside>
    </>
  );
}

interface SidebarProps {
  collapsed: boolean;
  mobileOpen: boolean;
  onMobileClose: () => void;
  width: number;
}

export default function Sidebar({ collapsed, mobileOpen, onMobileClose, width }: SidebarProps) {
  return (
    <>
      <SidebarDesktop collapsed={collapsed} width={width} />
      <SidebarMobile open={mobileOpen} onClose={onMobileClose} />
    </>
  );
}
