import {
  loadDeviceHardwareSettings,
  type DeviceHardwareSettings,
} from "@/lib/deviceHardware";

const PORT_KEY = "pos_cash_drawer_port_v2";

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
}

let selectedPort: SerialPortLike | null = null;

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
  if (!port.writable) await port.open({ baudRate });
  return port.writable;
}

export function hasCashDrawer(): boolean {
  return Boolean(serialApi());
}

export async function getCashDrawerStatus(): Promise<CashDrawerStatus> {
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

/** Must be called directly from a user click so the native chooser is allowed. */
export async function connectCashDrawer(
  settings = loadDeviceHardwareSettings(),
): Promise<boolean> {
  const serial = serialApi();
  if (!serial) return false;
  try {
    const port = await serial.requestPort();
    await ensureWritable(port, settings.drawerBaudRate);
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

export async function forgetCashDrawer(): Promise<void> {
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

/** Pulse an already-authorized ESC/POS drawer port without opening a chooser. */
export async function openCashDrawer(
  settings = loadDeviceHardwareSettings(),
): Promise<boolean> {
  try {
    const port = await resolveAuthorizedPort();
    if (!port) return false;
    const writable = await ensureWritable(port, settings.drawerBaudRate);
    const writer = writable?.getWriter();
    if (!writer) return false;
    const connector = settings.drawerPin === 5 ? 1 : 0;
    const pulse = new Uint8Array([0x1b, 0x70, connector, 0x19, 0xfa]);
    try {
      await writer.write(pulse);
    } finally {
      writer.releaseLock();
    }
    rememberPort(port);
    return true;
  } catch (error) {
    console.error("Cash drawer pulse failed:", error);
    selectedPort = null;
    return false;
  }
}
