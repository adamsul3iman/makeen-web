"use client";

import {
  DEFAULT_BARCODE_LABEL_TEMPLATE,
  DEFAULT_RECEIPT_TEMPLATE,
  normalizePrintTemplateConfig,
} from "@/lib/printTemplates";
import type {
  BarcodeLabelTemplateConfig,
  PrintTemplate,
  PrintTemplateConfig,
  PrintTemplateKind,
  ReceiptTemplateConfig,
} from "@/types/printTemplates";

export const PRINT_TEMPLATE_EVENT = "pos:print-template";
const PREFIX = "pos_print_template_v1";

function key(storeId: string | null | undefined, kind: PrintTemplateKind): string {
  return `${PREFIX}:${storeId?.trim() || "unbound"}:${kind}`;
}
export function defaultPrintConfig(kind: "RECEIPT"): ReceiptTemplateConfig;
export function defaultPrintConfig(kind: "BARCODE_LABEL"): BarcodeLabelTemplateConfig;
export function defaultPrintConfig(kind: PrintTemplateKind): PrintTemplateConfig;
export function defaultPrintConfig(kind: PrintTemplateKind): PrintTemplateConfig {
  return kind === "RECEIPT"
    ? { ...DEFAULT_RECEIPT_TEMPLATE, sections: DEFAULT_RECEIPT_TEMPLATE.sections.map((row) => ({ ...row })) }
    : { ...DEFAULT_BARCODE_LABEL_TEMPLATE, order: [...DEFAULT_BARCODE_LABEL_TEMPLATE.order] };
}

export function loadCachedPrintConfig(kind: "RECEIPT", storeId?: string | null): ReceiptTemplateConfig;
export function loadCachedPrintConfig(kind: "BARCODE_LABEL", storeId?: string | null): BarcodeLabelTemplateConfig;
export function loadCachedPrintConfig(kind: PrintTemplateKind, storeId?: string | null): PrintTemplateConfig;
export function loadCachedPrintConfig(kind: PrintTemplateKind, storeId?: string | null): PrintTemplateConfig {
  if (typeof window === "undefined") return defaultPrintConfig(kind);
  try {
    const raw = window.localStorage.getItem(key(storeId, kind));
    return raw ? normalizePrintTemplateConfig(kind, JSON.parse(raw) as unknown) : defaultPrintConfig(kind);
  } catch {
    return defaultPrintConfig(kind);
  }
}

export function cacheDefaultPrintTemplate(template: PrintTemplate, storeId?: string | null): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(key(storeId, template.kind), JSON.stringify(template.config));
  window.dispatchEvent(new CustomEvent(PRINT_TEMPLATE_EVENT, { detail: { kind: template.kind, storeId } }));
}
