"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import { usePathname } from "next/navigation";
import {
  expireLocalAdminSession,
  probeAdminSession,
  probeStaffCapability,
} from "@/lib/clientAdminSession";
import { usePosStoreHydrated } from "@/hooks/usePosStoreHydrated";
import { usePosStore } from "@/store/usePosStore";
import { capabilityForAdminPath, hasCapability } from "@/lib/permissions";

/**
 * Client-side back-office guard. The app-root proxy already enforces the
 * session and role area; this guard narrows further to the specific capability
 * of the current /admin path.
 *
 * The device/owner session is validated server-side at login, so the page
 * renders immediately (no "checking session" flash). The server probe still
 * runs in the background so a revoked capability or an expired owner cookie
 * is caught within the same session and bounced out.
 *
 * `useSyncExternalStore` with a `false` server snapshot gives a mount flag
 * that is `false` during SSR and the hydration render (so the prerendered
 * HTML stays empty and matches) and `true` only after hydration — no
 * setState-in-effect, no localStorage access at build time.
 */
export default function AdminGuard({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const adminSession = usePosStore((s) => s.adminSession);
  const currentCashier = usePosStore((s) => s.currentCashier);
  const hydrated = usePosStoreHydrated();
  const mounted = useSyncExternalStore(emptySubscribe, () => true, () => false);
  const [probeComplete, setProbeComplete] = useState(false);
  const requiredCapability = capabilityForAdminPath(pathname);
  const hasLocalAccess = Boolean(
    adminSession ||
    (hasCapability(currentCashier, "backoffice.access") && hasCapability(currentCashier, requiredCapability)),
  );

  useEffect(() => {
    if (!mounted || !hydrated) return;

    if (!hasLocalAccess) {
      router.replace(currentCashier ? "/pos" : "/login");
      return;
    }

    // Background revocation check — never blocks rendering.
    const probe = adminSession
      ? probeAdminSession()
      : probeStaffCapability(requiredCapability);
    void probe.then((status) => {
      setProbeComplete(true);
      if (status === "invalid") {
        if (adminSession) expireLocalAdminSession();
        router.replace(adminSession ? "/login" : "/pos");
      }
    });
  }, [mounted, hydrated, adminSession, currentCashier, hasLocalAccess, requiredCapability, router]);

  if (!mounted) return null;
  if (!hydrated) return null;
  if (!hasLocalAccess) return null;
  if (!probeComplete) return null;
  return <>{children}</>;
}

function emptySubscribe() {
  return () => {};
}
