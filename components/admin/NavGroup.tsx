"use client";

import { useState, useCallback, useEffect } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";
import type { NavGroup as NavGroupType } from "@/lib/adminNav";
import NavItem from "./NavItem";

interface NavGroupProps {
  group: NavGroupType;
  isActive: (href: string) => boolean;
  collapsed: boolean;
}

export default function NavGroupComponent({ group, isActive, collapsed }: NavGroupProps) {
  const isGroupActive = group.items.some((item) => isActive(item.href));

  const [expanded, setExpanded] = useState(isGroupActive);

  useEffect(() => {
    if (group.standalone) return;
    try {
      const stored = localStorage.getItem(`nav-group-${group.id}`);
      if (stored !== null) {
        setExpanded(stored === "true");
      }
    } catch {}
  }, [group.id, group.standalone]);

  const toggle = useCallback(() => {
    setExpanded((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(`nav-group-${group.id}`, String(next));
      } catch {}
      return next;
    });
  }, [group.id]);

  if (group.standalone) {
    return (
      <div className="pb-1">
        {group.items.map((item) => (
          <NavItem
            key={item.href}
            href={item.href}
            label={item.label}
            icon={item.icon}
            active={isActive(item.href)}
            collapsed={collapsed}
          />
        ))}
      </div>
    );
  }

  if (collapsed) {
    return (
      <div className="pt-1">
        {group.items.map((item) => (
          <NavItem
            key={item.href}
            href={item.href}
            label={item.label}
            icon={item.icon}
            active={isActive(item.href)}
            collapsed
          />
        ))}
      </div>
    );
  }

  return (
    <div className="pt-1">
      <button
        type="button"
        onClick={toggle}
        className="flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider transition-colors duration-150 text-slate-500 hover:text-slate-400"
      >
        <span className="flex-1 truncate text-right">{group.label}</span>
        <ChevronDown
          className={cn(
            "h-3 w-3 shrink-0 transition-transform duration-150",
            expanded ? "rotate-0" : "-rotate-90",
          )}
        />
      </button>

      <div
        className={cn(
          "overflow-hidden transition-all duration-200",
          expanded ? "max-h-[500px] opacity-100" : "max-h-0 opacity-0",
        )}
      >
        <div className="space-y-0.5 py-0.5">
          {group.items.map((item) => (
            <NavItem
              key={item.href}
              href={item.href}
              label={item.label}
              icon={item.icon}
              active={isActive(item.href)}
              collapsed={false}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
