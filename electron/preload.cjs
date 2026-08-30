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
   * List serial COM ports (\\\\.\\COM1..COM256) reachable over the file
   * system. Raw ESC/POS devices (cash drawer / thermal serial I/O) are
   * driven through these ports, NOT through the Windows print spooler.
   */
  listComPorts() {
    return ipcRenderer.invoke("hardware:listPorts");
  },

  /**
   * Raw ESC/POS drawer kick on a serial port. Returns { ok, error? }.
   * Bypasses the print spooler entirely — never rides print:silent.
   */
  kickDrawer({ comPort, baudRate, pin }) {
    return ipcRenderer.invoke("hardware:drawer", { comPort, baudRate, pin });
  },

  /**
   * Raw write test (ESC @ printer initialize) on a serial port. Lets an
   * operator validate the COM path from the Devices page without touching
   * the spooler or opening the drawer.
   */
  initComPort({ comPort, baudRate }) {
    return ipcRenderer.invoke("hardware:initPort", { comPort, baudRate });
  },
});
