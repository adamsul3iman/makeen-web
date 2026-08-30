import {
  loadDeviceHardwareSettings,
  type DeviceHardwareSettings,
} from "@/lib/deviceHardware";
import { loadHardwareHubConfig } from "@/lib/hardware/config";

const PORT_KEY = "pos_cash_drawer_port_v2";
const COM_KEY = "pos_cash_drawer_com_port_v2";

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
  /** Windows COM device the drawer is wired to (Electron raw path only). */
  comPort?: string;
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

// ── Electron raw COM path ─────────────────────────────────────────
// In the packaged desktop app the drawer lives on a Windows serial COM port
// and is pulsed with Node fs writes in electron/main.js (hardware:drawer) —
// it never touches webContents.print and never goes near the graphics
// spooler. These helpers route to that channel when window.electronAPI is
// present (isElectron), and the browser Web Serial path otherwise.

export function drawerComPortStorageKey(scope?: string | null): string {
  const term = scope?.trim() || "unbound";
  return `${COM_KEY}:${term}`;
}

function getSavedComPort(scope?: string | null): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(drawerComPortStorageKey(scope)) || null;
}

function saveComPort(comPort: string, scope?: string | null): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(drawerComPortStorageKey(scope), comPort);
}

function clearSavedComPort(scope?: string | null): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(drawerComPortStorageKey(scope));
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
 *  - Electron desktop → raw COM IPC is always wired (supported).
 *  - Browser → Web Serial must exist (Chrome/Edge).
 */
export function hasCashDrawer(): boolean {
  if (typeof window !== "undefined" && window.electronAPI) return true;
  return Boolean(serialApi());
}

async function resolveComPort(options: DrawerSettingsLike, scope?: string | null): Promise<string | null> {
  const explicit =
    "comPort" in options && options.comPort ? String(options.comPort).trim() : "";
  if (explicit) {
    saveComPort(explicit, scope);
    return explicit;
  }
  return getSavedComPort(scope);
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

/** True when the raw COM IPC bridge is available (Electron desktop). */
function isElectronDrawer(): boolean {
  return typeof window !== "undefined" && Boolean(window.electronAPI);
}

/** Electron drawer status derived from the per-terminal hub config comPort
 *  (the single source of truth), falling back to the localStorage seat. */
function electronCashDrawerStatus(scope?: string | null): CashDrawerStatus {
  const hub = loadHardwareHubConfig(scope);
  const hubPort = hub.drawer.comPort?.trim() ?? "";
  const comPort = hubPort || getSavedComPort(scope) || "";
  return {
    supported: true,
    authorizedPortCount: comPort ? 1 : 0,
    selected: Boolean(comPort),
    comPort: comPort || undefined,
  };
}

/** Must be called directly from a user click so the native chooser is allowed. */
/** Drawer wiring needed to connect/pulse the ESC/POS port. */
export interface DrawerPulseOptions {
  baudRate: DeviceHardwareSettings["drawerBaudRate"];
  pin: DeviceHardwareSettings["drawerPin"];
  /** Windows COM device (e.g. "COM3") for the Electron raw path. */
  comPort?: string;
}

type DrawerSettingsLike = DeviceHardwareSettings | DrawerPulseOptions;

function drawerBaud(options: DrawerSettingsLike): DeviceHardwareSettings["drawerBaudRate"] {
  return "drawerBaudRate" in options ? options.drawerBaudRate : options.baudRate;
}

function drawerPin(options: DrawerSettingsLike): DeviceHardwareSettings["drawerPin"] {
  return "drawerPin" in options ? options.drawerPin : options.pin;
}

/** Enumerate serial ports available to the drawer:
 *  Electron → hardware:listPorts (COM1..COM256 probe), browser → []. */
export async function listCashDrawerPorts(): Promise<string[]> {
  if (isElectronDrawer() && window.electronAPI) {
    try {
      const ports = (await window.electronAPI.listComPorts()) ?? [];
      return ports.map((p) => p.trim()).filter(Boolean);
    } catch (err) {
      console.error("Cash drawer COM enumeration failed:", err);
      return [];
    }
  }
  return [];
}

/**
 * Raw write test (ESC @ initialize) on the drawer's serial device — Electron
 * only. Harmless on any POS printer serial I/O: resets printer state without
 * feeding paper or opening the drawer, so the operator can validate the COM
 * path from the Devices page without a sale. Returns true on a clean write.
 */
export async function testCashDrawerPort(
  options: DrawerSettingsLike = loadDeviceHardwareSettings(),
  scope?: string | null,
): Promise<boolean> {
  if (!isElectronDrawer() || !window.electronAPI) return false;
  const comPort = await resolveComPort(options, scope);
  if (!comPort) return false;
  try {
    const result = await window.electronAPI.initComPort({
      comPort,
      baudRate: drawerBaud(options),
    });
    if (result?.ok) {
      saveComPort(comPort, scope);
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
 * Bind the drawer transport. Electron → persists the chosen COM port in
 * localStorage (no OS chooser; the operator picks from listCashDrawerPorts).
 * Browser → opens the native Web Serial chooser.
 */
export async function connectCashDrawer(
  settings: DrawerSettingsLike = loadDeviceHardwareSettings(),
  scope?: string | null,
): Promise<boolean> {
  if (isElectronDrawer()) {
    const comPort =
      "comPort" in settings && settings.comPort ? String(settings.comPort).trim() : "";
    if (!comPort) return false;
    saveComPort(comPort, scope);
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
    clearSavedComPort(scope);
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
 * Electron → sends the exact ESC/POS bytes to the Windows COM device through
 * the raw hardware:drawer IPC (never the print spooler).
 * Browser → writes the same bytes over Web Serial.
 */
export async function openCashDrawer(
  options: DrawerSettingsLike = loadDeviceHardwareSettings(),
  scope?: string | null,
): Promise<boolean> {
  const baudRate = drawerBaud(options);
  const pin = drawerPin(options);
  if (isElectronDrawer() && window.electronAPI) {
    const comPort = await resolveComPort(options, scope);
    if (!comPort) return false;
    try {
      const result = await window.electronAPI.kickDrawer({
        comPort,
        baudRate,
        pin,
      });
      if (result?.ok) {
        saveComPort(comPort, scope);
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
