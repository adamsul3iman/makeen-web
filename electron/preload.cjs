// CommonJS preload — deliberately NOT ESM. Electron loads preload scripts
// through the CJS loader regardless of package.json "type", and sandboxed
// preloads can never be ESM. A .cjs extension guarantees this file parses
// under every packaging/sandbox combination.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  /**
   * Silently print HTML to a resolved printer — no native dialog.
   * Returns { success: boolean, error?: string, deviceName?: string }.
   */
  printSilent({ html, printerName, printerKind }) {
    return ipcRenderer.invoke("print:silent", { html, printerName, printerKind });
  },

  /** Enumerate available printers on the system. */
  getPrinters() {
    return ipcRenderer.invoke("print:getPrinters");
  },
});
