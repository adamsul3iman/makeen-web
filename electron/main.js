import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { open, write, close } from "node:fs/promises";
import { promisify } from "node:util";

import electron from "electron";

const execFileAsync = promisify(execFile);
import serve from "electron-serve";
import electronUpdater from "electron-updater";

const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = electron;
const { autoUpdater } = electronUpdater;

const UPDATE_CHECK_DELAY_MS = 10_000;
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const ELECTRON_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEVELOPMENT_ROOT = path.resolve(ELECTRON_DIRECTORY, "..");

let mainWindow = null;
let updateCheckTimer = null;

const DEFAULT_THERMAL_PRINTER = "Rongta RP80";
const THERMAL_NAME_HINTS = ["rongta", "rp80", "rp326", "80mm", "thermal", "receipt"];
const LABEL_NAME_HINTS = ["label", "barcode", "tsp", "tspl", "tsc", "zebra", "godex"];
const A4_NAME_HINTS = ["a4", "laser", "inkjet", "hp", "canon", "epson wf"];
const PRINT_CALLBACK_TIMEOUT_MS = 20_000;

// A THERMAL (receipt) job MUST never land on a label/TSPL or text-passthrough
// device. Those drivers spool the job's raw bytes to the printer instead of
// rasterizing a graphic, which is exactly the reported symptom: a receipt page
// coming out as literal "SIZE 10 mm, 10 mm / SET PEEL OFF / PRINT 1,1" label
// commands. When such a device name is the only match, we fail loudly instead
// of spraying raw TSPL at the receipt printer.
const LABEL_OR_TEXT_DEVICE_RE =
  /label|tspl|tsp|tsc|zebra|godex|barcode|text only|generic\/text|raw|print to/i;

// Raw command buffers (TSPL/ESC-POS) are reserved for BARCODE jobs which this
// bridge does NOT implement — there is deliberately no raw IPC channel. These
// signatures are matched against incoming html payloads so a mis-routed label
// buffer can never be interpreted as a receipt document and silently spooled.
const RAW_COMMAND_PATTERNS = [
  /^\s*(CLS|DIR|DRIVE|MODE|GAP|DENSITY|SET|SIZE|PRINT|BARCODE|TEXT|BLOCK|BOX|CUT|EOP|FEED|PEEL)\b/i,
  /\bsize\s*[\d.]+(\s*mm)?\s*,\s*[\d.]+(\s*mm)?\s*$/im,
  /\b(set\s+)?peel\s+(on|off)\s*$/im,
  /^\s*print\s+\d+\s*,\s*\d+\s*$/im,
  /\bbarcode\s*[-"\d]+\s*[, ]\s*[-\d]+/i,
  /^\s*gap\s+[\d.]+\s*mm,/im,
];

// ── Silent-print IPC ─────────────────────────────────────────────────
// Renderer calls window.electronAPI.printSilent({ html, printerName, printerKind }).
// A hidden BrowserWindow is created, the HTML is loaded, and
// webContents.print({ silent: true }) sends it straight to the printer.
//
// webContents.print() is VOID + callback-based (never a Promise), so the
// outcome MUST be captured through the (success, failureReason) callback —
// awaiting its return value always yields undefined.

function resolveDeviceName(printers, requestedName, printerKind) {
  if (requestedName) {
    const exact = printers.find((p) => p.name === requestedName);
    if (exact) return exact.name;
    const caseInsensitive = printers.find(
      (p) => p.name.toLowerCase() === requestedName.toLowerCase(),
    );
    if (caseInsensitive) return caseInsensitive.name;
  }
  const hints = printerKind === "A4" ? A4_NAME_HINTS : printerKind === "LABEL" ? LABEL_NAME_HINTS : THERMAL_NAME_HINTS;
  // Receipt jobs must stay on a real thermal receipt driver. Hint scans skip
  // label/TSPL/text-passthrough devices so a RECEIPT never resolves onto a
  // device that would print the job as raw TSPL command text.
  const candidates =
    printerKind === "THERMAL"
      ? printers.filter((p) => !LABEL_OR_TEXT_DEVICE_RE.test(p.name))
      : printers;
  const pool = candidates.length > 0 ? candidates : printers;
  for (const hint of hints) {
    const hit = pool.find((p) => p.name.toLowerCase().includes(hint));
    if (hit) return hit.name;
  }
  const fallback = pool.find((p) => p.isDefault);
  return fallback?.name ?? null;
}

/**
 * Reject any payload that is NOT a real HTML document before it ever reaches
 * the spooler. The silent bridge prints STATICALLY (webContents.print rasterizes
 * the page) and is reserved for receipts/reports; raw TSPL/ESC-POS buffers have
 * no business travelling through it. A label job must use its own raw channel —
 * which does not exist in this build — and a mis-routed buffer must fail here
 * rather than print itself as literal command text on the thermal paper.
 */
function looksLikeRawLabelPayload(html) {
  if (typeof html !== "string") return true;
  const trimmed = html.replace(/^\uFEFF/, "").trim();
  if (!trimmed) return true;
  // A real document starts with markup. Command buffers start with a command.
  if (!trimmed.startsWith("<")) return true;
  return RAW_COMMAND_PATTERNS.some((re) => re.test(trimmed));
}

function printWithResult(webContents, options) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (outcome) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        resolve(outcome);
      }
    };
    // Safety net: Chromium's callback is documented to always fire, but a
    // wedged spooler must not hang the renderer invoke forever.
    const timeout = setTimeout(
      () => settle({ ok: false, failureReason: "PRINT_TIMED_OUT" }),
      PRINT_CALLBACK_TIMEOUT_MS,
    );
    try {
      webContents.print(options, (success, failureReason) => {
        settle({ ok: success !== false, failureReason });
      });
    } catch (syncError) {
      settle({ ok: false, failureReason: String(syncError) });
    }
  });
}

// Serialize silent prints: webContents.print is not concurrency-safe for
// multiple hidden windows and the OS spooler can balk when several jobs are
// handed off simultaneously. A promise-chain mutex guarantees one in-flight
// job at a time, so a burst of receipts/shift reports never creates orphaned
// BrowserWindows or drops payloads under load.
let printQueueTail = null;

ipcMain.handle("print:silent", async (_event, { html, printerName, printerKind }) => {
  // ── Raw-payload gate ────────────────────────────────────────────────
  // This channel exists ONLY to render HTML graphics on the receipt/report
  // printer. Any payload that is a raw TSPL/ESC-POS command buffer is rejected
  // outright so label commands can never be physically printed as text.
  if (looksLikeRawLabelPayload(html)) {
    console.error("[electron] Silent print REJECTED: non-HTML (raw label/command) payload", {
      printerName,
      printerKind,
    });
    return { success: false, error: "REJECTED_RAW_LABEL_PAYLOAD" };
  }

  // Each job awaits the previous one before starting, so hidden print windows
  // are created/destroyed strictly one at a time.
  const previous = printQueueTail;
  let release;
  printQueueTail = new Promise((resolve) => (release = resolve));
  // Guarded so the mutex is ALWAYS released (see finally) even if the queue
  // predecessor rejects — a leaked lock would starve every later print.
  let printWindow = null;
  try {
    await previous;
    printWindow = new BrowserWindow({
      show: false,
      width: 400,
      height: 800,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: false,
      },
    });

    await printWindow.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
    );

    // Small delay to let the renderer paint before printing.
    await new Promise((r) => setTimeout(r, 300));

    const printers = await printWindow.webContents.getPrintersAsync();
    const requested = printerName || DEFAULT_THERMAL_PRINTER;
    // A RECEIPT must never resolve to a label/TSPL/text device even when it is
    // explicitly named — that is the mis-routing that prints raw label commands
    // on the receipt printer instead of the HTML graphic. (LABEL jobs may use
    // label devices; each channel keeps to its own device class.)
    if (printerKind === "THERMAL" && LABEL_OR_TEXT_DEVICE_RE.test(requested)) {
      console.error("[electron] Silent print REJECTED: receipt routed to label/text device", {
        requested,
        printerKind,
        installed: printers.map((p) => p.name),
      });
      return { success: false, error: "LABEL_DEVICE_REJECTED_FOR_RECEIPT", requested };
    }
    const deviceName = resolveDeviceName(printers, requested, printerKind);
    if (!deviceName) {
      console.error("[electron] Silent print: no matching printer for", {
        printerName,
        printerKind,
        installed: printers.map((p) => p.name),
      });
      return { success: false, error: "NO_MATCHING_PRINTER", installed: printers.map((p) => p.name) };
    }

    const outcome = await printWithResult(printWindow.webContents, {
      silent: true,
      printBackground: true,
      deviceName,
    });
    if (!outcome.ok) {
      console.error("[electron] Silent print rejected:", {
        deviceName,
        reason: outcome.failureReason,
      });
      return { success: false, error: outcome.failureReason || "PRINT_FAILED", deviceName };
    }
    // Grace period: the Chromium callback fires when the job is handed to the
    // OS spooler, but some USB thermal drivers abort in-flight jobs if the
    // source window is destroyed immediately. Let the spooler settle.
    await new Promise((r) => setTimeout(r, 750));
    console.info("[electron] Silent print OK:", { deviceName, printerKind, bytes: html.length });
    return { success: true, deviceName };
  } catch (err) {
    console.error("[electron] Silent print failed:", err);
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (printWindow && !printWindow.isDestroyed()) {
      printWindow.destroy();
    }
    // Always release the mutex (even on throw) so later jobs in the queue are
    // never starved.
    if (release) release();
  }
});

ipcMain.handle("print:getPrinters", async (event) => {
  try {
    const sender = event.sender ?? mainWindow?.webContents;
    if (!sender) return [];
    return await sender.getPrintersAsync();
  } catch {
    return [];
  }
});

// ── Raw ESC/POS hardware IPC ────────────────────────────────────────
// These channels write raw command bytes DIRECTLY to a serial (COM) device
// with Node's fs — completely bypassing the Windows graphical print spooler.
// A cash drawer is a dumb electromechanical solenoid: it lives on the RS-232
// / USB-serial drawer port (or the thermal printer's serial I/O), NOT on the
// windows spooler. Routing the ESC/POS kick through webContents.print is what
// produced the "gibberish" symptom (the spooler rasterizes the byte buffer as
// text), so raw hardware pulses ALWAYS go through these dedicated channels and
// NEVER through the HTML document pipeline in print:silent.
//
// Web Serial (navigator.serial in the renderer) is not wired into this build,
// which is exactly why the drawer never kicked in the desktop app: the browser
// Web Serial API, when exposed, ALSO requires a session.setDevicePermission
// handler + native chooser in Electron. These wired COM channels are the
// dependency-free, chooser-free drawer path for the packaged app.

const COM_MAX_SCAN = 256;
const RAW_HARDWARE_TIMEOUT_MS = 2_000;

/** Normalize an operator-entered port ("COM3", "com3", "\\\\.\\COM3") to a
 *  Windows device path ("\\\\.\\COM3"). Returns null for anything else. */
function normalizeComPortName(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const device = /^\\\\\.\\COM\d{1,3}$/i.test(trimmed)
    ? trimmed
    : null;
  const bare = device ?? (/^COM\d{1,3}$/i.test(trimmed) ? `\\\\.\\${trimmed.toUpperCase()}` : null);
  return bare;
}

let lastComBaudKey = "";

/** Set the port's baud via the Windows `mode` command, but only when it
 *  differs from the last applied value for that port. This mirrors the
 *  baudRate option the old Web Serial path passed to port.open(). Non-fatal:
 *  a driver that already holds the serial DCB just gets opened as-is. */
async function ensureComBaud(comPort, baudRate) {
  const baud = Number(baudRate);
  if (!Number.isInteger(baud) || baud <= 0) return;
  const key = `${comPort.toUpperCase()}:${baud}`;
  if (key === lastComBaudKey) return;
  try {
    await execFileAsync(
      "cmd.exe",
      ["/c", `mode ${comPort.toUpperCase()}: baud=${baud} parity=n data=8 stop=1`],
      { windowsHide: true, timeout: RAW_HARDWARE_TIMEOUT_MS },
    );
    lastComBaudKey = key;
  } catch {
    // The serial DCB belongs to whoever owns the port today; not fatal.
  }
}

/** Open the COM device, write the full command buffer, close. Throws on
 *  failure so callers can wrap with a timeout. */
async function writeRawCom(comPort, bytes, baudRate) {
  const device = normalizeComPortName(comPort);
  if (!device) throw new Error(`Invalid COM port: ${comPort}`);
  await ensureComBaud(comPort, baudRate);
  let fd = null;
  try {
    fd = await open(device, "r+");
    const buf = Buffer.from(bytes);
    let offset = 0;
    while (offset < buf.length) {
      const { bytesWritten } = await write(fd, buf, offset, buf.length - offset, null);
      offset += bytesWritten;
    }
  } finally {
    if (fd) {
      try {
        await close(fd);
      } catch {
        // Port may already be gone (unplugged mid-write).
      }
    }
  }
}

/** Enumerate serial ports by probing \\\\.\\COM1..\\\\.\\COM256 with the file
 *  system. A port that opens exists and is free; EBUSY/EACCES means it exists
 *  but is held by another driver; ENXIO/ENOENT means no such device. */
async function listComPorts() {
  const ports = [];
  for (let i = 1; i <= COM_MAX_SCAN; i += 1) {
    const name = `COM${i}`;
    const device = `\\\\.\\${name}`;
    let fd = null;
    try {
      fd = await open(device, "r+");
      ports.push(name);
    } catch (err) {
      if (err && (err.code === "EBUSY" || err.code === "EACCES")) {
        ports.push(name);
      }
    } finally {
      if (fd) {
        try {
          await close(fd);
        } catch {
          /* ignore */
        }
      }
    }
  }
  return ports;
}

function withRawTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("RAW_HARDWARE_TIMED_OUT")), ms);
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

/** Raw ESC/POS drawer kick: ESC p m t1 t2 — the SAME 5-byte pulse the browser
 *  Web Serial path sends. pin 2 → connector 0, pin 5 → connector 1. */
ipcMain.handle("hardware:drawer", async (_event, opts) => {
  const { comPort, baudRate, pin } = opts ?? {};
  if (!normalizeComPortName(comPort)) {
    return { ok: false, error: "INVALID_COM_PORT" };
  }
  const connector = pin === 5 ? 1 : 0;
  const pulse = [0x1b, 0x70, connector, 0x19, 0xfa];
  try {
    await withRawTimeout(
      writeRawCom(comPort, pulse, baudRate),
      RAW_HARDWARE_TIMEOUT_MS,
    );
    return { ok: true };
  } catch (err) {
    console.error("[electron] Drawer kick failed:", err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

/** Raw write test: ESC @ (printer initialize). Harmless anywhere on a POS
 *  printer's serial I/O — resets the printer state without feeding paper or
 *  opening the drawer. Lets an operator validate the COM path in the Devices
 *  page before relying on it in the live checkout lane. */
ipcMain.handle("hardware:initPort", async (_event, opts) => {
  const { comPort, baudRate } = opts ?? {};
  if (!normalizeComPortName(comPort)) {
    return { ok: false, error: "INVALID_COM_PORT" };
  }
  try {
    await withRawTimeout(
      writeRawCom(comPort, [0x1b, 0x40], baudRate),
      RAW_HARDWARE_TIMEOUT_MS,
    );
    return { ok: true };
  } catch (err) {
    console.error("[electron] COM init write failed:", err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle("hardware:listPorts", async () => {
  try {
    return await withRawTimeout(listComPorts(), RAW_HARDWARE_TIMEOUT_MS);
  } catch (err) {
    console.error("[electron] COM port enumeration failed:", err);
    return [];
  }
});

/**
 * Serve the static Next.js export from the `out/` directory.
 * In production (packaged), `app.getAppPath()` points at the asar or root.
 * In development, we resolve relative to the electron/ folder.
 */
const staticServe = serve({ directory: "out" });

function getProjectRoot() {
  return app.isPackaged ? app.getAppPath() : DEVELOPMENT_ROOT;
}

function createMainWindow() {
  const iconPath = path.join(getProjectRoot(), "public", "icons", "icon-512.png");

  Menu.setApplicationMenu(null);
  mainWindow = new BrowserWindow({
    title: "MAKEEN POS",
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#f4f4f5",
    ...(process.platform === "win32" ? { icon: iconPath } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: path.join(ELECTRON_DIRECTORY, "preload.cjs"),
      webSecurity: false,
    },
  });

  mainWindow.removeMenu();
  mainWindow.setMenuBarVisibility(false);

  mainWindow.once("ready-to-show", () => {
    mainWindow?.maximize();
    mainWindow?.show();
  });

  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`[electron] Page load failed: ${errorCode} ${errorDescription} — ${validatedURL}`);
  });

  mainWindow.webContents.on("console-message", (_event, level, message) => {
    if (level >= 2) console.error(`[renderer] ${message}`);
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // Load the static export via electron-serve to register the app://- protocol,
  // then navigate to /login (the POS entry point). The root / is the public
  // marketing page for the web domain only — desktop users go straight to login.
  void staticServe(mainWindow).then(() => {
    void mainWindow.loadURL("app://-/login");
  });
}

function configureAutoUpdater() {
  if (isDev) return;

  autoUpdater.logger = console;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;

  autoUpdater.on("error", (error) => {
    console.error("[auto-updater] Error:", error);
  });

  autoUpdater.on("update-available", async (info) => {
    console.info(`[auto-updater] Update available: ${info.version}`);

    const response = await dialog.showMessageBox(mainWindow, {
      type: "info",
      title: "تحديث متاح",
      message: `يتوفر إصدار جديد من MAKEEN POS (${info.version})`,
      detail: "سيتم تنزيله الآن. سيتم تثبيته تلقائياً عند إغلاق التطبيق.",
      buttons: ["تنزيل الآن", "لاحقاً"],
      defaultId: 0,
      cancelId: 1,
    });

    if (response.response === 0) {
      autoUpdater.downloadUpdate();
    }
  });

  autoUpdater.on("download-progress", (progress) => {
    const percent = Math.round(progress.percent);
    mainWindow?.setProgressBar(progress.percent / 100);
    console.info(`[auto-updater] Download progress: ${percent}%`);
  });

  autoUpdater.on("update-downloaded", async (info) => {
    mainWindow?.setProgressBar(-1);
    console.info(`[auto-updater] Update downloaded: ${info.version}`);

    const response = await dialog.showMessageBox(mainWindow, {
      type: "info",
      title: "جاهز للتثبيت",
      message: `تم تنزيل التحديث ${info.version} بنجاح`,
      detail: "يجب إعادة تشغيل التطبيق لتثبيت التحديث. هل تريد إعادة التشغيل الآن؟",
      buttons: ["إعادة التشغيل", "لاحقاً"],
      defaultId: 0,
      cancelId: 1,
    });

    if (response.response === 0) {
      autoUpdater.quitAndInstall(false, true);
    }
  });

  const checkForUpdates = () => {
    void autoUpdater.checkForUpdates().catch((error) => {
      console.error("[auto-updater] Check failed:", error);
    });
  };

  setTimeout(checkForUpdates, UPDATE_CHECK_DELAY_MS);
  updateCheckTimer = setInterval(checkForUpdates, UPDATE_CHECK_INTERVAL_MS);
}

const isDev = !app.isPackaged;

async function launchApplication() {
  try {
    console.info("[electron] MAKEEN POS starting — serving static export from out/");
    createMainWindow();
    configureAutoUpdater();
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error("Unable to start MAKEEN POS:", message);
    dialog.showErrorBox("MAKEEN POS", `Unable to start the application.\n\n${message}`);
    app.quit();
  }
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(launchApplication);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });

  app.on("window-all-closed", () => {
    app.quit();
  });

  app.on("will-quit", () => {
    if (updateCheckTimer) clearInterval(updateCheckTimer);
  });
}
