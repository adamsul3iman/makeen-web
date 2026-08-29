"use client";

import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import AdminGuard from "@/components/admin/AdminGuard";
import Sidebar from "./Sidebar";
import TopBar from "./TopBar";
import Breadcrumbs from "./Breadcrumbs";

const SIDEBAR_W = 256;
const SIDEBAR_COLLAPSED_W = 76;

const SIDEBAR_COLLAPSED_KEY = "admin-sidebar-collapsed";

export default function AdminShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  // `collapsed` ALWAYS begins at a safe, stable default (false) — never read
  // from localStorage during the initial render, which would otherwise cause
  // a hydration mismatch. The persisted preference is applied after mount in
  // the effect below. The setState is deferred into an async continuation
  // (matching the repo's pattern in UnitsEditorModal) so the effect body never
  // synchronously calls setState (react-hooks/set-state-in-effect).
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    Promise.resolve().then(() => {
      try {
        if (localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true") {
          setCollapsed(true);
        }
      } catch {}
    });
  }, []);

  const toggleCollapse = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(next));
      } catch {}
      return next;
    });
  }, []);

  // Close the mobile drawer whenever the route changes. Delayed into an async
  // continuation so the effect body never synchronously calls setState.
  useEffect(() => {
    Promise.resolve().then(() => setMobileOpen(false));
  }, [pathname]);

  const sidebarW = collapsed ? SIDEBAR_COLLAPSED_W : SIDEBAR_W;

  return (
    <div
      className="w-full min-h-screen bg-background text-foreground"
      style={{ "--sw": `${sidebarW}px` } as CSSProperties}
    >
      <Sidebar
        collapsed={collapsed}
        mobileOpen={mobileOpen}
        onMobileClose={() => setMobileOpen(false)}
        width={sidebarW}
      />

      {/* The header is fixed and spans the full viewport width; the
          sidebar (below it) and main content both start below it. */}
      <TopBar
        collapsed={collapsed}
        onToggleCollapse={toggleCollapse}
        onMobileMenuOpen={() => setMobileOpen(true)}
      />

      <div className="min-w-0 pt-16 pr-0 transition-[padding-right] duration-200 md:pr-[var(--sw)]">
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
