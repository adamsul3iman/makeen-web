"use client";

import Link from "next/link";
import {
  Barcode,
  BarChart3,
  Building2,
  Calculator,
  FileSpreadsheet,
  FolderTree,
  Gem,
  Grid2x2,
  HandCoins,
  History,
  LayoutDashboard,
  Package,
  PackageSearch,
  ReceiptText,
  ScrollText,
  Settings,
  Truck,
  Usb,
  Users,
  Wallet,
} from "lucide-react";
import { ModalShell } from "@/components/ui/ModalShell";
import { usePosStore } from "@/store/usePosStore";
import { capabilityForAdminPath, hasCapability } from "@/lib/permissions";

const HUB_ITEMS = [
  { href: "/admin", label: "الرئيسية", icon: LayoutDashboard },
  { href: "/admin/reports", label: "التقارير والذكاء التجاري", icon: BarChart3 },
  { href: "/admin/reports/sales", label: "سجل المبيعات والفواتير", icon: ReceiptText },
  { href: "/admin/reports/profitability", label: "قائمة الدخل والربحية", icon: Calculator },
  { href: "/admin/inventory", label: "المخزون", icon: Package },
  { href: "/admin/inventory/movements", label: "حركات المخزون", icon: History },
  { href: "/admin/categories", label: "الفئات الهرمية", icon: FolderTree },
  { href: "/admin/catalog-excel", label: "استيراد وتصدير إكسل", icon: FileSpreadsheet },
  { href: "/admin/barcodes", label: "ملصقات الباركود", icon: Barcode },
  { href: "/admin/staff", label: "إدارة الموظفين", icon: Users },
  { href: "/admin/branches", label: "الفروع والكاشيرات", icon: Building2 },
  { href: "/admin/debts", label: "الذمم والعملاء", icon: HandCoins },
  { href: "/admin/loyalty", label: "نقاط الولاء", icon: Gem },
  { href: "/admin/expenses", label: "المصروفات", icon: Wallet },
  { href: "/admin/suppliers", label: "الموردون", icon: Truck },
  { href: "/admin/supplier-accounts", label: "فواتير الموردين والدفعات", icon: HandCoins },
  { href: "/admin/purchases", label: "أوامر الشراء", icon: PackageSearch },
  { href: "/admin/shifts", label: "تقارير الورديات", icon: ReceiptText },
  { href: "/admin/devices", label: "الأجهزة والطباعة", icon: Usb },
  { href: "/admin/settings", label: "إعدادات المتجر", icon: Settings },
];

/** Inline admin actions that open a POS overlay instead of routing away. */
const HUB_ACTIONS = [
  { key: "invoices", label: "الفواتير السابقة", icon: ReceiptText },
  { key: "audit", label: "سجل الرقابة", icon: ScrollText },
] as const;

/**
 * Admin Hub — the store-owner's quick-launch grid into the back office,
 * opened from the Admin Mode top bar or Ctrl+Shift+A. Pure navigation: every
 * tile is a Link that closes the hub and routes to the target admin page,
 * where the "العودة لنقطة البيع" bridge brings the owner straight back.
 */
export default function AdminHubModal() {
  const isOpen = usePosStore((s) => s.isAdminHubOpen);
  const adminSession = usePosStore((s) => s.adminSession);
  const currentCashier = usePosStore((s) => s.currentCashier);
  const closeAdminHub = usePosStore((s) => s.closeAdminHub);
  const openPreviousInvoicesModal = usePosStore((s) => s.openPreviousInvoicesModal);
  const openAuditLogModal = usePosStore((s) => s.openAuditLogModal);

  if (!isOpen) return null;

  const visibleItems = HUB_ITEMS.filter(({ href }) =>
    hasCapability(currentCashier, capabilityForAdminPath(href)),
  );
  const visibleActions = HUB_ACTIONS.filter(({ key }) =>
    hasCapability(currentCashier, key === "audit" ? "audit.view" : "reports.view"),
  );

  const runAction = (key: (typeof HUB_ACTIONS)[number]["key"]) => {
    closeAdminHub();
    if (key === "invoices") openPreviousInvoicesModal();
    else if (key === "audit") openAuditLogModal();
  };

  return (
    <ModalShell
      title="لوحة التحكم"
      description={`${adminSession?.name ?? currentCashier?.name ?? "الموظف"} • ${
        adminSession ? "مالك المتجر" : currentCashier?.roleName ?? "موظف"
      }`}
      icon={
        <div className="grid h-11 w-11 place-items-center rounded-xl bg-header text-info-bright">
          <Grid2x2 className="h-6 w-6" aria-hidden="true" />
        </div>
      }
      onClose={closeAdminHub}
      size="xl"
      height="lg"
      placement="top"
      bodyClassName="grid grid-cols-2 content-start gap-3 p-6 sm:grid-cols-3 lg:grid-cols-4"
      footer={
        <p className="text-xs font-semibold text-muted-foreground">
          أزرار سريعة للعمليات الخلفية — العودة لنقطة البيع متاحة في كل صفحة
        </p>
      }
    >
      {visibleItems.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              onClick={closeAdminHub}
              className="group flex min-h-32 flex-col items-center justify-center gap-3 rounded-2xl border border-border bg-surface-muted/50 px-3 py-5 text-center transition hover:border-header hover:bg-header hover:text-primary-foreground"
            >
              <div className="grid h-12 w-12 place-items-center rounded-xl bg-surface text-muted shadow-card transition group-hover:bg-header/90 group-hover:text-info-bright">
                <Icon className="h-6 w-6" />
              </div>
              <span className="text-sm font-bold">{label}</span>
            </Link>
      ))}
      {visibleActions.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              type="button"
              onClick={() => runAction(key)}
              className="group flex min-h-32 flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-info/40 bg-info-soft/50 px-3 py-5 text-center transition hover:border-header hover:bg-header hover:text-primary-foreground"
            >
              <div className="grid h-12 w-12 place-items-center rounded-xl bg-surface text-info shadow-card transition group-hover:bg-header/90 group-hover:text-info-bright">
                <Icon className="h-6 w-6" />
              </div>
              <span className="text-sm font-bold">{label}</span>
            </button>
      ))}
    </ModalShell>
  );
}
