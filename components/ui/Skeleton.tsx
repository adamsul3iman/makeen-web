import type { ReactNode } from "react";

export function Skeleton({ className = "" }: { className?: string }) {
  return (
    <div
      className={`relative overflow-hidden rounded-lg bg-surface-muted before:absolute before:inset-0 before:-translate-x-full before:animate-[shimmer_1.5s_infinite] before:bg-gradient-to-r before:from-transparent before:via-white/40 before:to-transparent ${className}`}
    />
  );
}

export function StatCardSkeleton() {
  return (
    <div className="rounded-2xl border border-border bg-surface p-5 shadow-sm">
      <div className="flex items-center justify-between">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-4 w-4 rounded-full" />
      </div>
      <Skeleton className="mt-3 h-7 w-28" />
    </div>
  );
}

export function TableSkeleton({ rows = 5, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
      <div className="border-b border-border px-5 py-3">
        <div className="flex gap-4">
          {Array.from({ length: cols }).map((_, i) => (
            <Skeleton key={i} className="h-3 flex-1" />
          ))}
        </div>
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="border-b border-border/50 px-5 py-3.5">
          <div className="flex gap-4">
            {Array.from({ length: cols }).map((_, c) => (
              <Skeleton key={c} className={`h-4 ${c === 0 ? "w-40" : "flex-1"}`} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function CardSkeleton({ children }: { children?: ReactNode }) {
  return (
    <section className="flex flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
      <div className="flex items-center gap-2 border-b border-border px-5 py-3.5">
        <Skeleton className="h-4 w-4 rounded" />
        <Skeleton className="h-4 w-32" />
      </div>
      <div className="flex-1 p-5">{children ?? <Skeleton className="h-40 w-full" />}</div>
    </section>
  );
}
