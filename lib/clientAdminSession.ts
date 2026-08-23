"use client";

import { usePosStore } from "@/store/usePosStore";
import { hasCapability, isStaffCapability, type StaffCapability } from "@/lib/permissions";

export type AdminSessionProbe = "valid" | "invalid" | "unreachable";

/**
 * Static export: there is no server to validate an HttpOnly cookie against.
 * The admin session lives in the persisted zustand store (established at
 * login through `authenticate_admin_client`), so validity is a local check.
 */
export async function probeAdminSession(): Promise<AdminSessionProbe> {
  return usePosStore.getState().adminSession ? "valid" : "invalid";
}

export async function probeStaffCapability(capability: string): Promise<AdminSessionProbe> {
  const state = usePosStore.getState();
  if (state.adminSession) return "valid";
  if (!isStaffCapability(capability)) return "invalid";
  const actor = state.currentCashier;
  if (!actor) return "invalid";
  return hasCapability(actor, capability as StaffCapability) ? "valid" : "invalid";
}

export function expireLocalAdminSession(): void {
  usePosStore.setState((state) => ({
    adminSession: null,
    notice: {
      message: "انتهت جلسة المدير على هذا الجهاز — سجّل الدخول مجدداً للوصول للإدارة",
      tone: "error",
    },
    currentCashier:
      state.currentCashier?.role === "admin" ? null : state.currentCashier,
  }));
}
