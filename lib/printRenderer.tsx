/**
 * Server-side HTML renderers for print views.
 *
 * These functions use `renderToString` from react-dom/server to produce
 * self-contained HTML documents where the print CSS is always active
 * (not gated behind @media print). The local print agent feeds the
 * output directly to Puppeteer or a PDF-to-printer bridge.
 */
import { renderToString } from "react-dom/server.browser";
import ShiftPrintView from "@/components/admin/ShiftPrintView";
import ThermalShiftPrintView from "@/components/admin/ThermalShiftPrintView";
import type { ShiftAudit } from "@/types/shifts.types";
import type { CompletedInvoice } from "@/types/pos.types";
import type { ReceiptTemplateConfig } from "@/types/printTemplates";
import ThermalReceiptPrint, {
  type ReceiptPrintStore,
} from "@/components/print/ThermalReceiptPrint";
import { renderBarcodeSvg } from "@/lib/barcodeSvg";
import { buildJordanQrBase64, renderJordanQrSvg } from "@/lib/qrGenerator";

/* ── Thermal (80 mm) ─────────────────────────────────────────────────────── */

const THERMAL_ACTIVE_CSS = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{width:100%;background:#fff;color:#000}
body{font-family:'Courier New',Consolas,monospace;font-size:10px;line-height:1.2;direction:rtl}
#thermal-shift-print{display:block!important;width:100%;max-width:80mm;margin:0 auto}
/* Thermal roll: the <=80mm page width is what the silent Electron bridge uses
   (it passes no pageSize, so @page CSS is the only paper-size control). */
@page{size:80mm auto;margin:0}
.th-table{width:100%;border-collapse:collapse;table-layout:fixed;margin:0}
.th-bordered th,.th-bordered td{border:1px solid #000;padding:2px;font-size:10px;word-wrap:break-word;overflow-wrap:break-word;text-align:right}
.th-bordered th{font-weight:700;text-align:center;background:#f0f0f0}
#thermal-shift-print *{visibility:visible;color:#000;background:transparent;box-shadow:none;text-shadow:none}
`;

/* ── Thermal receipt (80/58 mm) data fallback ───────────────────────────── */

const RECEIPT_ACTIVE_CSS = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{width:100%;background:#fff;color:#000}
body{font-family:'Tajawal','Cairo',system-ui,-apple-system,'Segoe UI',sans-serif;font-size:11px;line-height:1.4;direction:rtl}
@page{size:80mm auto;margin:0}
/* ── Legacy DOM-capture root (#thermal-receipt) — kept for the old capture
   path only. NEVER leak these rules outside this id: the self-contained
   #thermal-receipt-print document (below) carries its table styling inline and
   must not be overridden by the generic table/th/td defaults here, otherwise
   the item/price/qty/total columns drift out of alignment when printed. ── */
#thermal-receipt{display:block!important;width:100%;max-width:80mm}
#thermal-receipt *{visibility:visible;color:#000;background:transparent;box-shadow:none;text-shadow:none}
#thermal-receipt table{width:100%;border-collapse:collapse}
#thermal-receipt th,#thermal-receipt td{padding:1px 2px;font-size:10px;text-align:right;word-wrap:break-word;overflow-wrap:break-word}
/* ── Self-contained print root (#thermal-receipt-print): lock the columns so
   the physical paper layout is deterministic. tableLayout:fixed + the
   colgroup widths in the component fix item/price/qty/total into their
   columns; these rules only guarantee collapse/overflow behavior and never
   override the inline cell styling (alignment, padding, font-size). ── */
#thermal-receipt-print{direction:rtl}
/* The items table self-locks its columns via inline table-layout:fixed +
   colgroup widths (inline wins), so we only guarantee collapse/width here and
   intentionally do NOT force table-layout:fixed globally — the summary table
   (label/value) relies on auto layout and must not be split 50/50. */
#thermal-receipt-print table{width:100%;border-collapse:collapse;margin:0}
#thermal-receipt-print td,#thermal-receipt-print th{vertical-align:top;word-wrap:break-word;overflow-wrap:break-word;hyphens:none}
/* Print-safe items table: fixed layout + locked column splits so the
   Name/Price/Qty/Total columns never wrap or overlap on the roll. The inline
   colgroup widths in the component remain authoritative; these rules are a
   belt-and-braces guarantee that table-layout:fixed is enforced and every
   cell can wrap long Arabic product names without pushing the layout. */
#thermal-receipt-print table[data-items]{display:table;table-layout:fixed;width:100%}
#thermal-receipt-print table[data-items] th,
#thermal-receipt-print table[data-items] td{overflow-wrap:anywhere;word-break:break-word}
@media print{
  #thermal-receipt-print{display:block!important}
  #thermal-receipt-print *{visibility:visible!important;color:#000!important;background:transparent!important;box-shadow:none!important;text-shadow:none!important}
}
`;

/** Same block as RECEIPT_ACTIVE_CSS but sized to an explicit paper width. */
function receiptActiveCss(paperWidth: 58 | 80): string {
  return RECEIPT_ACTIVE_CSS
    .replace(/@page\{size:80mm auto;margin:0\}/, `@page{size:${paperWidth}mm auto;margin:0}`)
    .replace(/max-width:80mm/g, `max-width:${paperWidth}mm`);
}

/* ── A4 (office) ─────────────────────────────────────────────────────────── */

const A4_ACTIVE_CSS = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{width:100%;background:#fff;color:#000}
body{font-family:"Tahoma","Arial",sans-serif;font-size:10.5pt;line-height:1.45;direction:rtl}
/* A4 office portrait with the same margins the on-screen report uses — the
   silent Electron bridge passes no pageSize, so @page is the only control. */
@page{size:A4 portrait;margin:10mm 12mm}
#shift-print-view,.print-shift-root{display:block!important;width:100%;max-width:none;position:relative;z-index:auto;overflow:visible}
#shift-print-view *,.print-shift-root *{visibility:visible;color:#000;background:transparent;box-shadow:none;text-shadow:none}
.ps-header{width:100%;border-collapse:collapse;border-bottom:2.5pt solid #000;margin-bottom:14pt}
.ps-header td{padding:2pt 0;text-align:center}
.ps-header-title{font-size:16pt;font-weight:900;padding-bottom:4pt}
.ps-header-sub{font-size:10pt;font-weight:400;color:#333}
.ps-section{width:100%;border-collapse:collapse;margin-bottom:12pt;page-break-inside:avoid}
.ps-section-head{text-align:right;font-size:11pt;font-weight:900;padding:5pt 6pt;border-bottom:1.5pt solid #000;border-top:.5pt solid #999;background:#f0f0f0;color:#000}
.ps-section td,.ps-section th{padding:3.5pt 6pt;text-align:right;vertical-align:middle;border-bottom:.5pt solid #ccc}
.ps-label{font-weight:600;width:55%;text-align:right;color:#222}
.ps-value{font-weight:400;text-align:left;width:45%;font-variant-numeric:tabular-nums}
.ps-positive{color:#166534}.ps-negative{color:#991b1b}
.ps-total-row td{border-top:1.5pt solid #000;border-bottom:2pt solid #000;padding-top:5pt;padding-bottom:5pt}
.ps-total-label,.ps-total-value{font-weight:900;font-size:11pt}
.ps-tri-subhead th{font-size:9pt;font-weight:700;text-align:center;color:#444;padding:2pt 6pt;border-bottom:.75pt solid #999}
.ps-tri-ok{color:#166534}.ps-tri-surplus{color:#166534;font-weight:700}.ps-tri-short{color:#991b1b;font-weight:700}
.ps-signoff{width:100%;border-collapse:collapse;margin-top:28pt;page-break-inside:avoid}
.ps-sig-cell{width:50%;text-align:center;padding:0 16pt;vertical-align:bottom}
.ps-sig-cell span{display:block;font-size:9.5pt;margin-top:4pt;color:#333}
.ps-sig-line{width:100%;height:0;border-bottom:1pt solid #000;margin-bottom:2pt}
.ps-date-cell{text-align:center;font-size:9pt;color:#666;padding-top:10pt}
`;

/* ── Wrapper builder ─────────────────────────────────────────────────────── */

const PRINT_FONT_LINKS = [
  '<link rel="preconnect" href="https://fonts.googleapis.com" />',
  '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />',
  '<link href="https://fonts.googleapis.com/css2?family=Tajawal:wght@400;500;700;800;900&family=Cairo:wght@400;700;800;900&display=swap" rel="stylesheet" />',
].join("\n");

function wrapHtml(title: string, activeCss: string, bodyHtml: string): string {
  return [
    "<!DOCTYPE html>",
    '<html lang="ar" dir="rtl">',
    "<head>",
    '<meta charset="utf-8" />',
    `<title>${title}</title>`,
    PRINT_FONT_LINKS,
    `<style>${activeCss}</style>`,
    "</head>",
    "<body>",
    bodyHtml,
    "</body>",
    "</html>",
  ].join("\n");
}

/* ── Public API ──────────────────────────────────────────────────────────── */

export type PrintJobKind = "Z_REPORT" | "X_REPORT" | "RECEIPT" | "INVOICE";

/**
 * Render a shift audit into a self-contained HTML document ready for
 * the local print agent to pipe to Puppeteer / pdf-to-printer.
 *
 * @param shift  – the full ShiftAudit payload
 * @param kind   – "Z_REPORT" / "X_REPORT" → thermal, others → A4
 */
export function renderShiftPrintHtml(
  shift: ShiftAudit,
  kind: PrintJobKind,
): string {
  const isThermal = kind === "Z_REPORT" || kind === "X_REPORT";

  const componentHtml = isThermal
    ? renderToString(<ThermalShiftPrintView shift={shift} kind={kind} />)
    : renderToString(<ShiftPrintView shift={shift} />);

  // Strip the original <style> tag injected by the component — we supply
  // our own always-active CSS via wrapHtml() instead.
  const cleaned = componentHtml.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");

  return wrapHtml(
    kind === "X_REPORT"
      ? "تقرير X — طباعة حرارية"
      : isThermal
        ? "تقرير Z — طباعة حرارية"
        : "تقرير Z — طباعة A4",
    isThermal ? THERMAL_ACTIVE_CSS : A4_ACTIVE_CSS,
    cleaned,
  );
}

/**
 * Self-contained receipt renderer (config-aware, print-exact).
 *
 * Produces a complete HTML document for the 80/58mm thermal slip with ALL of
 * the Print Studio styling carried inline — no Tailwind, no host stylesheet —
 * so the document renders identically whether it is driven by the Electron
 * silent bridge or the browser iframe (both of which load an isolated document
 * with no access to the app's CSS). The barcode (CODE128) and Jordan fiscal QR
 * are pre-rendered as SVG strings and inlined the same way the live receipt
 * builds them. This REPLACES the old plain-data fallback, so the printed slip
 * always matches the Studio preview and the on-screen ThermalReceipt.
 */
export async function renderReceiptPrintHtml(
  invoice: CompletedInvoice,
  opts: ReceiptRenderOptions,
): Promise<string> {
  const mm = (opts.paperWidth ?? opts.config.paperWidth ?? 80) === 58 ? 58 : 80;
  const isReturn = invoice.total < 0;
  const taxNumber = opts.store?.taxNumber?.trim() || "";
  // Jordan ISTD compliance: the fiscal QR may ONLY appear on a finalized,
  // settled sale. Parked/OPEN/proforma documents (isFinalized === false) must
  // never carry it — they render as a plain proforma slip instead.
  const isFinalized = invoice.isFinalized !== false;

  const barcodeSvg = opts.config.showInvoiceBarcode
    ? await renderBarcodeSvg(invoice.syncId)
    : null;

  let qrSvg: string | null = null;
  if (
    isFinalized &&
    opts.config.showFiscalQr &&
    Math.abs(invoice.tax) > 0 &&
    !invoice.isSettlement &&
    Boolean(taxNumber) &&
    !isReturn &&
    invoice.total >= 0
  ) {
    const content = invoice.istdQr
      ? invoice.istdQr
      : buildJordanQrBase64({
          sellerName: opts.store?.name?.trim() || "متجر التجزئة",
          taxNumber,
          timestamp: invoice.completed_at,
          total: invoice.total,
          tax: invoice.tax,
        });
    qrSvg = await renderJordanQrSvg(content).catch(() => null);
  }

  const body = renderToString(
    <ThermalReceiptPrint
      invoice={invoice}
      config={opts.config}
      store={opts.store}
      branchName={opts.branchName}
      terminalName={opts.terminalName}
      barcodeSvg={barcodeSvg}
      qrSvg={qrSvg}
    />,
  );

  const css =
    receiptActiveCss(mm) +
    `
#thermal-receipt-print{display:block!important;width:100%;max-width:${mm}mm;margin:0 auto}
#thermal-receipt-print *{visibility:visible;color:#000;background:transparent;box-shadow:none;text-shadow:none}
#thermal-receipt-print img{max-width:60%;height:auto}
#thermal-receipt-print svg{display:block;max-width:100%;height:auto}
`;

  return wrapHtml("إيصال مبيعات", css, body);
}

/** Options for the config-aware self-contained receipt renderer. */
export interface ReceiptRenderOptions {
  /** The Print Studio receipt template config. */
  config: ReceiptTemplateConfig;
  /** Overrides `config.paperWidth` when supplied. */
  paperWidth?: 58 | 80;
  /** Store branding (name, logo, address, tax number, footer...). */
  store?: ReceiptPrintStore;
  branchName?: string;
  terminalName?: string;
}
