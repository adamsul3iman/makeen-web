"use client";

import { usePathname } from "next/navigation";

const EXACT_MATCH_ROUTES = new Set(["/admin"]);

/**
 * Unified active-route detection. Uses prefix matching for most routes
 * so that e.g. /admin/inventory/movements highlights "المخزون".
 * The dashboard /admin uses exact match to avoid false positives.
 */
export function useActiveRoute(): (href: string) => boolean {
  const pathname = usePathname();
  return (href: string) => {
    if (EXACT_MATCH_ROUTES.has(href)) return pathname === href;
    return pathname === href || pathname.startsWith(href + "/");
  };
}
