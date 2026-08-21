export const STAFF_CAPABILITIES = [
  "pos.sell",
  "pos.hold_invoice",
  "pos.request_discount",
  "pos.request_price_override",
  "pos.request_return",
  "pos.request_void",
  "pos.request_open_drawer",
  "pos.record_expense",
  "pos.collect_debt",
  "pos.close_shift",
  "pos.reprint_receipt",
  "backoffice.access",
  "reports.view",
  "reports.profitability",
  "shifts.view",
  "shifts.x_report",
  "audit.view",
  "risk.view",
  "risk.review",
  "inventory.view",
  "inventory.manage",
  "catalog.manage",
  "catalog.add",
  "purchases.manage",
  "suppliers.manage",
  "customers.manage",
  "print_studio.manage",
  "branches.manage",
  "staff.manage",
  "settings.manage",
] as const;

export type StaffCapability = (typeof STAFF_CAPABILITIES)[number];

/**
 * Capabilities that unlock the Smart Goods-In mobile module. The narrow
 * mobile role (`catalog.add` — inventory clerk) shares the route with the
 * broader back-office supply roles.
 */
export const RECEIVING_CAPABILITIES: readonly StaffCapability[] = [
  "catalog.add",
  "inventory.manage",
  "purchases.manage",
  "suppliers.manage",
];

/** True when the actor may operate the goods-in module. */
export function hasAnyReceivingCapability(actor: CapabilityActor | null | undefined): boolean {
  return RECEIVING_CAPABILITIES.some((cap) => hasCapability(actor, cap));
}

/** The first receiving capability the actor holds (used by the mobile gate probe). */
export function firstReceivingCapability(actor: CapabilityActor | null | undefined): StaffCapability | null {
  return RECEIVING_CAPABILITIES.find((cap) => hasCapability(actor, cap)) ?? null;
}

export const STAFF_ROLE_CODES = [
  "cashier",
  "senior_cashier",
  "accountant",
  "inventory_clerk",
  "inventory_manager",
  "store_manager",
] as const;

export type StaffRoleCode = (typeof STAFF_ROLE_CODES)[number];

export interface StaffLimits {
  [key: string]: number | null;
  maxDiscountPercent: number;
  maxRefundAmount: number | null;
  maxPriceReductionPercent: number;
  maxCashVarianceWithoutApproval: number;
}

export interface StaffRoleDefinition {
  code: StaffRoleCode;
  name: string;
  description: string;
  capabilities: StaffCapability[];
  limits: StaffLimits;
  sortOrder: number;
}

const POS_BASE: StaffCapability[] = [
  "pos.sell",
  "pos.hold_invoice",
  "pos.request_discount",
  "pos.request_price_override",
  "pos.request_return",
  "pos.request_void",
  "pos.request_open_drawer",
  "pos.reprint_receipt",
];

const BACKOFFICE_OPERATIONAL: StaffCapability[] = [
  "backoffice.access",
  "reports.view",
  "reports.profitability",
  "shifts.view",
  "shifts.x_report",
  "audit.view",
  "risk.view",
  "risk.review",
  "inventory.view",
  "inventory.manage",
  "catalog.manage",
  "purchases.manage",
  "suppliers.manage",
  "customers.manage",
  "print_studio.manage",
  "branches.manage",
];

export const STAFF_ROLE_PRESETS: Record<StaffRoleCode, StaffRoleDefinition> = {
  cashier: {
    code: "cashier",
    name: "كاشير",
    description: "البيع اليومي مع طلب موافقة المدير للإجراءات الحساسة.",
    capabilities: [...POS_BASE, "pos.record_expense", "pos.collect_debt", "pos.close_shift"],
    limits: {
      maxDiscountPercent: 0,
      maxRefundAmount: 0,
      maxPriceReductionPercent: 0,
      maxCashVarianceWithoutApproval: 0,
    },
    sortOrder: 10,
  },
  senior_cashier: {
    code: "senior_cashier",
    name: "كاشير أول",
    description: "تشغيل نقطة البيع والمصروفات وتسوية الذمم مع بقاء الاعتماد المالي محمياً.",
    capabilities: [
      ...POS_BASE,
      "pos.record_expense",
      "pos.collect_debt",
      "pos.close_shift",
      "shifts.view",
    ],
    limits: {
      maxDiscountPercent: 10,
      maxRefundAmount: 50,
      maxPriceReductionPercent: 10,
      maxCashVarianceWithoutApproval: 1,
    },
    sortOrder: 20,
  },
  accountant: {
    code: "accountant",
    name: "محاسب",
    description: "قراءة التقارير والربحية والورديات وسجل الرقابة دون تعديل الإعدادات.",
    capabilities: [
      "backoffice.access",
      "reports.view",
      "reports.profitability",
      "shifts.view",
      "shifts.x_report",
      "audit.view",
      "risk.view",
    ],
    limits: {
      maxDiscountPercent: 0,
      maxRefundAmount: 0,
      maxPriceReductionPercent: 0,
      maxCashVarianceWithoutApproval: 0,
    },
    sortOrder: 30,
  },
  inventory_clerk: {
    code: "inventory_clerk",
    name: "أمين مخزون",
    description: "إضافة المنتجات عبر الكاميرا من الموبايل فقط — دون نقطة البيع أو التقارير المالية.",
    capabilities: ["catalog.add"],
    limits: {
      maxDiscountPercent: 0,
      maxRefundAmount: 0,
      maxPriceReductionPercent: 0,
      maxCashVarianceWithoutApproval: 0,
    },
    sortOrder: 35,
  },
  inventory_manager: {
    code: "inventory_manager",
    name: "مسؤول مخزون",
    description: "إدارة الأصناف والمخزون والمشتريات والموردين مع تقارير التشغيل.",
    capabilities: [
      "backoffice.access",
      "reports.view",
  "inventory.view",
  "inventory.manage",
  "catalog.manage",
  "catalog.add",
  "purchases.manage",
      "suppliers.manage",
      "print_studio.manage",
    ],
    limits: {
      maxDiscountPercent: 0,
      maxRefundAmount: 0,
      maxPriceReductionPercent: 0,
      maxCashVarianceWithoutApproval: 0,
    },
    sortOrder: 40,
  },
  store_manager: {
    code: "store_manager",
    name: "مدير متجر",
    description: "إدارة التشغيل والتقارير والمخزون مع استثناء حساب المالك وإعدادات الأمان.",
    capabilities: [
      ...POS_BASE,
      "pos.record_expense",
      "pos.collect_debt",
      "pos.close_shift",
      ...BACKOFFICE_OPERATIONAL,
    ],
    limits: {
      maxDiscountPercent: 25,
      maxRefundAmount: 250,
      maxPriceReductionPercent: 25,
      maxCashVarianceWithoutApproval: 5,
    },
    sortOrder: 50,
  },
};

export interface CapabilityActor {
  role?: string | null;
  roleCode?: string | null;
  capabilities?: readonly string[] | null;
}

export function isStaffCapability(value: unknown): value is StaffCapability {
  return typeof value === "string" && (STAFF_CAPABILITIES as readonly string[]).includes(value);
}

export function isStaffRoleCode(value: unknown): value is StaffRoleCode {
  return typeof value === "string" && (STAFF_ROLE_CODES as readonly string[]).includes(value);
}

export function normalizeStaffRoleCode(value: unknown): StaffRoleCode {
  if (isStaffRoleCode(value)) return value;
  if (value === "محاسب") return "accountant";
  if (value === "أمين مخزون") return "inventory_clerk";
  if (value === "مسؤول مخزون") return "inventory_manager";
  if (value === "مدير متجر") return "store_manager";
  if (value === "كاشير أول") return "senior_cashier";
  return "cashier";
}

export function capabilitiesFor(actor: CapabilityActor | null | undefined): StaffCapability[] {
  if (!actor) return [];
  if (actor.role === "admin" || actor.role === "مدير") return [...STAFF_CAPABILITIES];
  if (Array.isArray(actor.capabilities)) {
    return actor.capabilities.filter(isStaffCapability);
  }
  return [...STAFF_ROLE_PRESETS[normalizeStaffRoleCode(actor.roleCode ?? actor.role)].capabilities];
}

export function hasCapability(
  actor: CapabilityActor | null | undefined,
  capability: StaffCapability,
): boolean {
  return capabilitiesFor(actor).includes(capability);
}

export function limitsFor(actor: CapabilityActor | null | undefined): StaffLimits {
  if (actor?.role === "admin" || actor?.role === "مدير") {
    return {
      maxDiscountPercent: 100,
      maxRefundAmount: null,
      maxPriceReductionPercent: 100,
      maxCashVarianceWithoutApproval: Number.POSITIVE_INFINITY,
    };
  }
  return STAFF_ROLE_PRESETS[normalizeStaffRoleCode(actor?.roleCode ?? actor?.role)].limits;
}

export function capabilityForAdminPath(pathname: string): StaffCapability {
  if (pathname.startsWith("/admin/reports/profitability")) return "reports.profitability";
  if (pathname.startsWith("/admin/reports")) return "reports.view";
  if (pathname.startsWith("/admin/shifts")) return "shifts.view";
  if (pathname.startsWith("/admin/risk")) return "risk.view";
  if (pathname.startsWith("/admin/inventory")) return "inventory.view";
  if (pathname.startsWith("/admin/categories") || pathname.startsWith("/admin/catalog")) return "catalog.manage";
  if (pathname.startsWith("/admin/barcodes") || pathname.startsWith("/admin/print-studio")) return "print_studio.manage";
  if (pathname.startsWith("/admin/purchases")) return "purchases.manage";
  if (pathname.startsWith("/admin/supplier")) return "suppliers.manage";
  if (pathname.startsWith("/admin/debts") || pathname.startsWith("/admin/loyalty")) return "customers.manage";
  if (pathname.startsWith("/admin/branches") || pathname.startsWith("/admin/devices")) return "branches.manage";
  if (pathname.startsWith("/admin/staff")) return "staff.manage";
  if (pathname.startsWith("/admin/settings")) return "settings.manage";
  if (pathname.startsWith("/admin/expenses")) return "pos.record_expense";
  return "backoffice.access";
}

export function firstBackofficePath(actor: CapabilityActor | null | undefined): string {
  if (hasCapability(actor, "reports.view")) return "/admin/reports";
  if (hasCapability(actor, "risk.view")) return "/admin/risk";
  if (hasCapability(actor, "inventory.view")) return "/admin/inventory";
  if (hasCapability(actor, "customers.manage")) return "/admin/debts";
  return "/admin";
}

export interface HomeRoutingActor {
  role?: string | null;
  roleCode?: string | null;
  /** Device-session staff role code (the field the signed cookie carries). */
  staffRoleCode?: string | null;
}

/**
 * Where an authenticated device session belongs. Used by the root `proxy.ts`
 * to redirect role-home on `/login` and to bounce a session off a route it
 * must not see (e.g. an inventory clerk hitting `/pos`).
 */
export function homePathForDevice(actor: HomeRoutingActor | null | undefined): string {
  if (!actor) return "/login";
  if (actor.role === "admin") return "/admin";
  const roleCode = normalizeStaffRoleCode(actor.staffRoleCode ?? actor.roleCode ?? actor.role);
  if (roleCode === "inventory_clerk") return "/mobile/add-product";
  if (roleCode === "cashier" || roleCode === "senior_cashier") return "/pos";
  // Warehouse staff land straight in the Smart Goods-In flow; store managers
  // need the back-office dashboard so they keep /admin as their home.
  if (roleCode === "inventory_manager") return "/mobile/receiving";
  return "/admin";
}

export function deviceCanAccessPath(
  actor: HomeRoutingActor | null | undefined,
  pathname: string,
): boolean {
  if (!actor) return false;
  if (actor.role === "admin") return true;
  const roleCode = normalizeStaffRoleCode(actor.staffRoleCode ?? actor.roleCode ?? actor.role);

  // The Smart Goods-In mobile module is open to the supply roles (inventory
  // clerk, inventory manager, store manager) regardless of their other areas.
  // Additive, not an early return: supply roles must still reach /admin and
  // /pos when their role grants it — a bare early return here once bounced
  // back-office roles into an infinite /admin redirect loop.
  if (
    hasAnyReceivingCapability({ roleCode }) &&
    (pathname === "/mobile" || pathname.startsWith("/mobile/"))
  ) {
    return true;
  }

  if (roleCode === "inventory_clerk") {
    return pathname === "/" || pathname === "/mobile" || pathname.startsWith("/mobile/");
  }
  if (pathname === "/" || pathname === "/pos" || pathname.startsWith("/pos/")) {
    return roleCode === "cashier" || roleCode === "senior_cashier";
  }
  if (roleCode !== "cashier" && roleCode !== "senior_cashier") {
    return pathname === "/admin" || pathname.startsWith("/admin/");
  }
  return false;
}
