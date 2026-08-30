"use client";

import {
  DEFAULT_BARCODE_LABEL_TEMPLATE,
  DEFAULT_RECEIPT_TEMPLATE,
  normalizePrintTemplateConfig,
} from "@/lib/printTemplates";
import { fetchPrintTemplates } from "@/lib/printClient";
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

/** True when a device-local config for this store/kind exists in the cache. */
export function hasCachedPrintConfig(
  kind: PrintTemplateKind,
  storeId?: string | null,
): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(key(storeId, kind)) !== null;
  } catch {
    return false;
  }
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

/**
 * Resolve the Print Studio receipt template that a print intent MUST use,
 * guaranteeing the custom design (never the generic fallback) even when the
 * `useDefaultPrintTemplate` hook has not finished hydrating yet.
 *
 * Order of precedence:
 *  1. A device-local cached config (written when Print Studio saves a default,
 *     or by an earlier resolution / hook fetch) — returned immediately.
 *  2. Otherwise the store's server template (fetched + cached), so the printed
 *     slip is byte-identical to Print Studio even on a register that has never
 *     printed before and hydrates lazily.
 *  3. The normalized built-in default, only when fully offline AND nothing has
 *     ever been cached (the last-resort generic layout).
 *
 * A module-level in-flight promise lets concurrent triggers (the checkout
 * auto-print and a manual reprint) share a single fetch and never duplicate the
 * request, and the localStorage write makes every later call a cache hit.
 */
let receiptTemplatePromise: Promise<ReceiptTemplateConfig> | null = null;

export function resolveReceiptTemplateForPrint(
  storeId?: string | null,
): Promise<ReceiptTemplateConfig> {
  // Fast path: an existing cache is authoritative (already customized).
  if (hasCachedPrintConfig("RECEIPT", storeId)) {
    return Promise.resolve(loadCachedPrintConfig("RECEIPT", storeId) as ReceiptTemplateConfig);
  }
  if (!receiptTemplatePromise) {
    receiptTemplatePromise = (async (): Promise<ReceiptTemplateConfig> => {
      try {
        const templates = await fetchPrintTemplates("RECEIPT");
        const template = templates.find((row) => row.isDefault && row.kind === "RECEIPT") ?? templates[0];
        if (template && template.kind === "RECEIPT") {
          cacheDefaultPrintTemplate(template, storeId);
          return template.config as ReceiptTemplateConfig;
        }
      } catch {
        // Offline / not configured: fall through to the local default below.
      }
      return loadCachedPrintConfig("RECEIPT", storeId) as ReceiptTemplateConfig;
    })().finally(() => {
      receiptTemplatePromise = null;
    });
  }
  return receiptTemplatePromise;
}
