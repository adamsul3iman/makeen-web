"use client";

import { useEffect, useCallback } from "react";
import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/cn";

interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmLabel?: string;
  confirmTone?: "destructive" | "default";
}

export default function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel = "تأكيد",
  confirmTone = "destructive",
}: ConfirmDialogProps) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    },
    [onClose],
  );

  useEffect(() => {
    if (!open) return;
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, handleKeyDown]);

  if (!open) return null;

  const confirmClasses =
    confirmTone === "destructive"
      ? "bg-destructive text-white hover:bg-destructive-hover"
      : "bg-primary text-primary-foreground hover:bg-primary-hover";

  return (
    <div
      className="fixed inset-0 z-[75] flex items-center justify-center bg-black/45 p-4"
      onClick={onClose}
    >
      <div
        className="flex w-full max-w-sm flex-col items-center rounded-2xl bg-surface p-6 text-center shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 grid h-12 w-12 place-items-center rounded-full bg-destructive/10">
          <AlertTriangle className="h-6 w-6 text-destructive" />
        </div>
        <h2 className="text-lg font-black text-foreground">{title}</h2>
        <p className="mt-2 text-sm font-semibold text-muted">{message}</p>
        <div className="mt-6 flex w-full gap-3">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-xl border border-border bg-surface px-4 py-2.5 text-sm font-bold text-foreground transition hover:bg-surface-muted"
          >
            إلغاء
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={cn(
              "flex-1 rounded-xl px-4 py-2.5 text-sm font-black transition",
              confirmClasses,
            )}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
