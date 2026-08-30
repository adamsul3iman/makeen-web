/**
 * Hardware & Peripherals Hub — self-contained test-payload builders.
 *
 * These produce complete, standalone HTML documents for each printer slot so
 * the Hardware Hub diagnostics panel can fire a real test without depending on
 * a receipt being currently mounted in the POS DOM.
 */

import type { SlotKind } from "./types";

function pageShell(title: string, body: string): string {
  return [
    "<!DOCTYPE html>",
    '<html lang="ar" dir="rtl">',
    "<head>",
    '<meta charset="utf-8" />',
    "<title>",
    title,
    "</title>",
    "<style>",
    "*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}",
    "@page{size:auto;margin:0}",
    "body{font-family:'Courier New',Consolas,monospace;direction:rtl;color:#000;background:#fff}",
    "table{width:100%;border-collapse:collapse}",
    "td,th{padding:2px 4px;text-align:right}",
    ".center{text-align:center}",
    ".title{font-weight:700;font-size:120%}",
    "</style>",
    "</head>",
    "<body>",
    body,
    "</body>",
    "</html>",
  ].join("\n");
}

/** Thermal receipt-style test page (self-contained, no DOM dependency). */
export function buildReceiptTestHtml(): string {
  return pageShell(
    "اختبار الإيصال الحراري",
    [
      '<div class="center title">MAKEEN POS</div>',
      '<div class="center">رسالة اختبار الطابعة الحرارية</div>',
      '<div class="center">Receipt Test Print</div>',
      '<hr style="border-top:1px dashed #000" />',
      "<table>",
      "<tr><td>المنتج</td><td>الكمية</td><td>السعر</td></tr>",
      "<tr><td>منتج تجريبي</td><td>2</td><td>1.00</td></tr>",
      "<tr><td>بند ثانٍ</td><td>1</td><td>0.75</td></tr>",
      "</table>",
      '<hr style="border-top:1px dashed #000" />',
      "<table>",
      "<tr><td>المجموع</td><td>2.75</td></tr>",
      "<tr><td>التاريخ</td><td>" + new Date().toLocaleDateString("ar-EG") + "</td></tr>",
      "</table>",
      '<div class="center">— خط إغلاق —</div>',
    ].join("\n"),
  );
}

/** Barcode label test page. */
export function buildLabelTestHtml(): string {
  return pageShell(
    "اختبار ملصق الباركود",
    [
      '<div class="center title">ملصق اختبار</div>',
      '<div class="center" style="font-weight:700;letter-spacing:6px">6251234567890</div>',
      '<div class="center" style="margin-top:4px">Product Test 123</div>',
      '<div class="center">' + new Date().toLocaleDateString("ar-EG") + "</div>",
    ].join("\n"),
  );
}

/** A4 document-style test page. */
export function buildA4TestHtml(): string {
  return pageShell(
    "اختبار طابعة A4",
    [
      '<div style="padding:40px 32px">',
      '<h1 style="font-size:22px;margin-bottom:12px">اختبار الطابعة A4</h1>',
      '<p style="font-size:14px;line-height:1.8;margin-bottom:12px">هذه صفحة اختبار للتأكد من أن طابعة الأوراق (A4) تعمل بشكل صحيح مع التقارير والفواتير.</p>',
      "<table style=\"border:1px solid #000;margin-top:16px\">",
      "<tr><th>البند</th><th>الوصف</th><th>الحالة</th></tr>",
      "<tr><td>1</td><td>طباعة الصفحات</td><td>تعمل</td></tr>",
      "<tr><td>2</td><td>الألوان / تدرج رمادي</td><td>تعمل</td></tr>",
      "<tr><td>3</td><td>الهوامش والتخطيط</td><td>تعمل</td></tr>",
      "</table>",
      '<p style="margin-top:16px;font-size:12px">النصي التاريخ: ' + new Date().toLocaleString("ar-EG") + "</p>",
      "</div>",
    ].join("\n"),
  );
}

/** Build the appropriate test HTML for a slot kind. */
export function buildSlotTestHtml(kind: SlotKind): string {
  if (kind === "LABEL") return buildLabelTestHtml();
  if (kind === "A4") return buildA4TestHtml();
  return buildReceiptTestHtml();
}
