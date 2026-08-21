"use client";

import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import AdminGuard from "@/components/admin/AdminGuard";
import Sidebar from "./Sidebar";
import TopBar from "./TopBar";
import Breadcrumbs from "./Breadcrumbs";

const SIDEBAR_W = 256;
const SIDEBAR_COLLAPSED_W = 76;

export default function AdminShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    try {
      if (localStorage.getItem("admin-sidebar-collapsed") === "true") {
        setCollapsed(true);
      }
    } catch {}
  }, []);

  const toggleCollapse = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("admin-sidebar-collapsed", String(next));
      } catch {}
      return next;
    });
  }, []);

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  const sidebarW = collapsed ? SIDEBAR_COLLAPSED_W : SIDEBAR_W;

  return (
    <div
      className="w-full min-h-screen bg-background text-foreground"
      style={{ "--sw": `${sidebarW}px` } as CSSProperties}
    >
      <Sidebar
        collapsed={collapsed}
        onToggleCollapse={toggleCollapse}
        mobileOpen={mobileOpen}
        onMobileClose={() => setMobileOpen(false)}
        width={sidebarW}
      />

      {/* Content wrapper — pr-0 on mobile, pr-[var(--sw)] on desktop.
          The CSS variable --sw is set on the parent and drives the
          padding-right dynamically (collapsed vs expanded). No inline
          style on the wrapper = zero hydration mismatch risk. */}
      <div className="min-w-0 pr-0 transition-[padding-right] duration-200 md:pr-[var(--sw)]">
        <TopBar
          onMobileMenuOpen={() => setMobileOpen(true)}
        />

        <main className="min-w-0 px-4 py-5 md:px-6 md:py-6">
          <div className="mb-4">
            <Breadcrumbs />
          </div>
          <AdminGuard>{children}</AdminGuard>
        </main>
      </div>
    </div>
  );
}
