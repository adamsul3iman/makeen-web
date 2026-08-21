"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Loader } from "lucide-react";
import { usePosStore } from "@/store/usePosStore";
import { firstReceivingCapability } from "@/lib/permissions";

/**
 * Mobile landing: routes an inventory clerk to the camera add-product page
 * (their primary flow) and every other goods-in capable role to the Smart
 * Receiving module.
 */
export default function MobilePage() {
  const router = useRouter();
  const currentCashier = usePosStore((s) => s.currentCashier);

  useEffect(() => {
    const roleCode = currentCashier?.roleCode ?? currentCashier?.role;
    const target =
      roleCode === "inventory_clerk" || !firstReceivingCapability(currentCashier)
        ? "/mobile/add-product"
        : "/mobile/receiving";
    router.replace(target);
  }, [currentCashier, router]);

  return (
    <div
      dir="rtl"
      className="flex min-h-screen w-screen items-center justify-center bg-gray-100 p-6"
    >
      <div className="flex w-full max-w-sm flex-col items-center gap-3 rounded-3xl bg-white p-8 shadow-xl">
        <Loader className="h-8 w-8 animate-spin text-primary" />
        <p className="text-sm font-black text-foreground">جارٍ التوجيه…</p>
      </div>
    </div>
  );
}
