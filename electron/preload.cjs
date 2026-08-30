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

  /**
   * Raw ESC/POS drawer kick on a shared Windows printer. Returns { ok, error? }.
   * Writes the pulse bytes directly to \\\\127.0.0.1\\<shareName> through the
   * spooler's RAW datatype — never rides print:silent (that path rasterizes
   * bytes as text → gibberish).
   */
  kickDrawer({ shareName, pin }) {
    return ipcRenderer.invoke("hardware:drawer", { shareName, pin });
  },

  /**
   * Raw write test (ESC @ printer initialize) on a shared Windows printer.
   * Lets an operator validate the UNC share path from the Devices page without
   * touching the spooler renderer or opening the drawer.
   */
  initPrinter({ shareName }) {
    return ipcRenderer.invoke("hardware:initPrinter", { shareName });
  },
});
