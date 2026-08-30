import {
  loadDeviceHardwareSettings,
  type DeviceHardwareSettings,
} from "@/lib/deviceHardware";
import { loadHardwareHubConfig } from "@/lib/hardware/config";

const PORT_KEY = "pos_cash_drawer_port_v2";
const SHARE_KEY = "pos_cash_drawer_share_name_v2";

interface SerialPortInfoLike {
  usbVendorId?: number;
  usbProductId?: number;
}

interface SerialPortLike {
  readable?: ReadableStream | null;
  writable: WritableStream<Uint8Array> | null;
  getInfo?(): SerialPortInfoLike;
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
}

interface NavigatorWithSerial {
  serial?: {
    getPorts(): Promise<SerialPortLike[]>;
    requestPort(options?: { filters?: Array<Record<string, number>> }): Promise<SerialPortLike>;
  };
}

export interface CashDrawerStatus {
  supported: boolean;
  authorizedPortCount: number;
  selected: boolean;
  /** Windows printer share name the drawer is wired through (Electron only). */
  shareName?: string;
}

let selectedPort: SerialPortLike | null = null;

/** Bound a hardware operation so a wedged/unplugged serial device can never
 *  hang the checkout lane (which awaits the drawer pulse before printing).
 *  Returns the resolved value, or rejects with `name === "DrawerTimeout"`.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(`${label} timed out after ${ms}ms`);
      err.name = "DrawerTimeout";
      reject(err);
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (reason) => {
        clearTimeout(timer);
        reject(reason);
      },
    );
  });
}

const DRAWER_OPEN_TIMEOUT_MS = 2_000;
const DRAWER_WRITE_TIMEOUT_MS = 1_500;

// ── Electron raw UNC-share path ────────────────────────────────────
// In the packaged desktop app the drawer lives behind the thermal printer's
// Windows USB virtual port ("USB001") and is pulsed by writing the raw ESC/POS
// bytes to the printer's Windows SHARE (\\\\127.0.0.1\\<ShareName>) with Node
// fs in electron/main.js (hardware:drawer) — it never touches webContents.print
// and never goes near the graphics rendering spooler. These helpers route to
// that channel when window.electronAPI is present (isElectron), and the browser
// Web Serial path otherwise.

export function drawerShareNameStorageKey(scope?: string | null): string {
  const term = scope?.trim() || "unbound";
  return `${SHARE_KEY}:${term}`;
}

function getSavedShareName(scope?: string | null): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(drawerShareNameStorageKey(scope)) || null;
}

function saveShareName(shareName: string, scope?: string | null): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(drawerShareNameStorageKey(scope), shareName);
}

function clearSavedShareName(scope?: string | null): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(drawerShareNameStorageKey(scope));
}

/** ESC/POS drawer pulse for a given connector pin (2 → connector 0, 5 → 1).
 *  Shared by the browser Web Serial writer and mirrored in electron/main.js
 *  so both transports kick the solenoid identically. */
export function buildDrawerPulse(pin: 2 | 5): Uint8Array {
  const connector = pin === 5 ? 1 : 0;
  return new Uint8Array([0x1b, 0x70, connector, 0x19, 0xfa]);
}

/**
 * True when a drawer transport is available in the current host.
 *  - Electron desktop → raw UNC-share IPC is always wired (supported).
 *  - Browser → Web Serial must exist (Chrome/Edge).
 */
export function hasCashDrawer(): boolean {
  if (typeof window !== "undefined" && window.electronAPI) return true;
  return Boolean(serialApi());
}

async function resolveShareName(options: DrawerSettingsLike, scope?: string | null): Promise<string | null> {
  const explicit =
    "shareName" in options && options.shareName ? String(options.shareName).trim() : "";
  if (explicit) {
    saveShareName(explicit, scope);
    return explicit;
  }
  return getSavedShareName(scope);
}

function serialApi(): NavigatorWithSerial["serial"] | undefined {
  if (typeof navigator === "undefined") return undefined;
  return (navigator as NavigatorWithSerial).serial;
}

function storage(): Storage | null {
  return typeof window === "undefined" ? null : window.localStorage;
}

function portFingerprint(port: SerialPortLike): string | null {
  const info = port.getInfo?.();
  if (!info || (info.usbVendorId == null && info.usbProductId == null)) return null;
  return `${info.usbVendorId ?? "unknown"}:${info.usbProductId ?? "unknown"}`;
}

function rememberPort(port: SerialPortLike): void {
  const fingerprint = portFingerprint(port);
  if (fingerprint) storage()?.setItem(PORT_KEY, fingerprint);
}

async function resolveAuthorizedPort(): Promise<SerialPortLike | null> {
  if (selectedPort) return selectedPort;
  const serial = serialApi();
  if (!serial) return null;
  const ports = await serial.getPorts();
  const saved = storage()?.getItem(PORT_KEY);
  const matched = saved ? ports.find((port) => portFingerprint(port) === saved) : null;
  selectedPort = matched ?? (ports.length === 1 ? ports[0] : null);
  return selectedPort;
}

async function ensureWritable(
  port: SerialPortLike,
  baudRate: DeviceHardwareSettings["drawerBaudRate"],
): Promise<WritableStream<Uint8Array> | null> {
  if (!port.writable) {
    await withTimeout(port.open({ baudRate }), DRAWER_OPEN_TIMEOUT_MS, "drawer open");
  }
  return port.writable;
}

export async function getCashDrawerStatus(scope?: string | null): Promise<CashDrawerStatus> {
  if (isElectronDrawer()) {
    // Single source of truth: the COM port persisted in the per-terminal hub
    // config. localStorage is the legacy/fallback seat for the same value.
    return { ...electronCashDrawerStatus(scope) };
  }
  const serial = serialApi();
  if (!serial) return { supported: false, authorizedPortCount: 0, selected: false };
  try {
    const ports = await serial.getPorts();
    const port = await resolveAuthorizedPort();
    return {
      supported: true,
      authorizedPortCount: ports.length,
      selected: Boolean(port),
    };
  } catch {
    return { supported: true, authorizedPortCount: 0, selected: false };
  }
}

/** True when the raw UNC-share IPC bridge is available (Electron desktop). */
function isElectronDrawer(): boolean {
  return typeof window !== "undefined" && Boolean(window.electronAPI);
}

/** Electron drawer status derived from the per-terminal hub config shareName
 *  (the single source of truth), falling back to the localStorage seat. */
function electronCashDrawerStatus(scope?: string | null): CashDrawerStatus {
  const hub = loadHardwareHubConfig(scope);
  const hubShare = hub.drawer.shareName?.trim() ?? "";
  const shareName = hubShare || getSavedShareName(scope) || "";
  return {
    supported: true,
    authorizedPortCount: shareName ? 1 : 0,
    selected: Boolean(shareName),
    shareName: shareName || undefined,
  };
}

/** Must be called directly from a user click so the native chooser is allowed. */
/** Drawer wiring needed to connect/pulse the ESC/POS port. */
export interface DrawerPulseOptions {
  baudRate: DeviceHardwareSettings["drawerBaudRate"];
  pin: DeviceHardwareSettings["drawerPin"];
  /** Windows printer share name (e.g. "MAKEENRECEIPT") for the Electron raw
   *  UNC-share path. Empty in browser builds where Web Serial owns the port. */
  shareName?: string;
}

type DrawerSettingsLike = DeviceHardwareSettings | DrawerPulseOptions;

function drawerBaud(options: DrawerSettingsLike): DeviceHardwareSettings["drawerBaudRate"] {
  return "drawerBaudRate" in options ? options.drawerBaudRate : options.baudRate;
}

function drawerPin(options: DrawerSettingsLike): DeviceHardwareSettings["drawerPin"] {
  return "drawerPin" in options ? options.drawerPin : options.pin;
}

/**
 * Raw write test (ESC @ initialize) on the drawer's shared Windows printer —
 * Electron only. Harmless on any POS printer: resets printer state without
 * feeding paper or opening the drawer, so the operator can validate the UNC
 * share path from the Devices page without a sale. Returns true on a clean write.
 */
export async function testCashDrawerPort(
  options: DrawerSettingsLike = loadDeviceHardwareSettings(),
  scope?: string | null,
): Promise<boolean> {
  if (!isElectronDrawer() || !window.electronAPI) return false;
  const shareName = await resolveShareName(options, scope);
  if (!shareName) return false;
  try {
    const result = await window.electronAPI.initPrinter({ shareName });
    if (result?.ok) {
      saveShareName(shareName, scope);
      return true;
    }
    console.error("Cash drawer init write rejected:", result?.error);
    return false;
  } catch (error) {
    console.error("Cash drawer init write failed:", error);
    return false;
  }
}

/**
 * Bind the drawer transport. Electron → persists the chosen Windows printer
 * share name in the hub config / localStorage (no OS chooser; the operator
 * types the share name in the Devices page).
 * Browser → opens the native Web Serial chooser.
 */
export async function connectCashDrawer(
  settings: DrawerSettingsLike = loadDeviceHardwareSettings(),
  scope?: string | null,
): Promise<boolean> {
  if (isElectronDrawer()) {
    const shareName =
      "shareName" in settings && settings.shareName ? String(settings.shareName).trim() : "";
    if (!shareName) return false;
    saveShareName(shareName, scope);
    return true;
  }
  const serial = serialApi();
  if (!serial) return false;
  try {
    const port = await serial.requestPort();
    await ensureWritable(port, drawerBaud(settings));
    selectedPort = port;
    rememberPort(port);
    return true;
  } catch (error) {
    if ((error as { name?: string })?.name !== "NotFoundError") {
      console.error("Cash drawer connection failed:", error);
    }
    return false;
  }
}

export async function forgetCashDrawer(scope?: string | null): Promise<void> {
  if (isElectronDrawer()) {
    clearSavedShareName(scope);
    return;
  }
  const port = selectedPort;
  selectedPort = null;
  storage()?.removeItem(PORT_KEY);
  if (!port || (!port.readable && !port.writable)) return;
  try {
    await port.close();
  } catch {
    // The OS may already have closed an unplugged device.
  }
}

/**
 * Pulse an already-authorized ESC/POS drawer port without opening a chooser.
 * Accepts either the full legacy `DeviceHardwareSettings` object or a focused
 * `{ baudRate, pin }` pair, so the Hardware Hub can drive it from its own
 * drawer config without fabricating unrelated settings.
 *
 * Electron → sends the exact ESC/POS bytes to the shared Windows printer UNC
 * path through the raw hardware:drawer IPC (never the print spooler renderer).
 * Browser → writes the same bytes over Web Serial.
 */
export async function openCashDrawer(
  options: DrawerSettingsLike = loadDeviceHardwareSettings(),
  scope?: string | null,
): Promise<boolean> {
  const baudRate = drawerBaud(options);
  const pin = drawerPin(options);
  if (isElectronDrawer() && window.electronAPI) {
    const shareName = await resolveShareName(options, scope);
    if (!shareName) return false;
    try {
      const result = await window.electronAPI.kickDrawer({
        shareName,
        pin,
      });
      if (result?.ok) {
        saveShareName(shareName, scope);
        return true;
      }
      console.error("Cash drawer kick rejected:", result?.error);
      return false;
    } catch (error) {
      console.error("Cash drawer pulse failed:", error);
      return false;
    }
  }
  try {
    const port = await resolveAuthorizedPort();
    if (!port) return false;
    const writable = await ensureWritable(port, baudRate);
    const writer = writable?.getWriter();
    if (!writer) return false;
    const pulse = buildDrawerPulse(pin);
    try {
      await withTimeout(writer.write(pulse), DRAWER_WRITE_TIMEOUT_MS, "drawer pulse");
    } finally {
      writer.releaseLock();
    }
    rememberPort(port);
    return true;
  } catch (error) {
    console.error("Cash drawer pulse failed:", error);
    // A wedged/unplugged port must not poison the next attempt: drop the stale
    // reference so resolveAuthorizedPort re-queries the OS on the next kick.
    selectedPort = null;
    return false;
  }
}
