import { StatCardSkeleton, TableSkeleton, CardSkeleton } from "@/components/ui/Skeleton";

export default function AdminLoading() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="h-7 w-48 rounded-lg bg-surface-muted" />
          <div className="mt-2 h-4 w-32 rounded bg-surface-muted" />
        </div>
        <div className="h-10 w-24 rounded-lg bg-surface-muted" />
      </div>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <StatCardSkeleton key={i} />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <CardSkeleton>
          <TableSkeleton rows={4} cols={3} />
        </CardSkeleton>
        <CardSkeleton />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <CardSkeleton>
            <TableSkeleton rows={5} cols={3} />
          </CardSkeleton>
        </div>
        <CardSkeleton>
          <div className="h-56 w-full" />
        </CardSkeleton>
      </div>
    </div>
  );
}
