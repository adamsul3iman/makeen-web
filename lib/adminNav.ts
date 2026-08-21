import type { LucideIcon } from "lucide-react";
import {
  ArrowRight,
  Barcode,
  BarChart3,
  Building2,
  Calculator,
  FolderTree,
  Gem,
  HandCoins,
  History,
  LayoutDashboard,
  Package,
  PackageSearch,
  PanelsTopLeft,
  ReceiptText,
  Settings,
  ShieldAlert,
  Truck,
  Usb,
  Users,
  Wallet,
} from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

export interface NavGroup {
  id: string;
  label: string;
  items: NavItem[];
  /** Only the dashboard "Home" group has no section header. */
  standalone?: boolean;
}

export const NAV_GROUPS: NavGroup[] = [
  {
    id: "home",
    label: "الرئيسية",
    items: [
      { href: "/admin", label: "لوحة التحكم", icon: LayoutDashboard },
    ],
    standalone: true,
  },
  {
    id: "analytics",
    label: "التحليل",
    items: [
      { href: "/admin/reports", label: "التقارير", icon: BarChart3 },
      { href: "/admin/reports/sales", label: "سجل المبيعات", icon: ReceiptText },
      { href: "/admin/reports/profitability", label: "الربحية", icon: Calculator },
    ],
  },
  {
    id: "inventory",
    label: "المخزون والكتالوج",
    items: [
      { href: "/admin/inventory", label: "المخزون", icon: Package },
      { href: "/admin/inventory/movements", label: "حركات المخزون", icon: History },
      { href: "/admin/categories", label: "التصنيفات", icon: FolderTree },
      { href: "/admin/shortages", label: "نقص المخزون", icon: PackageSearch },
    ],
  },
  {
    id: "catalog",
    label: "المنتجات والملصقات",
    items: [
      { href: "/admin/barcodes", label: "ملصقات الباركود", icon: Barcode },
      { href: "/admin/print-studio", label: "استوديو الطباعة", icon: PanelsTopLeft },
      { href: "/admin/purchases", label: "أوامر الشراء", icon: PackageSearch },
    ],
  },
  {
    id: "finance",
    label: "المالية والأطراف",
    items: [
      { href: "/admin/staff", label: "الموظفين", icon: Users },
      { href: "/admin/branches", label: "الفروع", icon: Building2 },
      { href: "/admin/debts", label: "الذمم", icon: HandCoins },
      { href: "/admin/loyalty", label: "الولاء", icon: Gem },
      { href: "/admin/expenses", label: "المصروفات", icon: Wallet },
      { href: "/admin/suppliers", label: "الموردون", icon: Truck },
      { href: "/admin/supplier-accounts", label: "فواتير الموردين", icon: HandCoins },
    ],
  },
  {
    id: "operations",
    label: "التشغيل",
    items: [
      { href: "/admin/shifts", label: "الورديات", icon: ReceiptText },
      { href: "/admin/risk", label: "الرقابة", icon: ShieldAlert },
      { href: "/admin/devices", label: "الأجهزة", icon: Usb },
    ],
  },
  {
    id: "config",
    label: "الإعدادات",
    items: [
      { href: "/admin/settings", label: "الإعدادات", icon: Settings },
    ],
  },
];

export const PAGE_TITLES: Record<string, string> = {
  "/admin": "لوحة التحكم",
  "/admin/inventory": "المخزون",
  "/admin/inventory/movements": "حركات المخزون",
  "/admin/categories": "التصنيفات والعلامات",
  "/admin/barcodes": "ملصقات الباركود",
  "/admin/print-studio": "استوديو الطباعة",
  "/admin/staff": "إدارة الموظفين",
  "/admin/branches": "الفروع والكاشيرات",
  "/admin/debts": "الذمم والعملاء",
  "/admin/loyalty": "نقاط الولاء",
  "/admin/expenses": "المصروفات",
  "/admin/suppliers": "الموردون",
  "/admin/shortages": "نقص المخزون والطلب",
  "/admin/supplier-accounts": "فواتير الموردين والدفعات",
  "/admin/purchases": "أوامر الشراء",
  "/admin/shifts": "تقارير الورديات",
  "/admin/risk": "الرقابة ومكافحة الاحتيال",
  "/admin/devices": "الأجهزة والطباعة",
  "/admin/settings": "إعدادات المتجر",
  "/admin/reports": "التقارير والذكاء التجاري",
  "/admin/reports/sales": "سجل المبيعات والفواتير",
  "/admin/reports/profitability": "قائمة الدخل والربحية",
};

export function getPageTitle(pathname: string): string {
  if (PAGE_TITLES[pathname]) return PAGE_TITLES[pathname];
  const segments = pathname.split("/").filter(Boolean);
  for (let i = segments.length; i > 1; i--) {
    const key = "/" + segments.slice(0, i).join("/");
    if (PAGE_TITLES[key]) return PAGE_TITLES[key];
  }
  return "لوحة التحكم";
}
