"use client";

import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";

interface KpiCardProps {
  label: string;
  value: string;
  icon: LucideIcon;
  /** Meaningful, restrained state colors — only applied when the number itself
   *  carries a signal (e.g. negative profit), never as decoration. */
  tone?: "default" | "success" | "destructive" | "primary";
  hint?: string;
}

const VALUE_TONES: Record<NonNullable<KpiCardProps["tone"]>, string> = {
  default: "text-foreground",
  success: "text-success",
  destructive: "text-destructive",
  primary: "text-primary",
};

const ICON_TONES: Record<NonNullable<KpiCardProps["tone"]>, string> = {
  default: "bg-surface-muted text-muted",
  success: "bg-success/10 text-success",
  destructive: "bg-destructive/10 text-destructive",
  primary: "bg-primary/10 text-primary",
};

export default function KpiCard({ label, value, icon: Icon, tone = "default", hint }: KpiCardProps) {
  return (
    <div className="flex min-w-0 flex-col rounded-2xl border border-border bg-surface p-5 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-xs font-bold text-muted">{label}</p>
        <span className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-lg", ICON_TONES[tone])}>
          <Icon className="h-4 w-4" />
        </span>
      </div>
      <p
        className={cn(
          "mt-3 min-w-0 text-2xl font-black tabular-nums leading-tight break-words lg:text-2xl xl:text-[2rem]",
          VALUE_TONES[tone],
        )}
      >
        {value}
      </p>
      {hint && <p className="mt-1.5 truncate text-xs font-semibold text-muted">{hint}</p>}
    </div>
  );
}
