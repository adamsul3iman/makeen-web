"use client";

import type { ReactNode } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

export interface Column<T> {
  key: string;
  header: string;
  className?: string;
  render?: (row: T, index: number) => ReactNode;
  sortable?: boolean;
  sortKey?: string;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[];
  rowKey: (row: T, index: number) => string;
  emptyMessage?: string;
  emptyIcon?: React.ElementType;
  sortColumn?: string;
  sortDirection?: "asc" | "desc";
  onSort?: (column: string) => void;
  onRowClick?: (row: T) => void;
  expandRow?: (row: T) => ReactNode;
  expandedKey?: string | null;
  onToggleExpand?: (key: string) => void;
}

export function DataTable<T>({
  columns,
  data,
  rowKey,
  emptyMessage = "لا توجد بيانات",
  sortColumn,
  sortDirection,
  onSort,
  onRowClick,
  expandRow,
  expandedKey,
  onToggleExpand,
}: DataTableProps<T>) {
  const hasExpand = Boolean(expandRow && onToggleExpand);

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
      <div className="scrollbar-hidden overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-surface-muted/50 text-right">
              {hasExpand && <th className="w-10 px-3 py-3" />}
              {columns.map((col) => (
                <th
                  key={col.key}
                  className={`px-5 py-3 text-xs font-black text-muted ${col.className ?? ""} ${
                    col.sortable && onSort ? "cursor-pointer select-none hover:text-foreground" : ""
                  }`}
                  onClick={
                    col.sortable && onSort
                      ? () => onSort(col.sortKey ?? col.key)
                      : undefined
                  }
                >
                  <span className="inline-flex items-center gap-1">
                    {col.header}
                    {col.sortable && sortColumn === (col.sortKey ?? col.key) && (
                      sortDirection === "asc" ? (
                        <ChevronUp className="h-3.5 w-3.5" />
                      ) : (
                        <ChevronDown className="h-3.5 w-3.5" />
                      )
                    )}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length + (hasExpand ? 1 : 0)}
                  className="py-12 text-center text-sm font-bold text-muted"
                >
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              data.map((row, index) => {
                const key = rowKey(row, index);
                const isExpanded = expandedKey === key;
                return (
                  <DataTableRow
                    key={key}
                    row={row}
                    index={index}
                    columns={columns}
                    hasExpand={hasExpand}
                    isExpanded={isExpanded}
                    onToggleExpand={onToggleExpand ? () => onToggleExpand(key) : undefined}
                    onRowClick={onRowClick}
                    expandContent={expandRow?.(row)}
                    isLast={index === data.length - 1}
                  />
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DataTableRow<T>({
  row,
  index,
  columns,
  hasExpand,
  isExpanded,
  onToggleExpand,
  onRowClick,
  expandContent,
  isLast,
}: {
  row: T;
  index: number;
  columns: Column<T>[];
  hasExpand: boolean;
  isExpanded: boolean;
  onToggleExpand?: () => void;
  onRowClick?: (row: T) => void;
  expandContent?: ReactNode;
  isLast: boolean;
}) {
  return (
    <>
      <tr
        className={`text-right transition hover:bg-surface-muted/50 ${
          onRowClick ? "cursor-pointer" : ""
        } ${isLast ? "" : "border-b border-border/50"}`}
        onClick={onRowClick ? () => onRowClick(row) : undefined}
      >
        {hasExpand && (
          <td className="w-10 px-3 py-3">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onToggleExpand?.();
              }}
              className="grid h-6 w-6 place-items-center rounded text-muted transition hover:bg-surface-muted"
            >
              {isExpanded ? (
                <ChevronUp className="h-4 w-4" />
              ) : (
                <ChevronDown className="h-4 w-4" />
              )}
            </button>
          </td>
        )}
        {columns.map((col, i) => (
          <td key={col.key} className={`px-5 py-3 ${col.className ?? ""}`}>
            {col.render ? col.render(row, index) : String((row as Record<string, unknown>)[col.key] ?? "")}
          </td>
        ))}
      </tr>
      {isExpanded && expandContent && (
        <tr className="border-b border-border/50 bg-surface-muted/30">
          <td colSpan={columns.length + 1} className="px-5 py-4">
            {expandContent}
          </td>
        </tr>
      )}
    </>
  );
}
