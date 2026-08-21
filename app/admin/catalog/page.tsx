"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Catalog shortcut: redirect /admin/catalog to /admin/categories.
 * Client-side redirect so it works with static export.
 */
export default function AdminCatalogRedirectPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/admin/categories");
  }, [router]);
  return null;
}
