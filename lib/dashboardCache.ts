import type { ReportsOverview } from "@/types/reports.types";

const DASHBOARD_CACHE_PREFIX = "makeen-dashboard-overview";

function keyFor(storeId: string): string {
  return `${DASHBOARD_CACHE_PREFIX}:${storeId}`;
}

/** Reads the last reported overview for a store, if any. Returns null when the
 *  cache is empty, stale, or the environment has no storage (SSR/private). */
export function readDashboardOverview(storeId: string | null | undefined): ReportsOverview | null {
  if (!storeId || typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(keyFor(storeId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ReportsOverview;
    if (!parsed || typeof parsed !== "object" || !parsed.summary || !parsed.generatedAt) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Persists the latest overview so the next visit paints instantly offline-first. */
export function writeDashboardOverview(storeId: string | null | undefined, overview: ReportsOverview): void {
  if (!storeId || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(keyFor(storeId), JSON.stringify(overview));
  } catch {
    // Quota/private-mode failures are non-fatal — the overview just isn't cached.
  }
}
