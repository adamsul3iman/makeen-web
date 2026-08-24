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
  getPrinters(): Promise<Array<{ name: string }>>;
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

/**
 * Render HTML for the print job (receipt or shift report) and send it
 * to the Electron main process for silent printing — no native dialog.
 */
async function printViaElectron(
  html: string | undefined,
  shift: ShiftAudit | undefined,
  jobType: PrintJobKind,
  printerKind?: PrinterKind,
): Promise<boolean> {
  if (!isElectron() || !window.electronAPI) return false;

  let renderedHtml = html;
  if (!renderedHtml && shift) {
    const { renderShiftPrintHtml } = await import("./printRenderer");
    renderedHtml = renderShiftPrintHtml(shift, jobType);
  }
  if (!renderedHtml) return false;

  // Wrap the fragment in a full HTML document for the hidden BrowserWindow
  const fullHtml = renderedHtml.includes("<!DOCTYPE") || renderedHtml.includes("<html")
    ? renderedHtml
    : [
        "<!DOCTYPE html>",
        '<html lang="ar" dir="rtl">',
        "<head>",
        '<meta charset="utf-8" />',
        "<style>",
        "*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}",
        "html,body{width:100%;background:#fff;color:#000}",
        "body{font-family:'Courier New',Consolas,monospace;font-size:10px;line-height:1.4;direction:rtl}",
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

  // The main process resolves the actual device by enumerating installed
  // printers against printerKind (hardcoded names never match drivers like
  // "RONGTA 80mm Series Printer"). printerName stays reserved for an explicit
  // user-configured override.
  try {
    const result = await window.electronAPI.printSilent({
      html: fullHtml,
      printerName: undefined,
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

// ── Receipt HTML capture ───────────────────────────────────────────

/**
 * Capture the rendered receipt HTML from the hidden ThermalReceipt DOM node.
 * Returns a full HTML document ready for the agent to pipe to Puppeteer.
 * Returns null if the receipt element is not in the DOM.
 */
export function captureReceiptHtml(): string | null {
  if (typeof document === "undefined") return null;
  const el = document.getElementById("thermal-receipt");
  if (!el) return null;

  const receiptHtml = el.innerHTML;

  return [
    "<!DOCTYPE html>",
    '<html lang="ar" dir="rtl">',
    "<head>",
    '<meta charset="utf-8" />',
    "<title>إيصال مبيعات</title>",
    "<style>",
    "*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}",
    "html,body{width:100%;background:#fff;color:#000}",
    "body{font-family:'Courier New',Consolas,monospace;font-size:10px;line-height:1.4;direction:rtl}",
    "#thermal-receipt{display:block!important;width:100%;max-width:80mm}",
    "#thermal-receipt *{visibility:visible;color:#000;background:transparent;box-shadow:none;text-shadow:none}",
    "table{width:100%;border-collapse:collapse}",
    "th,td{padding:1px 2px;font-size:10px;text-align:right}",
    "th{font-weight:700}",
    ".text-center{text-align:center}",
    ".text-left{text-align:left}",
    "img{max-width:60%;height:auto}",
    "</style>",
    "</head>",
    "<body>",
    `<div id="thermal-receipt" dir="rtl" lang="ar">`,
    receiptHtml,
    "</div>",
    "</body>",
    "</html>",
  ].join("\n");
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
  /** Called when the agent successfully accepted the job (no fallback needed). */
  onAgentSuccess?: () => void;
  /** Called when falling back to window.print(). */
  onFallback?: () => void;
}

/**
 * Smart print — three-tier strategy:
 *   1. Electron IPC silent print (no dialog, direct to thermal printer)
 *   2. Standalone print agent via Supabase print_jobs table
 *   3. Fallback: window.print() (native dialog) — BROWSER ONLY.
 *
 * Returns true if a silent path handled it (caller should NOT call window.print()).
 * Inside Electron the fallback tier is suppressed: a native dialog freezes a
 * checkout lane, so a failed silent print surfaces as an error notice instead
 * (callers key off the `false` return while isElectron() is true).
 */
export async function smartPrint(options: PrintOptions): Promise<boolean> {
  // ── Tier 1: Electron silent print ────────────────────────────────
  if (isElectron()) {
    const ok = await printViaElectron(
      options.renderedHtml,
      options.shift,
      options.jobType,
      options.printerKind,
    ).catch(() => false);
    if (ok) {
      options.onAgentSuccess?.();
      return true;
    }
  }

  // ── Tier 2: Supabase print agent ────────────────────────────────
  const available = await isPrintAgentAvailable();

  if (available) {
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

  // ── Tier 3: window.print() fallback (browser only) ──────────────
  // Hard constraint: never inside the Electron wrapper. The native
  // dialog blocks the cashier until dismissed; a failed silent print
  // must surface as an in-app notice instead.
  if (!isElectron()) {
    options.onFallback?.();
  }
  return false;
}
