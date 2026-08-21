"use client";

import { useEffect, useState } from "react";
import { cacheDefaultPrintTemplate, loadCachedPrintConfig, PRINT_TEMPLATE_EVENT } from "@/lib/clientPrintTemplates";
import { posFetch } from "@/lib/tenantClient";
import type {
  BarcodeLabelTemplateConfig,
  PrintTemplate,
  PrintTemplateConfig,
  PrintTemplateKind,
  ReceiptTemplateConfig,
} from "@/types/printTemplates";

export function useDefaultPrintTemplate(kind: "RECEIPT", storeId?: string | null): ReceiptTemplateConfig;
export function useDefaultPrintTemplate(kind: "BARCODE_LABEL", storeId?: string | null): BarcodeLabelTemplateConfig;
export function useDefaultPrintTemplate(kind: PrintTemplateKind, storeId?: string | null): PrintTemplateConfig;
export function useDefaultPrintTemplate(kind: PrintTemplateKind, storeId?: string | null): PrintTemplateConfig {
  const scope = `${kind}:${storeId?.trim() || "unbound"}`;
  const [snapshot, setSnapshot] = useState<{ scope: string; config: PrintTemplateConfig }>(() => ({
    scope,
    config: loadCachedPrintConfig(kind, storeId),
  }));
  const config = snapshot.scope === scope ? snapshot.config : loadCachedPrintConfig(kind, storeId);

  useEffect(() => {
    const refreshFromCache = (event: Event) => {
      const detail = (event as CustomEvent<{ kind?: PrintTemplateKind; storeId?: string | null }>).detail;
      if (!detail || (detail.kind === kind && (detail.storeId ?? null) === (storeId ?? null))) {
        setSnapshot({ scope, config: loadCachedPrintConfig(kind, storeId) });
      }
    };
    window.addEventListener(PRINT_TEMPLATE_EVENT, refreshFromCache);
    let cancelled = false;
    posFetch(`/api/print-templates?kind=${kind}`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) return null;
        return response.json() as Promise<{ templates?: PrintTemplate[] }>;
      })
      .then((body) => {
        if (cancelled) return;
        const template = body?.templates?.find((row) => row.isDefault) ?? body?.templates?.[0];
        if (!template) return;
        cacheDefaultPrintTemplate(template, storeId);
        setSnapshot({ scope, config: template.config });
      })
      .catch(() => {
        // Offline printing intentionally keeps the last device-local template.
      });
    return () => {
      cancelled = true;
      window.removeEventListener(PRINT_TEMPLATE_EVENT, refreshFromCache);
    };
  }, [kind, scope, storeId]);

  return config;
}
