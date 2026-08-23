"use client";

import { useEffect } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

export default function PosError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error("[MAKEEN] POS section error:", error);
  }, [error]);

  return (
    <div dir="rtl" className="flex min-h-screen w-screen flex-col items-center justify-center bg-background p-6 text-center">
      <AlertTriangle className="mb-4 h-14 w-14 text-destructive" />
      <h2 className="text-xl font-black text-foreground">تعذر تحميل نقطة البيع</h2>
      <p className="mt-2 max-w-md text-sm font-semibold text-muted">
        {error.message || "حدث خطأ في نقطة البيع. أعد المحاولة لاستئناف البيع."}
      </p>
      {error.digest && (
        <p className="mt-1 font-mono text-xs text-muted-foreground">رقم الخطأ: {error.digest}</p>
      )}
      <button
        type="button"
        onClick={retry}
        className="mt-6 flex h-11 items-center justify-center gap-2 rounded-xl bg-primary px-6 text-sm font-black text-primary-foreground transition hover:bg-primary-hover"
      >
        <RefreshCw className="h-4 w-4" />
        إعادة المحاولة
      </button>
    </div>
  );
}
