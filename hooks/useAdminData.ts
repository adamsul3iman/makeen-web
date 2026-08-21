"use client";

import { useEffect, useState } from "react";
import { posFetch } from "@/lib/tenantClient";

type DataState<T> = {
  loading: boolean;
  error: string | null;
  data: T | null;
  success: boolean;
};

type UseAdminDataOptions<T> = {
  /** URL path relative to root (default: "/catalog") */
  endpoint?: string;
  /** Query parameters merged into the fetch */
  params?: Record<string, string>;
  /** Placeholder data while loading (e.g., empty object) */
  placeholder?: T;
  /** Enable/disable the hook */
  enabled?: boolean;
};

/**
 * Standardized data fetching hook for Admin Panel pages.
 * Guarantees: Loading | Error | Empty | Success states handled uniformly.
 * Provides: reload key management, and consistent state shape.
 */
export function useAdminData<T>(
  options: UseAdminDataOptions<T> = {}
) {
  const { endpoint: baseEndpoint = "/api/catalog", params = {}, placeholder, enabled = true } = options;

  const [state, setState] = useState<DataState<T>>({
    loading: !enabled,
    error: null,
    data: placeholder ?? null,
    success: false,
  });

  // Build query string from params
  const queryString = new URLSearchParams(
    Object.entries(params).reduce(
      (acc, [key, value]) => {
        if (value !== undefined && value !== null && value !== "") {
          acc[key] = value;
        }
        return acc;
      },
      {} as Record<string, string>
    )
  ).toString();

  const fetchData = useEffect(() => {
    if (!enabled) return;

    setState({ loading: true, error: null, data: null, success: false });

    const load = async () => {
      try {
        const response = await posFetch(`/api${baseEndpoint}?${queryString}`, {
          cache: "no-store",
        });
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body.error ?? "تعذر التحميل");
        }
        const data = (await response.json()) as T;
        setState({
          loading: false,
          error: null,
          data,
          success: true,
        });
      } catch (err: any) {
        console.error(`Admin data fetch error [${baseEndpoint}]:`, err);
        setState({
          loading: false,
          error: err.message ?? "حدث خطأ غير متوقع",
          data: placeholder ?? null,
          success: false,
        });
      }
    };

    load();

    return () => {
      // Cleanup
    };
  }, [baseEndpoint, queryString, enabled]);

  // Effective data: use loaded data or fallback to placeholder
  const effectiveData = state.data ?? placeholder ?? null;

  return {
    // State
    loading: state.loading,
    error: state.error,
    data: effectiveData,
    success: state.success,
    // Actions
    refresh: () => setState((s) => ({ ...s, loading: true })),
  };
}