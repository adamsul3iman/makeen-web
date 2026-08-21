"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { posFetch } from "@/lib/tenantClient";

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

const cache = new Map<string, CacheEntry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();
const listeners = new Map<string, Set<() => void>>();

const STALE_MS = 30_000;
const GC_TTL_MS = 5 * 60_000;
const MAX_CACHE_ENTRIES = 50;

function evictOldest(): void {
  let oldestKey: string | null = null;
  let oldestTs = Infinity;
  for (const [key, entry] of cache) {
    if (entry.timestamp < oldestTs) {
      oldestTs = entry.timestamp;
      oldestKey = key;
    }
  }
  if (oldestKey) {
    cache.delete(oldestKey);
    listeners.delete(oldestKey);
  }
}

function gcCache(): void {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.timestamp > GC_TTL_MS) {
      cache.delete(key);
      listeners.delete(key);
    }
  }
}

function subscribe(url: string, cb: () => void) {
  if (!listeners.has(url)) listeners.set(url, new Set());
  listeners.get(url)!.add(cb);
  return () => {
    listeners.get(url)?.delete(cb);
    if (listeners.get(url)?.size === 0) listeners.delete(url);
  };
}

function notify(url: string) {
  listeners.get(url)?.forEach((cb) => cb());
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await posFetch(url, { cache: "no-store" });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

async function revalidate<T>(url: string): Promise<T> {
  const existing = inflight.get(url);
  if (existing) return existing as Promise<T>;

  const promise = fetchJson<T>(url).finally(() => inflight.delete(url));
  inflight.set(url, promise);
  const data = await promise;

  if (cache.size >= MAX_CACHE_ENTRIES) {
    gcCache();
  }
  if (cache.size >= MAX_CACHE_ENTRIES) {
    evictOldest();
  }

  cache.set(url, { data, timestamp: Date.now() });
  notify(url);
  return data;
}

export interface UseAdminQueryResult<T> {
  data: T | null;
  error: string | null;
  isLoading: boolean;
  isStale: boolean;
  mutate: (updater?: (current: T | null) => T | null) => void;
  refetch: () => void;
}

export function useAdminQuery<T>(url: string | null, staleMs = STALE_MS): UseAdminQueryResult<T> {
  const [, forceRender] = useState(0);
  const mountedRef = useRef(true);

  const cached = url ? (cache.get(url) as CacheEntry<T> | undefined) : undefined;
  const isStale = !cached || Date.now() - cached.timestamp > staleMs;

  const [data, setData] = useState<T | null>(cached?.data ?? null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(!cached);

  const refetch = useCallback(() => {
    if (!url) return;
    setError(null);
    revalidate<T>(url)
      .then((d) => {
        if (mountedRef.current) {
          setData(d);
          setIsLoading(false);
        }
      })
      .catch((err) => {
        if (mountedRef.current) {
          setError(err instanceof Error ? err.message : "تعذر تحميل البيانات");
          setIsLoading(false);
        }
      });
  }, [url]);

  const mutate = useCallback(
    (updater?: (current: T | null) => T | null) => {
      if (!url) return;
      if (updater) {
        const next = updater((cache.get(url)?.data as T | null) ?? null);
        if (next !== null) {
          cache.set(url, { data: next as unknown, timestamp: Date.now() });
          setData(next);
          notify(url);
        }
      } else {
        refetch();
      }
    },
    [url, refetch],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!url) return;

    if (cached && !isStale) {
      setData(cached.data);
      setIsLoading(false);
      return;
    }

    if (cached) {
      setData(cached.data);
      setIsLoading(false);
      revalidate<T>(url)
        .then((d) => mountedRef.current && setData(d))
        .catch((err) => {
          if (mountedRef.current) {
            setError(err instanceof Error ? err.message : "تعذر تحديث البيانات");
          }
        });
    } else {
      setIsLoading(true);
      revalidate<T>(url)
        .then((d) => mountedRef.current && (setData(d), setIsLoading(false)))
        .catch((err) => {
          if (mountedRef.current) {
            setError(err instanceof Error ? err.message : "تعذر تحميل البيانات");
            setIsLoading(false);
          }
        });
    }

    return subscribe(url, () => {
      const entry = cache.get(url) as CacheEntry<T> | undefined;
      if (entry && mountedRef.current) setData(entry.data);
    });
  }, [url, isStale]);

  return { data, error, isLoading, isStale, mutate, refetch };
}

export function invalidateAdminQuery(url: string) {
  cache.delete(url);
  notify(url);
}

export function prefetchAdminQuery<T>(url: string): Promise<T> {
  const existing = cache.get(url) as CacheEntry<T> | undefined;
  if (existing && Date.now() - existing.timestamp < STALE_MS) {
    return Promise.resolve(existing.data);
  }
  return revalidate<T>(url);
}
