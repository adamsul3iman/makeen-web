"use client";

import type { Key, ReactNode } from "react";
import { cn } from "@/lib/cn";

type ColumnAlignment = "start" | "center" | "end";

export interface AdminDataTableColumn<T> {
  id: string;
  header: ReactNode;
  cell: (row: T, index: number) => ReactNode;
  align?: ColumnAlignment;
  action?: boolean;
  headerClassName?: string;
  cellClassName?: string | ((row: T, index: number) => string);
}

interface AdminDataTableProps<T> {
  columns: readonly AdminDataTableColumn<T>[];
  rows: readonly T[];
  getRowKey: (row: T, index: number) => Key;
  caption?: string;
  toolbar?: ReactNode;
  footer?: ReactNode;
  emptyState?: ReactNode;
  loading?: boolean;
  loadingRows?: number;
  density?: "compact" | "default";
  className?: string;
  viewportClassName?: string;
  tableClassName?: string;
  rowClassName?: string | ((row: T, index: number) => string);
  onRowClick?: (row: T, index: number) => void;
}

const alignmentClasses: Record<ColumnAlignment, string> = {
  start: "text-start",
  center: "text-center",
  end: "text-end",
};

function resolveClassName<T>(
  value: string | ((row: T, index: number) => string) | undefined,
  row: T,
  index: number,
) {
  return typeof value === "function" ? value(row, index) : value;
}

export function AdminTableActions({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-h-10 items-center justify-end gap-1.5 whitespace-nowrap",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function AdminDataTable<T>({
  columns,
  rows,
  getRowKey,
  caption,
  toolbar,
  footer,
  emptyState = "لا توجد بيانات للعرض",
  loading = false,
  loadingRows = 5,
  density = "default",
  className,
  viewportClassName,
  tableClassName,
  rowClassName,
  onRowClick,
}: AdminDataTableProps<T>) {
  const cellPadding = density === "compact" ? "px-3 py-2.5" : "px-4 py-3";

  return (
    <section
      className={cn(
        "min-w-0 overflow-hidden rounded-xl border border-border bg-surface shadow-card",
        className,
      )}
      aria-busy={loading}
    >
      {toolbar ? <div className="border-b border-border">{toolbar}</div> : null}

      <div className={cn("max-w-full overflow-x-auto overflow-y-auto touch-pan-x touch-pan-y", viewportClassName)}>
        <table className={cn("w-full border-separate border-spacing-0", tableClassName)}>
          {caption ? <caption className="sr-only">{caption}</caption> : null}
          <thead>
            <tr>
              {columns.map((column) => {
                const alignment = column.action ? "end" : (column.align ?? "start");
                return (
                  <th
                    key={column.id}
                    scope="col"
                    className={cn(
                      "sticky top-0 z-10 border-b border-border bg-surface-muted text-xs font-black text-muted",
                      cellPadding,
                      alignmentClasses[alignment],
                      column.action && "w-px whitespace-nowrap",
                      column.headerClassName,
                    )}
                  >
                    {column.header}
                  </th>
                );
              })}
            </tr>
          </thead>

          <tbody>
            {loading
              ? Array.from({ length: loadingRows }, (_, rowIndex) => (
                  <tr key={`loading-${rowIndex}`} className="border-b border-border last:border-0">
                    {columns.map((column) => (
                      <td
                        key={column.id}
                        className={cn(
                          "border-b border-border last:border-b-0",
                          cellPadding,
                          column.action && "w-px",
                        )}
                      >
                        <span className="block h-4 animate-pulse rounded-md bg-surface-muted" />
                      </td>
                    ))}
                  </tr>
                ))
              : null}

            {!loading && rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-4 py-12 text-center text-sm font-bold text-muted">
                  {emptyState}
                </td>
              </tr>
            ) : null}

            {!loading
              ? rows.map((row, rowIndex) => (
                  <tr
                    key={getRowKey(row, rowIndex)}
                    onClick={onRowClick ? () => onRowClick(row, rowIndex) : undefined}
                    className={cn(
                      "group transition-colors hover:bg-surface-muted/70",
                      onRowClick && "cursor-pointer",
                      resolveClassName(rowClassName, row, rowIndex),
                    )}
                  >
                    {columns.map((column) => {
                      const alignment = column.action ? "end" : (column.align ?? "start");
                      return (
                        <td
                          key={column.id}
                          className={cn(
                            "border-b border-border text-sm font-semibold text-foreground group-last:border-b-0",
                            cellPadding,
                            alignmentClasses[alignment],
                            column.action && "w-px whitespace-nowrap",
                            resolveClassName(column.cellClassName, row, rowIndex),
                          )}
                        >
                          {column.cell(row, rowIndex)}
                        </td>
                      );
                    })}
                  </tr>
                ))
              : null}
          </tbody>
        </table>
      </div>

      {footer ? <div>{footer}</div> : null}
    </section>
  );
}
