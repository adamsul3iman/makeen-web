"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { usePosStore } from "@/store/usePosStore";
import { homePathForDevice } from "@/lib/permissions";

/**
 * Root page: resolves the session to the role's home or falls back to /login.
 *
 * In static export mode there is no server-side proxy, so this client component
 * reads the persisted Zustand session and performs a client-side redirect.
 */
export default function Home() {
  const router = useRouter();
  const currentCashier = usePosStore((s) => s.currentCashier);
  const adminSession = usePosStore((s) => s.adminSession);

  useEffect(() => {
    if (adminSession) {
      router.replace("/admin");
    } else if (currentCashier) {
      const roleCode = currentCashier.roleCode ?? currentCashier.role;
      const home = homePathForDevice({ role: "cashier", roleCode });
      router.replace(home);
    } else {
      router.replace("/login");
    }
  }, [currentCashier, adminSession, router]);

  return null;
}
