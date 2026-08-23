"use client";

import { useEffect, useRef } from "react";
import { useRouter, usePathname } from "next/navigation";
import { usePosStoreHydrated } from "@/hooks/usePosStoreHydrated";
import { usePosStore } from "@/store/usePosStore";
import { homePathForDevice, deviceCanAccessPath } from "@/lib/permissions";

/**
 * Client-side route guard that replaces the server-side `proxy.ts` for the
 * static Electron export.
 *
 * Placed in the root layout, it runs on every navigation:
 *   - Public pages (/login, /register, /super-admin) are always reachable.
 *   - Unauthenticated visitors on protected routes are sent to /login.
 *   - Authenticated visitors on /login are bounced to their role home.
 *   - Wrong-area access (e.g. cashier on /admin) bounces to the role home.
 *
 * This component renders nothing; it only performs redirects.
 */
const PUBLIC_PATHS = ["/login", "/register", "/super-admin"];

export default function AuthGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const hydrated = usePosStoreHydrated();
  const currentCashier = usePosStore((s) => s.currentCashier);
  const adminSession = usePosStore((s) => s.adminSession);
  const didInit = useRef(false);

  useEffect(() => {
    if (!hydrated) return;

    const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
    const actor = adminSession
      ? { role: "admin" as const }
      : currentCashier
        ? { role: "cashier" as const, staffRoleCode: currentCashier.roleCode ?? currentCashier.role }
        : null;

    // Authenticated user on /login — skip; the login handler manages its own navigation.

    // Public pages are always allowed.
    if (isPublic) return;

    // "/" is the marketing landing page — redirect authenticated users to their role home.
    if (pathname === "/") {
      if (actor) {
        router.replace(homePathForDevice(actor));
      }
      return;
    }

    // API routes and static assets — let them through.
    if (pathname.startsWith("/api/") || pathname.startsWith("/_next/")) return;

    // Protected route without a session → /login.
    if (!actor) {
      router.replace("/login");
      return;
    }

    // Wrong area for this role → role home.
    if (!deviceCanAccessPath(actor, pathname)) {
      router.replace(homePathForDevice(actor));
      return;
    }
  }, [hydrated, pathname, currentCashier, adminSession, router, didInit]);

  return <>{children}</>;
}
