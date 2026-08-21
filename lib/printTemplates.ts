import type {
  BarcodeLabelElementId,
  BarcodeLabelTemplateConfig,
  PrintTemplateConfig,
  PrintTemplateKind,
  ReceiptSectionConfig,
  ReceiptSectionId,
  ReceiptTemplateConfig,
} from "@/types/printTemplates";

const RECEIPT_SECTION_ORDER: ReceiptSectionId[] = [
  "branding",
  "document",
  "meta",
  "customer",
  "items",
  "summary",
  "total",
  "payment",
  "codes",
  "footer",
];

const LABEL_ELEMENT_ORDER: BarcodeLabelElementId[] = [
  "store",
  "name",
  "barcode",
  "barcodeText",
  "unit",
  "price",
];

export const RECEIPT_SECTION_LABELS: Record<ReceiptSectionId, string> = {
  branding: "هوية المتجر والشعار",
  document: "نوع الفاتورة ورقمها",
  meta: "التاريخ والوردية والكاشير",
  customer: "بيانات العميل",
  items: "جدول الأصناف",
  summary: "الضريبة والخصم والتوصيل",
  total: "الإجمالي النهائي",
  payment: "الدفع والباقي والولاء",
  codes: "باركود الفاتورة وQR الضريبي",
  footer: "رسالة أسفل الفاتورة",
};

export const LABEL_ELEMENT_LABELS: Record<BarcodeLabelElementId, string> = {
  store: "اسم المتجر",
  name: "اسم المنتج",
  barcode: "رمز الباركود",
  barcodeText: "رقم الباركود",
  unit: "وحدة البيع",
  price: "السعر",
};

export const DEFAULT_RECEIPT_TEMPLATE: ReceiptTemplateConfig = {
  version: 1,
  paperWidth: 80,
  density: "standard",
  fontScale: 1,
  logoSize: "medium",
  dividerStyle: "dashed",
  itemStyle: "grid",
  itemColumnMode: "full",
  tableHeaderStyle: "dark",
  summaryStyle: "grid",
  totalStyle: "rules",
  totalScale: 1,
  zebraRows: true,
  showLineNumbers: false,
  showItemUnit: true,
  showItemDiscount: true,
  showItemBarcode: false,
  showItemTax: true,
  showCustomerPhone: true,
  showBranchTerminal: true,
  showTaxNumber: true,
  showCashierTime: true,
  showInvoiceBarcode: true,
  showFiscalQr: true,
  sections: RECEIPT_SECTION_ORDER.map((id) => ({ id, visible: true })),
};

export const DEFAULT_BARCODE_LABEL_TEMPLATE: BarcodeLabelTemplateConfig = {
  version: 1,
  widthMm: 40,
  heightMm: 25,
  gapMm: 2,
  paddingMm: 1,
  fontScale: 1,
  barcodeHeightMm: 7,
  borderStyle: "solid",
  showStoreName: false,
  showName: true,
  showBarcodeText: true,
  showUnit: true,
  showPrice: true,
  order: [...LABEL_ELEMENT_ORDER],
};

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function numberIn(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed * 10) / 10));
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function orderedUnique<T extends string>(raw: unknown, allowed: readonly T[]): T[] {
  const source = Array.isArray(raw) ? raw : [];
  const seen = new Set<T>();
  const result: T[] = [];
  for (const value of source) {
    if (allowed.includes(value as T) && !seen.has(value as T)) {
      seen.add(value as T);
      result.push(value as T);
    }
  }
  for (const value of allowed) {
    if (!seen.has(value)) result.push(value);
  }
  return result;
}

export function normalizeReceiptTemplate(value: unknown): ReceiptTemplateConfig {
  const input = object(value);
  const sectionInput = new Map<ReceiptSectionId, boolean>();
  if (Array.isArray(input.sections)) {
    for (const raw of input.sections) {
      const row = object(raw);
      const id = row.id as ReceiptSectionId;
      if (RECEIPT_SECTION_ORDER.includes(id) && !sectionInput.has(id)) {
        sectionInput.set(id, bool(row.visible, true));
      }
    }
  }
  const sectionOrder = orderedUnique(
    Array.isArray(input.sections) ? input.sections.map((row) => object(row).id) : [],
    RECEIPT_SECTION_ORDER,
  );
  const sections: ReceiptSectionConfig[] = sectionOrder.map((id) => ({
    id,
    visible: id === "items" || id === "total" ? true : sectionInput.get(id) ?? true,
  }));

  return {
    version: 1,
    paperWidth: input.paperWidth === 58 ? 58 : 80,
    density:
      input.density === "compact" || input.density === "comfortable"
        ? input.density
        : "standard",
    fontScale: numberIn(input.fontScale, 1, 0.8, 1.3),
    logoSize:
      input.logoSize === "small" || input.logoSize === "large" ? input.logoSize : "medium",
    dividerStyle:
      input.dividerStyle === "solid" || input.dividerStyle === "none"
        ? input.dividerStyle
        : "dashed",
    itemStyle:
      input.itemStyle === "lines" || input.itemStyle === "clean" ? input.itemStyle : "grid",
    itemColumnMode: input.itemColumnMode === "compact" ? "compact" : "full",
    tableHeaderStyle:
      input.tableHeaderStyle === "outline" || input.tableHeaderStyle === "minimal"
        ? input.tableHeaderStyle
        : "dark",
    summaryStyle:
      input.summaryStyle === "lines" || input.summaryStyle === "clean"
        ? input.summaryStyle
        : "grid",
    totalStyle:
      input.totalStyle === "boxed" || input.totalStyle === "dark"
        ? input.totalStyle
        : "rules",
    totalScale: numberIn(input.totalScale, 1, 0.8, 1.5),
    zebraRows: bool(input.zebraRows, true),
    showLineNumbers: bool(input.showLineNumbers, false),
    showItemUnit: bool(input.showItemUnit, true),
    showItemDiscount: bool(input.showItemDiscount, true),
    showItemBarcode: bool(input.showItemBarcode, false),
    showItemTax: bool(input.showItemTax, true),
    showCustomerPhone: bool(input.showCustomerPhone, true),
    showBranchTerminal: bool(input.showBranchTerminal, true),
    showTaxNumber: bool(input.showTaxNumber, true),
    showCashierTime: bool(input.showCashierTime, true),
    showInvoiceBarcode: bool(input.showInvoiceBarcode, true),
    showFiscalQr: bool(input.showFiscalQr, true),
    sections,
  };
}

export function normalizeBarcodeLabelTemplate(value: unknown): BarcodeLabelTemplateConfig {
  const input = object(value);
  return {
    version: 1,
    widthMm: numberIn(input.widthMm, 40, 20, 100),
    heightMm: numberIn(input.heightMm, 25, 12, 80),
    gapMm: numberIn(input.gapMm, 2, 0, 10),
    paddingMm: numberIn(input.paddingMm, 1, 0, 6),
    fontScale: numberIn(input.fontScale, 1, 0.7, 1.4),
    barcodeHeightMm: numberIn(input.barcodeHeightMm, 7, 3, 30),
    borderStyle:
      input.borderStyle === "none" || input.borderStyle === "dashed"
        ? input.borderStyle
        : "solid",
    showStoreName: bool(input.showStoreName, false),
    showName: bool(input.showName, true),
    showBarcodeText: bool(input.showBarcodeText, true),
    showUnit: bool(input.showUnit, true),
    showPrice: bool(input.showPrice, true),
    order: orderedUnique(input.order, LABEL_ELEMENT_ORDER),
  };
}

export function normalizePrintTemplateConfig(
  kind: PrintTemplateKind,
  value: unknown,
): PrintTemplateConfig {
  return kind === "RECEIPT"
    ? normalizeReceiptTemplate(value)
    : normalizeBarcodeLabelTemplate(value);
}
