/**
 * Mock back-office data for the Admin Dashboard (Phase 10).
 *
 * Data-dense, decision-oriented figures for a Jordanian retail store
 * selling plastics, paper goods, linens, and household items. Every
 * number is meant to drive an action: restock, liquidate, or investigate.
 */

export interface LiveStat {
  id: string;
  label: string;
  value: string;
  /** Percent change vs the previous trading day. */
  delta: number;
  tone: "primary" | "success" | "destructive" | "muted";
}

export interface TopMover {
  id: string;
  name: string;
  category: string;
  units: number;
  revenue: number;
  stock: number;
}

export interface DeadStockItem {
  id: string;
  name: string;
  category: string;
  stock: number;
  value: number;
  /** Days since the last unit sold. */
  lastSoldDaysAgo: number;
}

export interface LowStockAlert {
  id: string;
  name: string;
  category: string;
  stock: number;
  reorderLevel: number;
  /** Estimated days of stock remaining at the current sell-through rate. */
  daysOfStockLeft: number;
}

export interface SalesTrendPoint {
  /** Short Arabic day label, e.g. "أحد 28". */
  date: string;
  sales: number;
}

/** One barcode/packaging variant of a product. */
export interface InventoryVariant {
  id: string;
  barcode: string;
  costPrice: number;
  price: number;
}

/** A product as shown in the inventory grid. */
export interface InventoryProduct {
  id: string;
  name: string;
  category: string;
  baseUnit: string;
  stock: number;
  variants: InventoryVariant[];
}

export interface AdminSnapshot {
  liveStats: LiveStat[];
  topMovers: TopMover[];
  deadStock: DeadStockItem[];
  lowStockAlerts: LowStockAlert[];
  salesTrend: SalesTrendPoint[];
  inventoryProducts: InventoryProduct[];
}

/** Product categories, ordered as they appear in the POS catalog. */
export const PRODUCT_CATEGORIES = [
  "مستلزمات المطبخ",
  "مواد التنظيف",
  "ألبان وأجبان",
  "خضار وفواكه",
  "مياه ومشروبات",
  "سكر ورز",
  "شيبس ووجبات",
  "زيوت ومواد أساسية",
];

/** A staff account that can unlock the register with a 4-digit PIN. */
export interface StaffMember {
  id: string;
  name: string;
  pin: string;
  role: string;
}

export const STAFF_MEMBERS: StaffMember[] = [
  { id: "cashier-ahmed", name: "أحمد", pin: "1234", role: "مدير" },
  { id: "cashier-mahmoud", name: "محمود", pin: "9999", role: "كاشير" },
];

export const STAFF_ROLES = ["مدير", "كاشير", "مسؤول مخزون"];

const INVENTORY_PRODUCTS: InventoryProduct[] = [
  {
    id: "p-cups",
    name: "كاسات بلاستيك 7 أونص",
    category: "مستلزمات المطبخ",
    baseUnit: "حبة",
    stock: 640,
    variants: [
      { id: "pv-cups-1", barcode: "12345", costPrice: 0.09, price: 0.15 },
      { id: "pv-cups-2", barcode: "6250001234567", costPrice: 9.0, price: 12.0 },
    ],
  },
  {
    id: "p-roll",
    name: "رول سفرة نايلون",
    category: "مستلزمات المطبخ",
    baseUnit: "لفة",
    stock: 58,
    variants: [
      { id: "pv-roll-1", barcode: "6250001234574", costPrice: 1.1, price: 1.5 },
    ],
  },
  {
    id: "p-towels",
    name: "بشاكير قطن",
    category: "مستلزمات المطبخ",
    baseUnit: "حبة",
    stock: 48,
    variants: [
      { id: "pv-towels-1", barcode: "6250001234581", costPrice: 2.1, price: 2.75 },
      { id: "pv-towels-2", barcode: "6250001234598", costPrice: 24.0, price: 29.99 },
    ],
  },
  {
    id: "p-glass",
    name: "منظف زجاج",
    category: "مواد التنظيف",
    baseUnit: "عبوة",
    stock: 22,
    variants: [
      { id: "pv-glass-1", barcode: "6291040123456", costPrice: 0.85, price: 1.25 },
    ],
  },
  {
    id: "p-bleach",
    name: "مبيض ملابس",
    category: "مواد التنظيف",
    baseUnit: "عبوة",
    stock: 66,
    variants: [
      { id: "pv-bleach-1", barcode: "6291040123463", costPrice: 0.7, price: 1.1 },
    ],
  },
  {
    id: "p-milk",
    name: "حليب طويل الأمد",
    category: "ألبان وأجبان",
    baseUnit: "عبوة",
    stock: 30,
    variants: [
      { id: "pv-milk-1", barcode: "6291010253456", costPrice: 0.8, price: 0.95 },
      { id: "pv-milk-2", barcode: "6291010253470", costPrice: 18.0, price: 21.6 },
    ],
  },
  {
    id: "p-lemon",
    name: "ليمون بلدي",
    category: "خضار وفواكه",
    baseUnit: "كغ",
    stock: 15,
    variants: [
      { id: "pv-lemon-1", barcode: "2000012345678", costPrice: 0.8, price: 1.2 },
    ],
  },
  {
    id: "p-tomato",
    name: "بندورة بلدية",
    category: "خضار وفواكه",
    baseUnit: "كغ",
    stock: 12,
    variants: [
      { id: "pv-tomato-1", barcode: "2000012345685", costPrice: 0.5, price: 0.8 },
    ],
  },
  {
    id: "p-water",
    name: "ماء معدني 500 مل",
    category: "مياه ومشروبات",
    baseUnit: "عبوة",
    stock: 210,
    variants: [
      { id: "pv-water-1", barcode: "6250000987654", costPrice: 0.18, price: 0.25 },
      { id: "pv-water-2", barcode: "6250000987661", costPrice: 4.2, price: 5.4 },
    ],
  },
  {
    id: "p-sugar",
    name: "سكر رز 500 غم",
    category: "سكر ورز",
    baseUnit: "كيس",
    stock: 5,
    variants: [
      { id: "pv-sugar-1", barcode: "6250000987678", costPrice: 0.45, price: 0.55 },
    ],
  },
  {
    id: "p-rice",
    name: "رز بسمتي 1 كغ",
    category: "سكر ورز",
    baseUnit: "كيس",
    stock: 35,
    variants: [
      { id: "pv-rice-1", barcode: "6250000987685", costPrice: 1.9, price: 2.4 },
    ],
  },
  {
    id: "p-chips",
    name: "شيبس عائلي",
    category: "شيبس ووجبات",
    baseUnit: "كيس",
    stock: 120,
    variants: [
      { id: "pv-chips-1", barcode: "6250000987692", costPrice: 0.25, price: 0.35 },
    ],
  },
  {
    id: "p-oil",
    name: "زيت دوار الشمس 1 لتر",
    category: "زيوت ومواد أساسية",
    baseUnit: "قارورة",
    stock: 6,
    variants: [
      { id: "pv-oil-1", barcode: "6250000987708", costPrice: 2.5, price: 2.9 },
      { id: "pv-oil-2", barcode: "6250000987715", costPrice: 28.0, price: 33.0 },
    ],
  },
];

const ARABIC_DAYS = ["أحد", "اثنين", "ثلاثاء", "أربعاء", "خميس", "جمعة", "سبت"];

/** Build a fresh snapshot stamped with today's date. */
/** A customer holding an outstanding ledger balance. */
export interface CustomerLedger {
  id: string;
  name: string;
  phone: string;
  /** Outstanding debt; positive means the customer owes the store. */
  balance: number;
}

/** One entry on a customer's ledger. */
export interface CustomerLedgerEntry {
  id: string;
  type: "SALE_DEBT" | "SETTLEMENT";
  amount: number;
  balanceAfter: number;
  description: string;
  createdAt: string;
}

/** A closed shift with its full Z-report metrics. */
export interface ShiftReport {
  shiftId: string;
  date: string;
  cashier: string;
  startingCash: number;
  cashSales: number;
  visaSales: number;
  cliqSales: number;
  debtSales: number;
  debtCollections: number;
  discounts: number;
  returns: number;
  expenses: number;
  totalSales: number;
  expectedCashInDrawer: number;
  actualCash: number;
  variance: number;
  status: "CLOSED";
  /** Branch/terminal that ran the shift (Phase 26). */
  branchId?: string;
  terminalId?: string;
  branch?: string;
  terminal?: string;
}

export const CUSTOMERS: CustomerLedger[] = [
  { id: "cust-1", name: "محمد العلي", phone: "0791234567", balance: 42.5 },
  { id: "cust-2", name: "شركة النور للتغليف", phone: "065556677", balance: 187.0 },
  { id: "cust-3", name: "مقهى الريم", phone: "0789876543", balance: 96.25 },
  { id: "cust-4", name: "سوبرماركت الجودة", phone: "0771122334", balance: 254.0 },
  { id: "cust-5", name: "أحمد حمدان", phone: "0795554433", balance: 12.75 },
];

const ENTRY_TYPES: CustomerLedgerEntry["type"][] = ["SALE_DEBT", "SETTLEMENT"];

/** Deterministic mock ledger per customer for offline demo. */
export function buildCustomerEntries(customerId: string): CustomerLedgerEntry[] {
  // Stable small index for arbitrary ids (incl. live UUIDs).
  let hash = 0;
  for (let i = 0; i < customerId.length; i++) {
    hash = (hash * 31 + customerId.charCodeAt(i)) % 997;
  }
  const index = (hash % 9) + 1;
  const chronological: CustomerLedgerEntry[] = [];
  let running = 0;
  for (let i = 0; i < 4; i++) {
    const isSale = i % 2 === 0;
    const type = ENTRY_TYPES[isSale ? 0 : 1];
    const amount = isSale ? 15 + index * 3 + i * 5 : 10 + index * 2;
    running += isSale ? amount : -amount;
    chronological.push({
      id: `${customerId}-tx-${i}`,
      type,
      amount,
      balanceAfter: Math.round(running * 100) / 100,
      description: isSale ? "فاتورة آجلة" : "دفعة نقدية",
      createdAt: new Date(Date.now() - (3 - i) * 86400000 * 3).toISOString(),
    });
  }
  return chronological.reverse();
}

export function buildShiftReports(): ShiftReport[] {
  const cashier = ["أحمد", "محمود", "أحمد", "محمود", "أحمد", "أحمد", "محمود"];
  const raw = [
    { cashSales: 527.1, visaSales: 168.3, cliqSales: 41.5, debtSales: 117.0, debtCollections: 45.0, discounts: 12.4, returns: 45.6, expenses: 18.0, actualCash: 586.1 },
    { cashSales: 489.7, visaSales: 201.5, cliqSales: 27.9, debtSales: 88.0, debtCollections: 30.0, discounts: 9.1, returns: 22.3, expenses: 0, actualCash: 542.2 },
    { cashSales: 612.4, visaSales: 145.0, cliqSales: 63.2, debtSales: 94.5, debtCollections: 0, discounts: 15.8, returns: 38.1, expenses: 32.5, actualCash: 606.9 },
    { cashSales: 445.2, visaSales: 122.8, cliqSales: 19.7, debtSales: 66.0, debtCollections: 22.5, discounts: 7.7, returns: 12.0, expenses: 9.0, actualCash: 460.9 },
    { cashSales: 701.9, visaSales: 233.6, cliqSales: 88.4, debtSales: 140.0, debtCollections: 75.0, discounts: 20.2, returns: 51.4, expenses: 25.0, actualCash: 789.6 },
    { cashSales: 398.6, visaSales: 98.4, cliqSales: 35.1, debtSales: 52.0, debtCollections: 0, discounts: 5.9, returns: 18.2, expenses: 0, actualCash: 405.4 },
    { cashSales: 356.8, visaSales: 111.2, cliqSales: 22.6, debtSales: 47.5, debtCollections: 60.0, discounts: 4.6, returns: 9.9, expenses: 14.5, actualCash: 419.0 },
  ];

  return raw.map((r, i) => {
    const startingCash = 100;
    const totalSales = Math.round((r.cashSales + r.visaSales + r.debtSales) * 100) / 100;
    const expectedCashInDrawer =
      Math.round((startingCash + r.cashSales + r.debtCollections - r.expenses) * 100) / 100;
    const variance = Math.round((r.actualCash - expectedCashInDrawer) * 100) / 100;
    const d = new Date();
    d.setDate(d.getDate() - (raw.length - 1 - i));
    return {
      shiftId: `shift-${d.getTime().toString(36)}`,
      date: `${ARABIC_DAYS[d.getDay()]} ${d.getDate()}`,
      cashier: cashier[i],
      startingCash,
      cashSales: r.cashSales,
      visaSales: r.visaSales,
      cliqSales: r.cliqSales,
      debtSales: r.debtSales,
      debtCollections: r.debtCollections,
      discounts: r.discounts,
      returns: r.returns,
      expenses: r.expenses,
      totalSales,
      expectedCashInDrawer,
      actualCash: r.actualCash,
      variance,
      status: "CLOSED" as const,
    };
  });
}

/** A drawer expense row for the admin ledger. */
export interface ExpenseEntry {
  id: string;
  category: string;
  amount: number;
  notes: string;
  cashier: string;
  createdAt: string;
}

export const EXPENSE_CATEGORIES = [
  "transport",
  "utilities",
  "general",
  "supplies",
  "maintenance",
] as const;

export const EXPENSE_CATEGORY_LABELS: Record<(typeof EXPENSE_CATEGORIES)[number], string> = {
  transport: "نقل وتوصيل",
  utilities: "فواتير وخدمات",
  general: "مصروف عام",
  supplies: "قرطاسية ولوازم",
  maintenance: "صيانة",
};

/** Deterministic mock drawer-expense history for offline demo. */
export function buildExpenseEntries(): ExpenseEntry[] {
  const notes = ["توصيل طلبيات", "فاتورة كهرباء", "شراء أكياس", "إصلاح ميزان", "سند نظافة"];
  return [0, 1, 2, 3, 4].map((i) => {
    const d = new Date();
    d.setDate(d.getDate() - i);
    return {
      id: `exp-${i}`,
      category: EXPENSE_CATEGORIES[i],
      amount: [18.0, 32.5, 9.0, 25.0, 14.5][i],
      notes: notes[i],
      cashier: i % 2 === 0 ? "أحمد" : "محمود",
      createdAt: d.toISOString(),
    };
  });
}

/** A supplier on the purchase ledger. */
export interface SupplierLedger {
  id: string;
  name: string;
  phone: string;
  email: string;
  balance: number;
}

export const SUPPLIERS: SupplierLedger[] = [
  { id: "sup-1", name: "شركة الأمانة للمواد الغذائية", phone: "0792221110", email: "amana@example.com", balance: 0 },
  { id: "sup-2", name: "مستودعات الوطن للتغليف", phone: "0655443322", email: "watan@example.com", balance: 184.5 },
  { id: "sup-3", name: "شركة البتراء للمشروبات", phone: "0780111222", email: "petra@example.com", balance: 0 },
  { id: "sup-4", name: "مؤسسة الريادة للتنظيف", phone: "0798887766", email: "riyada@example.com", balance: 96.0 },
];

/** A purchase-order header with its line items. */
export interface PurchaseOrderEntry {
  id: string;
  supplierName: string;
  totalAmount: number;
  status: "pending" | "received";
  itemCount: number;
  createdAt: string;
}

/** Deterministic mock purchase orders for offline demo. */
export function buildPurchaseOrders(): PurchaseOrderEntry[] {
  const orders: [string, number, "pending" | "received", number][] = [
    ["شركة الأمانة للمواد الغذائية", 312.0, "received", 3],
    ["مستودعات الوطن للتغليف", 144.5, "received", 2],
    ["شركة البتراء للمشروبات", 208.0, "pending", 2],
    ["مؤسسة الريادة للتنظيف", 96.0, "received", 1],
    ["مستودعات الوطن للتغليف", 67.2, "pending", 1],
  ];
  return orders.map(([supplierName, totalAmount, status, itemCount], i) => {
    const d = new Date();
    d.setDate(d.getDate() - i * 2);
    return {
      id: `po-${i}`,
      supplierName,
      totalAmount,
      status,
      itemCount,
      createdAt: d.toISOString(),
    };
  });
}

export function buildAdminSnapshot(): AdminSnapshot {
  const trendValues = [642, 718, 690, 803, 754, 887, 812];

  const salesTrend: SalesTrendPoint[] = trendValues.map((sales, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (trendValues.length - 1 - i));
    return {
      date: `${ARABIC_DAYS[d.getDay()]} ${d.getDate()}`,
      sales,
    };
  });

  return {
    liveStats: [
      { id: "ls-sales", label: "مبيعات اليوم", value: "812.40 د.أ", delta: 7.6, tone: "primary" },
      { id: "ls-cash", label: "نقداً", value: "527.10 د.أ", delta: 5.2, tone: "success" },
      { id: "ls-visa", label: "بطاقة", value: "168.30 د.أ", delta: 12.4, tone: "success" },
      { id: "ls-debt", label: "ذمم", value: "117.00 د.أ", delta: -3.1, tone: "muted" },
      { id: "ls-returns", label: "المرتجعات", value: "45.60 د.أ", delta: -18.6, tone: "destructive" },
    ],

    topMovers: [
      { id: "tm-1", name: "كاسات بلاستيك 7 أونص", category: "مستلزمات المطبخ", units: 184, revenue: 27.6, stock: 640 },
      { id: "tm-2", name: "ماء معدني 500 مل", category: "مياه ومشروبات", units: 96, revenue: 24.0, stock: 210 },
      { id: "tm-3", name: "رول سفرة نايلون", category: "مستلزمات المطبخ", units: 41, revenue: 61.5, stock: 58 },
      { id: "tm-4", name: "شيبس عائلي", category: "شيبس ووجبات", units: 57, revenue: 19.95, stock: 120 },
      { id: "tm-5", name: "مبيض ملابس", category: "مواد التنظيف", units: 34, revenue: 37.4, stock: 66 },
    ],

    deadStock: [
      { id: "ds-1", name: "بشاكير قطن", category: "مستلزمات المطبخ", stock: 48, value: 132.0, lastSoldDaysAgo: 61 },
      { id: "ds-2", name: "رز بسمتي 1 كغ", category: "سكر ورز", stock: 35, value: 84.0, lastSoldDaysAgo: 47 },
      { id: "ds-3", name: "منظف زجاج", category: "مواد التنظيف", stock: 22, value: 27.5, lastSoldDaysAgo: 54 },
      { id: "ds-4", name: "حليب طويل الأمد", category: "ألبان وأجبان", stock: 30, value: 28.5, lastSoldDaysAgo: 73 },
    ],

    lowStockAlerts: [
      { id: "la-1", name: "زيت دوار الشمس 1 لتر", category: "زيوت ومواد أساسية", stock: 6, reorderLevel: 24, daysOfStockLeft: 1 },
      { id: "la-2", name: "رول سفرة نايلون", category: "مستلزمات المطبخ", stock: 3, reorderLevel: 20, daysOfStockLeft: 2 },
      { id: "la-3", name: "سكر رز 500 غم", category: "سكر ورز", stock: 5, reorderLevel: 30, daysOfStockLeft: 2 },
      { id: "la-4", name: "ماء معدني 500 مل", category: "مياه ومشروبات", stock: 12, reorderLevel: 60, daysOfStockLeft: 3 },
      { id: "la-5", name: "كاسات بلاستيك 7 أونص", category: "مستلزمات المطبخ", stock: 24, reorderLevel: 100, daysOfStockLeft: 4 },
    ],

    salesTrend,
    inventoryProducts: INVENTORY_PRODUCTS,
  };
}
