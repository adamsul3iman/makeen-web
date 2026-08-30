import path from "node:path";
import { fileURLToPath } from "node:url";

import electron from "electron";
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
