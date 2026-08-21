"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";

interface ListPaginationProps {
  page: number;
  totalPages: number;
  total: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  pageSizeOptions?: number[];
  onPageSizeChange?: (pageSize: number) => void;
}

function buildPages(current: number, total: number): Array<number | "…"> {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  const raw = new Set([1, total, current - 1, current, current + 1]);
  const sorted = Array.from(raw)
    .filter((p) => p >= 1 && p <= total)
    .sort((a, b) => a - b);
  const out: Array<number | "…"> = [];
  let previous = 0;
  for (const pageNumber of sorted) {
    if (pageNumber - previous > 1) out.push("…");
    out.push(pageNumber);
    previous = pageNumber;
  }
  return out;
}

/** Server-agnostic page control for admin tables/lists. Renders a windowed
 * page-number strip with prev/next and an optional per-page size selector. */
export function ListPagination({
  page,
  totalPages,
  total,
  pageSize,
  onPageChange,
  pageSizeOptions = [10, 25, 50, 100],
  onPageSizeChange,
}: ListPaginationProps) {
  if (total === 0) return null;
  const safePage = Math.max(1, Math.min(page, totalPages));
  const start = Math.max(1, (safePage - 1) * pageSize + 1);
  const end = Math.min(safePage * pageSize, total);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-5 py-3">
      <p className="text-xs font-semibold text-muted">
        عرض {start}–{end} من {total}
      </p>
      <div className="flex items-center gap-1">
        {onPageSizeChange && (
          <select
            value={pageSize}
            onChange={(e) => onPageSizeChange(Number(e.target.value))}
            aria-label="عدد الصفوف لكل صفحة"
            className="ms-1 me-2 rounded-lg border border-border bg-surface px-2 py-1.5 text-xs font-bold text-muted outline-none transition focus:border-primary"
          >
            {pageSizeOptions.map((size) => (
              <option key={size} value={size}>
                {size} / صفحة
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          onClick={() => onPageChange(safePage - 1)}
          disabled={safePage <= 1}
          aria-label="الصفحة السابقة"
          className="grid h-8 w-8 place-items-center rounded-lg border border-border text-muted transition hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
        {buildPages(safePage, totalPages).map((entry, index) =>
          entry === "…" ? (
            <span key={`gap-${index}`} className="px-1.5 text-xs font-bold text-muted">
              …
            </span>
          ) : (
            <button
              key={entry}
              type="button"
              onClick={() => onPageChange(entry)}
              aria-current={entry === safePage ? "page" : undefined}
              className={`grid h-8 min-w-8 place-items-center rounded-lg px-2 text-xs font-black tabular-nums transition ${
                entry === safePage
                  ? "bg-primary text-primary-foreground"
                  : "text-muted hover:bg-surface-muted hover:text-foreground"
              }`}
            >
              {entry}
            </button>
          ),
        )}
        <button
          type="button"
          onClick={() => onPageChange(safePage + 1)}
          disabled={safePage >= totalPages}
          aria-label="الصفحة التالية"
          className="grid h-8 w-8 place-items-center rounded-lg border border-border text-muted transition hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
