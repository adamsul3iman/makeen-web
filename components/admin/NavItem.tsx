"use client";

import { memo } from "react";
import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";

interface NavItemProps {
  href: string;
  label: string;
  icon: LucideIcon;
  active: boolean;
  collapsed: boolean;
}

function NavItem({ href, label, icon: Icon, active, collapsed }: NavItemProps) {
  return (
    <Link
      href={href}
      title={collapsed ? label : undefined}
      className={cn(
        "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-semibold transition-colors duration-150",
        collapsed && "justify-center px-2",
        active
          ? "border-r-[3px] border-slate-900 bg-slate-100 text-slate-900"
          : "text-slate-600 hover:bg-slate-100 hover:text-slate-900",
      )}
    >
      <Icon className="h-4 w-4 shrink-0" />
      {!collapsed && <span className="truncate">{label}</span>}
    </Link>
  );
}

// All NavItem props are primitives or stable module constants (from NAV_GROUPS),
// so shallow equality is a faithful bail-out: rows whose active/collapsed state
// is unchanged skip re-rendering during navigation and sidebar toggles.
export default memo(NavItem);
