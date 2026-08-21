export type ReceiptPaperWidth = 58 | 80;
export type DrawerBaudRate = 9600 | 19200 | 38400 | 115200;
export type DrawerPin = 2 | 5;
export type ScannerSubmitKey = "ENTER" | "TAB" | "ENTER_OR_TAB";

export interface DeviceHardwareSettings {
  receiptWidth: ReceiptPaperWidth;
  autoPrintReceipt: boolean;
  autoOpenDrawer: boolean;
  drawerBaudRate: DrawerBaudRate;
  drawerPin: DrawerPin;
  scannerSubmitKey: ScannerSubmitKey;
  soundEnabled: boolean;
  soundVolume: number;
}

export const DEFAULT_DEVICE_HARDWARE_SETTINGS: DeviceHardwareSettings = {
  receiptWidth: 80,
  autoPrintReceipt: true,
  autoOpenDrawer: false,
  drawerBaudRate: 9600,
  drawerPin: 2,
  scannerSubmitKey: "ENTER_OR_TAB",
  soundEnabled: true,
  soundVolume: 60,
};

export const DEVICE_HARDWARE_EVENT = "pos:device-hardware";
const STORAGE_PREFIX = "pos_device_hardware_v1";

export function deviceHardwareStorageKey(terminalId?: string | null): string {
  const scope = terminalId?.trim() || "unbound";
  return `${STORAGE_PREFIX}:${scope}`;
}

function isPaperWidth(value: unknown): value is ReceiptPaperWidth {
  return value === 58 || value === 80;
}

function isBaudRate(value: unknown): value is DrawerBaudRate {
  return value === 9600 || value === 19200 || value === 38400 || value === 115200;
}

function isDrawerPin(value: unknown): value is DrawerPin {
  return value === 2 || value === 5;
}

function isScannerSubmitKey(value: unknown): value is ScannerSubmitKey {
  return value === "ENTER" || value === "TAB" || value === "ENTER_OR_TAB";
}

export function normalizeDeviceHardwareSettings(value: unknown): DeviceHardwareSettings {
  const input = value && typeof value === "object"
    ? value as Partial<DeviceHardwareSettings>
    : {};
  return {
    receiptWidth: isPaperWidth(input.receiptWidth)
      ? input.receiptWidth
      : DEFAULT_DEVICE_HARDWARE_SETTINGS.receiptWidth,
    autoPrintReceipt:
      typeof input.autoPrintReceipt === "boolean"
        ? input.autoPrintReceipt
        : DEFAULT_DEVICE_HARDWARE_SETTINGS.autoPrintReceipt,
    autoOpenDrawer:
      typeof input.autoOpenDrawer === "boolean"
        ? input.autoOpenDrawer
        : DEFAULT_DEVICE_HARDWARE_SETTINGS.autoOpenDrawer,
    drawerBaudRate: isBaudRate(input.drawerBaudRate)
      ? input.drawerBaudRate
      : DEFAULT_DEVICE_HARDWARE_SETTINGS.drawerBaudRate,
    drawerPin: isDrawerPin(input.drawerPin)
      ? input.drawerPin
      : DEFAULT_DEVICE_HARDWARE_SETTINGS.drawerPin,
    scannerSubmitKey: isScannerSubmitKey(input.scannerSubmitKey)
      ? input.scannerSubmitKey
      : DEFAULT_DEVICE_HARDWARE_SETTINGS.scannerSubmitKey,
    soundEnabled:
      typeof input.soundEnabled === "boolean"
        ? input.soundEnabled
        : DEFAULT_DEVICE_HARDWARE_SETTINGS.soundEnabled,
    soundVolume:
      typeof input.soundVolume === "number" && Number.isFinite(input.soundVolume)
        ? Math.round(Math.min(100, Math.max(0, input.soundVolume)))
        : DEFAULT_DEVICE_HARDWARE_SETTINGS.soundVolume,
  };
}

export function loadDeviceHardwareSettings(
  terminalId?: string | null,
): DeviceHardwareSettings {
  if (typeof window === "undefined") return { ...DEFAULT_DEVICE_HARDWARE_SETTINGS };
  try {
    const raw = window.localStorage.getItem(deviceHardwareStorageKey(terminalId));
    return raw
      ? normalizeDeviceHardwareSettings(JSON.parse(raw) as unknown)
      : { ...DEFAULT_DEVICE_HARDWARE_SETTINGS };
  } catch {
    return { ...DEFAULT_DEVICE_HARDWARE_SETTINGS };
  }
}

export function saveDeviceHardwareSettings(
  terminalId: string | null | undefined,
  value: DeviceHardwareSettings,
): DeviceHardwareSettings {
  const normalized = normalizeDeviceHardwareSettings(value);
  if (typeof window === "undefined") return normalized;
  window.localStorage.setItem(
    deviceHardwareStorageKey(terminalId),
    JSON.stringify(normalized),
  );
  window.dispatchEvent(
    new CustomEvent(DEVICE_HARDWARE_EVENT, {
      detail: { terminalId: terminalId?.trim() || null },
    }),
  );
  return normalized;
}

export function resetDeviceHardwareSettings(
  terminalId?: string | null,
): DeviceHardwareSettings {
  if (typeof window !== "undefined") {
    window.localStorage.removeItem(deviceHardwareStorageKey(terminalId));
    window.dispatchEvent(
      new CustomEvent(DEVICE_HARDWARE_EVENT, {
        detail: { terminalId: terminalId?.trim() || null },
      }),
    );
  }
  return { ...DEFAULT_DEVICE_HARDWARE_SETTINGS };
}

export function scannerAcceptsSubmitKey(
  key: string,
  setting: ScannerSubmitKey,
): boolean {
  if (key === "Enter") return setting === "ENTER" || setting === "ENTER_OR_TAB";
  if (key === "Tab") return setting === "TAB" || setting === "ENTER_OR_TAB";
  return false;
}
