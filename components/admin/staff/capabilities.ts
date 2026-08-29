import { type StaffCapability } from "@/lib/permissions";

/**
 * Grouped permission matrix for the role editor. Grouping mirrors how the
 * staff_roles seeds (045) and POS presets organize capabilities, so toggling
 * reads naturally section by section.
 */
export interface CapabilityGroup {
  id: string;
  label: string;
  capabilities: StaffCapability[];
}

export const CAPABILITY_GROUPS: readonly CapabilityGroup[] = [
  {
    id: "pos",
    label: "نقطة البيع",
    capabilities: [
      "pos.sell",
      "pos.hold_invoice",
      "pos.request_discount",
      "pos.request_price_override",
      "pos.request_return",
      "pos.request_void",
      "pos.request_open_drawer",
      "pos.reprint_receipt",
      "pos.record_expense",
      "pos.collect_debt",
      "pos.close_shift",
    ],
  },
  {
    id: "backoffice",
    label: "لوحة التحكم والتقارير",
    capabilities: [
      "backoffice.access",
      "reports.view",
      "reports.profitability",
      "shifts.view",
      "shifts.x_report",
    ],
  },
  {
    id: "oversight",
    label: "الرقابة والامتثال",
    capabilities: ["audit.view", "risk.view", "risk.review"],
  },
  {
    id: "inventory",
    label: "المخزون والأصناف",
    capabilities: ["inventory.view", "inventory.manage", "catalog.manage", "catalog.add"],
  },
  {
    id: "supply",
    label: "المشتريات والموردون",
    capabilities: ["purchases.manage", "suppliers.manage"],
  },
  {
    id: "operations",
    label: "العملاء والطباعة والفروع",
    capabilities: ["customers.manage", "print_studio.manage", "branches.manage"],
  },
  {
    id: "administration",
    label: "الإدارة",
    capabilities: ["staff.manage", "settings.manage"],
  },
];

export const CAPABILITY_LABELS: Record<StaffCapability, string> = {
  "pos.sell": "البيع من نقطة البيع",
  "pos.hold_invoice": "تعليق الفواتير",
  "pos.request_discount": "طلب خصم (بموافقة المدير فوق الحد)",
  "pos.request_price_override": "طلب تعديل سعر",
  "pos.request_return": "طلب مرتجع",
  "pos.request_void": "طلب إلغاء فاتورة",
  "pos.request_open_drawer": "طلب فتح الدرج النقدي",
  "pos.reprint_receipt": "إعادة طباعة الإيصال",
  "pos.record_expense": "تسجيل مصروف",
  "pos.collect_debt": "تحصيل ذمم العملاء",
  "pos.close_shift": "إغلاق الوردية",
  "backoffice.access": "الدخول إلى لوحة التحكم",
  "reports.view": "عرض تقارير المبيعات",
  "reports.profitability": "تقرير الأرباح والخسائر",
  "shifts.view": "عرض الورديات",
  "shifts.x_report": "تقرير X للوردية",
  "audit.view": "سجل الرقابة والتغييرات",
  "risk.view": "محرك المخاطر",
  "risk.review": "مراجعة وتقييد المخاطر",
  "inventory.view": "عرض المخزون",
  "inventory.manage": "إدارة المخزون والحركات",
  "catalog.manage": "إدارة الأصناف",
  "catalog.add": "إضافة أصناف من الجوال",
  "purchases.manage": "إدارة المشتريات أوامر التوريد",
  "suppliers.manage": "إدارة الموردين",
  "customers.manage": "إدارة العملاء والذمم",
  "print_studio.manage": "استوديو الطباعة",
  "branches.manage": "إدارة الفروع والأجهزة",
  "staff.manage": "إدارة الموظفين والأدوار",
  "settings.manage": "إدارة إعدادات المتجر",
};

export type RoleLimitKey =
  | "maxDiscountPercent"
  | "maxRefundAmount"
  | "maxPriceReductionPercent"
  | "maxCashVarianceWithoutApproval";

export const ROLE_LIMIT_FIELDS: readonly {
  key: RoleLimitKey;
  label: string;
  suffix: string;
  currency?: boolean;
}[] = [
  { key: "maxDiscountPercent", label: "أقصى خصم مسموح", suffix: "%" },
  { key: "maxRefundAmount", label: "أقصى مرتجع مسموح", suffix: "دينار", currency: true },
  { key: "maxPriceReductionPercent", label: "أقصى تخفيض للسعر", suffix: "%" },
  { key: "maxCashVarianceWithoutApproval", label: "فرق الصندوق المسموح", suffix: "دينار", currency: true },
];