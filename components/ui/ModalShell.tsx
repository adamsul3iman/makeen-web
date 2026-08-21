"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";

type ModalSize = "sm" | "md" | "lg" | "xl";
type ModalHeight = "auto" | "sm" | "md" | "lg";

const SIZE_CLASSES: Record<ModalSize, string> = {
  sm: "max-w-sm",
  md: "max-w-md",
  lg: "max-w-lg",
  xl: "max-w-3xl",
};

const HEIGHT_CLASSES: Record<Exclude<ModalHeight, "auto">, string> = {
  sm: "h-[32rem]",
  md: "h-[40rem]",
  lg: "h-[44rem]",
};

export interface ModalShellProps {
  open?: boolean;
  title: string;
  description?: ReactNode;
  icon?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onClose?: () => void;
  size?: ModalSize;
  height?: ModalHeight;
  placement?: "center" | "top";
  dismissible?: boolean;
  closeLabel?: string;
  className?: string;
  bodyClassName?: string;
}

export function ModalShell({
  open = true,
  title,
  description,
  icon,
  children,
  footer,
  onClose,
  size = "md",
  height = "auto",
  placement = "center",
  dismissible = true,
  closeLabel = "إغلاق",
  className,
  bodyClassName,
}: ModalShellProps) {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return;

    const previousOverflow = document.body.style.overflow;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (dismissible && event.key === "Escape") onClose?.();
    };

    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", handleKeyDown);
    panelRef.current?.focus();

    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
      previouslyFocused?.focus();
    };
  }, [dismissible, onClose, open]);

  if (!open) return null;

  return (
    <div
      className={cn(
        "fixed inset-0 z-[75] flex justify-center bg-black/45 p-4",
        placement === "top" ? "items-start pt-[8vh]" : "items-center",
      )}
      onClick={() => {
        if (dismissible) onClose?.();
      }}
    >
      <section
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        className={cn(
          "flex w-full flex-col overflow-hidden rounded-2xl border border-border bg-surface text-foreground shadow-overlay",
          placement === "top"
            ? "max-h-[calc(92dvh-1rem)]"
            : "max-h-[calc(100dvh-2rem)]",
          SIZE_CLASSES[size],
          height !== "auto" && HEIGHT_CLASSES[height],
          className,
        )}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="flex min-w-0 items-start gap-3">
            {icon && <div className="shrink-0">{icon}</div>}
            <div className="min-w-0">
              <h2 id={titleId} className="text-base font-black text-foreground">
                {title}
              </h2>
              {description && (
                <div id={descriptionId} className="mt-1 text-sm font-medium text-muted">
                  {description}
                </div>
              )}
            </div>
          </div>
          {dismissible && onClose && (
            <Button
              variant="ghost"
              size="icon"
              aria-label={closeLabel}
              onClick={onClose}
              className="-m-1 shrink-0"
            >
              <X className="h-5 w-5" aria-hidden="true" />
            </Button>
          )}
        </header>

        <div
          className={cn(
            "min-h-0 flex-1 overflow-y-auto px-5 py-4 [scrollbar-gutter:stable]",
            bodyClassName,
          )}
        >
          {children}
        </div>

        {footer && (
          <footer className="shrink-0 border-t border-border px-5 py-4">
            {footer}
          </footer>
        )}
      </section>
    </div>
  );
}
