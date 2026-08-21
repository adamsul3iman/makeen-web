"use client";

import { usePosStore } from "@/store/usePosStore";
import { setTenantStoreId } from "@/lib/tenantClient";

/**
 * Universal client-side sign-out shared by the POS, the admin back-office and
 * the mobile catalog page.
 *
 * In the static Electron export there are no server-side API routes to call,
 * so cookie revocation is not possible. The local Zustand session (tenant
 * binding + admin/cashier/store) is cleared and the browser is hard-navigated
 * to /login so no intermediate screen can ever flash.
 */
export async function logoutToLogin(): Promise<void> {
  setTenantStoreId(null);
  usePosStore.setState({ adminSession: null, currentCashier: null, currentStore: null });
  window.location.replace("/login");
}
