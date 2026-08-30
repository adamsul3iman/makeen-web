/**
 * Client-side print agent utilities.
 *
 * 1. In Electron → tries silent IPC print (no dialog, direct to thermal printer).
 * 2. If a standalone print agent is reachable → queues into print_jobs table.
 * 3. Otherwise → falls back to window.print().
 */

import { getSupabaseBrowser } from "./supabaseBrowser";
import { getTenantStoreId } from "./tenantClient";
import type { ShiftAudit } from "@/types/shifts.types";

export type PrintJobKind = "Z_REPORT" | "X_REPORT" | "RECEIPT" | "INVOICE";
export type PrinterKind = "THERMAL" | "A4" | "LABEL";

// ── Electron silent-print bridge ────────────────────────────────────

interface ElectronPrintAPI {
  printSilent(payload: {
    html: string;
    printerName?: string;
    printerKind?: PrinterKind;
  }): Promise<{ success: boolean; error?: string }>;
  getPrinters(): Promise<Array<{ name: string; isDefault?: boolean }>>;
  /** Enumerate serial COM devices (Electron raw hardware path). */
  listComPorts(): Promise<string[]>;
  /** Raw ESC/POS drawer pulse on a COM device. */
  kickDrawer(payload: {
    comPort: string;
    baudRate: number;
    pin: number;
  }): Promise<{ ok: boolean; error?: string }>;
  /** Raw ESC @ write test on a COM device. */
  initComPort(payload: {
    comPort: string;
    baudRate: number;
  }): Promise<{ ok: boolean; error?: string }>;
}

declare global {
  interface Window {
    electronAPI?: ElectronPrintAPI;
  }
}

/**
 * True when running inside Electron (preload exposes window.electronAPI).
 * Exported so callers can honor the hard UX rule: the native print dialog
 * may NEVER appear inside the Electron wrapper — only in plain browsers.
 */
export function isElectron(): boolean {
  return typeof window !== "undefined" && !!window.electronAPI;
}

// Raw command buffers (TSPL/ESC-POS) belong to BARCODE jobs alone and must
// never ride the receipt/HTML channel — mirroring the gate in electron/main.js.
// A rendered receipt is always a document that begins with markup; a raw label
// buffer begins with a command (SIZE / SET PEEL / PRINT / GAP / CLS / ...).
const RAW_COMMAND_MARKERS = [
  /^\s*(CLS|DIR|DRIVE|MODE|GAP|DENSITY|SET|SIZE|PRINT|BARCODE|TEXT|BLOCK|BOX|CUT|EOP|FEED|PEEL)\b/i,
  /\bsize\s*[\d.]+(\s*mm)?\s*,\s*[\d.]+(\s*mm)?\s*$/im,
  /\b(set\s+)?peel\s+(on|off)\s*$/im,
  /^\s*print\s+\d+\s*,\s*\d+\s*$/im,
  /^\s*gap\s+[\d.]+\s*mm,/im,
];

/**
 * True when the given string is a printable HTML document (not a raw TSPL /
 * ESC-POS command buffer). Used to keep receipts/reports on the graphical
 * silent bridge and to make raw strings uncapable of reaching the spooler as
 * a receipt page.
 */
export function looksLikeHtmlDocument(html: string | undefined | null): boolean {
  if (typeof html !== "string") return false;
  const trimmed = html.replace(/^\uFEFF/, "").trim();
  if (!trimmed) return false;
  if (!trimmed.startsWith("<")) return false;
  return !RAW_COMMAND_MARKERS.some((re) => re.test(trimmed));
}

/**
 * Wrap the receipt/report fragment in a full HTML document sized for thermal
 * paper, exactly as the hidden Electron print window expects. Shared by every
 * silent-print path so receipts and shift reports go through byte-identical
 * markup (the same bridge that already prints shift reports reliably).
 */
function wrapSilentHtml(renderedHtml: string): string {
  if (renderedHtml.includes("<!DOCTYPE") || renderedHtml.includes("<html")) {
    return renderedHtml;
  }
  return [
    "<!DOCTYPE html>",
    '<html lang="ar" dir="rtl">',
    "<head>",
    '<meta charset="utf-8" />',
    "<style>",
    "*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}",
    "html,body{width:100%;background:#fff;color:#000}",
    "body{font-family:'Courier New',Consolas,monospace;font-size:10px;line-height:1.4;direction:rtl}",
    /* Thermal paper: size the page to the roll width so the driver never
       falls back to the browser's A4 default (which mis-sizes the receipt
       and pushes a blank page through before the real content). */
    "@page{size:80mm auto;margin:0}",
    "#thermal-receipt{display:block!important;width:100%;max-width:80mm}",
    "#thermal-shift-print{display:block!important;width:100%;max-width:80mm}",
    "#thermal-receipt *,#thermal-shift-print *{visibility:visible;color:#000;background:transparent}",
    "table{width:100%;border-collapse:collapse}",
    "th,td{padding:1px 2px;font-size:10px;text-align:right}",
    "</style>",
    "</head>",
    "<body>",
    renderedHtml,
    "</body>",
    "</html>",
  ].join("\n");
}

/**
 * Render HTML for the print job (receipt or shift report) and send it
 * to the Electron main process for silent printing — no native dialog.
 */
async function printViaElectron(
  html: string | undefined,
  shift: ShiftAudit | undefined,
  jobType: PrintJobKind,
  printerKind?: PrinterKind,
  printerName?: string,
): Promise<boolean> {
  if (!isElectron() || !window.electronAPI) return false;

  let renderedHtml = html;
  if (!renderedHtml && shift) {
    const { renderShiftPrintHtml } = await import("./printRenderer");
    renderedHtml = renderShiftPrintHtml(shift, jobType);
  }
  if (!renderedHtml) return false;

  // Graphical path only — a raw TSPL buffer must never reach the silent bridge.
  if (!looksLikeHtmlDocument(renderedHtml)) {
    console.warn("[printAgent] printViaElectron rejected: payload is not HTML", {
      jobType,
      printerKind,
    });
    return false;
  }

  const fullHtml = wrapSilentHtml(renderedHtml);

  // The main process resolves the actual device by enumerating installed
  // printers against printerKind (hardcoded names never match drivers like
  // "RONGTA 80mm Series Printer"). printerName stays reserved for an explicit
  // user-configured override.
  try {
    const result = await window.electronAPI.printSilent({
      html: fullHtml,
      printerName,
      printerKind,
    });
    if (!result.success && result.error) {
      console.warn("[printAgent] Electron silent print rejected:", result.error);
    }
    return result.success;
  } catch (err) {
    console.warn("[printAgent] Electron IPC print failed:", err);
    return false;
  }
}

/**
 * Direct Electron silent-print bridge for post-checkout receipts. This is the
 * EXACT same IPC call (window.electronAPI.printSilent → "print:silent") that
 * reliably prints shift reports and operational logs, used here with NO tier
 * fallback, NO Supabase print_jobs queue insert, and NO hidden-iframe dialog —
 * so a checkout receipt goes straight to the thermal printer with zero
 * intervening failure points inside the desktop wrapper.
 *
 * Returns true only when the OS spooler actually accepted the job. Callers in
 * the POS should treat a false return as "did not print" and surface the
 * in-app notice (never a native dialog) so the checkout lane is not blocked.
 */
export async function printReceiptSilently(options: {
  html: string;
  printerName?: string;
  printerKind?: PrinterKind;
}): Promise<boolean> {
  if (!isElectron() || !window.electronAPI) return false;
  // The receipt channel is graphical HTML only. Reject raw label buffers so a
  // BARCODE job can never be printed as literal TSPL on the receipt printer.
  if (!looksLikeHtmlDocument(options.html)) {
    console.warn("[printAgent] checkout silent print rejected: payload is not HTML");
    return false;
  }
  const fullHtml = wrapSilentHtml(options.html);
  try {
    const result = await window.electronAPI.printSilent({
      html: fullHtml,
      printerName: options.printerName,
      printerKind: options.printerKind ?? "THERMAL",
    });
    if (!result.success && result.error) {
      console.warn("[printAgent] checkout silent print rejected:", result.error);
    }
    return result.success;
  } catch (err) {
    console.warn("[printAgent] checkout silent print IPC failed:", err);
    return false;
  }
}

// ── Health check (cached) ──────────────────────────────────────────

const AGENT_HEALTH_URL = "http://localhost:9100/health";
const HEALTH_CACHE_MS = 30_000;

let lastHealthCheck = 0;
let lastHealthResult = false;

/**
 * Quick probe: is the print agent running on this machine?
 * Result is cached for 30s to avoid hammering localhost on every click.
 * Always returns false when called from a non-browser context.
 */
export async function isPrintAgentAvailable(): Promise<boolean> {
  if (typeof window === "undefined") return false;

  const now = Date.now();
  if (now - lastHealthCheck < HEALTH_CACHE_MS) return lastHealthResult;

  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch(AGENT_HEALTH_URL, {
      signal: ctrl.signal,
      cache: "no-store",
    });
    clearTimeout(timeout);
    const ok = res.ok;
    lastHealthCheck = now;
    lastHealthResult = ok;
    return ok;
  } catch {
    lastHealthCheck = now;
    lastHealthResult = false;
    return false;
  }
}

/** Force-clear the cached health result (e.g. after a failed print attempt). */
export function invalidateHealthCache(): void {
  lastHealthCheck = 0;
  lastHealthResult = false;
}

// ── Browser print (async-safe, via hidden iframe) ─────────────────

let printIframe: HTMLIFrameElement | null = null;
let printIframeSeq = 0;

/**
 * Print rendered HTML via a hidden same-origin iframe. This is the robust
 * browser fallback: it does NOT depend on window.print() running inside a
 * synchronous user gesture. Chrome blocks window.print() once the originating
 * gesture is consumed by awaits/timers (which is exactly what checkout does),
 * so we render the receipt in an isolated iframe and call print() on its own
 * window instead. Returns true once the iframe handed off to the print dialog.
 */
export function printInBrowser(html: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (typeof document === "undefined") return resolve(false);

    try {
      const seq = ++printIframeSeq;
      const iframe = document.createElement("iframe");
      printIframe = iframe;
      iframe.setAttribute("aria-hidden", "true");
      iframe.style.position = "fixed";
      iframe.style.right = "0";
      iframe.style.bottom = "0";
      iframe.style.width = "0";
      iframe.style.height = "0";
      iframe.style.border = "0";
      iframe.style.visibility = "hidden";
      document.body.appendChild(iframe);

      const contentDoc = iframe.contentDocument || iframe.contentWindow?.document;
      if (!contentDoc || !iframe.contentWindow) {
        iframe.remove();
        printIframe = null;
        return resolve(false);
      }

      contentDoc.open();
      contentDoc.write(html);
      contentDoc.close();

      // Give the iframe document a beat to lay out before calling print.
      const finish = () => {
        try {
          iframe.contentWindow?.print();
        } catch {
          // Iframe print is not reliable here — fall back to a direct call.
          try {
            window.print();
          } catch {
            /* both paths rejected; surface as failure */
          }
        } finally {
          if (printIframe === iframe) printIframe = null;
          // Keep the iframe off-screen until the dialog is dismissed, then
          // remove it so it never leaks into layout/accessibility.
          setTimeout(() => iframe.remove(), 1000);
        }
      };

      if (contentDoc.readyState === "complete") {
        finish();
      } else {
        // Older WebKit/Blink can drop the dialog if print() is deferred too
        // far; a RAF + microtask keeps us as close to the gesture as possible.
        requestAnimationFrame(() => requestAnimationFrame(finish));
        if (seq === printIframeSeq) setTimeout(finish, 300);
      }
      resolve(true);
    } catch {
      try {
        window.print();
      } catch {
        /* ignored */
      }
      resolve(false);
    }
  });
}

// ── Submit print job ───────────────────────────────────────────────

export interface PrintJobRequest {
  terminal_id: string;
  job_type: PrintJobKind;
  shift?: ShiftAudit;
  rendered_html?: string;
  printer_kind?: PrinterKind;
}

export interface PrintJobResponse {
  success: boolean;
  job_id?: string;
  error?: string;
}

/**
 * Queue a print job for the local print agent by inserting a QUEUED row
 * directly into print_jobs. The agent picks it up via Supabase Realtime /
 * the claim_print_job RPC.
 */
export async function submitPrintJob(req: PrintJobRequest): Promise<PrintJobResponse> {
  const sb = getSupabaseBrowser();
  const storeId = getTenantStoreId();
  if (!sb || !storeId) {
    console.warn("[printAgent] Supabase غير مهيأة — تعذر إدراج مهمة الطباعة");
    return { success: false, error: "supabase_not_configured" };
  }

  let renderedHtml = req.rendered_html;
  if (!renderedHtml && req.shift) {
    const { renderShiftPrintHtml } = await import("./printRenderer");
    renderedHtml = renderShiftPrintHtml(req.shift, req.job_type);
  }
  if (!renderedHtml) {
    return { success: false, error: "rendered_html_required_for_receipt" };
  }

  const printerKind =
    req.printer_kind ??
    (req.job_type === "Z_REPORT" || req.job_type === "X_REPORT" ? "THERMAL" : "A4");

  const { data: job, error } = await sb
    .from("print_jobs")
    .insert({
      store_id: storeId,
      kind: req.job_type,
      status: "QUEUED",
      printer_kind: printerKind,
      rendered_html: renderedHtml,
      terminal_id: req.terminal_id,
      payload: { shift: req.shift ?? null, job_type: req.job_type },
    })
    .select("id")
    .maybeSingle();

  if (error) {
    console.warn("[printAgent] فشل إدراج مهمة الطباعة:", error.message);
    return { success: false, error: error.message };
  }

  return { success: true, job_id: job?.id ?? null };
}

// ── Combined: try agent, fall back ─────────────────────────────────

export interface PrintOptions {
  /** The terminal UUID (activeTerminalId from store). */
  terminalId: string;
  /** Job kind — determines renderer + default printer kind. */
  jobType: PrintJobKind;
  /** Shift payload for Z_REPORT / X_REPORT. */
  shift?: ShiftAudit;
  /** Pre-rendered HTML for RECEIPT / INVOICE (client-rendered DOM). */
  renderedHtml?: string;
  /** Override printer kind (auto-detected from jobType if omitted). */
  printerKind?: PrinterKind;
  /** Explicit printer name (as returned by getPrinters()) to route to.
   *  Mirrors the Devices-page selection; empty means auto-resolution. */
  printerName?: string;
  /** Called when the agent successfully accepted the job (no fallback needed). */
  onAgentSuccess?: () => void;
  /** Called when falling back to browser printing. Receives the rendered
   *  HTML when available (RECEIPT/INVOICE), so the caller can open the dialog
   *  via the async-safe hidden-iframe printer; null otherwise (report flows
   *  that print a live DOM element). */
  onFallback?: (renderedHtml?: string) => void;
}

/**
 * Smart print — three-tier strategy:
 *   1. Electron IPC silent print (no dialog, direct to thermal printer)
 *   2. Standalone print agent via Supabase print_jobs table
 *   3. Fallback: window.print() (native dialog) — ALWAYS in a plain browser.
 *
 * Returns true if a silent path handled it AND no further printing is needed
 * (i.e. the job reached a real spooler). Returns false in a plain browser so
 * callers can show the native dialog.
 *
 * BROWSER POLICY (decision): a print_jobs queue INSERT is meaningless without
 * a spooler draining it, so it is never treated as "printed". In a non-Electron
 * browser this function ALWAYS falls through to the fallback tier (native
 * window.print()) so the receipt is actually produced. Inside Electron a failed
 * silent print must surface as an in-app notice instead of a native dialog
 * (which would block the checkout lane), so the fallback tier is suppressed
 * there — callers key off the false return while isElectron() is true.
 */
export async function smartPrint(options: PrintOptions): Promise<boolean> {
  // ── Tier 1: Electron silent print ────────────────────────────────
  if (isElectron()) {
    const ok = await printViaElectron(
      options.renderedHtml,
      options.shift,
      options.jobType,
      options.printerKind,
      options.printerName,
    ).catch(() => false);
    if (ok) {
      options.onAgentSuccess?.();
      return true;
    }
  }

  // ── Tier 2: Supabase print agent ────────────────────────────────
  // Only treated as "printed" inside Electron (a true local spooler). In a
  // plain browser a print_jobs INSERT does not mean anything actually printed
  // (the localhost:9100 health probe can be a warm 30s cache, not a live
  // spooler), so it must never suppress the native dialog.
  const available = await isPrintAgentAvailable();

  if (isElectron() && available) {
    try {
      const result = await submitPrintJob({
        terminal_id: options.terminalId,
        job_type: options.jobType,
        shift: options.shift,
        rendered_html: options.renderedHtml,
        printer_kind: options.printerKind,
      });

      if (result.success) {
        options.onAgentSuccess?.();
        return true;
      }
    } catch {
      invalidateHealthCache();
    }
  }

  // ── Tier 3: browser fallback (ALWAYS reached in a plain browser) ──
  // In a non-Electron browser this is the only guaranteed way to produce
  // output. We use the async-safe iframe printer when we have rendered HTML
  // (bypasses Chrome's user-gesture block on window.print() after awaits);
  // otherwise delegate to the caller's onFallback (report flows that render
  // their own live DOM and dialogs). Inside Electron the fallback stays
  // suppressed so the cashier lane is never frozen by a native dialog.
  if (options.onFallback) options.onFallback(options.renderedHtml);
  return !isElectron();
}
