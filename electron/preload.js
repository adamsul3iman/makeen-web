import { contextBridge, ipcRenderer } from "node:electron";

contextBridge.exposeInMainWorld("electronAPI", {
  /**
   * Silently print HTML to a named printer — no native dialog.
   * Returns { success: boolean, error?: string }.
   */
  printSilent({ html, printerName }) {
    return ipcRenderer.invoke("print:silent", { html, printerName });
  },

  /** Enumerate available printers on the system. */
  getPrinters() {
    return ipcRenderer.invoke("print:getPrinters");
  },
});
