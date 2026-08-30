"use client";

import { useCallback, useEffect, useState } from "react";
import {
  HARDWARE_HUB_EVENT,
  loadHardwareHubConfig,
  resetHardwareHubConfig,
  saveHardwareHubConfig,
} from "@/lib/hardware/config";
import type { HardwareHubConfig, PrinterSlot, SlotId } from "@/lib/hardware/types";

export interface SystemPrinter {
  name: string;
  isDefault: boolean;
}

export function useHardwareHub(terminalId?: string | null) {
  const [config, setConfig] = useState<HardwareHubConfig>(() =>
    loadHardwareHubConfig(terminalId),
  );
  const [printers, setPrinters] = useState<SystemPrinter[]>([]);

  useEffect(() => {
    const refresh = () => {
      const next = loadHardwareHubConfig(terminalId);
      setConfig((prev) =>
        JSON.stringify(prev) === JSON.stringify(next) ? prev : next,
      );
    };
    refresh();
    window.addEventListener("storage", refresh);
    window.addEventListener(HARDWARE_HUB_EVENT, refresh);
    return () => {
      window.removeEventListener("storage", refresh);
      window.removeEventListener(HARDWARE_HUB_EVENT, refresh);
    };
  }, [terminalId]);

  /**
   * Patch a single slot (or the whole drawer). Always returns the newest
   * persisted config so callers can chain updates safely.
   */
  const updateConfig = useCallback(
    (mutator: (draft: HardwareHubConfig) => HardwareHubConfig) => {
      const next = mutator(loadHardwareHubConfig(terminalId));
      const saved = saveHardwareHubConfig(terminalId, next);
      setConfig(saved);
      return saved;
    },
    [terminalId],
  );

  const updateSlot = useCallback(
    (slotId: SlotId, patch: Partial<PrinterSlot>) => {
      return updateConfig((draft) => ({
        ...draft,
        slots: {
          ...draft.slots,
          [slotId]: { ...draft.slots[slotId], ...patch },
        },
      }));
    },
    [updateConfig],
  );

  const resetConfig = useCallback(() => {
    const next = resetHardwareHubConfig(terminalId);
    setConfig(next);
    return next;
  }, [terminalId]);

  const refreshPrinters = useCallback(async (): Promise<SystemPrinter[]> => {
    if (typeof window === "undefined" || !window.electronAPI) {
      setPrinters([]);
      return [];
    }
    try {
      const list = (await window.electronAPI.getPrinters()) ?? [];
      const mapped = list.map((p) => ({ name: p.name, isDefault: Boolean(p.isDefault) }));
      setPrinters(mapped);
      return mapped;
    } catch {
      setPrinters([]);
      return [];
    }
  }, []);

  return {
    config,
    printers,
    updateConfig,
    updateSlot,
    resetConfig,
    refreshPrinters,
  };
}
