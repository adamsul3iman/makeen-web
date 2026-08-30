/**
 * Hardware & Peripherals Hub — configuration store.
 *
 * Persists the printer-slot assignments and cash-drawer routing per terminal in
 * localStorage (mirroring how the legacy DeviceHardwareSettings were scoped).
 * On first read it MIGRATES the old flat settings (receiptPrinterName,
 * receiptWidth, autoOpenDrawer, drawerBaudRate, drawerPin) into the new
 * slot/drawer shape so existing installations upgrade seamlessly.
 */

import {
  loadDeviceHardwareSettings,
  type DeviceHardwareSettings,
} from "@/lib/deviceHardware";
import type { HardwareHubConfig, PrintIntent, PrinterSlot, SlotId } from "./types";
import { SLOT_RECEIPT, SLOT_LABEL, SLOT_A4 } from "./slots";

export const HARDWARE_HUB_EVENT = "pos:hardware-hub";
const STORAGE_PREFIX = "pos_hardware_hub_v2";

export function hardwareHubStorageKey(terminalId?: string | null): string {
  const scope = terminalId?.trim() || "unbound";
  return `${STORAGE_PREFIX}:${scope}`;
}

/** Default hub config with all three slots enabled and no explicit devices. */
export function defaultHardwareHubConfig(
  legacy?: DeviceHardwareSettings,
): HardwareHubConfig {
  return {
    version: 2,
    slots: {
      [SLOT_RECEIPT]: makeSlot(SLOT_RECEIPT, legacy?.receiptPrinterName ?? "", legacy?.receiptWidth ?? 80),
      [SLOT_LABEL]: makeSlot(SLOT_LABEL, "", undefined),
      [SLOT_A4]: makeSlot(SLOT_A4, "", undefined),
    },
    drawer: {
      baudRate: legacy?.drawerBaudRate ?? 9600,
      pin: legacy?.drawerPin ?? 2,
      comPort: "",
      triggers: {
        // Preserve the legacy auto-open behavior for cash sales by default.
        cashSale: legacy?.autoOpenDrawer ?? false,
        splitSale: legacy?.autoOpenDrawer ?? false,
        manual: true,
      },
    },
    intents: {},
  };
}

function makeSlot(id: SlotId, deviceName: string, paperWidth: 58 | 80 | undefined): PrinterSlot {
  const base = {
    id,
    deviceName,
    paperWidth,
    enabled: true,
  };
  if (id === SLOT_RECEIPT) return { ...base, kind: "THERMAL", label: "Receipt Thermal 80mm", nameAr: "الإيصال الحراري" };
  if (id === SLOT_LABEL) return { ...base, kind: "LABEL", label: "Barcode / Label", nameAr: "ملصقات الباركود" };
  return { ...base, kind: "A4", label: "A4 / Reports", nameAr: "أوراق A4 والملخصات" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

/** Heal/validate a raw persisted config into a fully-populated one. */
function normalizeHardwareHubConfig(raw: unknown, legacy: DeviceHardwareSettings): HardwareHubConfig {
  const base = defaultHardwareHubConfig(legacy);
  if (!isRecord(raw)) return base;

  const slotsIn = isRecord(raw.slots) ? raw.slots : {};
  for (const key of [SLOT_RECEIPT, SLOT_LABEL, SLOT_A4]) {
    const s = slotsIn[key];
    if (isRecord(s)) {
      base.slots[key] = {
        ...base.slots[key],
        ...(typeof s.deviceName === "string" ? { deviceName: s.deviceName } : {}),
        ...(s.paperWidth === 58 || s.paperWidth === 80 ? { paperWidth: s.paperWidth } : {}),
        ...(typeof s.enabled === "boolean" ? { enabled: s.enabled } : {}),
      };
    }
  }

  if (isRecord(raw.drawer)) {
    const d = raw.drawer;
    if (d.baudRate === 9600 || d.baudRate === 19200 || d.baudRate === 38400 || d.baudRate === 115200) {
      base.drawer.baudRate = d.baudRate;
    }
    if (d.pin === 2 || d.pin === 5) base.drawer.pin = d.pin;
    if (typeof d.comPort === "string") base.drawer.comPort = d.comPort.trim();
    if (isRecord(d.triggers)) {
      const t = d.triggers;
      base.drawer.triggers = {
        cashSale: typeof t.cashSale === "boolean" ? t.cashSale : base.drawer.triggers.cashSale,
        splitSale: typeof t.splitSale === "boolean" ? t.splitSale : base.drawer.triggers.splitSale,
        manual: typeof t.manual === "boolean" ? t.manual : base.drawer.triggers.manual,
      };
    }
  }

  if (isRecord(raw.intents)) {
    for (const [key, resolver] of Object.entries(raw.intents)) {
      if (isRecord(resolver) && typeof resolver.slotId === "string") {
        const intentKey = key as PrintIntent;
        const slotId = resolver.slotId as SlotId;
        base.intents[intentKey] = {
          slotId,
          fallbackKind: (resolver.fallbackKind as "THERMAL" | "A4" | "LABEL") ?? "THERMAL",
        };
      }
    }
  }

  return base;
}

export function loadHardwareHubConfig(terminalId?: string | null): HardwareHubConfig {
  const legacy = loadDeviceHardwareSettings(terminalId);
  if (typeof window === "undefined") return { ...defaultHardwareHubConfig(legacy) };
  try {
    const raw = window.localStorage.getItem(hardwareHubStorageKey(terminalId));
    return raw ? normalizeHardwareHubConfig(JSON.parse(raw) as unknown, legacy) : defaultHardwareHubConfig(legacy);
  } catch {
    return defaultHardwareHubConfig(legacy);
  }
}

export function saveHardwareHubConfig(
  terminalId: string | null | undefined,
  value: HardwareHubConfig,
): HardwareHubConfig {
  if (typeof window === "undefined") return value;
  window.localStorage.setItem(hardwareHubStorageKey(terminalId), JSON.stringify(value));
  window.dispatchEvent(
    new CustomEvent(HARDWARE_HUB_EVENT, { detail: { terminalId: terminalId?.trim() || null } }),
  );
  return value;
}

export function resetHardwareHubConfig(terminalId?: string | null): HardwareHubConfig {
  const legacy = loadDeviceHardwareSettings(terminalId);
  if (typeof window !== "undefined") {
    window.localStorage.removeItem(hardwareHubStorageKey(terminalId));
    window.dispatchEvent(
      new CustomEvent(HARDWARE_HUB_EVENT, { detail: { terminalId: terminalId?.trim() || null } }),
    );
  }
  return defaultHardwareHubConfig(legacy);
}
