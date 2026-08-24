# HARDWARE & ELECTRON INTEGRATION AUDIT — MAKEEN POS

**Date:** 2026-08-24 (overnight read-only audit)
**Scope:** `electron/main.js`, `electron/preload.cjs`, IPC handlers, `lib/printAgent.ts`, `hooks/useBarcodeScanner.ts`, `lib/scanCoalesce.ts`, `lib/moneyInput.ts`, `lib/deviceHardware.ts`, `print-agent/src/*` (listener, spooler, config, index)
**Mode:** READ-ONLY. No application code was modified.
**Electron version:** ^43.4.1 · Next.js static export served via `electron-serve` (`app://-`) · standalone Node print agent packaged with pkg

---

## Executive Summary

The Electron shell is **fundamentally sound**: correct `contextBridge` usage, per-job print windows destroyed in `finally`, a spooler-wedge timeout, single-instance lock, and a well-designed keyboard-wedge scanner pipeline with three independent layers of defense.

However, there are **2 critical**, **7 high**, and several medium findings that matter specifically for an unattended 24-hour shift:

1. The main process has **no renderer/GPU/child-process crash handling and no global exception handler** — a crashed renderer leaves a dead black terminal until someone manually restarts the app.
2. The standalone print agent's processing pipeline can **deadlock permanently on one hung step** (Puppeteer `page.pdf()` or SumatraPDF have no timeouts), freezing ALL printing for the rest of the shift while `/health` still reports `ok`.
3. `webSecurity: false` is set on **both** BrowserWindows — this is the single biggest security smell in the codebase.
4. The print agent health server binds **0.0.0.0** (whole LAN), and stores a **plaintext Supabase service-role key** next to the exe.

---

## 1. Memory Management (24-hour shift stability)

### 1.1 Print window lifecycle in `main.js` — GOOD, with caveats

`ipcMain.handle("print:silent")` (electron/main.js:77) creates a hidden `BrowserWindow` per job and destroys it in a `finally` block (electron/main.js:134-138) via `destroy()`. This covers success, failure, timeout, and throw paths — **no window leak on any single-job path**.

Caveats found:

| # | Severity | Finding |
|---|----------|---------|
| M-1 | MEDIUM | **No print queue / concurrency cap.** Every `print:silent` call immediately spawns a full Chromium renderer (~30–60 MB RSS). With auto-print-on-checkout enabled (`deviceHardware.autoPrintReceipt` default `true`), two cashiers' rapid receipts or a retry storm stack multiple hidden windows simultaneously. Each also holds memory through a 300 ms paint delay + 20 s max print wait + 750 ms spooler grace (electron/main.js:97, 63-65, 129). A serialized job queue (mutex around window creation) would bound worst-case memory to exactly one print window. |
| M-2 | LOW | The 750 ms post-print grace period (electron/main.js:129) runs even when the outcome was failure — trivial waste, not a leak. |
| M-3 | LOW | Data-URL loading of receipt HTML (`data:text/html;charset=utf-8,...`, electron/main.js:92-94) inflates payload by ~25–30% via `encodeURIComponent`; very long invoices approach Chromium's practical data-URL limits and fail inside the try/catch (graceful but opaque error surfaced as generic `PRINT_FAILED`). |

### 1.2 Zombie child processes

- **Electron shell itself spawns nothing.** No `child_process` usage in `electron/main.js`. There is no zombie-process risk from the shell's own process tree.
- **Print agent (`print-agent/src/spooler.ts`):**
  - Puppeteer browser is a cached singleton guarded by `_browser.connected` (spooler.ts:77) — self-heals after a Chrome crash by relaunching. Good.
  - **H-4 (HIGH): No timeout on `page.pdf()`** (spooler.ts:147-153). `page.setContent` has a 15 s timeout, but if Chrome hangs *during* PDF generation, `processJob` awaits forever. Because `MAX_CONCURRENT = 1` (listener.ts:43) and the periodic drain skips when `processing >= MAX_CONCURRENT` (listener.ts:220), **one hung render freezes all printing until manual service restart** — while `/health` keeps returning `200 ok` with no error field. This is the most likely "printer silently died mid-shift" root cause in the field.
  - Same applies to `ptp.print(pdfPath, opts)` (spooler.ts:204): pdf-to-printer spawns SumatraPDF and waits; a wedged printer driver blocks indefinitely.
  - **M-4 (MEDIUM): Orphaned chrome.exe on hard kill.** The agent runs as a Windows service with `sc failure ... restart/5000/...` recovery (index.ts:123). If the service is force-killed (power loss, taskkill), the Puppeteer child Chrome is not in a Windows Job Object and may survive restart → orphaned Chrome processes accumulate over days of continuous operation. Recommend launching Chrome with `--renderer-process-limit=1` plus a startup sweep that kills stale `chrome.exe --headless` instances, or wrapping the child in a Job Object.
  - **L-1 (LOW): Temp residue.** `job-<id>.pdf` in `%TEMP%\makeen-print-agent` is deleted best-effort in `finally` (spooler.ts:206); a kill between write and unlink leaves residue that accumulates over weeks. Add a startup sweep deleting stale files.

### 1.3 Timers and listeners

- `updateCheckTimer` is cleared on `will-quit` (electron/main.js:317-319). Correct.
- Scanner keydown listeners are properly removed on hook unmount (`useBarcodeScanner.ts:196-199`). Correct.
- Health-cache timers in `printAgent.ts` are plain timestamps, not intervals. Correct.

### 1.4 Crash handling — the big gap

| # | Severity | Finding |
|---|----------|---------|
| **H-1** | **HIGH** | **No crash/exception handlers anywhere in `main.js`.** Missing: `process.on("uncaughtException")`, `process.on("unhandledRejection")`, `webContents.on("render-process-gone")`, `app.on("child-process-gone")`, `app.on("gpu-process-gone")`. Consequences over a long shift: (a) renderer OOM/crash → permanent dead UI with zero recovery and zero log beyond nothing; (b) GPU driver reset → black/frozen window; (c) an uncaught exception in main silently kills features (e.g., the updater) without quitting. For a POS terminal this is the difference between "cashier calls support" and "cashier loses the sale." Minimum fix: on `render-process-gone` reload or recreate the window; on `uncaughtException` log-and-continue or show an error box. |
| H-5 | HIGH | **Updater dialog null-crash vector.** `autoUpdater.on("update-available"|"update-downloaded")` call `dialog.showMessageBox(mainWindow, …)` (electron/main.js:229, 254) with no null guard. If the window is closed/recreating when the 4-hourly check fires (`window-all-closed` → quit race), `showMessageBox(null, …)` throws inside an async event handler → unhandled rejection, updater wedged for the rest of the shift. Guard with `if (!mainWindow || mainWindow.isDestroyed()) return;`. |
| L-2 | LOW | Fragile TDZ ordering: `configureAutoUpdater()` reads `isDev` (electron/main.js:215) declared at line 279. Works only because invocation happens after module evaluation completes (inside `whenReady`). Hoist the declaration above its use before someone "simplifies" this into a bug. |

### 1.5 What already works well (do not regress)

- Single-instance lock prevents duplicate app copies eating RAM (electron/main.js:294-303).
- `mainWindow = null` on `closed` avoids dangling references (electron/main.js:202-204).
- `window-all-closed → app.quit()` is correct for a Windows POS terminal.
- 20-second `PRINT_CALLBACK_TIMEOUT_MS` safety net guarantees the renderer invoke can never hang forever even if Chromium's print callback never fires (electron/main.js:61-66).

---

## 2. Hardware Edge Cases

### 2.1 USB barcode scanner (keyboard-wedge)

Architecture: keystroke-timing heuristic — machine-fast burst (avg < 30 ms/key, ≤ 600 ms total, ≥ 3 chars, ≤ 60 ms gap, 128-char buffer) terminated by Enter/Tab commits via `store.scanBarcode(code)` (`hooks/useBarcodeScanner.ts`).

Corrupted-input behavior matrix:

| Scenario | Behavior | Verdict |
|---|---|---|
| Unknown/garbled code committed | `scanBarcode` misses `barcodeIndex` → Arabic error notice + error tone, cart untouched (store/usePosStore.ts:1387) | Graceful |
| Scan lands in money/discount field while modal open | Capture-phase listener detects wedge burst on terminator, swallows it, plays ERROR tone (useBarcodeScanner.ts:88-107); second line of defense: `moneyInput.ts` regex rejects any non-money shape keystroke-by-keystroke so garbage can never reach `completeCheckout` | Excellent defense-in-depth |
| Cheap scanner double-fires same code | `shouldCoalesceScan` drops identical commit within 120 ms (lib/scanCoalesce.ts) | Correct |
| Stale burst whose Enter was lost | Burst must still be fresh at submit time (≤ 600 ms, useBarcodeScanner.ts:154) — can never fire minutes later | Correct |
| PIN lock / closed shift / open modal | All three gates block scanning behind dialogs (useBarcodeScanner.ts:134-141) | Correct |
| Listener leak on route change | Cleanup present | Correct |

Remaining gaps:

| # | Severity | Finding |
|---|----------|---------|
| HW-1 | MEDIUM | **Timing heuristic is brittle to scanner configuration.** Many retail scanners ship with a programmable inter-character delay (e.g. 50 ms "keyboard interval" for legacy hosts). At >30 ms average the burst is no longer detected as a wedge: the modal-suppression guard (Risk 7 layer 1) silently stops working. Layer 2 (`moneyInput` regex) still prevents money-field corruption, but the scan will type raw digits into whatever field has focus and the Enter will submit forms (e.g., customer search). Document the required scanner config, or add a length-based heuristic (≥ 8 consecutive digits with no separators) as a third signal. |
| HW-2 | LOW | Buffer overflow (>128 chars) and duration overflow are flushed **silently** (useBarcodeScanner.ts:120-127, 184-191). A misconfigured scanner appending suffixes (FN/CRLF prefixes) can produce permanently discarded scans with no operator-visible feedback. Consider a debug counter or warn log. |
| HW-3 | LOW | No EAN/check-digit validation — corrupted-but-plausible codes simply hit the unknown-barcode path. Acceptable; noted for completeness. |
| — | INFO | Scanner USB disconnect/reconnect needs no app-side handling (pure HID keyboard enumeration at OS level). Resilient by design. |

### 2.2 Thermal / A4 printing

Electron silent-print tier (`main.js`):

| Scenario | Behavior | Verdict |
|---|---|---|
| Printer missing/unplugged before print | `resolveDeviceName` falls back name→hints→default→null; returns `{success:false, error:"NO_MATCHING_PRINTER", installed:[…]}` with full diagnostics logged (electron/main.js:105-112) | Graceful |
| Paper out / cover open at submit time | Spooler rejects → `(success=false, failureReason)` callback → mapped to `PRINT_FAILED` + reason, returned to renderer, shown as in-app notice (smartPrint suppresses native dialog inside Electron by contract, lib/printAgent.ts:283-286) | Graceful, does NOT crash main process |
| Wedged spooler / callback never fires | 20 s timeout → `PRINT_TIMED_OUT`; window destroyed in `finally` | Graceful |
| `webContents.print` throws synchronously | Caught (electron/main.js:71-73) | Graceful |
| **HW-4** | **MEDIUM** | **Paper-out AFTER handoff is invisible.** The print callback fires when the job is queued to the OS spooler, not when physically printed. If paper runs out mid-receipt, Windows retries silently; the cashier saw `success:true`, the receipt never emerges, and the app never knows. Mitigation options: poll the printer status via `getPrintersAsync()` (some drivers expose status flags) or a post-print "did it come out?" confirm tone/button on high-value documents (Z-report especially). |
| HW-5 | LOW | Concurrent prints are not mutexed (see M-1); thermal drivers usually serialize at the spooler, but interleaved A4 + thermal jobs each spawn their own hidden window. |

Standalone agent tier (`print-agent/`):

| # | Severity | Finding |
|---|----------|---------|
| **H-6** | **HIGH** | **Failed jobs are never retried.** On render or spool failure the agent calls `resolveJob(supabase, jobId, false)` (listener.ts:130, 143) — the job is resolved-failed and dropped. The schema carries an `attempts` column, but no increment/backoff/requeue logic exists anywhere. **A transient paper-out at 14:00 means that Z-report/receipt is permanently lost** unless the cashier notices and reprints manually. Recommend: on spool-failure requeue up to N attempts with delay (the claim RPC presumably already guards double-processing). |
| **H-7** | **HIGH** | **Pipeline stall deadlock** — see §1.2/H-4: no timeout on `page.pdf()`/SumatraPDF + `MAX_CONCURRENT=1` = permanent silent freeze. Combined with H-6, a single hung job both freezes the queue *and* the frozen job is never failed, so nothing recovers it. Wrap every stage in `Promise.race` with generous timeouts (e.g. 60 s render, 90 s spool) and resolve-false on breach. |
| HW-6 | MEDIUM | Claim RPC uses `getStoreId()` which returns `""` on any network hiccup (listener.ts:250, 258) → `claim_print_job("")` claims nothing. Self-heals on the 30 s drain, but during a Supabase blip jobs pile up with only realtime triggers skipped ("Agent busy" path, listener.ts:182-185) — those skipped INSERT events rely entirely on the drain interval. Acceptable, but raise MAX_CONCURRENT-aware logging here. |
| HW-7 | LOW | Realtime payload rows are trusted blindly (`payload.new as PrintJobRow`, listener.ts:188) — malformed payloads would throw inside the handler; caught nowhere except the outer `processing--` finally, leaving an error swallowed by Supabase client. Wrap in try/catch and log. |
| HW-8 | INFO | Shutdown hygiene is good in console mode: SIGINT/SIGTERM → `stop()` closes browser, removes channel, closes server (index.ts:190-197, listener.ts:226-233). But as a raw `sc.exe` service there is no wrapper guaranteeing SIGTERM delivery on stop — see M-4 orphan risk. `unhandledRejection` logs and keeps alive (index.ts:198-202) — right choice for a service. |

Cash drawer settings exist in `deviceHardware.ts` (`drawerBaudRate`, `drawerPin`) but no drawer-kick code path exists yet in the audited files — settings are forward-declared only. No audit findings apply; flagging so nobody assumes drawer kick is wired up.

### 2.3 Auto-updater (shift-relevant)

Update checks start 10 s after boot and repeat every 4 h (electron/main.js:11-12, 275-276). Two UX risks for an active shift: (a) modal dialog steals focus mid-checkout — consider deferring prompts until idle; (b) the null-window crash vector in H-5. `autoDownload:false` requires explicit consent — good.

---

## 3. IPC Security

### 3.1 What is done correctly (textbook)

- `contextIsolation: true` and `nodeIntegration: false` on **both** windows (electron/main.js:85-87, 173-175).
- Preload exposes exactly **two fixed-channel `invoke()` wrappers** — no `ipcRenderer` passthrough, no dynamic channels, no `remote`, no `executeJavaScript` (preload.cjs:7-19). This is the correct minimal contextBridge surface.
- Hidden print window: `sandbox: true`, no preload, no node (electron/main.js:84-89).
- No wildcard `ipcMain.on`, no `webContents.send` into pages with structured-clone bypasses.
- `setWindowOpenHandler` denies all popups (though see S-3 below).
- electron-updater with `allowPrerelease:false`, `autoDownload:false`.

### 3.2 Findings

| # | Severity | Finding |
|---|----------|---------|
| **C-1** | **CRITICAL** | **`webSecurity: false` on BOTH windows** (electron/main.js:88 and :177). This disables same-origin policy for the main POS UI. Any XSS in the renderer (tenant-controlled strings — product names, receipt headers, customer names — rendered anywhere without escaping) can now freely `fetch()` cross-origin, read responses, and exfiltrate session tokens. There is no apparent reason this flag is needed: the app loads from `app://-` via electron-serve, and the data:-URL print window works fine with webSecurity on. **Remove both occurrences; if some asset breaks, load it locally instead.** |
| **S-1** | **HIGH** | **Print agent binds `0.0.0.0:9100`** (listener.ts:64). `/health` is reachable from the entire store LAN/Wi-Fi and discloses terminal UUID, thermal printer model, A4 model, uptime. Worse, the port accepts connections that keep the service warm for anyone probing. Bind `127.0.0.1` — `lib/printAgent.ts:108` only ever calls `localhost`. One-line fix, meaningful attack-surface reduction. |
| **S-2** | **HIGH** | **Plaintext service-role Supabase key in `config.json` next to the exe** (config.ts:75-85, index.ts:63). Anyone with file access to the register gets full DB god-mode. Standard practice for local agents is DPAPI (` CryptProtectData`) encryption or at minimum NTFS ACLs + documentation. Also note the wizard echoes nothing, but the key sits in a world-readable file. |
| S-3 | MEDIUM | **`shell.openExternal(url)` with no scheme allowlist** (electron/main.js:197-200). `window.open("file:///C:/...")`, `smb://`, or custom protocol URIs from a compromised renderer are passed straight to the OS shell — historically an RCE/phishing vector (crafted `ms-office`/`search-ms` URIs). Allowlist `^https?://`. |
| S-4 | MEDIUM | **No sender validation on IPC handlers.** `ipcMain.handle("print:silent", (_event, {html,…}))` ignores `_event`; any frame/webContents in the process could invoke it. Today only one renderer exists, but the pattern invites future holes. Add: `if (!event.senderFrame?.url.startsWith("app://-/")) throw new Error("forbidden")` in both handlers. |
| S-5 | MEDIUM | **Unvalidated IPC payload → arbitrary HTML loaded and executed.** `{ html }` is never type-checked or size-capped before being loaded as a data: URL (electron/main.js:77-94). Scripts inside tenant-rendered receipt HTML execute in the print window — sandboxed and node-less (good), but with `webSecurity:false` (C-1) they can exfiltrate freely. Validate `typeof html === "string"` + cap length (e.g. 512 KB) and strip `<script>` in `renderShiftPrintHtml`/capture paths. |
| S-6 | MEDIUM | **No `will-navigate` lock on the main window.** Nothing prevents the renderer from navigating itself to an arbitrary http(s) URL (electron-serve only maps `app://`). One XSS → full-page phishing clone of the login screen harvesting cashier PINs. Deny out-of-scheme navigation via `will-navigate` + `setWindowOpenHandler` already denies popups. |
| S-7 | LOW | Main window runs with `sandbox: false` (electron/main.js:175). Given the preload needs only `contextBridge`+`ipcRenderer` (both available sandboxed — and the file comment already argues .cjs for sandbox compatibility), `sandbox: true` costs nothing. Enable it. |
| L-3 | LOW | `console-message` level≥2 forwarded to stdout (electron/main.js:193-195): in packaged builds stdout can land in persistent logs — ensure renderer errors don't carry PII/tokens. |
| L-4 | LOW | `print:getPrinters` swallows all errors into `[]` (electron/main.js:146-148) — renderer cannot distinguish "no printers installed" from "IPC failure". Return a discriminated result instead. |

### 3.3 Renderer-side hardware bridge (`lib/printAgent.ts`)

Clean: feature-detects `window.electronAPI`, catches everything, degrades through three tiers (Electron IPC → Supabase agent → browser-only `window.print()`, suppressed inside Electron by contract). One design note: tier-2 health probe hits `http://localhost:9100/health` — once S-1 is fixed to loopback binding these stay compatible. The 30 s health cache + invalidation on failure is correct.

---

## 4. Prioritized Remediation Plan

**P0 — before next production shift**
1. C-1: remove `webSecurity: false` from both BrowserWindows.
2. H-4/H-7: add timeouts around `page.pdf()` and SumatraPDF spool in the agent; resolve-failed on breach.
3. H-1: add `render-process-gone` → reload/recreate, `child-process-gone` logging, and `uncaughtException`/`unhandledRejection` handlers in `main.js`.
4. H-5: null-guard `mainWindow` in both updater dialogs.

**P1 — within the week**
5. S-1: bind agent health server to `127.0.0.1`.
6. H-6: implement attempt-counter requeue for spool failures (paper-out recovery).
7. S-3/S-4/S-6: allowlist external schemes, validate IPC senders, add `will-navigate` deny.
8. S-2: encrypt or ACL the agent's service key.

**P2 — hardening**
9. M-1: serialize `print:silent` with a promise-chain mutex; S-5 validate/size-cap HTML; S-7 enable main-window sandbox.
10. HW-1/HW-2: scanner-config documentation + digit-run heuristic; visible feedback on buffer overflow.
11. M-4/L-1: Job Object / stale-process sweep + temp cleanup in the agent.

---

## Appendix A — Verified-good inventory

- Print callback timeout safety net (main.js:51-75)
- Per-job window destroy in `finally` incl. timeout paths (main.js:134-138)
- Single-instance lock + second-instance focus restore (main.js:294-303)
- Timer cleanup on quit (main.js:317-319)
- Minimal fixed-channel preload API (preload.cjs)
- Three-layer wedge defense: capture-phase suppression → timing gate → money regex
- Double-read coalescing + stale-burst freshness gate
- Agent claim-RPC arbitration prevents multi-agent double-printing
- Agent survives `unhandledRejection` (service-appropriate)
- Puppeteer singleton self-heals via `_browser.connected`

*End of audit. No application files were created or modified; this report is the sole artifact.*
