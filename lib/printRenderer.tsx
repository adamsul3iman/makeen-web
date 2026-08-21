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

/* ── Thermal (80 mm) ─────────────────────────────────────────────────────── */

const THERMAL_ACTIVE_CSS = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{width:100%;background:#fff;color:#000}
body{font-family:'Courier New',Consolas,monospace;font-size:10px;line-height:1.2;direction:rtl}
#thermal-shift-print{display:block!important;width:100%}
.th-table{width:100%;border-collapse:collapse;table-layout:fixed;margin:0}
.th-bordered th,.th-bordered td{border:1px solid #000;padding:2px;font-size:10px;word-wrap:break-word;overflow-wrap:break-word;text-align:right}
.th-bordered th{font-weight:700;text-align:center;background:#f0f0f0}
#thermal-shift-print *{visibility:visible;color:#000;background:transparent;box-shadow:none;text-shadow:none}
`;

/* ── A4 (office) ─────────────────────────────────────────────────────────── */

const A4_ACTIVE_CSS = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{width:100%;background:#fff;color:#000}
body{font-family:"Tahoma","Arial",sans-serif;font-size:10.5pt;line-height:1.45;direction:rtl}
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

function wrapHtml(title: string, activeCss: string, bodyHtml: string): string {
  return [
    "<!DOCTYPE html>",
    '<html lang="ar" dir="rtl">',
    "<head>",
    '<meta charset="utf-8" />',
    `<title>${title}</title>`,
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
 * @param kind   – "Z_REPORT" → thermal table, everything else → A4
 */
export function renderShiftPrintHtml(
  shift: ShiftAudit,
  kind: PrintJobKind,
): string {
  const isThermal = kind === "Z_REPORT";

  const componentHtml = isThermal
    ? renderToString(<ThermalShiftPrintView shift={shift} />)
    : renderToString(<ShiftPrintView shift={shift} />);

  // Strip the original <style> tag injected by the component — we supply
  // our own always-active CSS via wrapHtml() instead.
  const cleaned = componentHtml.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");

  return wrapHtml(
    isThermal ? "تقرير Z — طباعة حرارية" : "تقرير Z — طباعة A4",
    isThermal ? THERMAL_ACTIVE_CSS : A4_ACTIVE_CSS,
    cleaned,
  );
}
