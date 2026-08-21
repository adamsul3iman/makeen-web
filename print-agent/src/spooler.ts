/**
 * Print spooler: renders HTML → PDF via puppeteer-core (system Chrome),
 * then sends the PDF to the OS printer via pdf-to-printer (SumatraPDF).
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execSync } from "child_process";
import type { Browser } from "puppeteer-core";

let _browser: Browser | null = null;
let _chromePath: string | null = null;

// ── Chrome / Chromium discovery ─────────────────────────────────────

/**
 * Common Chrome installation paths on Windows (64-bit and 32-bit).
 * Checked in order; first hit wins.
 */
const CHROME_PATHS = [
  // Chrome
  path.join(process.env["PROGRAMFILES"] ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
  path.join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
  // Edge (Chromium-based — works with Puppeteer)
  path.join(process.env["PROGRAMFILES"] ?? "C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe"),
  path.join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
  // Chromium
  path.join(process.env["LOCALAPPDATA"] ?? "", "Chromium", "Application", "chrome.exe"),
  // Brave
  path.join(process.env["PROGRAMFILES"] ?? "C:\\Program Files", "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
];

function findChrome(): string | null {
  for (const p of CHROME_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Download Chromium using Puppeteer's built-in browser manager.
 * Falls back to a manual download if the CLI fails.
 */
async function downloadChromium(log: (lvl: string, msg: string) => void): Promise<string | null> {
  const cacheDir = path.join(os.homedir(), ".cache", "puppeteer");
  const chromePath = path.join(cacheDir, "chrome", "win64");

  log("info", "Downloading Chromium (first run — this may take a minute)…");

  try {
    // Use npx to invoke puppeteer's browser install command
    execSync("npx --yes puppeteer browsers install chrome", {
      stdio: "pipe",
      timeout: 300_000, // 5 minutes
      env: { ...process.env, PUPPETEER_CACHE_DIR: cacheDir },
    });
  } catch {
    // CLI failed — try manual path detection
  }

  // Find the downloaded chrome.exe
  if (fs.existsSync(chromePath)) {
    const entries = fs.readdirSync(chromePath);
    for (const entry of entries) {
      const chrome = path.join(chromePath, entry, "chrome-win", "chrome.exe");
      if (fs.existsSync(chrome)) return chrome;
    }
  }

  return null;
}

// ── Browser management ──────────────────────────────────────────────

async function getBrowser(log: (lvl: string, msg: string) => void): Promise<Browser> {
  if (_browser && _browser.connected) return _browser;

  // Find Chrome: bundled → system → download
  if (!_chromePath) {
    _chromePath = findChrome();
    if (!_chromePath) {
      log("warn", "Chrome not found in standard locations — attempting download");
      _chromePath = await downloadChromium(log);
    }
    if (!_chromePath) {
      throw new Error(
        "Chrome/Chromium not found. Install Google Chrome or run:\n" +
        "  npx puppeteer browsers install chrome"
      );
    }
    log("info", `Using Chrome: ${_chromePath}`);
  }

  const puppeteer = await import("puppeteer-core");
  _browser = await puppeteer.default.launch({
    headless: true,
    executablePath: _chromePath,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });
  return _browser;
}

export async function closeBrowser(): Promise<void> {
  if (_browser) {
    await _browser.close().catch(() => {});
    _browser = null;
  }
}

// ── Paper dimensions ────────────────────────────────────────────────

function paperSize(printerKind: string): { width: string; height?: string } {
  switch (printerKind) {
    case "THERMAL":
      return { width: "80mm", height: "297mm" };
    case "LABEL":
      return { width: "40mm", height: "25mm" };
    case "A4":
    default:
      return { width: "210mm", height: "297mm" };
  }
}

// ── HTML → PDF ──────────────────────────────────────────────────────

export async function htmlToPdf(
  renderedHtml: string,
  printerKind: string,
  log: (lvl: string, msg: string) => void,
): Promise<Buffer> {
  const size = paperSize(printerKind);
  const browser = await getBrowser(log);
  const page = await browser.newPage();

  try {
    await page.setContent(renderedHtml, {
      waitUntil: "domcontentloaded",
      timeout: 15_000,
    });

    const pdfBuffer = await page.pdf({
      width: size.width,
      height: size.height,
      printBackground: true,
      margin: { top: "0", right: "0", bottom: "0", left: "0" },
      preferCSSPageSize: false,
    });

    return Buffer.from(pdfBuffer);
  } finally {
    await page.close().catch(() => {});
  }
}

// ── PDF → Printer ───────────────────────────────────────────────────

/**
 * Find SumatraPDF.exe — bundled with pdf-to-printer or system-installed.
 */
function findSumatraPdf(): string | undefined {
  // pdf-to-printer bundles SumatraPDF in its own directory
  try {
    const ptpDir = path.dirname(require.resolve("pdf-to-printer/package.json"));
    const sumatra = path.join(ptpDir, "SumatraPDF.exe");
    if (fs.existsSync(sumatra)) return sumatra;
  } catch {
    // Module not found
  }

  // Check common system paths
  const sysPaths = [
    path.join(process.env["PROGRAMFILES"] ?? "C:\\Program Files", "SumatraPDF", "SumatraPDF.exe"),
    path.join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "SumatraPDF", "SumatraPDF.exe"),
  ];
  for (const p of sysPaths) {
    if (fs.existsSync(p)) return p;
  }

  return undefined;
}

export async function spoolToPrinter(
  pdfBuffer: Buffer,
  printerName: string,
  jobId: string,
): Promise<void> {
  const tmpDir = path.join(os.tmpdir(), "makeen-print-agent");
  fs.mkdirSync(tmpDir, { recursive: true });
  const pdfPath = path.join(tmpDir, `job-${jobId}.pdf`);

  fs.writeFileSync(pdfPath, pdfBuffer);

  try {
    const ptp = await import("pdf-to-printer");
    const opts: Record<string, unknown> = { printer: printerName };
    const sumatra = findSumatraPdf();
    if (sumatra) opts.sumatraPdfPath = sumatra;
    await ptp.print(pdfPath, opts);
  } finally {
    try { fs.unlinkSync(pdfPath); } catch { /* best-effort */ }
  }
}
