/**
 * Client-side print agent utilities.
 *
 * Checks if a local print agent is reachable, submits print jobs via
 * POST /api/print, and falls back to window.print() when the agent is
 * unavailable.
 */

import { posFetch } from "./tenantClient";
import type { ShiftAudit } from "@/types/shifts.types";

export type PrintJobKind = "Z_REPORT" | "X_REPORT" | "RECEIPT" | "INVOICE";
export type PrinterKind = "THERMAL" | "A4" | "LABEL";

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
 * Submit a print job to the local print agent via POST /api/print.
 * The server renders the HTML, inserts a QUEUED row into print_jobs,
 * and the agent picks it up via Supabase Realtime.
 */
export async function submitPrintJob(req: PrintJobRequest): Promise<PrintJobResponse> {
  const res = await posFetch("/api/print", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => null) as { error?: string } | null;
    return { success: false, error: body?.error ?? `HTTP ${res.status}` };
  }

  return (await res.json()) as PrintJobResponse;
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
 * Smart print: tries the silent agent first; if unavailable, falls back
 * to the traditional window.print() path.
 *
 * Returns true if the agent handled it, false if window.print() was used.
 */
export async function smartPrint(options: PrintOptions): Promise<boolean> {
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
      // Agent rejected — fall through to window.print()
    } catch {
      // Network error talking to /api/print — fall through
      invalidateHealthCache();
    }
  }

  // Fallback: caller triggers window.print() via their existing mechanism
  options.onFallback?.();
  return false;
}
