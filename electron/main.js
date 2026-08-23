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

// ── Silent-print IPC ─────────────────────────────────────────────────
// Renderer calls window.electronAPI.printSilent({ html, printerName }).
// A hidden BrowserWindow is created, the HTML is loaded, and
// webContents.print({ silent: true }) sends it straight to the printer.

ipcMain.handle("print:silent", async (_event, { html, printerName }) => {
  const deviceName = printerName || DEFAULT_THERMAL_PRINTER;
  let printWindow = null;
  try {
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

    const success = await printWindow.webContents.print({
      silent: true,
      printBackground: true,
      deviceName,
    });

    return { success: !!success };
  } catch (err) {
    console.error("[electron] Silent print failed:", err);
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (printWindow && !printWindow.isDestroyed()) {
      printWindow.destroy();
    }
  }
});

ipcMain.handle("print:getPrinters", async () => {
  if (!mainWindow) return [];
  try {
    return mainWindow.webContents.getPrintersAsync();
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
      preload: path.join(ELECTRON_DIRECTORY, "preload.js"),
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
