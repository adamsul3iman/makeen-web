"use client";

import { useEffect } from "react";
import { AlertTriangle, Home, RefreshCw } from "lucide-react";

export default function AdminError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error("[MAKEEN] Admin section error:", error);
  }, [error]);

  return (
    <div dir="rtl" className="flex min-h-[60vh] flex-col items-center justify-center p-6 text-center">
      <AlertTriangle className="mb-4 h-12 w-12 text-destructive" />
      <h2 className="text-lg font-black text-foreground">تعذر تحميل لوحة التحكم</h2>
      <p className="mt-2 max-w-md text-sm font-semibold text-muted">
        {error.message || "حدث خطأ غير متوقع. أعد المحاولة أو عد إلى الصفحة الرئيسية."}
      </p>
      {error.digest && (
        <p className="mt-1 font-mono text-xs text-muted-foreground">رقم الخطأ: {error.digest}</p>
      )}
      <div className="mt-6 flex gap-3">
        <button
          type="button"
          onClick={retry}
          className="flex h-10 items-center justify-center gap-2 rounded-xl border border-border bg-surface px-4 text-sm font-bold text-foreground transition hover:bg-surface-muted"
        >
          <RefreshCw className="h-4 w-4" />
          إعادة المحاولة
        </button>
        <a
          href="/admin"
          className="flex h-10 items-center justify-center gap-2 rounded-xl bg-primary px-4 text-sm font-black text-primary-foreground transition hover:bg-primary-hover"
        >
          <Home className="h-4 w-4" />
          لوحة التحكم
        </a>
      </div>
    </div>
  );
}
