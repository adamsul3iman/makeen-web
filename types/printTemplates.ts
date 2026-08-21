export type PrintTemplateKind = "RECEIPT" | "BARCODE_LABEL";

export type ReceiptSectionId =
  | "branding"
  | "document"
  | "meta"
  | "customer"
  | "items"
  | "summary"
  | "total"
  | "payment"
  | "codes"
  | "footer";

export interface ReceiptSectionConfig {
  id: ReceiptSectionId;
  visible: boolean;
}

export interface ReceiptTemplateConfig {
  version: 1;
  paperWidth: 58 | 80;
  density: "compact" | "standard" | "comfortable";
  fontScale: number;
  logoSize: "small" | "medium" | "large";
  dividerStyle: "solid" | "dashed" | "none";
  itemStyle: "grid" | "lines" | "clean";
  itemColumnMode: "full" | "compact";
  tableHeaderStyle: "dark" | "outline" | "minimal";
  summaryStyle: "grid" | "lines" | "clean";
  totalStyle: "rules" | "boxed" | "dark";
  totalScale: number;
  zebraRows: boolean;
  showLineNumbers: boolean;
  showItemUnit: boolean;
  showItemDiscount: boolean;
  showItemBarcode: boolean;
  showItemTax: boolean;
  showCustomerPhone: boolean;
  showBranchTerminal: boolean;
  showTaxNumber: boolean;
  showCashierTime: boolean;
  showInvoiceBarcode: boolean;
  showFiscalQr: boolean;
  sections: ReceiptSectionConfig[];
}

export type BarcodeLabelElementId =
  | "store"
  | "name"
  | "barcode"
  | "barcodeText"
  | "unit"
  | "price";

export interface BarcodeLabelTemplateConfig {
  version: 1;
  widthMm: number;
  heightMm: number;
  gapMm: number;
  paddingMm: number;
  fontScale: number;
  barcodeHeightMm: number;
  borderStyle: "none" | "solid" | "dashed";
  showStoreName: boolean;
  showName: boolean;
  showBarcodeText: boolean;
  showUnit: boolean;
  showPrice: boolean;
  order: BarcodeLabelElementId[];
}

export type PrintTemplateConfig = ReceiptTemplateConfig | BarcodeLabelTemplateConfig;

export interface PrintTemplate<T extends PrintTemplateConfig = PrintTemplateConfig> {
  id: string;
  kind: PrintTemplateKind;
  name: string;
  isDefault: boolean;
  config: T;
  createdAt: string;
  updatedAt: string;
}
