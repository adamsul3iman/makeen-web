"use client";

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

export default function NavItem({ href, label, icon: Icon, active, collapsed }: NavItemProps) {
  return (
    <Link
      href={href}
      title={collapsed ? label : undefined}
      className={cn(
        "flex items-center gap-3 rounded-lg px-3 py-2.5 text-xs font-bold transition-colors duration-150",
        collapsed && "justify-center px-2",
        active
          ? "bg-white/10 text-white"
          : "text-slate-400 hover:bg-white/5 hover:text-white",
      )}
    >
      <Icon className="h-4 w-4 shrink-0" />
      {!collapsed && <span className="truncate">{label}</span>}
    </Link>
  );
}
