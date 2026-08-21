export {};

const values = new Map<string, string>();
const dispatched: string[] = [];

const localStorageMock: Storage = {
  get length() { return values.size; },
  clear: () => values.clear(),
  getItem: (key) => values.get(key) ?? null,
  key: (index) => [...values.keys()][index] ?? null,
  removeItem: (key) => { values.delete(key); },
  setItem: (key, value) => { values.set(key, String(value)); },
};

class CustomEventMock<T = unknown> extends Event {
  detail: T;
  constructor(type: string, options?: CustomEventInit<T>) {
    super(type);
    this.detail = options?.detail as T;
  }
}

Object.defineProperty(globalThis, "CustomEvent", { value: CustomEventMock, configurable: true });
Object.defineProperty(globalThis, "window", {
  value: {
    localStorage: localStorageMock,
    dispatchEvent: (event: Event) => {
      dispatched.push(event.type);
      return true;
    },
  },
  configurable: true,
});

let writtenPulse: number[] = [];
let openedAt = 0;
let closed = false;
let chooserCalls = 0;

const fakePort = {
  readable: null,
  writable: null as WritableStream<Uint8Array> | null,
  getInfo: () => ({ usbVendorId: 1208, usbProductId: 514 }),
  open: async ({ baudRate }: { baudRate: number }) => {
    openedAt = baudRate;
    fakePort.writable = {
      getWriter: () => ({
        write: async (bytes: Uint8Array) => { writtenPulse = [...bytes]; },
        releaseLock: () => undefined,
      }),
    } as unknown as WritableStream<Uint8Array>;
  },
  close: async () => {
    closed = true;
    fakePort.writable = null;
  },
};

const serial = {
  getPorts: async () => [fakePort],
  requestPort: async () => {
    chooserCalls += 1;
    return fakePort;
  },
};

Object.defineProperty(globalThis, "navigator", {
  value: { serial },
  configurable: true,
});

const hardware = await import("../lib/deviceHardware");
const drawer = await import("../lib/cashDrawer");
const sounds = await import("../lib/posSound");

let passed = 0;
const failures: string[] = [];

function check(label: string, condition: boolean): void {
  if (condition) passed += 1;
  else failures.push(label);
}

const defaults = hardware.loadDeviceHardwareSettings("terminal-a");
check("defaults use 80mm paper", defaults.receiptWidth === 80);
check("defaults accept Enter and Tab", defaults.scannerSubmitKey === "ENTER_OR_TAB");
check("POS sounds are enabled by default", defaults.soundEnabled && defaults.soundVolume === 60);

const normalized = hardware.normalizeDeviceHardwareSettings({
  receiptWidth: 70,
  autoPrintReceipt: false,
  autoOpenDrawer: true,
  drawerBaudRate: 123,
  drawerPin: 9,
  scannerSubmitKey: "SPACE",
});
check("invalid paper width falls back", normalized.receiptWidth === 80);
check("valid booleans survive normalization", !normalized.autoPrintReceipt && normalized.autoOpenDrawer);
check("invalid serial settings fall back", normalized.drawerBaudRate === 9600 && normalized.drawerPin === 2);

const normalizedSound = hardware.normalizeDeviceHardwareSettings({
  soundEnabled: false,
  soundVolume: 140,
});
check("sound mute survives normalization", !normalizedSound.soundEnabled);
check("sound volume is clamped", normalizedSound.soundVolume === 100);

const saved = hardware.saveDeviceHardwareSettings("terminal-a", {
  ...defaults,
  receiptWidth: 58,
  drawerBaudRate: 19200,
  drawerPin: 5,
  scannerSubmitKey: "TAB",
});
check("settings save per terminal", hardware.loadDeviceHardwareSettings("terminal-a").receiptWidth === 58);
check("another terminal keeps defaults", hardware.loadDeviceHardwareSettings("terminal-b").receiptWidth === 80);
check("save dispatches a same-tab refresh event", dispatched.includes(hardware.DEVICE_HARDWARE_EVENT));
check("scanner key policy accepts configured suffix", hardware.scannerAcceptsSubmitKey("Tab", saved.scannerSubmitKey));
check("scanner key policy rejects other suffix", !hardware.scannerAcceptsSubmitKey("Enter", saved.scannerSubmitKey));
check("sound cues use distinct patterns", sounds.getPosSoundPattern("SCAN_ACCEPTED") !== sounds.getPosSoundPattern("ERROR"));
check("maximum sound uses real output range", sounds.calculatePosSoundGain(100, 1) >= 0.85);
check("sound gain keeps zero fully silent", sounds.calculatePosSoundGain(0, 1) === 0);
check("sound gain is monotonic", sounds.calculatePosSoundGain(80, 1) > sounds.calculatePosSoundGain(40, 1));
sounds.emitPosSound("SCAN_ACCEPTED");
check("sound cue dispatches a semantic event", dispatched.includes(sounds.POS_SOUND_EVENT));

const connected = await drawer.connectCashDrawer(saved);
check("drawer chooser connects a port", connected && chooserCalls === 1 && openedAt === 19200);
const opened = await drawer.openCashDrawer(saved);
check("drawer pulse is written", opened && writtenPulse.join(",") === "27,112,1,25,250");
const status = await drawer.getCashDrawerStatus();
check("drawer status reports authorized selection", status.supported && status.selected && status.authorizedPortCount === 1);
await drawer.forgetCashDrawer();
check("forget closes the selected port", closed);

if (failures.length > 0) {
  for (const failure of failures) console.error(`  x ${failure}`);
  console.error(`Hardware workflows: ${passed} passed, ${failures.length} failed`);
  process.exit(1);
}

console.log(`Hardware workflows: ${passed} passed, 0 failed`);
