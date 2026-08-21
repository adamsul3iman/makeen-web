"use client";

import { useEffect, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { Loader } from "lucide-react";
import AddProductForm from "@/components/mobile/AddProductForm";
import { probeStaffCapability } from "@/lib/clientAdminSession";
import { usePosStoreHydrated } from "@/hooks/usePosStoreHydrated";
import { usePosStore } from "@/store/usePosStore";
import { logoutToLogin } from "@/lib/clientLogout";

const REQUIRED_CAPABILITY = "catalog.add";

/**
 * Session gate for the mobile camera page. The app-root proxy already ensures
 * this page is only reachable with a valid device session holding the
 * `inventory_clerk` (or owner) role, and the unified /login persists the
 * store + cashier through the same zustand store the POS uses — so there is
 * no separate mobile session and no "checking session" flash.
 *
 * The signed cookie is still re-probed in the background: if the session was
 * revoked server-side the user is sent to the unified /login.
 */
export default function MobileAddProduct() {
  const router = useRouter();
  const hydrated = usePosStoreHydrated();
  const mounted = useSyncExternalStore(emptySubscribe, () => true, () => false);
  const currentCashier = usePosStore((s) => s.currentCashier);
  const currentStore = usePosStore((s) => s.currentStore);

  useEffect(() => {
    if (!mounted || !hydrated) return;
    void probeStaffCapability(REQUIRED_CAPABILITY).then((status) => {
      if (status === "invalid") router.replace("/login");
    });
  }, [mounted, hydrated, router]);

  const handleLogout = () => {
    // Revoke the signed device cookie server-side (the POS/admin flows share
    // /api/admin/logout) and hard-navigate to the unified /login — no
    // intermediate login screen flashes.
    void logoutToLogin();
  };

  if (!mounted || !hydrated) {
    return (
      <div
        dir="rtl"
        className="flex min-h-screen w-screen items-center justify-center bg-gray-100 p-6"
      >
        <div className="flex w-full max-w-sm flex-col items-center gap-3 rounded-3xl bg-white p-8 shadow-xl">
          <Loader className="h-8 w-8 animate-spin text-primary" />
          <p className="text-sm font-black text-foreground">جارٍ تجهيز الصفحة…</p>
        </div>
      </div>
    );
  }

  const cashierName = currentCashier?.name ?? "";
  const roleName = currentCashier?.roleName ?? "";
  const cashierLabel = cashierName ? (roleName ? `${cashierName} · ${roleName}` : cashierName) : "";

  return (
    <AddProductForm
      storeName={currentStore?.name ?? "المتجر"}
      cashierLabel={cashierLabel}
      storeTaxPercent={currentStore?.taxPercent ?? 16}
      onLogout={handleLogout}
    />
  );
}

function emptySubscribe() {
  return () => {};
}
