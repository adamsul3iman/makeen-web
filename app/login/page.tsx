"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Eye, EyeOff, KeyRound, Loader2, Lock, LogIn, Mail, Store, User } from "lucide-react";
import { usePosStore } from "@/store/usePosStore";
import { homePathForDevice } from "@/lib/permissions";
import Logo from "@/components/shared/Logo";

/**
 * Unified sign-in for the MAKEEN POS.
 *
 *   Staff tab (default):  store code + staff username + PIN → /api/login.
 *                         The signed device session carries the staff role, so
 *                         the proxy lands a cashier on /pos, an inventory
 *                         clerk on /mobile/add-product and back-office staff
 *                         on /admin.
 *   Owner tab:            email + password → /api/admin/login (owners never
 *                         hold a PIN).
 *
 * The app-root proxy redirects any authenticated visitor away from /login to
 * their role home, so this page only renders for genuinely signed-out users
 * and needs no session probing of its own.
 */
export default function LoginPage() {
  const router = useRouter();
  const staffLogin = usePosStore((s) => s.staffLogin);
  const adminLogin = usePosStore((s) => s.adminLogin);
  const notice = usePosStore((s) => s.notice);

  const [mode, setMode] = useState<"staff" | "owner">("staff");

  const [storeCode, setStoreCode] = useState("");
  const [username, setUsername] = useState("");
  const [pin, setPin] = useState("");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  const [busy, setBusy] = useState(false);
  const [navigating, setNavigating] = useState(false);

  const submitStaff = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!storeCode.trim() || !username.trim() || !pin.trim()) {
      usePosStore.setState({
        notice: { message: "أدخل كود المتجر واسم المستخدم ورمز PIN", tone: "error" },
      });
      return;
    }
    setBusy(true);
    const ok = await staffLogin({ storeCode, username, pin });
    if (!ok) {
      setBusy(false);
      return;
    }
    const cashier = usePosStore.getState().currentCashier;
    const roleCode = cashier?.roleCode ?? cashier?.role;
    const target = homePathForDevice({ role: "cashier", staffRoleCode: roleCode });
    setNavigating(true);
    router.replace(target);
  };

  const submitOwner = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!email.trim() || !password) {
      usePosStore.setState({
        notice: { message: "أدخل البريد الإلكتروني وكلمة المرور", tone: "error" },
      });
      return;
    }
    setBusy(true);
    const ok = await adminLogin(email, password);
    if (!ok) {
      setBusy(false);
      return;
    }
    const target = homePathForDevice({ role: "admin" });
    setNavigating(true);
    router.replace(target);
  };

  if (navigating) {
    return (
      <div dir="rtl" className="flex min-h-screen w-screen items-center justify-center bg-gray-100">
        <Loader2 className="h-10 w-10 animate-spin text-primary" />
      </div>
    );
  }

  const tabBase =
    "flex h-12 flex-1 items-center justify-center gap-2 rounded-xl text-sm font-black transition";
  const tabActive = "bg-primary text-primary-foreground shadow-sm";
  const tabIdle = "bg-surface-muted text-muted-foreground hover:text-foreground";

  return (
    <div
      dir="rtl"
      className="flex min-h-screen w-screen items-center justify-center bg-gray-100 p-6"
    >
      <div className="w-full max-w-sm rounded-3xl bg-white p-8 shadow-xl">
        <Logo className="mx-auto mb-6 h-20 w-20" />
        <h1 className="text-center text-2xl font-black text-foreground">MAKEEN</h1>
        <p className="mt-1 flex items-center justify-center gap-1.5 text-center text-sm font-semibold text-muted">
          <Lock className="h-3.5 w-3.5" />
          تسجيل الدخول
        </p>

        <div className="mt-6 flex gap-2" role="tablist" aria-label="طريقة تسجيل الدخول">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "staff"}
            onClick={() => setMode("staff")}
            className={`${tabBase} ${mode === "staff" ? tabActive : tabIdle}`}
          >
            <User className="h-4 w-4" />
            موظف
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "owner"}
            onClick={() => setMode("owner")}
            className={`${tabBase} ${mode === "owner" ? tabActive : tabIdle}`}
          >
            <Mail className="h-4 w-4" />
            المالك
          </button>
        </div>

        {mode === "staff" ? (
          <form onSubmit={submitStaff} className="mt-6 space-y-4">
            <div>
              <label htmlFor="login-store-code" className="mb-1.5 flex items-center gap-1 text-sm font-bold text-muted">
                <Store className="h-3.5 w-3.5" />
                كود المتجر
              </label>
              <input
                id="login-store-code"
                type="text"
                autoComplete="off"
                autoFocus
                dir="ltr"
                value={storeCode}
                onChange={(e) => setStoreCode(e.target.value)}
                placeholder="MAIN01"
                className="w-full rounded-xl border border-border bg-surface-muted px-4 py-3 text-center text-lg font-black tracking-widest text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
              />
            </div>

            <div>
              <label htmlFor="login-username" className="mb-1.5 flex items-center gap-1 text-sm font-bold text-muted">
                <User className="h-3.5 w-3.5" />
                اسم المستخدم
              </label>
              <input
                id="login-username"
                type="text"
                autoComplete="username"
                dir="ltr"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="ahmed"
                className="w-full rounded-xl border border-border bg-surface-muted px-4 py-3 text-left text-base font-bold text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
              />
            </div>

            <div>
              <label htmlFor="login-pin" className="mb-1.5 flex items-center gap-1 text-sm font-bold text-muted">
                <KeyRound className="h-3.5 w-3.5" />
                رمز PIN
              </label>
              <input
                id="login-pin"
                type="password"
                inputMode="numeric"
                autoComplete="current-password"
                dir="ltr"
                maxLength={4}
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
                placeholder="••••"
                className="w-full rounded-xl border border-border bg-surface-muted px-4 py-3 text-center text-lg font-black tracking-[0.5em] text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
              />
            </div>

            <p
              className={`min-h-5 text-center text-sm font-bold ${
                notice?.tone === "error" ? "text-destructive" : "text-transparent"
              }`}
              aria-live="polite"
            >
              {(notice?.tone === "error" ? notice.message : "") || "·"}
            </p>

            <button
              type="submit"
              disabled={busy}
              className="flex h-14 w-full items-center justify-center gap-2 rounded-xl bg-success text-lg font-black text-success-foreground shadow-sm transition hover:bg-success-hover active:scale-[0.98] disabled:opacity-40"
            >
              {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <LogIn className="h-5 w-5" />}
              {busy ? "جارٍ الدخول…" : "دخول"}
            </button>
          </form>
        ) : (
          <form onSubmit={submitOwner} className="mt-6 space-y-4">
            <div>
              <label htmlFor="login-email" className="mb-1.5 flex items-center gap-1 text-sm font-bold text-muted">
                <Mail className="h-3.5 w-3.5" />
                البريد الإلكتروني
              </label>
              <input
                id="login-email"
                type="email"
                autoComplete="username"
                autoFocus
                dir="ltr"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="owner@store.com"
                className="w-full rounded-xl border border-border bg-surface-muted px-4 py-3 text-left text-base font-bold text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
              />
            </div>

            <div>
              <label htmlFor="login-password" className="mb-1.5 flex items-center gap-1 text-sm font-bold text-muted">
                <KeyRound className="h-3.5 w-3.5" />
                كلمة المرور
              </label>
              <div className="relative">
                <input
                  id="login-password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  dir="ltr"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full rounded-xl border border-border bg-surface-muted px-4 py-3 text-left text-base font-bold text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? "إخفاء كلمة المرور" : "إظهار كلمة المرور"}
                  className="absolute inset-y-0 left-2 grid w-10 place-items-center text-muted transition hover:text-foreground"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            <p
              className={`min-h-5 text-center text-sm font-bold ${
                notice?.tone === "error" ? "text-destructive" : "text-transparent"
              }`}
              aria-live="polite"
            >
              {(notice?.tone === "error" ? notice.message : "") || "·"}
            </p>

            <button
              type="submit"
              disabled={busy}
              className="flex h-14 w-full items-center justify-center gap-2 rounded-xl bg-success text-lg font-black text-success-foreground shadow-sm transition hover:bg-success-hover active:scale-[0.98] disabled:opacity-40"
            >
              {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <LogIn className="h-5 w-5" />}
              {busy ? "جارٍ الدخول…" : "دخول"}
            </button>
          </form>
        )}

        <p className="mt-6 text-center text-xs font-semibold text-muted-foreground">
          إنشاء المتاجر يتم عبر مدير النظام فقط
        </p>
      </div>
    </div>
  );
}
