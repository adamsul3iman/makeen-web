"use client";

import { useEffect, useState } from "react";
import { Eye, EyeOff, Lock, ShieldCheck, X } from "lucide-react";
import { usePosStore } from "@/store/usePosStore";

const ACTION_LABELS: Record<string, string> = {
  open_drawer: "فتح الدرج النقدي",
  cancel_invoice: "إلغاء فاتورة مكتملة",
  save_cashier: "حفظ بيانات موظف",
  delete_cashier: "حذف موظف",
  save_settings: "تغيير بريد مالك المتجر (بريد الدخول)",
  save_istd: "حفظ بيانات الفوترة الإلكترونية (JoFotara)",
  approve_discount: "الموافقة على خصم يتجاوز الحد",
  toggle_return_mode: "تفعيل وضع المرتجع",
};

/**
 * Secondary authentication gate for destructive admin actions.
 *
 * The admin session never stores the password, so every guarded action asks
 * the owner to re-enter it. For actions with no server write of their own the
 * password is checked against /api/admin/reverify; cashier upserts verify
 * server-side on their own endpoint.
 */
export default function SecondaryAuthModal() {
  const isOpen = usePosStore((s) => s.isSecondaryAuthOpen);
  const pendingAction = usePosStore((s) => s.pendingSecondaryAction);
  const confirm = usePosStore((s) => s.confirmSecondaryAction);
  const cancel = usePosStore((s) => s.cancelSecondaryAuth);

  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      cancel();
      setPassword("");
      setError("");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, cancel]);

  const label = pendingAction ? (ACTION_LABELS[pendingAction.type] ?? "عملية حساسة") : "عملية حساسة";

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy) return;
    if (!password) {
      setError("أدخل كلمة المرور");
      return;
    }
    setBusy(true);
    setError("");
    const ok = await confirm(password);
    setBusy(false);
    if (!ok) {
      setPassword("");
      setError("تعذر التحقق — تحقق من كلمة المرور أو الاتصال");
    }
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
      dir="rtl"
      onClick={() => {
        cancel();
        setPassword("");
        setError("");
      }}
    >
      <div
        className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-slate-900 text-sky-400">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-base font-black">تأكيد المدير</h2>
              <p className="text-xs font-semibold text-muted">{label}</p>
            </div>
          </div>
          <button
            type="button"
            aria-label="إغلاق"
            onClick={() => {
              cancel();
              setPassword("");
              setError("");
            }}
            className="grid h-11 w-11 cursor-pointer place-items-center rounded-lg text-muted transition hover:bg-surface-muted"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        <form onSubmit={handleSubmit}>
          <p className="mt-4 flex items-center gap-1.5 text-sm font-semibold text-muted">
            <Lock className="h-3.5 w-3.5" />
            أعد إدخال كلمة مرور المدير للمتابعة
          </p>

          <div className="mt-3 flex items-center gap-2 rounded-xl border border-border bg-surface-muted/60 px-3 py-2.5 focus-within:ring-2 focus-within:ring-primary/30">
            <input
              type={show ? "text" : "password"}
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setError("");
              }}
              autoFocus
              autoComplete="current-password"
              placeholder="••••••••"
              className="w-full bg-transparent text-base font-bold tracking-widest outline-none placeholder:text-slate-400"
            />
            <button
              type="button"
              aria-label={show ? "إخفاء كلمة المرور" : "إظهار كلمة المرور"}
              onClick={() => setShow((s) => !s)}
              className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-muted transition hover:bg-surface"
            >
              {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>

          <p
            className="mt-2 h-5 text-center text-sm font-bold text-destructive"
            aria-live="polite"
          >
            {error || " "}
          </p>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                cancel();
                setPassword("");
                setError("");
              }}
              className="h-12 flex-1 rounded-xl border border-border text-sm font-black text-muted transition hover:bg-surface-muted"
            >
              إلغاء
            </button>
            <button
              type="submit"
              disabled={busy}
              className="flex h-12 flex-1 items-center justify-center rounded-xl bg-slate-900 text-sm font-black text-white transition hover:bg-slate-800 disabled:opacity-50"
            >
              {busy ? "جارٍ التحقق…" : "تأكيد"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
