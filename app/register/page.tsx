import Link from "next/link";
import { Lock, LogIn, ShieldCheck, Store } from "lucide-react";

/**
 * Self-service registration is closed: stores are created only by the
 * platform owner from the Super Admin console (/super-admin). This page is
 * a friendly dead-end so anyone who lands on /register is pointed back to
 * the owner login.
 */
export default function RegisterPage() {
  return (
    <div
      dir="rtl"
      lang="ar"
      className="flex min-h-screen w-screen items-center justify-center bg-slate-50 p-6"
    >
      <div className="w-full max-w-md rounded-3xl bg-white p-8 text-center shadow-xl">
        <div className="mx-auto mb-6 grid h-16 w-16 place-items-center rounded-2xl bg-slate-900 text-sky-400">
          <Store className="h-9 w-9" />
        </div>
        <h1 className="text-2xl font-black text-foreground">إنشاء المتاجر عبر مدير النظام</h1>
        <p className="mt-3 text-sm font-semibold text-muted">
          لم يعد التسجيل الذاتي متاحاً. يتم إنشاء المتاجر وإدارتها من لوحة مدير النظام على
          المنصة.
        </p>

        <div className="mt-6 rounded-xl border border-border bg-surface-muted p-4 text-right">
          <p className="flex items-center gap-2 text-sm font-black text-foreground">
            <ShieldCheck className="h-4 w-4 text-primary" />
            هل أنت مالك متجر؟
          </p>
          <p className="mt-1 text-xs font-semibold text-muted">
            إن كان لديك حساب سجّل دخولك من صفحة الدخول، وإن لم يكن فتواصل مع مدير النظام
            لإنشاء متجرك.
          </p>
        </div>

        <Link
          href="/login"
          className="mt-6 flex h-14 w-full items-center justify-center gap-2 rounded-xl bg-primary text-lg font-black text-primary-foreground transition hover:bg-primary-hover"
        >
          <LogIn className="h-5 w-5" />
          تسجيل دخول مدير المتجر
        </Link>

        <p className="mt-4 flex items-center justify-center gap-1.5 text-xs font-semibold text-muted-foreground">
          <Lock className="h-3.5 w-3.5" />
          مدير النظام فقط من يملك صلاحية إنشاء المتاجر
        </p>
      </div>
    </div>
  );
}
