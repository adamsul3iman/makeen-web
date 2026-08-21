"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Search, Loader2, XCircle, CheckCircle } from "lucide-react";
import { cn } from "@/lib/cn";

interface ColumnDef<T> {
  accessorKey: string;
  header: string;
  cell: (info: { row: T }) => React.ReactNode;
  className?: string;
}

interface AdminTableProps<T = any> {
  data: T[];
  columns: ColumnDef<T>[];
  /** Page size selector options */
  pageOptions?: number[];
  /** Initial page (controlled) */
  initialPage?: number;
  /** Initial page size (controlled) */
  initialPageSize?: number;
  /** Search column accessorKey, optional */
  searchKey?: keyof T;
  /** Callback on page change */
  onPageChange?: (pageIndex: number, pageSize: number) => void;
  /** Callback on sort change */
  onSortChange?: (sortBy: { id: string; desc: boolean }) => void;
  /** Callback on search */
  onSearch?: (query: string) => void;
  /** Bulk selection callback */
  onBulkSelect?: (selectedIds: string[]) => void;
  /** Render extra actions column (e.g., edit, delete) */
  actions?: (row: T) => React.ReactNode;
  /** Table title above the grid */
  title?: string;
  /** Empty state illustration/description */
  emptyState?: {
    icon: React.ComponentType;
    title: string;
    description: string;
    cta?: string;
    ctaOnClick?: () => void;
  };
}

const DEFAULT_PAGE_OPTIONS = [5, 10, 25, 50];
const DEFAULT_PAGE_SIZE = 10;

export function AdminTable<T>({
  data,
  columns,
  pageOptions = DEFAULT_PAGE_OPTIONS,
  initialPage = 0,
  initialPageSize = DEFAULT_PAGE_SIZE,
  searchKey,
  onPageChange,
  onSortChange,
  onSearch,
  onBulkSelect,
  actions,
  title,
  emptyState,
}: AdminTableProps<T>) {
  const [pageIndex, setPageIndex] = useState(initialPage);
  const [pageSize, setPageSizeState] = useState(initialPageSize);
  const [sortBy, setSortBy] = useState({ id: "created_at", desc: false });
  const [searchQuery, setSearchQuery] = useState("");

  // Filtered & sorted data
  const sortedData = data.slice().sort((a, b) => {
    const field = sortBy.id === "created_at" ? "created_at" : sortBy.id;
    const aVal = a[field as keyof T] ?? a[field as keyof T] ?? "";
    const bVal = b[field as keyof T] ?? b[field as keyof T] ?? "";
    if (typeof aVal === "string" && typeof bVal === "string") {
      const comparison = aVal.localeCompare(bVal);
      return sortBy.desc ? -comparison : comparison;
    }
    return 0;
  });

  const filteredData = searchQuery
    ? sortedData.filter((row) => {
        if (!searchKey) return false;
        const value = row[searchKey as keyof T] ?? "";
        return String(value)
          .toString()
          .toLowerCase()
          .includes(searchQuery.toLowerCase());
      })
    : sortedData;

  // Pagination calc
  const totalPages = Math.max(1, Math.ceil(filteredData.length / pageSize));
  const clampedPage = Math.min(pageIndex, totalPages - 1);
  const pagedData = filteredData.slice(
    clampedPage * pageSize,
    clampedPage * pageSize + pageSize
  );

  // Bulk selection state
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  // Handlers
  const handlePageChange = useCallback(
    (newPageIndex: number, newPageSize: number) => {
      setPageIndex(newPageIndex);
      setPageSizeState(newPageSize);
      onPageChange?.(newPageIndex, newPageSize);
    },
    [onPageChange]
  );

  const handleSizeChange = useCallback(
    (newPageSize: number) => {
      setPageSizeState(newPageSize);
      setPageIndex(0);
      onPageChange?.(0, newPageSize);
    },
    [onPageChange]
  );

  const handleSortChange = useCallback(
    (newSortBy: { id: string; desc: boolean }) => {
      setSortBy(newSortBy);
      onSortChange?.(newSortBy);
    },
    [onSortChange]
  );

  const handleSearch = useCallback(
    (query: string) => {
      setSearchQuery(query);
      onSearch?.(query);
      setPageIndex(0); // reset to first page on new search
    },
    [onSearch]
  );

  const handleToggleSelect = useCallback(
    (rowId: string) => {
      setSelectedIds((ids) => {
        if (ids.includes(rowId)) return ids.filter((id) => id !== rowId);
        return [...ids, rowId];
      });
      onBulkSelect?.(selectedIds);
    },
    [onBulkSelect, selectedIds]
  );

  const handleSelectAll = useCallback(() => {
    const allIds = pagedData.map((row) => String((row as any).id ?? ""));
    setSelectedIds(allIds);
    onBulkSelect?.(allIds);
  }, [onBulkSelect, pagedData]);

  // Render empty state when no data and no search query
  if (data.length === 0 && !searchQuery) {
    return emptyState ? (
<div className="p-8 text-center text-slate-500">
        {/* @ts-ignore */}
        {emptyState.icon && <div className="inline-flex items-center justify-center"><emptyState.icon className="h-12 w-12 mb-3" /></div>}
        <h3 className="mb-1">{emptyState.title}</h3>
        <p className="text-sm">{emptyState.description}</p>
        {emptyState.ctaOnClick && (
          <button
            onClick={emptyState.ctaOnClick}
            className="mt-3 rounded-lg border border-primary px-3 py-1.5 text-sm font-bold text-primary hover:bg-primary/10"
          >
            {emptyState.cta ?? "إضافة جديد"}
          </button>
        )}
      </div>
    ) : (
      <p className="text-sm">لا توجد سجلات</p>
    );
  }

  // Main table render
  return (
    <div className="space-y-4">
      {/* Title */}
      {title && (
        <h2 className="text-lg font-bold text-foreground">{title}</h2>
      )}

      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row gap-3 sm:gap-2 items-end">
        {/* Search input */}
        {searchKey ? (
          <div className="flex-1">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => handleSearch(e.target.value)}
                placeholder="بحث..."
                className="w-full pl-8 h-10 rounded-lg border border-border px-3 text-sm font-bold text-foreground outline-none focus:border-primary"
              />
            </div>
          </div>
        ) : null}

        {/* Page size selector */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-500">عرض:</span>
          {pageOptions.map((opt) => (
            <button
              key={opt}
              onClick={() => handleSizeChange(opt)}
              className={cn(
                "rounded-lg border border-border px-2.5 py-1.5 text-xs font-bold",
                pageSize === opt ? "bg-primary text-primary-foreground" : "text-slate-500 hover:bg-surface-muted"
              )}
            >
              {opt}
            </button>
          ))}
          <span className="text-xs text-slate-500">صفحة</span>
          <select
            value={pageIndex + 1}
            onChange={(e) => {
              const newPage = parseInt(e.target.value) - 1;
              if (newPage >= 0 && newPage < totalPages) {
                handlePageChange(newPage, pageSize);
              }
            }}
            className="rounded-lg border border-border px-2 py-1 text-xs font-bold"
          >
            <option value="1">1</option>
            <option value="2">2</option>
            <option value="3">3</option>
            <option value="4">4</option>
            <option value="5">5</option>
            <option value="6">6</option>
            <option value="7">7</option>
            <option value="8">8</option>
            <option value="9">9</option>
            <option value="10">10</option>
          </select>
        </div>
      </div>

      {/* Table */}
      <table className="w-full rounded-lg overflow-hidden border-border">
<thead>
          <tr className="border-b border-border bg-slate-50">
            {columns.map((col) => (
              <th key={col.accessorKey} className="text-left font-black text-sm pe-2">
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
          <tbody>
            {pagedData.map((row, index) => (
              <tr
                key={String((row as any).id ?? "")}
                className={cn(
                  "border-b border-border/70 cursor-pointer hover:bg-slate-50 transition-colors",
                  selectedIds.includes(String((row as any).id ?? "")) && "bg-primary/10 text-primary"
                )}
                onClick={() => handleToggleSelect(String((row as any).id ?? ""))}
              >
                {columns.map((col) => (
                  <td key={String(col.accessorKey)} className={cn(
                    "text-left py-3 px-4 text-sm",
                    col.className || "",
                    selectedIds.includes(String((row as any).id ?? "")) && "font-bold text-primary"
                  )}>
                    {col.cell({ row })}
                    {actions && <div className="text-right">{actions(row)}</div>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t border-border bg-slate-50 sticky top-0">
            {columns.map((col) => (
              <th key={col.accessorKey} className="text-left font-black text-sm pe-2">
                {col.header}
              </th>
            ))}
          </tfoot>
        </table>

      {/* Pagination controls */}
      {totalPages > 1 && (
        <div className="flex justify-between items-center pt-3">
          <span className="text-sm text-slate-500">
            {`${clampedPage + 1} من ${totalPages}`}
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => handlePageChange(Math.max(0, clampedPage - 1), pageSize)}
              disabled={clampedPage === 0}
              className={cn(
                "rounded-lg border border-border px-3 py-1.5 text-sm font-bold",
                clampedPage === 0 ? "opacity-40 cursor-not-allowed" : ""
              )}
            >
              السابق
            </button>
            <button
              onClick={() => handlePageChange(Math.min(totalPages - 1, clampedPage + 1), pageSize)}
              disabled={clampedPage >= totalPages - 1}
              className={cn(
                "rounded-lg border border-border px-3 py-1.5 text-sm font-bold",
                clampedPage >= totalPages - 1 ? "opacity-40 cursor-not-allowed" : ""
              )}
            >
              التالي
            </button>
          </div>
        </div>
      )}

      {/* Bulk select toolbar */}
      {data.length > 0 && (
        <div className="mt-3 flex flex-col sm:flex-row gap-2">
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={selectedIds.length === filteredData.length && filteredData.length > 0}
              onChange={() => handleSelectAll()}
              className="rounded w-4 h-4 border border-primary cursor-pointer"
            />
            <span className="text-xs text-slate-600">
              تحديد الكل ({selectedIds.length} من {filteredData.length})
            </span>
          </div>
          {selectedIds.length > 0 && (
            <button
              onClick={() => {
                alert(`تم تحديد ${selectedIds.length}-record(s)`);
              }}
              className={cn(
                "rounded-lg border border-destructive px-3 py-1.5 text-sm font-bold text-destructive-foreground hover:bg-destructive/10"
              )}
            >
              حذف محددة
            </button>
          )}
        </div>
      )}
    </div>
  );
}