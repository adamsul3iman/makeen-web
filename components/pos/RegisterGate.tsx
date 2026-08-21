"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { KeyRound, Loader2, Lock, LogOut, RefreshCw, ShoppingCart, UserPlus } from "lucide-react";
import { usePosStoreHydrated } from "@/hooks/usePosStoreHydrated";
import { usePosStore } from "@/store/usePosStore";
import { logoutToLogin } from "@/lib/clientLogout";
import Logo from "@/components/shared/Logo";

/**
 * Timestamp (ms) of the last lock→/login redirect attempt, kept in
 * sessionStorage so it survives the full-page navigation a signed-out lock
 * triggers. If the cookie revoke failed (offline) the app-root proxy bounces
 * /login straight back to /pos; without this guard that would redirect-loop
 * forever.
 */
const LOCK_REDIRECT_KEY = "pos.lock.redirect";
const LOCK_REDIRECT_RECENT_MS = 5000;

/** Runs the sign-out once per page load (guards StrictMode double effects). */
let lockRedirectAttempted = false;

/**
 * Register gate — the only full-screen states the POS shows while no cashier
 * is unlocked.
 *
 *   Owner mode  — an active owner session: the owner opens the register as
 *                 themselves (no PIN — owners never hold one).
 *   Locked mode — a locked / closed-shift / signed-out register: never a
 *                 local PIN pad. The operator is signed out server-side (both
 *                 HttpOnly cookies) and hard-routed to the unified /login
 *                 gateway, where staff sign in with store code + username +
 *                 PIN.
 */
export default function RegisterGate() {
  const currentCashier = usePosStore((s) => s.currentCashier);
  const adminSession = usePosStore((s) => s.adminSession);
  const hydrated = usePosStoreHydrated();
  const currentStore = usePosStore((s) => s.currentStore);
  const cashiers = usePosStore((s) => s.cashiers);
  const loginAsOwner = usePosStore((s) => s.loginAsOwner);

  if (currentCashier) return null;

  if (!hydrated) {
    return (
      <div
        dir="rtl"
        className="flex min-h-dvh w-full items-center justify-center bg-background p-6"
      >
        <div className="flex w-full max-w-sm flex-col items-center gap-3 rounded-2xl bg-surface p-8 shadow-elevated">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-sm font-black text-foreground">جارٍ تجهيز نقطة البيع…</p>
        </div>
      </div>
    );
  }

  // Owner mode: the authenticated store owner opens the register directly as
  // themselves. The session was already validated server-side at
  // /api/admin/login, so there is no re-probe and no role-switch flash.
  if (adminSession) {
    const hasCashiers = cashiers.some((c) => c.role !== "admin" && c.role !== "مدير");
    return (
      <div
        dir="rtl"
        className="flex min-h-dvh w-full items-center justify-center bg-background p-6"
      >
        <div className="w-full max-w-sm rounded-2xl bg-surface p-8 shadow-elevated">
          <Logo className="mx-auto mb-6 h-20 w-20" />

          <h1 className="text-center text-2xl font-black text-foreground">
            أهلاً، {adminSession.name}
          </h1>
          <p className="mt-1 flex items-center justify-center gap-1.5 text-center text-sm font-semibold text-muted">
            <KeyRound className="h-3.5 w-3.5" />
            {currentStore?.name ?? "متجرك"}
          </p>
          <p className="mt-3 text-center text-xs font-bold text-muted-foreground">
            يمكنك فتح الصندوق مباشرة باسمك.
          </p>

          {!hasCashiers && (
            <div className="mt-6 rounded-xl border border-warning/30 bg-warning-soft p-4 text-center">
              <p className="text-sm font-black text-warning-strong">
                لا يوجد كاشير في هذا المتجر بعد
              </p>
              <p className="mt-1 text-xs font-semibold text-warning-strong">
                أنشئ كاشيراً باسم مستخدم ورمز PIN ليستخدم الصندوق.
              </p>
              <Link
                href="/admin/staff"
                className="mt-3 flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-header text-sm font-black text-primary-foreground transition hover:bg-header/90"
              >
                <UserPlus className="h-4 w-4" />
                إنشاء أول كاشير — لوحة التحكم
              </Link>
            </div>
          )}

          <button
            type="button"
            onClick={() => loginAsOwner()}
            className="mt-6 flex h-14 w-full items-center justify-center gap-2 rounded-xl bg-success text-lg font-black text-success-foreground shadow-card transition hover:bg-success-hover active:scale-[0.98]"
          >
            <ShoppingCart className="h-5 w-5" />
            افتح الصندوق الآن
          </button>

          {hasCashiers && (
            <p className="mt-3 text-center text-xs font-semibold text-muted-foreground">
              لتسليم الجهاز: اضغط «قفل / تبديل مستخدم» وستُعاد توجيهك لصفحة الدخول،
              ليدخل الكاشير باسم مستخدمه ورمز PIN.
            </p>
          )}

          <button
            type="button"
            onClick={() => void logoutToLogin()}
            className="mt-4 flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-destructive/10 text-sm font-black text-destructive transition hover:bg-destructive/20"
          >
            <LogOut className="h-4 w-4" />
            تسجيل خروج المدير ({adminSession.name})
          </button>
        </div>
      </div>
    );
  }

  return <LockedRedirect />;
}

function LockedRedirect() {
  // Lazy initial state: a lock attempt within the recent window means the
  // sign-out fetch just bounced us back (offline, cookie not revoked). This is
  // a pure render-time read, so no setState runs inside the effect.
  const [stuck, setStuck] = useState<boolean>(() => {
    if (typeof sessionStorage === "undefined") return false;
    const last = Number(sessionStorage.getItem(LOCK_REDIRECT_KEY) ?? 0);
    return Date.now() - last < LOCK_REDIRECT_RECENT_MS;
  });

  useEffect(() => {
    if (lockRedirectAttempted) return;
    lockRedirectAttempted = true;
    if (stuck) return;
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.setItem(LOCK_REDIRECT_KEY, String(Date.now()));
    }
    void logoutToLogin();
  }, [stuck]);

  if (stuck) {
    return (
      <div
        dir="rtl"
        className="flex min-h-dvh w-full items-center justify-center bg-background p-6"
      >
        <div className="w-full max-w-sm rounded-2xl bg-surface p-8 text-center shadow-elevated">
          <Logo className="mx-auto mb-5 h-20 w-20" />
          <h1 className="text-2xl font-black text-foreground">MAKEEN</h1>
          <p className="mt-3 text-sm font-semibold text-muted">
            تعذر إكمال تسجيل الخروج — تحقق من اتصال الشبكة ثم أعد المحاولة.
          </p>
          <button
            type="button"
            onClick={() => {
              lockRedirectAttempted = false;
              setStuck(false);
            }}
            className="mt-6 flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-primary text-base font-black text-primary-foreground transition hover:bg-primary-hover"
          >
            <RefreshCw className="h-5 w-5" />
            إعادة المحاولة
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      dir="rtl"
      className="flex min-h-dvh w-full items-center justify-center bg-background p-6"
    >
      <div className="flex w-full max-w-sm flex-col items-center gap-3 rounded-2xl bg-surface p-8 text-center shadow-elevated">
        <Lock className="h-7 w-7 text-primary" />
        <p className="text-sm font-black text-foreground">جارٍ العودة إلى صفحة الدخول…</p>
      </div>
    </div>
  );
}
