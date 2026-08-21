"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { PAGE_TITLES } from "@/lib/adminNav";

function buildBreadcrumbs(pathname: string): { label: string; href: string }[] {
  if (pathname === "/admin") return [];

  const segments = pathname.split("/").filter(Boolean);
  const crumbs: { label: string; href: string }[] = [];

  for (let i = 1; i <= segments.length; i++) {
    const href = "/" + segments.slice(0, i).join("/");
    const label = PAGE_TITLES[href];
    if (label) {
      crumbs.push({ label, href });
    }
  }

  if (crumbs.length === 0 || crumbs[crumbs.length - 1].href !== pathname) {
    crumbs.push({ label: pathname.split("/").pop() ?? "", href: pathname });
  }

  return crumbs;
}

export default function Breadcrumbs() {
  const pathname = usePathname();
  const crumbs = buildBreadcrumbs(pathname);

  if (crumbs.length <= 1) return null;

  return (
    <nav className="flex items-center gap-1.5 text-xs text-muted-foreground" aria-label="التسلسل الهرمي">
      <Link
        href="/admin"
        className="transition hover:text-foreground"
      >
        الرئيسية
      </Link>
      {crumbs.map((crumb, i) => (
        <span key={crumb.href} className="flex items-center gap-1.5">
          <ChevronLeft className="h-3 w-3" />
          {i === crumbs.length - 1 ? (
            <span className="font-medium text-foreground">{crumb.label}</span>
          ) : (
            <Link href={crumb.href} className="transition hover:text-foreground">
              {crumb.label}
            </Link>
          )}
        </span>
      ))}
    </nav>
  );
}
