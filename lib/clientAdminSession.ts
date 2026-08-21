"use client";

import { usePosStore } from "@/store/usePosStore";

export type AdminSessionProbe = "valid" | "invalid" | "unreachable";

export async function probeAdminSession(): Promise<AdminSessionProbe> {
  try {
    const response = await fetch("/api/admin/account", {
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
    });
    if (response.ok) return "valid";
    if (response.status === 401) return "invalid";
    return "unreachable";
  } catch {
    return "unreachable";
  }
}

export async function probeStaffCapability(capability: string): Promise<AdminSessionProbe> {
  try {
    const response = await fetch(`/api/access?capability=${encodeURIComponent(capability)}`, {
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
    });
    if (response.ok) return "valid";
    if (response.status === 401 || response.status === 403) return "invalid";
    return "unreachable";
  } catch {
    return "unreachable";
  }
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
